import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTurnEvent, interruptTurns, restoreTurns, maskPersonalData, isCurrentSnapshot } from '../src/session-state.ts';
import * as state from '../src/session-state.ts';

const turn = () => ({ id: 'turn-1', mode: 'text', text: 'Вопрос', reply: '', language: null, replyLanguage: null, status: 'processing', route: null, trace: null, preview: null, at: 1 });
const event = (type, payload, turnId = 'turn-1') => ({ type, payload, turn_id: turnId, seq: 1 });
const snapshot = (overrides = {}) => ({ session_id: 'session', last_seq: 12, last_turn_id: 'turn-1', active_scenario: 'SC13', pending_confirmation: null, last_trace: { actions: ['find_client'] }, ...overrides });

test('shared turn gate rejects stale identities and terminal mutations before hook side effects', () => {
  assert.equal(typeof state.shouldApplyTurnEvent, 'function');
  assert.equal(state.shouldApplyTurnEvent(turn(), event('agent.text', { text: 'Answer', language: 'ru' })), true);
  assert.equal(state.shouldApplyTurnEvent(turn(), event('agent.text', { text: 'Other' }, 'another')), false);
  assert.equal(state.shouldApplyTurnEvent(turn(), event('session.ready', { session_id: 'session', last_seq: 0 }, null)), false);
  for (const status of ['answered', 'clarify', 'handoff', 'error', 'interrupted']) {
    const terminal = { ...turn(), status };
    assert.equal(state.shouldApplyTurnEvent(terminal, event('action.preview', { name: 'old', summary: 'Old confirmation' })), false);
    assert.equal(state.shouldApplyTurnEvent(terminal, event('trace.updated', { client_first_audio_ms: 400 })), true);
    assert.equal(state.shouldApplyTurnEvent(terminal, event('error', { code: 'tts_unavailable', message: 'No sound' })), status !== 'error');
  }
});

test('rapid events accumulate transcript, route, text and final status without losing data', () => {
  const events = [
    event('transcript.partial', { text: 'Черновик' }),
    event('transcript.final', { text: 'КАСКО бар', language: 'kk' }),
    event('route.decision', { scenarios: [{ scenario_id: 'SC13' }], alternatives: [], language: 'kk' }),
    event('agent.text', { text: 'Полис нөмірі?', language: 'kk' }),
    event('turn.complete', { status: 'clarify' }),
  ];
  const [result] = events.reduce(applyTurnEvent, [turn()]);
  assert.equal(result.text, 'КАСКО бар');
  assert.equal(result.partialText, '');
  assert.equal(result.reply, 'Полис нөмірі?');
  assert.equal(result.status, 'clarify');
  assert.equal(result.route.scenarios[0].scenario_id, 'SC13');
});

test('server trace cannot erase measured browser latency with null', () => {
  const [result] = applyTurnEvent([{ ...turn(), trace: { client_first_audio_ms: 500 } }], event('trace.updated', { client_first_audio_ms: null, latency_ms: { total: 410 } }));
  assert.equal(result.trace.client_first_audio_ms, 500);
  assert.equal(result.trace.latency_ms.total, 410);
});

test('incremental traces deep merge stage durations instead of erasing previous measurements', () => {
  const [result] = applyTurnEvent([{ ...turn(), trace: { latency_ms: { stt: 100, router: 200 }, client_first_audio_ms: 600 } }], event('trace.updated', { latency_ms: { total: 500, router: 210 } }));
  assert.deepEqual(result.trace.latency_ms, { stt: 100, router: 210, total: 500 });
  assert.equal(result.trace.client_first_audio_ms, 600);
});

test('TTS failure keeps readable answer and awaits turn.complete', () => {
  const [result] = applyTurnEvent([{ ...turn(), reply: 'Готово' }], event('error', { code: 'tts_unavailable', message: 'Нет звука' }));
  assert.equal(result.reply, 'Готово');
  assert.equal(result.status, 'processing');
  assert.equal(result.errorCode, 'tts_unavailable');
  assert.equal(result.error, undefined);
});

test('server error messages never enter renderable turn state', () => {
  const [result] = applyTurnEvent([{ ...turn(), error: 'Previous raw message' }], event('error', { code: 'router_unavailable', message: 'Secret account 870101300123' }));
  assert.equal(result.errorCode, 'router_unavailable');
  assert.equal(result.status, 'error');
  assert.equal('error' in result, false);
  assert.equal(JSON.stringify(result).includes('870101300123'), false);
});

test('routing copies the detected mixed language to the turn independently of transcription', () => {
  const [result] = applyTurnEvent([turn()], event('route.decision', { scenarios: [], alternatives: [], language: 'mixed' }));
  assert.equal(result.language, 'mixed');
});

test('terminal turn content and status are immutable under late events but trace measurements can finish', () => {
  const late = [
    event('transcript.partial', { text: 'Late draft' }),
    event('transcript.final', { text: 'Late text', language: 'kk' }),
    event('route.decision', { scenarios: [{ scenario_id: 'SC20' }], alternatives: [], language: 'kk' }),
    event('action.preview', { name: 'late_action', summary: 'Late action' }),
    event('agent.text', { text: 'Late reply', language: 'kk' }),
    event('turn.complete', { status: 'answered' }),
    event('error', { code: 'late_failure', message: 'Sensitive message' }),
  ];
  for (const status of ['answered', 'clarify', 'handoff', 'error', 'interrupted']) {
    const original = { ...turn(), status, reply: 'Final reply' };
    assert.deepEqual(late.reduce(applyTurnEvent, [original]), [original], status);
    const [withTrace] = applyTurnEvent([original], event('trace.updated', { latency_ms: { total: 900 } }));
    assert.equal(withTrace.trace.latency_ms.total, 900);
    assert.equal(withTrace.status, status);
  }
});

