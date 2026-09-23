export type CatalogScenario = {
  scenario_id: string; slug: string; name: string; domain: string; category: string; description: string;
  priority: 'normal' | 'high' | 'urgent'; fast_path_eligible: boolean; requires_identification: boolean;
  not_this_if: Array<{ condition: string; use_instead: string }>;
  slots: { required: string[]; optional: string[] }; actions: string[]; requires_confirmation: boolean;
  handoff: { when: string; queue: string } | null;
  examples: { ru: string[]; kk: string[] };
  responses: { ru: { opening: string; closing: string }; kk: { opening: string; closing: string } };
  [key: string]: unknown;
};
export type SystemIntent = { id: string; description: string; behavior: string; response: { ru: string; kk: string }; [key: string]: unknown };
export type CatalogDocument = { meta: Record<string, unknown>; scenarios: CatalogScenario[]; system_intents: SystemIntent[]; [key: string]: unknown };
export type CatalogReferences = {
  actions: Array<{ name: string; irreversible: boolean }>; slots: Array<{ name: string }>; queues: string[];
  requiredScenarioIds: string[]; requiredSystemIds: string[];
};
export type CatalogIssue = { path: string; code: string };
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export const CATALOG_STORAGE_KEY = 'voice-router.catalog-draft.v1';
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 16000;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value);

function safeTree(value: unknown, depth = 0): boolean {
  if (depth > 30) return false;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => safeTree(item, depth + 1));
  if (record(value)) return Object.entries(value).every(([key, item]) => !['__proto__', 'prototype', 'constructor'].includes(key) && safeTree(item, depth + 1));
  return value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

export function validateCatalog(value: unknown, refs: CatalogReferences): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const add = (path: string, code = 'invalid_field') => issues.push({ path, code });
  if (!record(value) || !safeTree(value)) return [{ path: '$', code: 'invalid_document' }];
  if (!record(value.meta)) add('meta');
  else {
    if (!text(value.meta.dataset) || value.meta.dataset.length > 256) add('meta.dataset');
    if (!text(value.meta.version) || value.meta.version.length > 64) add('meta.version');
    const date = value.meta.as_of_date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) add('meta.as_of_date');
  }
  if (!Array.isArray(value.scenarios) || !Array.isArray(value.system_intents)) return [...issues, { path: '$', code: 'invalid_document' }];
  const allIds = new Set<string>(); const slugs = new Set<string>();
  const actionNames = new Set(refs.actions.map(action => action.name));
  const irreversible = new Set(refs.actions.filter(action => action.irreversible).map(action => action.name));
  const slotNames = new Set(refs.slots.map(slot => slot.name));
  const scenarioIds = new Set(value.scenarios.filter(record).map(scenario => scenario.scenario_id));
  const systemIds = new Set(value.system_intents.filter(record).map(intent => intent.id));
  for (const id of refs.requiredScenarioIds) if (!scenarioIds.has(id)) add(`scenarios.${id}`, 'required_scenario');
  for (const id of refs.requiredSystemIds) if (!systemIds.has(id)) add(`system_intents.${id}`, 'required_system');
  for (const [index, scenario] of value.scenarios.entries()) {
    const prefix = `scenarios[${index}]`;
    if (!record(scenario)) { add(prefix); continue; }
    if (!identifier(scenario.scenario_id)) add(`${prefix}.scenario_id`);
    else { if (allIds.has(scenario.scenario_id)) add(`${prefix}.scenario_id`, 'duplicate_id'); allIds.add(scenario.scenario_id); }
    if (typeof scenario.slug !== 'string' || !/^[a-z][a-z0-9_]{1,95}$/.test(scenario.slug)) add(`${prefix}.slug`);
    else { if (slugs.has(scenario.slug)) add(`${prefix}.slug`, 'duplicate_slug'); slugs.add(scenario.slug); }
    for (const key of ['name', 'domain', 'category', 'description']) if (!text(scenario[key])) add(`${prefix}.${key}`);
    if (typeof scenario.priority !== 'string' || !['normal', 'high', 'urgent'].includes(scenario.priority)) add(`${prefix}.priority`);
    for (const key of ['fast_path_eligible', 'requires_identification', 'requires_confirmation']) if (typeof scenario[key] !== 'boolean') add(`${prefix}.${key}`);
    if (!strings(scenario.actions)) add(`${prefix}.actions`);
    else {
      if (new Set(scenario.actions).size !== scenario.actions.length) add(`${prefix}.actions`, 'duplicate_reference');
      for (const action of scenario.actions) if (!actionNames.has(action)) add(`${prefix}.actions.${action}`, 'unknown_action');
      if (scenario.actions.some(action => irreversible.has(action)) && scenario.requires_confirmation !== true) add(`${prefix}.requires_confirmation`, 'confirmation_required');
    }
    if (!record(scenario.slots) || !strings(scenario.slots.required) || !strings(scenario.slots.optional)) add(`${prefix}.slots`);
    else {
      const slots = [...scenario.slots.required, ...scenario.slots.optional];
      if (new Set(slots).size !== slots.length) add(`${prefix}.slots`, 'duplicate_reference');
      for (const slot of slots) if (!slotNames.has(slot)) add(`${prefix}.slots.${slot}`, 'unknown_slot');
    }
    if (!Array.isArray(scenario.not_this_if)) add(`${prefix}.not_this_if`);
    else for (const [ruleIndex, rule] of scenario.not_this_if.entries()) {
      const path = `${prefix}.not_this_if[${ruleIndex}]`;
      if (!record(rule) || !text(rule.condition) || !identifier(rule.use_instead)) add(path);
      else if (!scenarioIds.has(rule.use_instead) && !systemIds.has(rule.use_instead)) add(`${path}.use_instead`, 'unknown_scenario');
    }
    if (scenario.handoff !== null) {
      if (!record(scenario.handoff) || !text(scenario.handoff.when) || !text(scenario.handoff.queue)) add(`${prefix}.handoff`);
      else if (!refs.queues.includes(scenario.handoff.queue)) add(`${prefix}.handoff.queue`, 'unknown_queue');
    }
    for (const language of ['ru', 'kk']) {
      if (!record(scenario.examples) || !strings(scenario.examples[language]) || scenario.examples[language].length === 0) add(`${prefix}.examples.${language}`);
      const response = record(scenario.responses) ? scenario.responses[language] : null;
      if (!record(response) || !text(response.opening) || !text(response.closing)) add(`${prefix}.responses.${language}`);
    }
  }
  for (const [index, intent] of value.system_intents.entries()) {
    const prefix = `system_intents[${index}]`;
    if (!record(intent)) { add(prefix); continue; }
    if (!identifier(intent.id)) add(`${prefix}.id`);
    else { if (allIds.has(intent.id)) add(`${prefix}.id`, 'duplicate_id'); allIds.add(intent.id); }
    for (const key of ['description', 'behavior']) if (!text(intent[key])) add(`${prefix}.${key}`);
    if (!record(intent.response) || !text(intent.response.ru) || !text(intent.response.kk)) add(`${prefix}.response`);
  }
  return issues;
}

