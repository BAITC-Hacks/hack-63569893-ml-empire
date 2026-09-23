/** Local evaluation only. Formulas mirror datas/evaluate.py, including missing-ID errors. */
export const MAX_EVALUATION_BYTES = 1_048_576
export interface EvaluationRow { id: string; lang: string; expected: string[]; type: string }
export interface EvaluationRun {
  predictions: Record<string, string[]>
  latencyMs: Record<string, number>
  latencyStage: 'router' | 'end_to_end' | 'unspecified'
  unknownIdCount: number
}
export type EvaluationImportError = 'file_size' | 'json' | 'schema' | 'no_predictions' | 'scenarios' | 'latency' | 'dataset_version'
export type EvaluationImportResult = { ok: true; run: EvaluationRun } | { ok: false; error: EvaluationImportError }
export interface EvaluationGroup { n: number; primary: number; full: number; primaryAccuracy: number | null; fullMatch: number | null }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const owns = (object: object, key: string) => Object.hasOwn(object, key)

/** Unknown metadata and labels are intentionally discarded; no imported text reaches an export. */
export function parseEvaluationRun(source: string, rows: EvaluationRow[], scenarioIds: string[], version: string): EvaluationImportResult {
  if (new TextEncoder().encode(source).byteLength > MAX_EVALUATION_BYTES) return { ok: false, error: 'file_size' }
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { return { ok: false, error: 'json' } }
  if (!record(parsed)) return { ok: false, error: 'schema' }
  const wrapped = owns(parsed, 'predictions')
  const values = wrapped ? parsed.predictions : parsed
  if (!record(values)) return { ok: false, error: 'schema' }
  if (wrapped && owns(parsed, 'dataset_version') && parsed.dataset_version !== version) return { ok: false, error: 'dataset_version' }
  const ids = new Set(rows.map(row => row.id))
  const scenarios = new Set(scenarioIds)
  const predictions: Record<string, string[]> = Object.create(null)
  let unknownIdCount = 0
  for (const [id, rawValue] of Object.entries(values)) {
    if (!ids.has(id)) { unknownIdCount += 1; continue }
    const value = typeof rawValue === 'string' ? [rawValue] : rawValue
    if (!Array.isArray(value) || value.length > scenarios.size || value.some(item => typeof item !== 'string' || !scenarios.has(item)) || new Set(value).size !== value.length) {
      return { ok: false, error: 'scenarios' }
    }
    predictions[id] = [...value] as string[]
  }
  if (!Object.keys(predictions).length) return { ok: false, error: 'no_predictions' }
  const latencyMs: Record<string, number> = Object.create(null)
  let latencyStage: EvaluationRun['latencyStage'] = 'unspecified'
  if (wrapped && owns(parsed, 'latency_stage')) {
    if (parsed.latency_stage !== 'router' && parsed.latency_stage !== 'end_to_end') return { ok: false, error: 'latency' }
    latencyStage = parsed.latency_stage
  }
  if (wrapped && owns(parsed, 'latency_ms')) {
    if (!record(parsed.latency_ms)) return { ok: false, error: 'latency' }
    for (const [id, value] of Object.entries(parsed.latency_ms)) {
      if (!ids.has(id)) continue
      if (!owns(predictions, id) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 600_000) return { ok: false, error: 'latency' }
      latencyMs[id] = value
    }
  }
  return { ok: true, run: { predictions, latencyMs, latencyStage, unknownIdCount } }
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
function group(rows: EvaluationRow[], run: EvaluationRun): EvaluationGroup {
  let primary = 0; let full = 0
  for (const row of rows) {
    const got = run.predictions[row.id] ?? []
    if (got.length && got[0] === row.expected[0]) primary += 1
    if (new Set(got).size === new Set(row.expected).size && row.expected.every(id => got.includes(id))) full += 1
  }
  return { n: rows.length, primary, full, primaryAccuracy: rows.length ? primary / rows.length : null, fullMatch: rows.length ? full / rows.length : null }
}
export function evaluateRun(run: EvaluationRun, rows: EvaluationRow[]) {
  const coveredRows = rows.filter(row => owns(run.predictions, row.id))
  const errors = rows.flatMap(row => {
    const predicted = run.predictions[row.id] ?? []
    const full = predicted.length === row.expected.length && row.expected.every(id => predicted.includes(id))
    return full ? [] : [{ id: row.id, lang: row.lang, type: row.type, expected: [...row.expected], predicted: [...predicted], missing: !owns(run.predictions, row.id) }]
  })
  const multi = rows.filter(row => row.type === 'multi_intent')
  const totalExpected = multi.reduce((total, row) => total + row.expected.length, 0)
  const foundExpected = multi.reduce((total, row) => total + row.expected.filter(id => (run.predictions[row.id] ?? []).includes(id)).length, 0)
  const partition = (field: 'lang' | 'type') => [...new Set(rows.map(row => row[field]))].sort().map(key => ({ key, ...group(rows.filter(row => row[field] === key), run) }))
  const allScenarios = [...new Set(rows.flatMap(row => [...row.expected, ...(run.predictions[row.id] ?? [])]))].sort()
  const byScenario = allScenarios.map(scenarioId => {
    const expectedRows = rows.filter(row => row.expected.includes(scenarioId))
    return {
      scenarioId, expected: expectedRows.length,
      missed: expectedRows.filter(row => !(run.predictions[row.id] ?? []).includes(scenarioId)).length,
      falsePositive: rows.filter(row => !row.expected.includes(scenarioId) && (run.predictions[row.id] ?? []).includes(scenarioId)).length,
      fullErrors: expectedRows.filter(row => errors.some(error => error.id === row.id)).length,
    }
  })
  const confusionMap = new Map<string, { expected: string; predicted: string; count: number }>()
  for (const row of rows) {
    const expected = row.expected[0]
    const predicted = run.predictions[row.id]?.[0] ?? (owns(run.predictions, row.id) ? 'NO_ROUTE' : 'MISSING')
    if (predicted === expected) continue
    const key = `${expected}:${predicted}`
    const existing = confusionMap.get(key)
    if (existing) existing.count += 1
    else confusionMap.set(key, { expected, predicted, count: 1 })
  }
  const timings = coveredRows.flatMap(row => owns(run.latencyMs, row.id) ? [run.latencyMs[row.id]] : [])
  return {
    overall: group(rows, run), observed: group(coveredRows, run), covered: coveredRows.length, missing: rows.length - coveredRows.length,
    multiIntentRecall: totalExpected ? foundExpected / totalExpected : null,
    byLanguage: partition('lang'), byType: partition('type'), byScenario, errors,
    confusion: [...confusionMap.values()].sort((a, b) => b.count - a.count || a.expected.localeCompare(b.expected) || a.predicted.localeCompare(b.predicted)),
    clarificationRate: coveredRows.length ? coveredRows.filter(row => run.predictions[row.id][0] === 'SYS_UNCLEAR').length / coveredRows.length : null,
    outOfScopeRate: coveredRows.length ? coveredRows.filter(row => run.predictions[row.id][0] === 'SYS_OUT_OF_SCOPE').length / coveredRows.length : null,
    medianLatencyMs: median(timings), timedCount: timings.length,
  }
}

export function compareRuns(full: EvaluationRun, fast: EvaluationRun, rows: EvaluationRow[]) {
  const pairedRows = rows.filter(row => owns(full.predictions, row.id) && owns(fast.predictions, row.id))
  const fullScore = group(pairedRows, full); const fastScore = group(pairedRows, fast)
  const timedRows = pairedRows.filter(row => owns(full.latencyMs, row.id) && owns(fast.latencyMs, row.id))
  const comparableTiming = full.latencyStage !== 'unspecified' && full.latencyStage === fast.latencyStage && timedRows.length > 0
  let fastWins = 0; let fastLosses = 0
  for (const row of pairedRows) {
    const difference = group([row], fast).full - group([row], full).full
    if (difference > 0) fastWins += 1
    if (difference < 0) fastLosses += 1
  }
  return {
    paired: pairedRows.length,
    fullOnly: rows.filter(row => owns(full.predictions, row.id) && !owns(fast.predictions, row.id)).length,
    fastOnly: rows.filter(row => owns(fast.predictions, row.id) && !owns(full.predictions, row.id)).length,
    full: fullScore, fast: fastScore, fastWins, fastLosses,
    primaryAccuracyDelta: pairedRows.length ? fastScore.primaryAccuracy! - fullScore.primaryAccuracy! : null,
    fullMatchDelta: pairedRows.length ? fastScore.fullMatch! - fullScore.fullMatch! : null,
    latency: comparableTiming ? {
      n: timedRows.length, stage: full.latencyStage,
      fullMedianMs: median(timedRows.map(row => full.latencyMs[row.id]))!,
      fastMedianMs: median(timedRows.map(row => fast.latencyMs[row.id]))!,
      medianDeltaMs: median(timedRows.map(row => fast.latencyMs[row.id] - full.latencyMs[row.id]))!,
    } : null,
  }
}

/** No input utterances, arbitrary metadata, imported labels or filenames in the report. */
export function serializeEvaluationReport(rows: EvaluationRow[], full: EvaluationRun | null, fast: EvaluationRun | null = null): string {
  const summarize = (run: EvaluationRun) => ({ metrics: evaluateRun(run, rows), latency_stage: run.latencyStage, ignored_id_count: run.unknownIdCount })
  return JSON.stringify({ schema_version: 1, reference: 'datas/dev_utterances.json', sample_count: rows.length,
    denominator: 'All reference utterances; missing predictions count as errors. Comparison uses only paired IDs.',
    runs: { ...(full ? { full: summarize(full) } : {}), ...(fast ? { fast: summarize(fast) } : {}) },
    comparison: full && fast ? compareRuns(full, fast, rows) : null,
  }, null, 2)
}
