import { maskPersonalData } from './session-state.ts';
import { maskTraceValue, serializeTrace } from './supervisor-model.ts';
import type { Turn } from './types';

type DatasetLanguage = 'ru' | 'kk' | 'mixed';
export interface DatasetClientTurn {
  role: 'client'; text: string; lang: DatasetLanguage; scenarios: string[]; slots: Record<string, unknown>;
}
export interface DatasetBotTurn {
  role: 'bot'; text: string; lang: DatasetLanguage; actions: Record<string, unknown>[];
}
export type DatasetTurn = DatasetClientTurn | DatasetBotTurn;
export interface DatasetDialog { dialog_id: string; title: string; tags: string[]; turns: DatasetTurn[] }
export interface DialogDataset { dialogs: DatasetDialog[] }
export interface DatasetSubmission { sourceIndex: number; turnId: string }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty);

// Only packaged reference data is loaded. Labels remain local and never enter onSend.
export function parseDialogDataset(value: unknown): DialogDataset {
  if (!record(value) || !Array.isArray(value.dialogs) || !value.dialogs.length) throw new Error('invalid_dialog_dataset');
  const ids = new Set<string>();
  const dialogs = value.dialogs.map((dialog): DatasetDialog => {
    if (!record(dialog) || !nonempty(dialog.dialog_id) || ids.has(dialog.dialog_id) || !nonempty(dialog.title)
      || !strings(dialog.tags) || !Array.isArray(dialog.turns) || !dialog.turns.length) throw new Error('invalid_dialog');
    ids.add(dialog.dialog_id);
    const turns = dialog.turns.map((turn): DatasetTurn => {
      if (!record(turn) || !nonempty(turn.text) || !['ru', 'kk', 'mixed'].includes(String(turn.lang))) throw new Error('invalid_dialog_turn');
      const base = { text: turn.text, lang: turn.lang as DatasetLanguage };
      if (turn.role === 'client' && strings(turn.scenarios) && turn.scenarios.length > 0 && record(turn.slots)) {
        return { ...base, role: 'client', scenarios: [...turn.scenarios], slots: { ...turn.slots } };
      }
      if (turn.role === 'bot' && Array.isArray(turn.actions) && turn.actions.every(record)) {
        return { ...base, role: 'bot', actions: turn.actions.map(action => ({ ...action })) };
      }
      throw new Error('invalid_dialog_role');
    });
    if (!turns.some(turn => turn.role === 'client')) throw new Error('missing_client_turn');
    return { dialog_id: dialog.dialog_id, title: dialog.title, tags: [...dialog.tags], turns };
  });
  return { dialogs };
}

export function getClientSteps(dialog: DatasetDialog) {
  return dialog.turns.flatMap((client, sourceIndex) => {
    if (client.role !== 'client') return [];
    const referenceReplies: DatasetBotTurn[] = [];
    for (let next = sourceIndex + 1; next < dialog.turns.length && dialog.turns[next].role === 'bot'; next++) referenceReplies.push(dialog.turns[next] as DatasetBotTurn);
    const previous = dialog.turns[sourceIndex - 1];
    const requiresReview = (previous?.role === 'bot' && previous.actions.some(action => action.mode === 'preview'))
      || referenceReplies.some(reply => reply.actions.some(action => action.mode === 'execute'));
    return [{ sourceIndex, client, referenceReplies, requiresReview }];
  });
}

export function isDatasetTurnTerminal(turn: Turn): boolean {
  return ['answered', 'clarify', 'handoff', 'error'].includes(turn.status) && !turn.restored;
}

export function compareDatasetTurn(expected: string[], turn: Turn) {
  if (!isDatasetTurnTerminal(turn)) return null;
  const predicted = turn.route?.scenarios.map(scenario => scenario.scenario_id) ?? [];
  const expectedSet = new Set(expected), predictedSet = new Set(predicted);
  return {
    predicted,
    primaryMatch: expected.length > 0 && expected[0] === predicted[0],
    exactMatch: expectedSet.size === predictedSet.size && [...expectedSet].every(id => predictedSet.has(id)),
    recall: expectedSet.size ? [...expectedSet].filter(id => predictedSet.has(id)).length / expectedSet.size : 0,
  };
}

export function getDatasetResults(dialog: DatasetDialog, submissions: DatasetSubmission[], turns: Turn[]) {
  const steps = getClientSteps(dialog);
  return submissions.flatMap(submission => {
    const step = steps.find(item => item.sourceIndex === submission.sourceIndex);
    if (!step) return [];
    const turn = turns.find(item => item.id === submission.turnId && !item.restored) ?? null;
    return [{ ...submission, step, turn, comparison: turn ? compareDatasetTurn(step.client.scenarios, turn) : null }];
  });
}

export function nextReferenceCount(current: number, total: number): number {
  return Math.min(Math.max(0, total), Math.max(0, current) + 1);
}

function maskDatasetText(value: string): string {
  return maskPersonalData(value)
    .replace(/\bSQ-[A-Z]+-\d+\b/g, '[полис / полис]')
    .replace(/\b\d{3}[A-Z]{3}\d{2}\b/g, '[номер / нөмір]');
}

export function redactDatasetValue(value: unknown): unknown {
  const safe = maskTraceValue(value);
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return maskDatasetText(item);
    if (Array.isArray(item)) return item.map(visit);
    if (!record(item)) return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [
      maskDatasetText(key), /^(?:vehicle_plate|drivers_iin)$/i.test(key) ? '[скрыто / жасырылған]' : visit(child),
    ]));
  };
  return visit(safe);
}

export function serializeDatasetRun(dialog: DatasetDialog, submissions: DatasetSubmission[], turns: Turn[]): string {
  return JSON.stringify(redactDatasetValue({
    schema: 'voice-router.dataset-run.v1', dataset: 'dialogs_sample.json', dialog_id: dialog.dialog_id,
    comparison_scope: 'scenario_labels_only',
    results: getDatasetResults(dialog, submissions, turns).map(result => ({
      source_index: result.sourceIndex, turn_id: result.turnId, expected: result.step.client.scenarios,
      language: result.step.client.lang, status: result.turn?.status ?? 'unavailable',
      ...(result.comparison ?? { predicted: null, primaryMatch: null, exactMatch: null, recall: null }),
      trace: result.turn ? JSON.parse(serializeTrace(result.turn)) as unknown : null,
    })),
  }), null, 2);
}
