import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getScenarioView, getSlots, getActions, getHandoff, getSessionMetrics,
  filterTurns, serializeTrace, maskTraceValue,
} from '../src/supervisor-model.ts';

const turn = (overrides = {}) => ({ id: 'turn-1', mode: 'audio', text: 'Вопрос', reply: '', language: 'ru', replyLanguage: null, status: 'answered', route: null, trace: null, preview: null, at: 1, ...overrides });
const catalog = [{ scenario_id: 'SC01', name: 'Первый', priority: 'normal' }, { scenario_id: 'SC02', name: 'Второй', priority: 'urgent' }];

test('active scenario is explicit and never inferred from the primary route', () => {
  const result = getScenarioView(turn({ route: { scenarios: [{ scenario_id: 'SC01' }, { scenario_id: 'SC02' }], active_scenario: 'SC02', language: 'ru', alternatives: [] } }), catalog);
  assert.equal(result.primary.scenario_id, 'SC01');
  assert.equal(result.active.scenario_id, 'SC02');
  assert.equal(result.active.priority, 'urgent');
  assert.equal(result.additional[0].scenario_id, 'SC02');
  assert.equal(getScenarioView(turn({ route: { scenarios: [{ scenario_id: 'SC01' }] } }), catalog).active, null);
});

test('queue and suspended scenarios preserve server order and distinguish absent from empty', () => {
  const result = getScenarioView(turn({ route: { scenarios: [], pending_scenarios: ['SC01', 'SC02'], suspended_scenarios: [], active_scenario: null } }), catalog);
  assert.deepEqual(result.pending.map(item => item.scenario_id), ['SC01', 'SC02']);
  assert.equal(result.pendingKnown, true);
  assert.equal(result.suspendedKnown, true);
  assert.equal(result.activeKnown, true);
  assert.equal(getScenarioView(turn(), catalog).pendingKnown, false);
});

test('malformed optional scenario details cannot crash normalization', () => {
  const result = getScenarioView(turn({ route: { scenarios: [null, {}, 7, 'SC01'], alternatives: [false], active_scenario: { scenario_id: 8 } }, trace: { pending_scenarios: ['SC02'] } }), catalog);
  assert.equal(result.primary.scenario_id, 'SC01');
  assert.deepEqual(result.alternatives, []);
  assert.equal(result.pending[0].scenario_id, 'SC02');
  assert.equal(result.active, null);
});

test('slot metadata is rendered only when supplied, not guessed from values or null', () => {
  const result = getSlots({ phone: { value: '+77011234567', status: 'confirmed', source: 'profile', scenario_id: 'SC01' }, policy: null, type: 'КАСКО' });
  assert.equal(result[0].status, 'confirmed');
  assert.equal(result[0].source, 'profile');
  assert.equal(result[0].scenarioId, 'SC01');
  assert.equal(result[1].status, null);
  assert.equal(result[2].status, null);
  assert.equal(getSlots({ location: { city: 'Алматы' } })[0].value.city, 'Алматы');
});

test('structured slot arrays retain names and ignore invalid entries', () => {
  const slots = getSlots([{ name: 'iin', value: '870101300123', status: 'invalid' }, null, { source: 'profile' }]);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].name, 'iin');
  assert.equal(slots[0].status, 'invalid');
});

test('execute action mode never implies completed; plain names never imply success', () => {
  const result = getActions(['find_client', 'create_claim:preview', 'update:execute', 'identify:requested', { name: 'save', mode: 'execute', status: 'failed', error: { code: 'denied' } }]);
  assert.equal(result[0].status, null);
  assert.equal(result[1].mode, 'preview');
  assert.equal(result[1].status, null);
  assert.equal(result[2].mode, 'execute');
  assert.equal(result[2].status, null);
  assert.equal(result[3].status, 'requested');
  assert.equal(result[4].status, 'failed');
});

test('an action.preview is explicitly awaiting confirmation without claiming execution', () => {
  const result = getActions([], { name: 'save', summary: 'Сохранить?', masked_args: { phone: '+7 ***' } });
  assert.equal(result[0].status, 'awaiting_confirmation');
  assert.equal(result[0].mode, 'preview');
  assert.equal(result[0].summary, 'Сохранить?');
});

test('safe preview enriches an existing preview without duplicating the action', () => {
  const preview = { name: 'save', summary: 'Сохранить?', masked_args: { phone: '+7 ***' } };
  const actions = getActions(['save:preview'], preview);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, 'awaiting_confirmation');
  assert.equal(actions[0].summary, preview.summary);
  assert.deepEqual(actions[0].args, preview.masked_args);
});

test('safe preview does not erase executed or completed history with the same name', () => {
  const preview = { name: 'save', summary: 'Сохранить снова?' };
  const actions = getActions([{ name: 'save', mode: 'execute', status: 'completed' }, { name: 'save', mode: 'preview', status: 'completed' }], preview);
  assert.equal(actions.length, 3);
  assert.equal(actions[0].status, 'completed');
  assert.equal(actions[1].status, 'completed');
  assert.equal(actions[2].status, 'awaiting_confirmation');
});

test('explicit awaiting confirmation can receive safe preview arguments without a duplicate', () => {
  const actions = getActions([{ name: 'save', status: 'awaiting_confirmation' }], { name: 'save', summary: 'Сохранить?', masked_args: { policy_number: '***' } });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].mode, 'preview');
  assert.equal(actions[0].status, 'awaiting_confirmation');
});