test('late TTS unavailability adds a safe warning without changing a completed answer', () => {
  const original = { ...turn(), status: 'answered', reply: 'Сохранённый ответ' };
  const [result] = applyTurnEvent([original], event('error', { code: 'tts_unavailable', message: 'Internal provider details' }));
  assert.equal(result.errorCode, 'tts_unavailable');
  assert.equal(result.status, 'answered');
  assert.equal(result.reply, original.reply);
  assert.equal(result.error, undefined);
});

test('unknown turn cannot mutate an existing turn', () => {
  const turns = [turn()];
  assert.deepEqual(applyTurnEvent(turns, event('agent.text', { text: 'Wrong' }, 'other')), turns);
});

test('connection loss marks only unfinished turns interrupted, never executed or retried', () => {
  const turns = [turn(), { ...turn(), id: 'done', status: 'answered' }];
  const result = interruptTurns(turns);
  assert.equal(result[0].status, 'interrupted');
  assert.equal(result[1].status, 'answered');
});

test('reload restores safe confirmation and active scenario without inventing transcript or completion', () => {
  const preview = { name: 'create_claim', summary: 'Создать обращение', masked_args: { phone: '+7 ***' } };
  const [result] = restoreTurns([], snapshot({ pending_confirmation: preview }), 123);
  assert.equal(result.id, 'turn-1');
  assert.equal(result.restored, true);
  assert.equal(result.text, '');
  assert.equal(result.reply, '');
  assert.equal(result.status, 'interrupted');
  assert.deepEqual(result.route.scenarios, []);
  assert.equal(result.route.active_scenario, 'SC13');
  assert.deepEqual(result.preview, preview);
});

test('reconnect keeps local history, updates trace and clears resolved preview from current turn', () => {
  const current = { ...turn(), text: 'Сохранить меня', status: 'answered', preview: { name: 'claim', summary: 'Подтвердите' }, trace: { client_first_audio_ms: 520 } };
  const [result] = restoreTurns([current], snapshot(), 456);
  assert.equal(result.text, current.text);
  assert.equal(result.at, 1);
  assert.equal(result.status, 'answered');
  assert.equal(result.trace.client_first_audio_ms, 520);
  assert.equal(result.preview, null);
});

test('restoration uses only valid optional transcript/route and preserves active separately from primary', () => {
  const route = { scenarios: [{ scenario_id: 'SC13' }], alternatives: ['SC11'], language: 'mixed', active_scenario: 'SC13' };
  const [result] = restoreTurns([], snapshot({ active_scenario: 'SC20', last_trace: { transcript: { text: 'КАСКО бар, осмотр нужен', language: 'mixed' }, route } }));
  assert.equal(result.text, 'КАСКО бар, осмотр нужен');
  assert.equal(result.language, 'mixed');
  assert.equal(result.route.scenarios[0].scenario_id, 'SC13');
  assert.equal(result.route.active_scenario, 'SC20');
  assert.equal(result.reply, '');
  assert.equal(result.status, 'interrupted');
  const [stringTranscript] = restoreTurns([], snapshot({ last_trace: { transcript: 'Сохранённая реплика', route } }));
  assert.equal(stringTranscript.text, 'Сохранённая реплика');
  assert.equal(stringTranscript.language, 'mixed');
});

test('malformed snapshot metadata never fabricates transcript or primary classification', () => {
  for (const transcript of [{ text: { secret: true }, language: 'ru' }, { text: 'No valid language', language: 'en' }, [], 123]) {
    const [result] = restoreTurns([], snapshot({ last_trace: { transcript, route: { scenarios: ['SC13'], alternatives: [], language: 'ru' } } }));
    assert.equal(result.text, '');
    assert.deepEqual(result.route.scenarios, []);
    assert.equal(result.route.active_scenario, 'SC13');
  }
});

test('snapshot updates and clears active scenario while preserving local primary classification', () => {
  const local = { ...turn(), route: { scenarios: [{ scenario_id: 'SC13' }], alternatives: [], language: 'ru', active_scenario: 'SC13' } };
  const [changed] = restoreTurns([local], snapshot({ active_scenario: 'SC20' }));
  assert.equal(changed.route.scenarios[0].scenario_id, 'SC13');
  assert.equal(changed.route.active_scenario, 'SC20');
  const [cleared] = restoreTurns([changed], snapshot({ active_scenario: null }));
  assert.equal(cleared.route.active_scenario, null);
  assert.equal(cleared.route.scenarios[0].scenario_id, 'SC13');
});

test('empty snapshot does not create a fictional turn', () => {
  assert.deepEqual(restoreTurns([], snapshot({ last_turn_id: null, last_trace: null, active_scenario: null }), 1), []);
});

test('late confirmation snapshot from an earlier turn or seq cannot overwrite current state', () => {
  assert.equal(isCurrentSnapshot(snapshot(), 'turn-2', 15), false);
  assert.equal(isCurrentSnapshot(snapshot(), 'turn-1', 13), false);
  assert.equal(isCurrentSnapshot(snapshot(), 'turn-1', 12), true);
});

test('display masking covers IIN before phone matching and formatted phone and email', () => {
  assert.equal(maskPersonalData('ИИН 870101300123'), 'ИИН ************');
  const result = maskPersonalData('+7 (701) 123-45-67, 87011234567, user@example.kz');
  assert.ok(!result.includes('123-45-67'));
  assert.ok(!result.includes('87011234567'));
  assert.ok(!result.includes('user@'));
  assert.ok(result.includes('u***@example.kz'));
});
