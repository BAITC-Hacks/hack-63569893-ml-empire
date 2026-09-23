import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseEvaluationRun, evaluateRun, compareRuns, serializeEvaluationReport,
  MAX_EVALUATION_BYTES, median,
} from '../src/evaluation-model.ts'

const rows = [
  { id: 'U001', lang: 'ru', expected: ['SC01'], type: 'single' },
  { id: 'U002', lang: 'kk', expected: ['SC02', 'SC01'], type: 'multi_intent' },
  { id: 'U003', lang: 'mixed', expected: ['SYS_UNCLEAR'], type: 'unclear' },
  { id: 'U004', lang: 'ru', expected: ['SYS_OUT_OF_SCOPE'], type: 'out_of_scope' },
]
const known = ['SC01', 'SC02', 'SYS_UNCLEAR', 'SYS_OUT_OF_SCOPE']
const parse = value => parseEvaluationRun(JSON.stringify(value), rows, known, '1.0')
const valid = value => { const result = parse(value); assert.equal(result.ok, true); return result.run }

test('missing IDs are errors and do not shrink the reference denominator', () => {
  const result = evaluateRun(valid({ U001: ['SC01'] }), rows)
  assert.deepEqual(result.overall, { n: 4, primary: 1, full: 1, primaryAccuracy: .25, fullMatch: .25 })
  assert.equal(result.covered, 1)
  assert.equal(result.missing, 3)
  assert.equal(result.errors.length, 3)
  assert.equal(result.observed.fullMatch, 1)
  assert.equal(result.multiIntentRecall, 0)
})
test('multi-intent recall uses expected-intent count, not number of utterances', () => {
  const result = evaluateRun(valid({ U001: ['SC01'], U002: ['SC01'] }), rows)
  assert.equal(result.multiIntentRecall, .5)
  assert.equal(result.byType.find(group => group.key === 'multi_intent').primaryAccuracy, 0)
  assert.equal(result.byScenario.find(group => group.scenarioId === 'SC02').missed, 1)
})
test('full match is order independent while primary accuracy is order sensitive', () => {
  const result = evaluateRun(valid({ U002: ['SC01', 'SC02'] }), rows)
  assert.equal(result.overall.full, 1)
  assert.equal(result.overall.primary, 0)
  assert.equal(result.multiIntentRecall, 1)
  assert.equal(result.byLanguage.find(group => group.key === 'kk').fullMatch, 1)
})
test('false positive and false negative scenario counts are separate', () => {
  const result = evaluateRun(valid({ U001: ['SC02'] }), rows)
  assert.equal(result.byScenario.find(group => group.scenarioId === 'SC02').falsePositive, 1)
  assert.equal(result.byScenario.find(group => group.scenarioId === 'SC01').missed, 2)
  assert.deepEqual(result.confusion.find(row => row.expected === 'SC01'), { expected: 'SC01', predicted: 'SC02', count: 1 })
})
test('empty response is covered but incorrect and distinguishable from a missing result', () => {
  const result = evaluateRun(valid({ U001: [] }), rows)
  assert.equal(result.covered, 1)
  assert.equal(result.missing, 3)
  assert.equal(result.errors[0].missing, false)
  assert.equal(result.confusion.find(row => row.expected === 'SC01').predicted, 'NO_ROUTE')
})
test('clarification and out-of-scope rates use supplied utterances as denominator', () => {
  const result = evaluateRun(valid({ U001: ['SYS_UNCLEAR'], U002: ['SYS_OUT_OF_SCOPE'] }), rows)
  assert.equal(result.clarificationRate, .5)
  assert.equal(result.outOfScopeRate, .5)
  assert.equal(result.medianLatencyMs, null)
})
test('canonical evaluator string predictions are accepted', () => {
  assert.deepEqual(valid({ U001: 'SC01' }).predictions.U001, ['SC01'])
})
test('unknown utterance IDs are ignored, counted, and never exported as raw strings', () => {
  const result = valid({ U001: ['SC01'], 'SECRET-phone-77071234567': ['SC01'] })
  assert.equal(result.unknownIdCount, 1)
  assert.deepEqual(Object.keys(result.predictions), ['U001'])
  assert.equal(serializeEvaluationReport(rows, result).includes('SECRET'), false)
})
test('invalid and duplicate scenarios are rejected instead of silently normalized', () => {
  for (const value of [{ U001: ['SC99'] }, { U001: ['SC01', 'SC01'] }, { U001: [123] }, { U001: null }]) {
    assert.equal(parse(value).ok, false)
  }
})
test('invalid JSON, nonobjects, empty runs, and excessive files are rejected safely', () => {
  for (const value of ['{secret:123}', '[]', 'null', '{}', ' '.repeat(MAX_EVALUATION_BYTES + 1)]) {
    const result = parseEvaluationRun(value, rows, known, '1.0')
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(result).includes('secret'), false)
  }
  assert.equal(parse({ not_in_dataset: ['SC01'] }).ok, false)
})
test('timings require valid finite milliseconds and a prediction for the same ID', () => {
  for (const latency_ms of [{ U001: -1 }, { U001: 600001 }, { U001: '42' }, { U002: 42 }]) {
    assert.equal(parse({ predictions: { U001: ['SC01'] }, latency_ms }).ok, false)
  }
  const result = valid({ predictions: { U001: ['SC01'], U002: [] }, latency_ms: { U001: 0, U002: 100 } })
  assert.equal(evaluateRun(result, rows).medianLatencyMs, 50)
  assert.equal(result.latencyStage, 'unspecified')
})
test('dataset version mismatches and unknown latency scopes are rejected', () => {
  assert.equal(parse({ predictions: { U001: ['SC01'] }, dataset_version: '9.0' }).ok, false)
  assert.equal(parse({ predictions: { U001: ['SC01'] }, latency_stage: 'unknown' }).ok, false)
})
test('comparison uses paired predictions only, with explicit coverage', () => {
  const full = valid({ U001: ['SC01'], U002: ['SC02', 'SC01'] })
  const fast = valid({ U002: ['SC01'], U003: ['SYS_UNCLEAR'] })
  const result = compareRuns(full, fast, rows)
  assert.equal(result.paired, 1)
  assert.equal(result.fullOnly, 1)
  assert.equal(result.fastOnly, 1)
  assert.equal(result.fullMatchDelta, -1)
  assert.equal(result.fastLosses, 1)
  assert.equal(result.full.fullMatch, 1)
  assert.equal(result.fast.fullMatch, 0)
  assert.equal(result.latency, null)
})
test('latency comparison pairs timing IDs rather than comparing unrelated medians', () => {
  const full = valid({ predictions: { U001: ['SC01'], U002: ['SC01'] }, latency_ms: { U001: 100, U002: 900 }, latency_stage: 'router' })
  const fast = valid({ predictions: { U001: ['SC01'], U002: ['SC01'] }, latency_ms: { U001: 60 }, latency_stage: 'router' })
  assert.deepEqual(compareRuns(full, fast, rows).latency, { n: 1, stage: 'router', fullMedianMs: 100, fastMedianMs: 60, medianDeltaMs: -40 })
})
test('different or unspecified timing stages cannot be compared', () => {
  const full = valid({ predictions: { U001: ['SC01'] }, latency_ms: { U001: 100 }, latency_stage: 'router' })
  const fast = valid({ predictions: { U001: ['SC01'] }, latency_ms: { U001: 50 }, latency_stage: 'end_to_end' })
  assert.equal(compareRuns(full, fast, rows).latency, null)
})
test('no paired data produces unknown metrics rather than zero performance', () => {
  const result = compareRuns(valid({ U001: ['SC01'] }), valid({ U002: [] }), rows)
  assert.equal(result.paired, 0)
  assert.equal(result.fullMatchDelta, null)
  assert.equal(result.full.fullMatch, null)
})
test('report allowlist excludes imported labels, text, unknown metadata, and arbitrary IDs', () => {
  const run = valid({ label: 'SECRET 77071234567', predictions: { U001: ['SC01'] }, api_key: 'SECRET' })
  const report = JSON.parse(serializeEvaluationReport(rows.map(row => ({ ...row, text: 'SECRET' })), run))
  assert.equal(report.schema_version, 1)
  assert.equal(report.runs.full.metrics.overall.n, 4)
  assert.equal(JSON.stringify(report).includes('SECRET'), false)
})
test('reference dataset perfect predictions score 1 and covers 104 utterances', () => {
  const data = JSON.parse(readFileSync(new URL('../../datas/dev_utterances.json', import.meta.url))).utterances
  const scenarios = [...new Set(data.flatMap(row => row.expected))]
  const predictions = Object.fromEntries(data.map(row => [row.id, row.expected]))
  const parsed = parseEvaluationRun(JSON.stringify(predictions), data, scenarios, '1.0')
  assert.equal(parsed.ok, true)
  const result = evaluateRun(parsed.run, data)
  assert.equal(result.overall.n, 104)
  assert.equal(result.overall.fullMatch, 1)
  assert.equal(result.overall.primaryAccuracy, 1)
  assert.equal(result.multiIntentRecall, 1)
  assert.equal(result.errors.length, 0)
})
test('median is deterministic and does not mutate its input', () => {
  const values = [4, 1, 8, 2]
  assert.equal(median(values), 3)
  assert.deepEqual(values, [4, 1, 8, 2])
  assert.equal(median([]), null)
  assert.equal(median([7]), 7)
})