test('handoff does not invent an operator connection or queue', () => {
  assert.equal(getHandoff(null), null);
  const handoff = getHandoff({ reason: 'Нужна помощь', context: { summary: 'КАСКО', phone: '+77011234567' }, status: 'requested' });
  assert.equal(handoff.reason, 'Нужна помощь');
  assert.equal(handoff.queue, null);
  assert.equal(handoff.status, 'requested');
  assert.deepEqual(handoff.context, { summary: 'КАСКО', phone: '+77011234567' });
});

test('session metrics separate real voice playback, text playback and server timing', () => {
  const metrics = getSessionMetrics([
    turn({ trace: { client_first_audio_ms: 100, latency_ms: { total: 50, router: 10 } } }),
    turn({ id: '2', trace: { client_first_audio_ms: 300, latency_ms: { total: 90, router: 20 } } }),
    turn({ id: '3', mode: 'text', trace: { client_first_audio_ms: 900, latency_ms: { total: 200 } } }),
    turn({ id: '4', trace: { client_first_audio_ms: null, latency_ms: { total: NaN, router: -2 } } }),
  ]);
  assert.deepEqual(metrics.voiceFirstAudio, { median: 200, count: 2 });
  assert.deepEqual(metrics.textFirstAudio, { median: 900, count: 1 });
  assert.deepEqual(metrics.serverTotal, { median: 90, count: 3 });
  assert.deepEqual(metrics.router, { median: 15, count: 2 });
  assert.deepEqual(getSessionMetrics([]).voiceFirstAudio, { median: null, count: 0 });
});

test('zero milliseconds is a received value, not missing data', () => {
  assert.deepEqual(getSessionMetrics([turn({ trace: { latency_ms: { router: 0 }, client_first_audio_ms: 0 } })]).router, { median: 0, count: 1 });
});

test('filters combine language, scenario and status and include explicit active scenarios', () => {
  const turns = [turn({ route: { scenarios: [{ scenario_id: 'SC01' }], active_scenario: 'SC02', language: 'mixed' } }), turn({ id: '2', language: 'kk', status: 'clarify' })];
  assert.equal(filterTurns(turns, { language: 'mixed', scenario: 'SC02', status: 'answered' }).length, 1);
  assert.equal(filterTurns(turns, { language: 'kk', scenario: '', status: 'clarify' })[0].id, '2');
  assert.deepEqual(filterTurns(turns, { language: 'ru', scenario: '', status: '' }), []);
});

test('trace exports mask known personal data recursively and omit secrets and internal prompts', () => {
  const value = turn({ text: 'ИИН 870101300123, +7 (701) 123-45-67, test@example.kz', route: { scenarios: [], slots: { full_name: 'Тест Клиент', nested: { phone: 77011234567, account_number: 'KZ1234567', authorization: 'Bearer secret' } } }, trace: { actions: [{ name: 'save', arguments: { password: 'private', email: 'test@example.kz' } }], latency_ms: { total: 100 }, system_prompt: 'private instructions', stack: 'internal' } });
  const serialized = serializeTrace(value);
  assert.ok(!serialized.includes('870101300123'));
  assert.ok(!serialized.includes('123-45-67'));
  assert.ok(!serialized.includes('test@example.kz'));
  assert.ok(!serialized.includes('Тест Клиент'));
  assert.ok(!serialized.includes('private'));
  assert.ok(!serialized.includes('Bearer secret'));
  assert.ok(!serialized.includes('KZ1234567'));
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.trace.latency_ms.total, 100);
  assert.equal(parsed.turn_id, 'turn-1');
  assert.equal(parsed.trace.system_prompt, undefined);
});

test('safe export handles circular and invalid optional values without executing them', () => {
  const cyclic = { phone: '+77011234567' }; cyclic.self = cyclic;
  assert.doesNotThrow(() => maskTraceValue(cyclic));
  assert.equal(maskTraceValue({ password: 'x', normal: Infinity }).normal, null);
  assert.equal(maskTraceValue({ password: 'x' }).password, undefined);
});

test('numeric IIN and camelCase personal fields are masked even without a familiar slot shape', () => {
  assert.equal(maskTraceValue(870101300123), '************');
  const safe = maskTraceValue({ fullName: 'Тест Клиент', policyNumber: 'ABC123', arbitrary: 870101300123, apiKey: 'secret' });
  assert.ok(!JSON.stringify(safe).includes('Тест Клиент'));
  assert.ok(!JSON.stringify(safe).includes('ABC123'));
  assert.equal(safe.apiKey, undefined);
});

test('export omits nested raw error diagnostics while keeping explicit action status', () => {
  const safe = JSON.parse(serializeTrace(turn({ trace: { actions: [{ name: 'save', status: 'failed', error: 'Traceback internal prompt', errorCode: 'action_failed' }] } })));
  assert.equal(safe.trace.actions[0].error, undefined);
  assert.equal(safe.trace.actions[0].status, 'failed');
});

test('array-form slot values use their slot name for redaction and preserve metadata', () => {
  const safe = maskTraceValue([{ name: 'full_name', value: 'Тест Клиент', source: 'profile', status: 'confirmed' }, { name: 'policy_number', value: 'A123' }]);
  assert.notEqual(safe[0].value, 'Тест Клиент');
  assert.notEqual(safe[1].value, 'A123');
  assert.equal(safe[0].status, 'confirmed');
  assert.equal(safe[0].source, 'profile');
});

test('numeric phone values under unknown keys receive the same masking as text', () => {
  assert.notEqual(maskTraceValue({ number: 77011234567 }).number, 77011234567);
});
