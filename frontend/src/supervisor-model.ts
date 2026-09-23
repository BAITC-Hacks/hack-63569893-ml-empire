import { maskPersonalData } from './session-state.ts';
import { readAffect } from './affect-model.ts';
import type { ActionPreview, CatalogItem, Scenario, Turn } from './types';

type Data = Record<string, unknown>;
export function asRecord(value: unknown): Data | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : null;
}
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
const owns = (value: Data | null, key: string) => value !== null && Object.hasOwn(value, key);

function scenario(value: unknown, catalog: CatalogItem[]): Scenario | null {
  const object = asRecord(value);
  const id = text(typeof value === 'string' ? value : object?.scenario_id);
  if (!id) return null;
  const known = catalog.find(item => item.scenario_id === id);
  const priority = object?.priority === 'normal' || object?.priority === 'high' || object?.priority === 'urgent' ? object.priority : known?.priority;
  return {
    scenario_id: id, name: text(object?.name) ?? known?.name, priority,
    reason: text(object?.reason) ?? undefined,
    confidence_estimate: typeof object?.confidence_estimate === 'number' && Number.isFinite(object.confidence_estimate) ? object.confidence_estimate : undefined,
  };
}
function scenarios(value: unknown, catalog: CatalogItem[]): Scenario[] {
  return Array.isArray(value) ? value.map(item => scenario(item, catalog)).filter((item): item is Scenario => item !== null) : [];
}

export function getScenarioView(turn: Turn, catalog: CatalogItem[] = []) {
  const route = asRecord(turn.route);
  const trace = asRecord(turn.trace);
  const read = (key: string) => owns(route, key) ? route?.[key] : trace?.[key];
  const known = (key: string) => owns(route, key) || owns(trace, key);
  const selected = scenarios(route?.scenarios, catalog);
  return {
    primary: selected[0] ?? null, additional: selected.slice(1),
    alternatives: scenarios(route?.alternatives, catalog),
    active: scenario(read('active_scenario'), catalog), activeKnown: known('active_scenario'),
    pending: scenarios(read('pending_scenarios'), catalog), pendingKnown: known('pending_scenarios'),
    suspended: scenarios(read('suspended_scenarios'), catalog), suspendedKnown: known('suspended_scenarios'),
  };
}

export interface SlotView { name: string; value: unknown; status: string | null; source: string | null; scenarioId: string | null }
export function getSlots(value: unknown): SlotView[] {
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.flatMap(item => { const data = asRecord(item); return text(data?.name) ? [[data!.name as string, item] as [string, unknown]] : []; })
    : Object.entries(asRecord(value) ?? {});
  return entries.map(([name, item]) => {
    const data = asRecord(item);
    const metadata = data && (owns(data, 'value') || owns(data, 'status') || owns(data, 'source') || owns(data, 'scenario_id'));
    return { name, value: metadata ? data.value : item, status: metadata ? text(data.status) : null, source: metadata ? text(data.source) : null, scenarioId: metadata ? text(data.scenario_id) : null };
  });
}

export interface ActionView { name: string; mode: string | null; status: string | null; summary: string | null; args: unknown; error: unknown; raw: unknown }
export function getActions(value: unknown, preview?: ActionPreview | null): ActionView[] {
  const actions: ActionView[] = (Array.isArray(value) ? value : []).flatMap((item): ActionView[] => {
    if (typeof item === 'string') {
      const separator = item.lastIndexOf(':');
      const suffix = separator > 0 ? item.slice(separator + 1) : '';
      const mode = ['preview', 'execute', 'requested'].includes(suffix) ? suffix : null;
      return [{ name: mode ? item.slice(0, separator) : item, mode, status: suffix === 'requested' ? 'requested' : null, summary: null, args: null, error: null, raw: item }];
    }
    const data = asRecord(item);
    if (!data) return [];
    return [{ name: text(data.name) ?? text(data.action) ?? 'action', mode: text(data.mode), status: text(data.status), summary: text(data.summary), args: data.masked_args ?? data.arguments ?? data.args, error: data.error, raw: data }];
  });
  if (preview) {
    const matching = actions.findLastIndex(action => action.name === preview.name && action.mode !== 'execute'
      && (action.status === 'awaiting_confirmation' || (action.mode === 'preview' && (action.status === null || action.status === 'requested' || action.status === 'preview'))));
    const prepared: ActionView = { name: preview.name, mode: 'preview', status: 'awaiting_confirmation', summary: preview.summary, args: preview.masked_args, error: null, raw: preview };
    if (matching >= 0) actions[matching] = { ...actions[matching], ...prepared, args: preview.masked_args ?? actions[matching].args };
    else actions.push(prepared);
  }
  return actions;
}

export function getHandoff(value: unknown) {
  const data = asRecord(value);
  return data ? {
    reason: text(data.reason), queue: text(data.queue) ?? text(data.direction),
    context: data.context ?? data.summary ?? null, status: text(data.status),
    activeScenario: data.active_scenario ?? null, slots: getSlots(data.slots), raw: data,
  } : null;
}

