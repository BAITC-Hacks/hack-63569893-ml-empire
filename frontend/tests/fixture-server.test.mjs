import assert from 'node:assert/strict';
import test from 'node:test';
import { createSession, sessionSnapshot, textTurn } from './fixture-server.mjs';

test('fixture creates a safe pending preview and contract snapshot for a text turn', () => {
  const session = createSession();
  const result = textTurn(session, 'turn-a', 'Проверка КАСКО');
  assert.deepEqual(result.events.map((event) => event.type), [
    'transcript.final', 'route.decision', 'action.preview', 'agent.text', 'error', 'trace.updated', 'turn.complete',
  ]);
  const route = result.events.find((event) => event.type === 'route.decision').payload;
  assert.deepEqual(route.scenarios.map((scenario) => scenario.scenario_id), ['SC13', 'SC20']);
  assert.match(result.events.find((event) => event.type === 'agent.text').payload.text, /^\[Тестовый сервер\]/);
  assert.equal(result.events.at(-1).payload.status, 'clarify');
  const snapshot = sessionSnapshot(session);
  assert.equal(snapshot.last_turn_id, 'turn-a');
  assert.equal(snapshot.last_seq, 7);
  assert.match(snapshot.pending_confirmation.summary, /синтетическ/i);
  assert.deepEqual(snapshot.last_trace.actions, ['fixture_create_claim:preview']);
});

for (const text of ['Да, подтверждаю', 'Иә, растаймын']) {
  test(`fixture confirmation clears pending exactly once: ${text}`, () => {
    const session = createSession();
    textTurn(session, 'preview', 'Тест');
    const result = textTurn(session, 'confirm', text);
    assert.equal(sessionSnapshot(session).pending_confirmation, null);
    assert.equal(result.events.at(-1).payload.status, 'answered');
    assert.deepEqual(sessionSnapshot(session).last_trace.actions, ['fixture_create_claim:execute']);
    assert.deepEqual(textTurn(session, 'confirm', text).events, []);
  });
}

test('fixture rejects without execution and does not accept unsolicited confirmation', () => {
  const session = createSession();
  textTurn(session, 'preview', 'Тест');
  textTurn(session, 'reject', 'Нет, отказываюсь');
  assert.equal(sessionSnapshot(session).pending_confirmation, null);
  assert.deepEqual(sessionSnapshot(session).last_trace.actions, ['fixture_create_claim:cancelled']);
  textTurn(session, 'unsolicited', 'Да, подтверждаю');
  assert.deepEqual(sessionSnapshot(session).last_trace.actions, []);
});

test('disconnect fixture interrupts only once while retaining pending confirmation', () => {
  const session = createSession();
  textTurn(session, 'preview', 'Тест');
  const pending = sessionSnapshot(session).pending_confirmation;
  const first = textTurn(session, 'disconnect', '/disconnect');
  assert.equal(first.disconnect, true);
  assert.ok(!first.events.some((event) => event.type === 'turn.complete'));
  assert.deepEqual(sessionSnapshot(session).pending_confirmation, pending);
  assert.equal(sessionSnapshot(session).last_turn_id, 'disconnect');
  assert.equal(textTurn(session, 'second-disconnect', '/disconnect').disconnect, false);
});

test('handoff fixture exposes context and a truthful received status without a live operator', () => {
  const session = createSession();
  const result = textTurn(session, 'handoff', '/handoff');
  const trace = sessionSnapshot(session).last_trace;
  assert.equal(result.events.at(-1).payload.status, 'handoff');
  assert.equal(trace.handoff.status, 'context_received');
  assert.equal(trace.handoff.queue, 'fixture_claims');
  assert.match(trace.handoff.reason, /тест/i);
  assert.match(trace.handoff.context.summary, /синтетическ/i);
  assert.equal(session.pending_confirmation, null);
});

test('structured slots and actions remain synthetic and do not execute a pending action', () => {
  const session = createSession();
  const result = textTurn(session, 'slots', '/slots');
  const route = result.events.find((item) => item.type === 'route.decision').payload;
  assert.equal(route.slots.phone.status, 'from_profile');
  assert.equal(route.slots.policy_number.status, 'confirmed');
  assert.equal(route.slots.inspection_date.status, 'missing');
  assert.equal(route.slots.email.status, 'invalid');
  assert.equal(route.slots.insurance_type.status, 'found');
  assert.ok(session.last_trace.actions.some((action) => action.mode === 'preview' && action.status === 'awaiting_confirmation'));
  assert.ok(session.pending_confirmation);
});

test('error fixture transports a synthetic unsafe diagnostic to test safe client mapping', () => {
  const session = createSession();
  const result = textTurn(session, 'error', '/error');
  const diagnostic = result.events.find((item) => item.type === 'error').payload;
  assert.equal(diagnostic.code, 'router_unavailable');
  assert.match(diagnostic.message, /DO_NOT_DISPLAY_FIXTURE_DIAGNOSTIC/);
  assert.equal(result.events.at(-1).payload.status, 'error');
  assert.deepEqual(session.last_trace.actions, []);
  assert.equal(session.pending_confirmation, null);
});

test('mixed fixture preserves mixed transcript and route language', () => {
  const session = createSession();
  const result = textTurn(session, 'mixed', '/mixed');
  assert.equal(result.events.find((item) => item.type === 'transcript.final').payload.language, 'mixed');
  assert.equal(result.events.find((item) => item.type === 'route.decision').payload.language, 'mixed');
  assert.equal(session.last_trace.language, 'mixed');
});

test('partial timing events retain a complete authoritative snapshot', () => {
  const session = createSession();
  const result = textTurn(session, 'timings', '/partial-metrics');
  const patches = result.events.filter((item) => item.type === 'trace.updated').map((item) => item.payload);
  assert.equal(patches.length, 2);
  assert.equal(patches[0].latency_ms.router, 40);
  assert.deepEqual(patches[1].latency_ms, { response: 8, total: 53 });
  assert.deepEqual(session.last_trace.latency_ms, { stt: 0, triage: 5, router: 40, response: 8, tts_first_audio: 0, total: 53 });
});

test('context fixture distinguishes selected primary, active, queued and suspended scenarios', () => {
  const session = createSession();
  const result = textTurn(session, 'context', '/context');
  const route = result.events.find((item) => item.type === 'route.decision').payload;
  assert.equal(route.scenarios[0].scenario_id, 'SC13');
  assert.equal(route.active_scenario, 'SC11');
  assert.deepEqual(route.pending_scenarios, ['SC20']);
  assert.deepEqual(route.suspended_scenarios, ['SC13']);
  assert.equal(sessionSnapshot(session).active_scenario, 'SC11');
});

test('audio fixture emits PCM between audio.start/end and labels it as a non-TTS tone', () => {
  const session = createSession();
  const result = textTurn(session, 'tone', '/audio');
  const start = result.events.findIndex((item) => item.type === 'audio.start');
  const end = result.events.findIndex((item) => item.type === 'audio.end');
  assert.ok(start > 0 && end > start);
  assert.ok(result.events.slice(start + 1, end).every((item) => Buffer.isBuffer(item)));
  assert.equal(result.events.slice(start + 1, end).reduce((sum, item) => sum + item.length, 0), 14400);
  assert.match(result.events.find((item) => item.type === 'agent.text').payload.text, /не TTS/i);
  assert.ok(!result.events.some((item) => item.type === 'error'));
  const sequence = result.events.filter((item) => !Buffer.isBuffer(item)).map((item) => item.seq);
  assert.deepEqual(sequence, Array.from({ length: sequence.length }, (_, index) => index + 1));
});
