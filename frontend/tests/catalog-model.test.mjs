import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateCatalog, parseCatalog, replaceCatalogEntry, createScenario, removeScenario, restoreCatalogDraft, serializeCatalog, MAX_CATALOG_BYTES } from '../src/catalog-model.ts';

const data = name => JSON.parse(readFileSync(new URL(`../../datas/${name}.json`, import.meta.url), 'utf8'));
const baseline = data('scenarios');
const refs = { actions: data('actions').actions, slots: data('slots').slots, queues: data('actions').queues, requiredScenarioIds: baseline.scenarios.map(s => s.scenario_id), requiredSystemIds: baseline.system_intents.map(s => s.id) };
const copy = () => structuredClone(baseline);

test('the supplied full catalog passes validation and roundtrips metadata and system intents', () => {
  assert.deepEqual(validateCatalog(baseline, refs), []);
  const restored = parseCatalog(serializeCatalog(baseline), refs);
  assert.deepEqual(restored, baseline);
  assert.equal(restored.scenarios.length, 40);
  assert.equal(restored.system_intents.length, 3);
});
test('duplicate scenario IDs and slugs, missing baseline entries, and unknown actions are rejected', () => {
  const value = copy(); value.scenarios[0].scenario_id = 'SC02'; value.scenarios[0].slug = value.scenarios[1].slug; value.scenarios[0].actions.push('execute_anything');
  const errors = validateCatalog(value, refs);
  for (const code of ['duplicate_id', 'duplicate_slug', 'required_scenario', 'unknown_action']) assert.ok(errors.some(e => e.code === code), code);
});
test('slot, routing exclusion, and handoff references are validated', () => {
  const value = copy(); value.scenarios[0].slots.required.push('made_up'); value.scenarios[0].not_this_if[0].use_instead = 'SC404'; value.scenarios[0].handoff = { when: 'always', queue: 'fake_queue' };
  const codes = validateCatalog(value, refs).map(e => e.code);
  for (const code of ['unknown_slot', 'unknown_scenario', 'unknown_queue']) assert.ok(codes.includes(code), code);
});
test('irreversible actions cannot disable confirmation', () => {
  const value = copy(); value.scenarios.find(s => s.actions.includes('create_policy')).requires_confirmation = false;
  assert.ok(validateCatalog(value, refs).some(e => e.code === 'confirmation_required'));
});
test('malformed localized responses, flags, priority and slot overlap are rejected without crashing', () => {
  const value = copy(); value.scenarios[0].responses.kk = null; value.scenarios[0].fast_path_eligible = 'yes'; value.scenarios[0].priority = 'critical'; value.scenarios[0].slots.optional.push('region');
  assert.ok(validateCatalog(value, refs).length >= 4);
  for (const malformed of [null, [], {}, { scenarios: [null], system_intents: [] }]) assert.ok(validateCatalog(malformed, refs).length > 0);
});
test('imports reject invalid JSON, oversized content, dangerous keys and missing system intents', () => {
  assert.throws(() => parseCatalog('{', refs));
  assert.throws(() => parseCatalog(' '.repeat(MAX_CATALOG_BYTES + 1), refs));
  assert.throws(() => parseCatalog('{"__proto__":{}}', refs));
  const value = copy(); value.system_intents = [];
  assert.throws(() => parseCatalog(JSON.stringify(value), refs));
});
test('entry replacement validates the complete catalog without changing the previous snapshot', () => {
  const entry = { ...baseline.scenarios[0], name: 'Новый заголовок' };
  const updated = replaceCatalogEntry(baseline, 'SC01', entry, refs);
  assert.equal(updated.scenarios[0].name, entry.name);
  assert.notEqual(baseline.scenarios[0].name, entry.name);
  assert.throws(() => replaceCatalogEntry(baseline, 'SC01', { ...entry, scenario_id: 'SC99' }, refs));
  const system = { ...baseline.system_intents[0], behavior: 'New behavior' };
  assert.equal(replaceCatalogEntry(baseline, system.id, system, refs).system_intents[0].behavior, 'New behavior');
});
test('new custom scenarios have valid bilingual defaults and unique IDs and can be deleted', () => {
  const added = createScenario(baseline, refs);
  assert.equal(added.scenarios.length, 41);
  assert.equal(added.scenarios.at(-1).scenario_id, 'CUSTOM_01');
  const twice = createScenario(added, refs);
  assert.equal(twice.scenarios.at(-1).scenario_id, 'CUSTOM_02');
  assert.deepEqual(validateCatalog(twice, refs), []);
  assert.deepEqual(removeScenario(added, 'CUSTOM_01', refs), baseline);
});
test('required and referenced scenarios cannot be deleted', () => {
  assert.throws(() => removeScenario(baseline, 'SC01', refs));
  const value = createScenario(baseline, refs); value.scenarios[0].not_this_if.push({ condition: 'custom', use_instead: 'CUSTOM_01' });
  assert.throws(() => removeScenario(value, 'CUSTOM_01', refs));
});
test('invalid persisted drafts recover to a deep-cloned baseline with a recovery signal', () => {
  const restored = restoreCatalogDraft('{bad', baseline, refs);
  assert.equal(restored.recovered, true);
  assert.deepEqual(restored.catalog, baseline);
  restored.catalog.scenarios[0].name = 'changed';
  assert.notEqual(baseline.scenarios[0].name, 'changed');
  assert.equal(restoreCatalogDraft(null, baseline, refs).recovered, false);
  assert.equal(restoreCatalogDraft(serializeCatalog(baseline), baseline, refs).recovered, false);
});

test('displayed metadata must be bounded strings and cannot invoke imported coercion properties', () => {
  for (const key of ['dataset', 'version', 'as_of_date']) {
    const value = copy(); value.meta[key] = { toString: 'not-a-function' };
    assert.ok(validateCatalog(value, refs).some(issue => issue.path === `meta.${key}`));
    assert.throws(() => parseCatalog(JSON.stringify(value), refs));
  }
  const oversized = copy(); oversized.meta.version = 'x'.repeat(65);
  assert.ok(validateCatalog(oversized, refs).some(issue => issue.path === 'meta.version'));
  const badDate = copy(); badDate.meta.as_of_date = '2026-13-40';
  assert.ok(validateCatalog(badDate, refs).some(issue => issue.path === 'meta.as_of_date'));
  const extension = copy(); extension.meta.extension = { description: 'Preserve custom metadata' };
  assert.deepEqual(parseCatalog(serializeCatalog(extension), refs).meta.extension, extension.meta.extension);
});

test('malformed priority with hostile coercion property is rejected without throwing', () => {
  const value = copy(); value.scenarios[0].priority = { toString: 'not-a-function' };
  assert.ok(validateCatalog(value, refs).some(issue => issue.path === 'scenarios[0].priority'));
});