export class CatalogValidationError extends Error {
  issues: CatalogIssue[];
  constructor(issues: CatalogIssue[]) { super('Invalid catalog'); this.name = 'CatalogValidationError'; this.issues = issues; }
}
function checked(value: unknown, refs: CatalogReferences): CatalogDocument {
  const issues = validateCatalog(value, refs);
  if (issues.length) throw new CatalogValidationError(issues);
  return value as CatalogDocument;
}
export function parseCatalog(source: string, refs: CatalogReferences): CatalogDocument {
  if (new TextEncoder().encode(source).byteLength > MAX_CATALOG_BYTES) throw new CatalogValidationError([{ path: '$', code: 'too_large' }]);
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new CatalogValidationError([{ path: '$', code: 'invalid_json' }]); }
  return checked(value, refs);
}
export function serializeCatalog(catalog: CatalogDocument): string { return JSON.stringify(catalog, null, 2) + '\n'; }
export function replaceCatalogEntry(catalog: CatalogDocument, id: string, entry: unknown, refs: CatalogReferences): CatalogDocument {
  const next = structuredClone(catalog);
  const scenarioIndex = next.scenarios.findIndex(scenario => scenario.scenario_id === id);
  const systemIndex = next.system_intents.findIndex(intent => intent.id === id);
  if (!record(entry) || (scenarioIndex >= 0 ? entry.scenario_id !== id : entry.id !== id)) throw new CatalogValidationError([{ path: 'id', code: 'immutable_id' }]);
  if (scenarioIndex >= 0) next.scenarios[scenarioIndex] = structuredClone(entry) as CatalogScenario;
  else if (systemIndex >= 0) next.system_intents[systemIndex] = structuredClone(entry) as SystemIntent;
  else throw new CatalogValidationError([{ path: 'id', code: 'unknown_scenario' }]);
  return checked(next, refs);
}
export function createScenario(catalog: CatalogDocument, refs: CatalogReferences): CatalogDocument {
  const next = structuredClone(catalog);
  let number = 1;
  const ids = new Set([...next.scenarios.map(s => s.scenario_id), ...next.system_intents.map(s => s.id)]);
  const slugs = new Set(next.scenarios.map(s => s.slug));
  while (ids.has(`CUSTOM_${String(number).padStart(2, '0')}`) || slugs.has(`custom_${number}`)) number++;
  next.scenarios.push({ scenario_id: `CUSTOM_${String(number).padStart(2, '0')}`, slug: `custom_${number}`, name: 'Новый сценарий / Жаңа сценарий', domain: 'general', category: 'info', description: 'Опишите назначение сценария. / Сценарийдің мақсатын сипаттаңыз.', priority: 'normal', fast_path_eligible: false, requires_identification: false, not_this_if: [], slots: { required: [], optional: [] }, actions: [], requires_confirmation: false, handoff: null, examples: { ru: ['Пример обращения'], kk: ['Өтініш үлгісі'] }, responses: { ru: { opening: 'Здравствуйте.', closing: 'Могу ещё помочь?' }, kk: { opening: 'Сәлеметсіз бе.', closing: 'Тағы көмектесе аламын ба?' } } });
  return checked(next, refs);
}
export function removeScenario(catalog: CatalogDocument, id: string, refs: CatalogReferences): CatalogDocument {
  if (refs.requiredScenarioIds.includes(id) || refs.requiredSystemIds.includes(id)) throw new CatalogValidationError([{ path: id, code: 'required_scenario' }]);
  if (!catalog.scenarios.some(scenario => scenario.scenario_id === id)) throw new CatalogValidationError([{ path: id, code: 'unknown_scenario' }]);
  return checked({ ...structuredClone(catalog), scenarios: catalog.scenarios.filter(scenario => scenario.scenario_id !== id).map(scenario => structuredClone(scenario)) }, refs);
}
export function restoreCatalogDraft(source: string | null, baseline: CatalogDocument, refs: CatalogReferences): { catalog: CatalogDocument; recovered: boolean } {
  if (source === null) return { catalog: structuredClone(baseline), recovered: false };
  try { return { catalog: parseCatalog(source, refs), recovered: false }; }
  catch { return { catalog: structuredClone(baseline), recovered: true }; }
}
