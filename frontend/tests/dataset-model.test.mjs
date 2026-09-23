import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDialogDataset, getClientSteps, compareDatasetTurn, getDatasetResults,
  isDatasetTurnTerminal, redactDatasetValue, serializeDatasetRun, nextReferenceCount,
} from '../src/dataset-model.ts';

const raw = JSON.parse(readFileSync(new URL('../../datas/dialogs_sample.json', import.meta.url), 'utf8'));
const turn = (overrides = {}) => ({ id: 'turn-1', mode: 'text', text: 'Добрый день', reply: 'Здравствуйте', language: 'ru', replyLanguage: 'ru', status: 'answered', route: { scenarios: [{ scenario_id: 'SC01' }], alternatives: [], language: 'ru' }, trace: null, preview: null, at: 1, ...overrides });

test('all 10 supplied dialogs preserve every labeled client and reference bot turn', () => {
  const dataset = parseDialogDataset(raw);
  assert.equal(dataset.dialogs.length, 10);
  assert.equal(dataset.dialogs.reduce((sum, dialog) => sum + dialog.turns.length, 0), 80);
  assert.equal(dataset.dialogs.reduce((sum, dialog) => sum + getClientSteps(dialog).length, 0), 40);
  assert.deepEqual(dataset.dialogs.map(dialog => dialog.dialog_id), raw.dialogs.map(dialog => dialog.dialog_id));
});

test('client steps never select a bot reply for API transmission', () => {
  const [dialog] = parseDialogDataset(raw).dialogs;
  const steps = getClientSteps(dialog);
  assert.deepEqual(steps.map(step => step.sourceIndex), [0, 2, 4, 6, 8, 10]);
  assert.ok(steps.every(step => step.client.role === 'client' && step.referenceReplies.every(reply => reply.role === 'bot')));
  assert.equal(steps[0].referenceReplies[0].text, dialog.turns[1].text);
});

test('a preview followed by execution marks the next client step as explicit confirmation', () => {
  const dataset = parseDialogDataset(raw);
  const steps = getClientSteps(dataset.dialogs[0]);
  assert.equal(steps[4].requiresReview, false);
  assert.equal(steps[5].requiresReview, true);
  const cancellation = getClientSteps(dataset.dialogs.find(dialog => dialog.dialog_id === 'D07'));
  assert.equal(cancellation.at(-1).requiresReview, true);
});

test('mixed language and ordered multi-intent labels are preserved', () => {
  const dialog = parseDialogDataset(raw).dialogs.find(item => item.dialog_id === 'D04');
  const step = getClientSteps(dialog)[2];
  assert.equal(step.client.lang, 'mixed');
  assert.deepEqual(step.client.scenarios, ['SC21', 'SC22']);
});

test('malformed role, missing labels, duplicate IDs and unsupported language are rejected', () => {
  for (const mutate of [
    data => { data.dialogs[0].turns[0].role = 'system'; },
    data => { delete data.dialogs[0].turns[0].scenarios; },
    data => { data.dialogs[1].dialog_id = data.dialogs[0].dialog_id; },
    data => { data.dialogs[0].turns[0].lang = 'en'; },
  ]) {
    const bad = structuredClone(raw); mutate(bad);
    assert.throws(() => parseDialogDataset(bad));
  }
});

test('primary accuracy is order-sensitive while exact match compares scenario sets', () => {
  const result = compareDatasetTurn(['SC01', 'SC02'], turn({ route: { scenarios: [{ scenario_id: 'SC02' }, { scenario_id: 'SC01' }], alternatives: [], language: 'ru' } }));
  assert.equal(result.primaryMatch, false);
  assert.equal(result.exactMatch, true);
  assert.equal(result.recall, 1);
});

test('wrong and incomplete multi-intent routes are not counted as exact matches', () => {
  const result = compareDatasetTurn(['SC01', 'SC02'], turn());
  assert.equal(result.primaryMatch, true);
  assert.equal(result.exactMatch, false);
  assert.equal(result.recall, 0.5);
});