export function finiteTiming(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function sampleSummary(values: unknown[]) {
  const samples = values.map(finiteTiming).filter((item): item is number => item !== null).sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  return { median: samples.length ? (samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2) : null, count: samples.length };
}
export function getSessionMetrics(turns: Turn[]) {
  return {
    voiceFirstAudio: sampleSummary(turns.filter(item => item.mode === 'audio').map(item => item.trace?.client_first_audio_ms)),
    textFirstAudio: sampleSummary(turns.filter(item => item.mode === 'text').map(item => item.trace?.client_first_audio_ms)),
    serverTotal: sampleSummary(turns.map(item => item.trace?.latency_ms?.total)),
    router: sampleSummary(turns.map(item => item.trace?.latency_ms?.router)),
    turns: turns.length,
    clarifications: turns.filter(item => item.status === 'clarify').length,
    handoffs: turns.filter(item => item.status === 'handoff').length,
    errors: turns.filter(item => item.status === 'error' || Boolean(item.error) || Boolean(asRecord(item)?.errorCode)).length,
  };
}

export interface TraceFilters { language: string; scenario: string; status: string }
export function filterTurns(turns: Turn[], filters: TraceFilters): Turn[] {
  return turns.filter(turn => {
    if (filters.language && (turn.route?.language ?? turn.language ?? 'unknown') !== filters.language) return false;
    if (filters.status && turn.status !== filters.status) return false;
    const view = getScenarioView(turn);
    return !filters.scenario || [view.primary, view.active, ...view.additional, ...view.pending, ...view.suspended].some(item => item?.scenario_id === filters.scenario);
  });
}

const secretKey = /^(?:.*_)?(?:password|passwd|secret|token|api_?key|authorization|cookie|prompt|stack|stacktrace|stack_trace|error|errors|diagnostics|debug)(?:_.*)?$/i;
const personalKey = /^(?:.*_)?(?:phone|telephone|mobile|email|iin|bin|iban|account_number|card_number|pan|full_name|first_name|last_name|client_name|customer_name|fio|address|policy_number|plate_number|license_plate|passport|client_id|customer_id)(?:_.*)?$/i;

// Redaction applies to values and their field names before either display or export.
// The export is deliberately allowlisted: arbitrary server diagnostics do not leave the browser.
export function maskTraceValue(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  const normalizedKey = key.replace(/([a-z])([A-Z])/g, '$1_$2');
  if (secretKey.test(normalizedKey)) return undefined;
  if (personalKey.test(normalizedKey) && value != null) return '[скрыто / жасырылған]';
  if (typeof value === 'string') return maskPersonalData(value).replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const masked = maskPersonalData(String(value));
    return masked !== String(value) ? masked : value;
  }
  if (typeof value === 'boolean' || value == null) return value ?? null;
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const result: unknown = Array.isArray(value)
    ? value.map(item => maskTraceValue(item, key, seen))
    : Object.fromEntries(Object.entries(value).flatMap(([field, item]) => {
      const slotName = asRecord(value)?.name;
      const masked = maskTraceValue(item, field === 'value' && typeof slotName === 'string' ? slotName : field, seen);
      return masked === undefined ? [] : [[field, masked]];
    }));
  seen.delete(value);
  return result;
}

export function displayTraceValue(value: unknown, key = ''): string {
  const safe = maskTraceValue(value, key);
  if (safe == null) return '∅';
  return typeof safe === 'string' ? safe : typeof safe === 'object' ? JSON.stringify(safe) : String(safe);
}

export function serializeTrace(turn: Turn): string {
  const trace = asRecord(turn.trace);
  const affect = readAffect(trace);
  const traceKeys = ['actions', 'latency_ms', 'client_first_audio_ms', 'handoff', 'active_scenario', 'pending_scenarios', 'suspended_scenarios', 'slots', 'is_continuation', 'clarification'];
  const route = asRecord(turn.route);
  const routeKeys = ['scenarios', 'alternatives', 'reason', 'language', 'slots', 'source', 'active_scenario', 'pending_scenarios', 'suspended_scenarios', 'is_continuation'];
  const pick = (data: Data | null, keys: string[]) => data ? Object.fromEntries(keys.filter(key => owns(data, key)).map(key => [key, data[key]])) : null;
  return JSON.stringify(maskTraceValue({
    schema: 'voice-router.trace.v1', turn_id: turn.id, mode: turn.mode,
    transcript: turn.text, language: turn.route?.language ?? turn.language,
    reply: turn.reply, status: turn.status, route: pick(route, routeKeys),
    trace: trace ? { ...pick(trace, traceKeys), affect: affect ? {emotion: affect.emotion, response_tone: affect.tone, source: affect.source, confidence: affect.confidence} : null } : null, confirmation_preview: turn.preview,
    // Raw error strings can contain backend diagnostics; omit them from exports.
    has_issue: Boolean(turn.error) || Boolean(asRecord(turn)?.errorCode), restored: Boolean(turn.restored),
  }), null, 2);
}
