import { useMemo, useRef, useState } from 'react'
import { Download, Upload, X } from 'lucide-react'
import reference from '../../../datas/dev_utterances.json'
import catalog from '../../../datas/scenarios.json'
import { compareRuns, evaluateRun, MAX_EVALUATION_BYTES, parseEvaluationRun, serializeEvaluationReport, type EvaluationGroup, type EvaluationImportError, type EvaluationRun } from '../evaluation-model'
import '../evaluation.css'

const scenarioIds = [...catalog.scenarios.map(scenario => scenario.scenario_id), ...catalog.system_intents.map(intent => intent.id)]
const rows = reference.utterances
type Slot = 'full' | 'fast'
const copy = {
  ru: {
    title: 'Качество маршрутизации', intro: 'Точность, ошибки и скорость ответа на 104 тестовых репликах.',
    modes: { full: 'Основной режим', fast: 'Быстрый режим' },
    stages: { router: 'Выбор сценария', end_to_end: 'Полный цикл', unspecified: 'Этап не указан' },
    export: 'Скачать отчёт', import: 'Загрузить результаты', file: 'Выбрать файл', clear: 'Удалить результат', loading: 'Читаем файл…', loaded: 'Результат загружен',
    importHelp: 'Выберите файл для каждого режима. Файлы обрабатываются только в браузере.',
    partial: 'Отсутствующие результаты учитываются как ошибки.', ignored: 'Неизвестных реплик пропущено:', coverage: 'Проверено реплик',
    empty: 'Результатов оценки пока нет.',
    summary: 'Результаты', metric: 'Показатель', value: 'Значение', primary: 'Точность основного сценария', full: 'Полное совпадение', recall: 'Полнота составных запросов',
    missing: 'Нет результата', observed: 'Совпадение по загруженным', observedWarning: 'Оценка по загруженным не заменяет оценку всей выборки.',
    clarify: 'Запросы уточнения', outOfScope: 'Запросы вне тематики',
    median: 'Медианная задержка', noTiming: 'Нет измерений', supplied: 'измерений',
    breakdown: 'Языки и типы', group: 'Группа', n: 'Реплик', language: 'Язык', type: 'Тип',
    groupNote: 'В каждой группе учитываются и отсутствующие результаты.',
    scenarios: 'Ошибки по сценариям', errorsOnly: 'Только с ошибками', scenario: 'Сценарий', expected: 'Ожидается', missed: 'Пропущен', extra: 'Лишний', incorrect: 'Реплик с несовпадением',
    scenarioNote: 'Одна реплика может относиться к нескольким сценариям.',
    confusion: 'Ошибки выбора основного сценария', predicted: 'Выбран', count: 'Количество', noRoute: 'Нет маршрута', missingResult: 'Нет результата', noErrors: 'Ошибок нет',
    errorList: 'Реплики с несовпадением', all: 'Все', comparison: 'Сравнение режимов', comparisonEmpty: 'Для сравнения загрузите результаты обоих режимов.',
    paired: 'Общих реплик', unpaired: 'Без пары:', fullOnly: 'в основном режиме', fastOnly: 'в быстром режиме', difference: 'Быстрый − основной', pp: 'п. п.',
    wins: 'Быстрый режим: улучшений', losses: 'ухудшений', pairedNote: 'Сравниваются только реплики, присутствующие в обоих файлах.',
    noPaired: 'Нет общих реплик для сравнения.', timingUnavailable: 'Недостаточно сопоставимых измерений времени.',
    timingDelta: 'Медианное изменение времени по репликам', timingNote: 'Отрицательная разница означает ускорение. Время взято из загруженных файлов.',
    noFilteredResults: 'Для выбранного языка несовпадений нет.',
    errors: { file_size: 'Файл больше 1 МиБ.', json: 'Не удалось прочитать формат файла. Выберите корректный JSON.', schema: 'Файл не содержит результаты оценки в поддерживаемом формате.', no_predictions: 'Нет результатов для реплик этой выборки.', scenarios: 'В результатах есть неизвестные или повторяющиеся сценарии.', latency: 'Некорректные измерения времени или этап измерения.', dataset_version: 'Результаты относятся к другой версии выборки.', read: 'Не удалось прочитать файл. Выберите его повторно.' },
  },
  kk: {
    title: 'Маршруттау сапасы', intro: '104 тест репликасындағы дәлдік, қателер және жауап жылдамдығы.',
    modes: { full: 'Негізгі режим', fast: 'Жылдам режим' },
    stages: { router: 'Сценарий таңдау', end_to_end: 'Толық цикл', unspecified: 'Кезең көрсетілмеген' },
    export: 'Есепті жүктеу', import: 'Нәтижелерді жүктеу', file: 'Файл таңдау', clear: 'Нәтижені жою', loading: 'Файл оқылуда…', loaded: 'Нәтиже жүктелді',
    importHelp: 'Әр режим үшін файл таңдаңыз. Файлдар тек браузерде өңделеді.',
    partial: 'Жоқ нәтижелер қате ретінде есептеледі.', ignored: 'Белгісіз репликалар өткізіліп жіберілді:', coverage: 'Тексерілген репликалар',
    empty: 'Бағалау нәтижелері әлі жоқ.',
    summary: 'Нәтижелер', metric: 'Көрсеткіш', value: 'Мән', primary: 'Негізгі сценарий дәлдігі', full: 'Толық сәйкестік', recall: 'Құрама сұраулардың толықтығы',
    missing: 'Нәтиже жоқ', observed: 'Жүктелгендер бойынша сәйкестік', observedWarning: 'Жүктелген нәтижелер бағасы толық жиынтық бағасын алмастырмайды.',
    clarify: 'Нақтылау сұраулары', outOfScope: 'Тақырыптан тыс сұраулар',
    median: 'Кідіріс медианасы', noTiming: 'Өлшемдер жоқ', supplied: 'өлшем',
    breakdown: 'Тілдер мен түрлер', group: 'Топ', n: 'Реплика', language: 'Тіл', type: 'Түр',
    groupNote: 'Әр топта жоқ нәтижелер де есепке алынады.',
    scenarios: 'Сценарийлер бойынша қателер', errorsOnly: 'Тек қатесі бар', scenario: 'Сценарий', expected: 'Күтіледі', missed: 'Өткізілген', extra: 'Артық', incorrect: 'Сәйкес емес репликалар',
    scenarioNote: 'Бір реплика бірнеше сценарийге қатысты болуы мүмкін.',
    confusion: 'Негізгі сценарийді таңдау қателері', predicted: 'Таңдалған', count: 'Саны', noRoute: 'Маршрут жоқ', missingResult: 'Нәтиже жоқ', noErrors: 'Қате жоқ',
    errorList: 'Сәйкес емес репликалар', all: 'Барлығы', comparison: 'Режимдерді салыстыру', comparisonEmpty: 'Салыстыру үшін екі режимнің де нәтижелерін жүктеңіз.',
    paired: 'Ортақ репликалар', unpaired: 'Жұпсыз:', fullOnly: 'негізгі режимде', fastOnly: 'жылдам режимде', difference: 'Жылдам − негізгі', pp: 'п. т.',
    wins: 'Жылдам режим: жақсарған', losses: 'нашарлаған', pairedNote: 'Екі файлда да бар репликалар ғана салыстырылады.',
    noPaired: 'Салыстыруға ортақ репликалар жоқ.', timingUnavailable: 'Салыстыруға жарамды уақыт өлшемдері жеткіліксіз.',
    timingDelta: 'Репликалар бойынша уақыт өзгерісінің медианасы', timingNote: 'Теріс айырма жылдамдауды білдіреді. Уақыт жүктелген файлдардан алынады.',
    noFilteredResults: 'Таңдалған тілде сәйкессіздіктер жоқ.',
    errors: { file_size: 'Файл 1 МиБ-тан үлкен.', json: 'Файл пішімі оқылмады. Дұрыс JSON таңдаңыз.', schema: 'Файлда қолдау көрсетілетін пішімдегі бағалау нәтижелері жоқ.', no_predictions: 'Бұл жиынтықтағы репликалар үшін нәтиже жоқ.', scenarios: 'Нәтижелерде белгісіз немесе қайталанатын сценарийлер бар.', latency: 'Уақыт өлшемдері немесе өлшеу кезеңі қате.', dataset_version: 'Нәтижелер жиынтықтың басқа нұсқасына тиесілі.', read: 'Файл оқылмады. Оны қайта таңдаңыз.' },
  },
}
function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'voice-router-evaluation.json'; anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function EvaluationLab({ language }: { language: 'ru' | 'kk' }) {
  const t = copy[language]
  const slotNames = t.modes
  const [runs, setRuns] = useState<Record<Slot, EvaluationRun | null>>({ full: null, fast: null })
  const [errors, setErrors] = useState<Partial<Record<Slot, EvaluationImportError | 'read'>>>({})
  const [loading, setLoading] = useState<Partial<Record<Slot, boolean>>>({})
  const generations = useRef({ full: 0, fast: 0 })
  const [selected, setSelected] = useState<Slot>('full')
  const [onlyErrors, setOnlyErrors] = useState(true)
  const [errorLanguage, setErrorLanguage] = useState('all')
  const run = runs[selected]
  const result = useMemo(() => run ? evaluateRun(run, rows) : null, [run])
  const filteredErrors = result?.errors.filter(row => errorLanguage === 'all' || row.lang === errorLanguage) ?? []
  const comparison = useMemo(() => runs.full && runs.fast ? compareRuns(runs.full, runs.fast, rows) : null, [runs])
  const percent = (value: number | null) => value === null ? '—' : new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(value)
  const ms = (value: number) => `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value)} мс`
  const difference = (value: number | null) => value === null ? '—' : `${value > 0 ? '+' : ''}${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value * 100)} ${t.pp}`
  const accept = (source: string, slot: Slot) => {
    const parsed = parseEvaluationRun(source, rows, scenarioIds, reference.meta.version)
    if (parsed.ok) {
      setRuns(current => ({ ...current, [slot]: parsed.run })); setSelected(slot)
      setErrors(current => ({ ...current, [slot]: undefined }))
    } else setErrors(current => ({ ...current, [slot]: parsed.error }))
  }
  const loadFile = async (file: File | undefined, slot: Slot) => {
    if (!file) return
    const generation = ++generations.current[slot]
    setErrors(current => ({ ...current, [slot]: undefined }))
    if (file.size > MAX_EVALUATION_BYTES) { setErrors(current => ({ ...current, [slot]: 'file_size' })); setLoading(current => ({ ...current, [slot]: false })); return }
    setLoading(current => ({ ...current, [slot]: true }))
    try {
      const source = await file.text()
      if (generations.current[slot] === generation) accept(source, slot)
    } catch { if (generations.current[slot] === generation) setErrors(current => ({ ...current, [slot]: 'read' })) }
    finally { if (generations.current[slot] === generation) setLoading(current => ({ ...current, [slot]: false })) }
  }
  const breakdownRow = (label: string, group: EvaluationGroup) => <tr key={label}><th scope="row">{label}</th><td>{group.n}</td><td>{percent(group.primaryAccuracy)}</td><td>{percent(group.fullMatch)}</td></tr>
  const routeName = (value: string) => value === 'MISSING' ? t.missingResult : value === 'NO_ROUTE' ? t.noRoute : value

  return <section className="evaluation-lab" aria-labelledby="evaluation-title">
    <header className="evaluation-heading"><div><h1 id="evaluation-title">{t.title}</h1><p>{t.intro}</p></div>
      <button className="evaluation-button" disabled={!runs.full && !runs.fast} onClick={() => download(serializeEvaluationReport(rows, runs.full, runs.fast))}><Download size={16} />{t.export}</button>
    </header>
    <section className="evaluation-import" aria-labelledby="evaluation-import-title"><h3 id="evaluation-import-title">{t.import}</h3><p className="evaluation-note">{t.importHelp}</p>
      <div className="evaluation-file-grid">{(['full', 'fast'] as const).map(slot => <fieldset key={slot}><legend>{slotNames[slot]}</legend>
        <label className="evaluation-file"><Upload size={16} />{t.file}<input type="file" accept=".json,application/json" aria-label={`${t.file}: ${slotNames[slot]}`} onChange={event => { void loadFile(event.target.files?.[0], slot); event.target.value = '' }} /></label>
        <div className="evaluation-import-status" aria-live="polite">{loading[slot] ? <span>{t.loading}</span> : runs[slot] ? <span>{t.loaded} · {Object.keys(runs[slot]!.predictions).length}/{rows.length}</span> : <span>JSON · ≤ 1 МиБ</span>}
          {runs[slot] && <button type="button" aria-label={`${t.clear}: ${slotNames[slot]}`} onClick={() => { generations.current[slot] += 1; setRuns(current => ({ ...current, [slot]: null })); setErrors(current => ({ ...current, [slot]: undefined })); setLoading(current => ({ ...current, [slot]: false })); if (selected === slot) setSelected(slot === 'full' ? 'fast' : 'full') }}><X size={16} /></button>}</div>
        {errors[slot] && <p className="evaluation-error" role="alert">{t.errors[errors[slot]!]}</p>}
      </fieldset>)}</div>
    </section>
    {!runs.full && !runs.fast ? <p className="evaluation-empty">{t.empty}</p> : <>
      <div className="evaluation-run-picker" role="group" aria-label={t.summary}>{(['full', 'fast'] as const).map(slot => <button key={slot} aria-pressed={selected === slot} disabled={!runs[slot]} onClick={() => setSelected(slot)}>{slotNames[slot]}</button>)}</div>
      {result && run && <>
        <div className="evaluation-coverage"><strong>{t.coverage}: {result.covered}/{rows.length}</strong>{result.missing > 0 && <span>{t.partial}</span>}{run.unknownIdCount > 0 && <span>{t.ignored} {run.unknownIdCount}</span>}</div>
        <div className="evaluation-columns"><section><h3>{t.summary} · {slotNames[selected]}</h3><div className="evaluation-table-wrap" tabIndex={0} role="region" aria-label={t.summary}><table><thead><tr><th>{t.metric}</th><th>{t.value}</th></tr></thead><tbody>
          <tr><th scope="row">{t.primary}</th><td>{percent(result.overall.primaryAccuracy)}</td></tr><tr><th scope="row">{t.full}</th><td>{percent(result.overall.fullMatch)}</td></tr><tr><th scope="row">{t.recall}</th><td>{percent(result.multiIntentRecall)}</td></tr><tr><th scope="row">{t.missing}</th><td>{result.missing}</td></tr>
          <tr><th scope="row">{t.observed}</th><td>{percent(result.observed.fullMatch)} ({result.covered})</td></tr><tr><th scope="row">{t.clarify}</th><td>{percent(result.clarificationRate)}</td></tr><tr><th scope="row">{t.outOfScope}</th><td>{percent(result.outOfScopeRate)}</td></tr>
          <tr><th scope="row">{t.median}</th><td>{result.medianLatencyMs === null ? t.noTiming : <>{ms(result.medianLatencyMs)}<small>{result.timedCount} {t.supplied} · {t.stages[run.latencyStage]}</small></>}</td></tr>
        </tbody></table></div><p className="evaluation-note">{t.observedWarning}</p></section>
        <section><h3>{t.breakdown}</h3><div className="evaluation-table-wrap" tabIndex={0} role="region" aria-label={t.breakdown}><table><thead><tr><th>{t.group}</th><th>{t.n}</th><th>{t.primary}</th><th>{t.full}</th></tr></thead><tbody>{result.byLanguage.map(group => breakdownRow(`${t.language}: ${group.key}`, group))}{result.byType.map(group => breakdownRow(group.key, group))}</tbody></table></div><p className="evaluation-note">{t.groupNote}</p></section></div>
        <section className="evaluation-section"><div className="evaluation-section-heading"><h3>{t.scenarios}</h3><label className="evaluation-check"><input type="checkbox" checked={onlyErrors} onChange={event => setOnlyErrors(event.target.checked)} />{t.errorsOnly}</label></div><p className="evaluation-note">{t.scenarioNote}</p>
          <div className="evaluation-table-wrap evaluation-scroll-table" tabIndex={0} role="region" aria-label={t.scenarios}><table><thead><tr><th>{t.scenario}</th><th>{t.expected}</th><th>{t.missed}</th><th>{t.extra}</th><th>{t.incorrect}</th></tr></thead><tbody>{result.byScenario.filter(row => !onlyErrors || row.missed || row.falsePositive || row.fullErrors).map(row => <tr key={row.scenarioId}><th scope="row"><code>{row.scenarioId}</code></th><td>{row.expected}</td><td>{row.missed}</td><td>{row.falsePositive}</td><td>{row.fullErrors}</td></tr>)}</tbody></table></div>
          {onlyErrors && !result.byScenario.some(row => row.missed || row.falsePositive || row.fullErrors) && <p>{t.noErrors}</p>}
        </section>
        <section className="evaluation-section"><h3>{t.confusion}</h3>{result.confusion.length ? <div className="evaluation-table-wrap evaluation-scroll-table" tabIndex={0} role="region" aria-label={t.confusion}><table><thead><tr><th>{t.expected}</th><th>{t.predicted}</th><th>{t.count}</th></tr></thead><tbody>{result.confusion.map(row => <tr key={`${row.expected}:${row.predicted}`}><th scope="row"><code>{row.expected}</code></th><td>{routeName(row.predicted)}</td><td>{row.count}</td></tr>)}</tbody></table></div> : <p>{t.noErrors}</p>}</section>
        <section className="evaluation-section"><div className="evaluation-section-heading"><h3>{t.errorList} · {result.errors.length}</h3><label>{t.language}<select value={errorLanguage} onChange={event => setErrorLanguage(event.target.value)}><option value="all">{t.all}</option><option value="ru">RU</option><option value="kk">KK</option><option value="mixed">Mixed</option></select></label></div>
          {filteredErrors.length ? <div className="evaluation-table-wrap evaluation-scroll-table" tabIndex={0} role="region" aria-label={t.errorList}><table><thead><tr><th>ID</th><th>{t.language}</th><th>{t.type}</th><th>{t.expected}</th><th>{t.predicted}</th></tr></thead><tbody>{filteredErrors.map(row => <tr key={row.id}><th scope="row">{row.id}</th><td>{row.lang}</td><td>{row.type}</td><td>{row.expected.join(', ')}</td><td>{row.missing ? t.missingResult : row.predicted.length ? row.predicted.join(', ') : t.noRoute}</td></tr>)}</tbody></table></div> : <p>{result.errors.length ? t.noFilteredResults : t.noErrors}</p>}
        </section>
      </>}
    </>}
    <section className="evaluation-comparison"><h3>{t.comparison}</h3>{!comparison ? <p>{t.comparisonEmpty}</p> : <>
      <p><strong>{t.paired}: {comparison.paired}/{rows.length}</strong>. {t.unpaired} {comparison.fullOnly} {t.fullOnly}, {comparison.fastOnly} {t.fastOnly}.</p>
      {comparison.paired ? <><p className="evaluation-note">{t.pairedNote}</p><div className="evaluation-table-wrap" tabIndex={0} role="region" aria-label={t.comparison}><table><thead><tr><th>{t.metric}</th><th>{slotNames.full}</th><th>{slotNames.fast}</th><th>{t.difference}</th></tr></thead><tbody><tr><th scope="row">{t.primary}</th><td>{percent(comparison.full.primaryAccuracy)}</td><td>{percent(comparison.fast.primaryAccuracy)}</td><td>{difference(comparison.primaryAccuracyDelta)}</td></tr><tr><th scope="row">{t.full}</th><td>{percent(comparison.full.fullMatch)}</td><td>{percent(comparison.fast.fullMatch)}</td><td>{difference(comparison.fullMatchDelta)}</td></tr>{comparison.latency && <tr><th scope="row">{t.median} · {t.stages[comparison.latency.stage]}</th><td>{ms(comparison.latency.fullMedianMs)}</td><td>{ms(comparison.latency.fastMedianMs)}</td><td>{ms(comparison.latency.fastMedianMs - comparison.latency.fullMedianMs)}</td></tr>}</tbody></table></div><p>{t.wins}: {comparison.fastWins} · {t.losses}: {comparison.fastLosses}</p></> : <p>{t.noPaired}</p>}
      {comparison.latency ? <p>{t.timingDelta}: {ms(comparison.latency.medianDeltaMs)} ({comparison.latency.n} {t.supplied}).</p> : <p>{t.timingUnavailable}</p>}<p className="evaluation-note">{t.timingNote}</p>
    </>}</section>
  </section>
}