test('pending or interrupted replies never claim completed evaluation', () => {
  for (const status of ['draft', 'processing', 'interrupted']) {
    assert.equal(compareDatasetTurn(['SC01'], turn({ status })), null);
  }
  assert.equal(isDatasetTurnTerminal(turn({ status: 'processing' })), false);
  assert.equal(isDatasetTurnTerminal(turn({ status: 'error' })), true);
});

test('terminal errors without a route count as failed routing, not absent samples', () => {
  const result = compareDatasetTurn(['SC01'], turn({ status: 'error', route: null }));
  assert.equal(result.exactMatch, false);
  assert.deepEqual(result.predicted, []);
});

test('result association uses explicit IDs, never matching text or array position', () => {
  const dialog = parseDialogDataset(raw).dialogs[0];
  const result = getDatasetResults(dialog, [{ sourceIndex: 0, turnId: 'correct-id' }], [turn({ id: 'unrelated-id' }), turn({ id: 'correct-id', route: null, status: 'processing' })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].turn.id, 'correct-id');
  assert.equal(result[0].comparison, null);
});

test('missing and restored IDs cannot inherit fabricated live results', () => {
  const dialog = parseDialogDataset(raw).dialogs[0];
  const result = getDatasetResults(dialog, [{ sourceIndex: 0, turnId: 'turn-1' }], [turn({ restored: true })]);
  assert.equal(result[0].turn, null);
  assert.equal(result[0].comparison, null);
});

test('invalid or bot source indexes cannot become scored dataset rows', () => {
  const dialog = parseDialogDataset(raw).dialogs[0];
  const result = getDatasetResults(dialog, [{ sourceIndex: 1, turnId: 'turn-1' }, { sourceIndex: 300, turnId: 'turn-1' }], [turn()]);
  assert.deepEqual(result, []);
});

test('reference playback clamps at the last turn and cannot run API work', () => {
  assert.equal(nextReferenceCount(0, 12), 1);
  assert.equal(nextReferenceCount(11, 12), 12);
  assert.equal(nextReferenceCount(12, 12), 12);
  assert.equal(nextReferenceCount(-3, 12), 1);
  assert.equal(nextReferenceCount(0, 0), 0);
});

test('reference redaction includes nested slots, policy, plate, keyed IIN and credentials', () => {
  const safe = JSON.stringify(redactDatasetValue({
    text: 'ИИН 910512300456, авто 482KMA02, полис SQ-OGPO-104901, +77071234567',
    slots: { vehicle_plate: '482KMA02', drivers_iin: ['910512300456'] },
    result: { '910512300456': '3', policy_number: 'SQ-OGPO-104901' },
    api_key: 'secret-not-for-export',
  }));
  for (const value of ['910512300456', '482KMA02', 'SQ-OGPO-104901', '+77071234567', 'secret-not-for-export']) assert.equal(safe.includes(value), false);
});

test('run export contains exact labels, explicit IDs and safe real results only', () => {
  const dialog = parseDialogDataset(raw).dialogs[0];
  const exported = JSON.parse(serializeDatasetRun(dialog, [{ sourceIndex: 0, turnId: 'turn-1' }], [turn({ text: 'ИИН 910512300456', trace: { debug: 'secret-diagnostic' } })]));
  assert.equal(exported.schema, 'voice-router.dataset-run.v1');
  assert.equal(exported.dialog_id, 'D01');
  assert.equal(exported.results[0].turn_id, 'turn-1');
  assert.deepEqual(exported.results[0].expected, ['SC01']);
  assert.deepEqual(exported.results[0].predicted, ['SC01']);
  assert.equal(JSON.stringify(exported).includes('910512300456'), false);
  assert.equal(JSON.stringify(exported).includes('secret-diagnostic'), false);
});
