import { useMemo, useRef, useState } from 'react'
import { Download, FileJson, Upload, X } from 'lucide-react'
import reference from '../../../datas/dev_utterances.json'
import catalog from '../../../datas/scenarios.json'
import { compareRuns, evaluateRun, MAX_EVALUATION_BYTES, parseEvaluationRun, serializeEvaluationReport, type EvaluationGroup, type EvaluationImportError, type EvaluationRun } from '../evaluation-model'
import '../evaluation.css'

const scenarioIds = [...catalog.scenarios.map(scenario => scenario.scenario_id), ...catalog.system_intents.map(intent => intent.id)]
const rows = reference.utterances
type Slot = 'full' | 'fast'
const slotNames = { full: 'Full path', fast: 'Fast path' }
const copy = {
  ru: {
    title: 'Качество маршрутизации', intro: 'Сравните результаты маршрутизатора с 104 размеченными репликами. Расчёт выполняется в браузере; файлы никуда не отправляются.',
    export: 'Скачать отчёт', import: 'Импорт результатов', file: 'Выбрать JSON', clear: 'Удалить результат', loading: 'Читаем файл…', loaded: 'Результат загружен',
    partial: 'Неполный прогон: отсутствующие ID считаются ошибками в итоговой оценке.', ignored: 'Неизвестных ID исключено:', coverage: 'Покрытие',
    paste: 'Или вставьте JSON', target: 'Режим результата', apply: 'Рассчитать', format: 'Формат и методика', formatText: 'Ключ: ID реплики; значение: сценарии в порядке маршрутизатора. Пустой список означает отсутствие маршрута. Не добавляйте тексты, ключи API или персональные данные.',
    latencyFormat: 'Задержки необязательны: latency_ms содержит миллисекунды по ID. latency_stage: router или end_to_end. Сравниваются только одинаковые этапы и общие ID. Это импортированные измерения, не замер браузера.',
    denominator: 'Primary: первый сценарий совпал. Full match: совпали множества сценариев. Знаменатель: все 104 реплики, включая отсутствующие. Intent recall: найденные ожидаемые интенты / все ожидаемые интенты в multi-intent.',
    empty: 'Загрузите результаты backend-оценки, чтобы увидеть ошибки по сценариям и языкам. Здесь нет демонстрационных показателей качества.',
    summary: 'Результаты', metric: 'Метрика', value: 'Значение', primary: 'Primary accuracy', full: 'Full match', recall: 'Intent recall · multi-intent',
    missing: 'Отсутствует результатов', observed: 'Full match только по загруженным', observedWarning: 'Показатель по загруженным не заменяет оценку всего датасета.',
    clarify: 'Доля SYS_UNCLEAR', outOfScope: 'Доля SYS_OUT_OF_SCOPE', rateNote: 'Доли системных ответов: первый сценарий / число загруженных ID, включая пустые ответы.',
    median: 'Медианная задержка', noTiming: 'Измерения не предоставлены', unspecified: 'Этап не указан', supplied: 'измерений',
    breakdown: 'Языки и типы', group: 'Группа', n: 'Реплик', language: 'Язык', type: 'Тип',
    scenarios: 'Ошибки по сценариям', errorsOnly: 'Только с ошибками', scenario: 'Сценарий', expected: 'Ожидается', missed: 'Пропущен', extra: 'Лишний', incorrect: 'Реплик с несовпадением',
    scenarioNote: 'Пропущен: ожидался, но не найден. Лишний: предсказан без эталона. Несовпадения считаются среди реплик, ожидающих этот сценарий; multi-intent может входить в несколько строк.',
    confusion: 'Путаница первого сценария', predicted: 'Предсказан', count: 'Количество', noRoute: 'Нет маршрута', missingResult: 'Нет результата', noErrors: 'Ошибок нет',
    errorList: 'Реплики с несовпадением', all: 'Все', comparison: 'Full path / Fast path', comparisonEmpty: 'Загрузите оба прогона. Сравнение будет рассчитано только по одинаковым ID.',
    paired: 'Общих ID', unpaired: 'Не сравниваются:', fullOnly: 'только Full', fastOnly: 'только Fast', difference: 'Fast − Full', pp: 'п. п.',
    wins: 'Fast исправил', losses: 'Fast ухудшил', pairedNote: 'Оценка ниже относится только к общим ID, а не ко всему датасету. Пустой ответ считается предоставленным результатом.',
    noPaired: 'Общих ID нет. Парное сравнение невозможно.', timingUnavailable: 'Парное сравнение времени недоступно: нужны измерения для общих ID с одинаковым явно указанным этапом.',
    timingDelta: 'Медиана парных разниц', timingNote: 'Отрицательная разница: Fast быстрее. Файлы не доказывают, какой маршрут выполнял сервер; режимы назначает загружающий.',
    source: 'Эталон: datas/dev_utterances.json · v1.0. Формулы: datas/evaluate.py.', jsonLabel: 'JSON с результатами маршрутизации', noFilteredResults: 'Для выбранного языка несовпадений нет.',
    errors: { file_size: 'Файл больше 1 МиБ.', json: 'Некорректный JSON.', schema: 'Нужен JSON-объект с результатами по ID.', no_predictions: 'Нет результатов для известных ID датасета.', scenarios: 'Проверьте сценарии: только известные ID, без повторов; значение должно быть списком или строкой.', latency: 'Проверьте этап и задержки: числа от 0 до 600 000 мс только для предоставленных результатов.', dataset_version: 'Версия датасета не совпадает с 1.0.', read: 'Не удалось прочитать файл. Выберите его повторно.' },
  },
  kk: {
    title: 'Маршруттау сапасы', intro: 'Маршруттау нәтижелерін белгіленген 104 репликамен салыстырыңыз. Есептеу браузерде жүреді; файлдар жіберілмейді.',
    export: 'Есепті жүктеу', import: 'Нәтижелерді импорттау', file: 'JSON таңдау', clear: 'Нәтижені жою', loading: 'Файл оқылуда…', loaded: 'Нәтиже жүктелді',
    partial: 'Толық емес тексеру: жоқ ID қорытынды бағалауда қате саналады.', ignored: 'Белгісіз ID есепке алынбады:', coverage: 'Қамту',
    paste: 'Немесе JSON енгізіңіз', target: 'Нәтиже режимі', apply: 'Есептеу', format: 'Пішім және әдістеме', formatText: 'Кілт: реплика ID-і; мән: маршрутизатор ретімен берілген сценарийлер. Бос тізім маршрут жоқ екенін білдіреді. Мәтіндерді, API кілттерін немесе жеке деректерді қоспаңыз.',
    latencyFormat: 'Кідірістер міндетті емес: latency_ms әр ID үшін миллисекундтарды қамтиды. latency_stage: router немесе end_to_end. Бірдей кезеңдер мен ортақ ID ғана салыстырылады. Бұл браузер өлшемі емес, импортталған өлшемдер.',
    denominator: 'Primary: бірінші сценарий сәйкес. Full match: сценарий жиындары сәйкес. Бөлім: жоқ нәтижелерді қоса алғанда барлық 104 реплика. Intent recall: табылған күтілетін ниеттер / multi-intent ішіндегі барлық күтілетін ниеттер.',
    empty: 'Сценарийлер мен тілдер бойынша қателерді көру үшін backend тексеру нәтижелерін жүктеңіз. Мұнда үлгілік сапа көрсеткіштері жоқ.',
    summary: 'Нәтижелер', metric: 'Метрика', value: 'Мән', primary: 'Primary accuracy', full: 'Full match', recall: 'Intent recall · multi-intent',
    missing: 'Жоқ нәтижелер', observed: 'Тек жүктелгендер бойынша Full match', observedWarning: 'Жүктелген нәтижелер көрсеткіші толық датасет бағасын алмастырмайды.',
    clarify: 'SYS_UNCLEAR үлесі', outOfScope: 'SYS_OUT_OF_SCOPE үлесі', rateNote: 'Жүйелік жауаптар үлесі: бірінші сценарий / бос жауаптарды қоса алғандағы жүктелген ID саны.',
    median: 'Кідіріс медианасы', noTiming: 'Өлшемдер берілмеген', unspecified: 'Кезең көрсетілмеген', supplied: 'өлшем',
    breakdown: 'Тілдер мен түрлер', group: 'Топ', n: 'Реплика', language: 'Тіл', type: 'Түр',
    scenarios: 'Сценарийлер бойынша қателер', errorsOnly: 'Тек қатесі бар', scenario: 'Сценарий', expected: 'Күтіледі', missed: 'Өткізілген', extra: 'Артық', incorrect: 'Сәйкес емес репликалар',
    scenarioNote: 'Өткізілген: күтілді, бірақ табылмады. Артық: эталонда жоқ, бірақ болжанды. Сәйкессіздік осы сценарийді күтетін репликаларда саналады; multi-intent бірнеше жолға кіруі мүмкін.',
    confusion: 'Бірінші сценарийдің шатасуы', predicted: 'Болжанды', count: 'Саны', noRoute: 'Маршрут жоқ', missingResult: 'Нәтиже жоқ', noErrors: 'Қате жоқ',
    errorList: 'Сәйкес емес репликалар', all: 'Барлығы', comparison: 'Full path / Fast path', comparisonEmpty: 'Екі тексеруді де жүктеңіз. Тек бірдей ID салыстырылады.',
    paired: 'Ортақ ID', unpaired: 'Салыстырылмайды:', fullOnly: 'тек Full', fastOnly: 'тек Fast', difference: 'Fast − Full', pp: 'п. т.',
    wins: 'Fast түзетті', losses: 'Fast нашарлатты', pairedNote: 'Төмендегі баға бүкіл датасетке емес, ортақ ID-лерге ғана қатысты. Бос жауап берілген нәтиже саналады.',
    noPaired: 'Ортақ ID жоқ. Жұптық салыстыру мүмкін емес.', timingUnavailable: 'Уақытты жұптық салыстыру қолжетімсіз: бірдей кезең көрсетілген ортақ ID өлшемдері қажет.',
    timingDelta: 'Жұптық айырмалар медианасы', timingNote: 'Теріс айырма: Fast жылдамырақ. Файлдар сервердің қай маршрутты орындағанын дәлелдемейді; режимді жүктеуші белгілейді.',
    source: 'Эталон: datas/dev_utterances.json · v1.0. Формулалар: datas/evaluate.py.', jsonLabel: 'Маршруттау нәтижелері бар JSON', noFilteredResults: 'Таңдалған тілде сәйкессіздіктер жоқ.',
    errors: { file_size: 'Файл 1 МиБ-тан үлкен.', json: 'JSON қате.', schema: 'ID бойынша нәтижелері бар JSON-объект қажет.', no_predictions: 'Датасетте белгілі ID бойынша нәтиже жоқ.', scenarios: 'Сценарийлерді тексеріңіз: тек белгілі, қайталанбайтын ID; мән тізім немесе жол болуы керек.', latency: 'Кезең мен кідірістерді тексеріңіз: берілген нәтижелер үшін 0 мен 600 000 мс аралығындағы сандар.', dataset_version: 'Датасет нұсқасы 1.0-ге сәйкес емес.', read: 'Файл оқылмады. Оны қайта таңдаңыз.' },
  },
}
function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'voice-router-evaluation.json'; anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function EvaluationLab({ language }: { language: 'ru' | 'kk' }) {
  const t = copy[language]
  const [runs, setRuns] = useState<Record<Slot, EvaluationRun | null>>({ full: null, fast: null })
  const [errors, setErrors] = useState<Partial<Record<Slot, EvaluationImportError | 'read'>>>({})
  const [loading, setLoading] = useState<Partial<Record<Slot, boolean>>>({})
  const generations = useRef({ full: 0, fast: 0 })
  const [selected, setSelected] = useState<Slot>('full')
  const [target, setTarget] = useState<Slot>('full')
  const [draft, setDraft] = useState('')
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
    <header className="evaluation-heading"><div><p className="eyebrow">AI LAB / EVALUATION</p><h2 id="evaluation-title">{t.title}</h2><p>{t.intro}</p></div>
      <button className="evaluation-button" disabled={!runs.full && !runs.fast} onClick={() => download(serializeEvaluationReport(rows, runs.full, runs.fast))}><Download size={16} />{t.export}</button>
    </header>
    <section className="evaluation-import" aria-labelledby="evaluation-import-title"><h3 id="evaluation-import-title">{t.import}</h3>
      <div className="evaluation-file-grid">{(['full', 'fast'] as const).map(slot => <fieldset key={slot}><legend>{slotNames[slot]}</legend>
        <label className="evaluation-file"><Upload size={16} />{t.file}<input type="file" accept=".json,application/json" aria-label={`${t.file}: ${slotNames[slot]}`} onChange={event => { void loadFile(event.target.files?.[0], slot); event.target.value = '' }} /></label>
        <div className="evaluation-import-status" aria-live="polite">{loading[slot] ? <span>{t.loading}</span> : runs[slot] ? <span>{t.loaded} · {Object.keys(runs[slot]!.predictions).length}/{rows.length}</span> : <span>JSON · ≤ 1 МиБ</span>}
          {runs[slot] && <button type="button" aria-label={`${t.clear}: ${slotNames[slot]}`} onClick={() => { generations.current[slot] += 1; setRuns(current => ({ ...current, [slot]: null })); setErrors(current => ({ ...current, [slot]: undefined })); setLoading(current => ({ ...current, [slot]: false })); if (selected === slot) setSelected(slot === 'full' ? 'fast' : 'full') }}><X size={16} /></button>}</div>
        {errors[slot] && <p className="evaluation-error" role="alert">{t.errors[errors[slot]!]}</p>}
      </fieldset>)}</div>
      <details className="evaluation-paste"><summary>{t.paste}</summary><label htmlFor="evaluation-target">{t.target}</label><select id="evaluation-target" value={target} onChange={event => setTarget(event.target.value as Slot)}><option value="full">Full path</option><option value="fast">Fast path</option></select>
        <textarea aria-label={t.jsonLabel} value={draft} maxLength={MAX_EVALUATION_BYTES} spellCheck={false} onChange={event => setDraft(event.target.value)} placeholder={'{"U001": ["SC01"]}'} />
        <button className="evaluation-button" disabled={!draft.trim()} onClick={() => { generations.current[target] += 1; setLoading(current => ({ ...current, [target]: false })); accept(draft, target) }}>{t.apply}</button>
      </details>
      <details className="evaluation-method"><summary><FileJson size={16} />{t.format}</summary><p>{t.formatText}</p><pre>{'{"predictions":{"U001":["SC01"]},"latency_ms":{"U001":350},"latency_stage":"router","dataset_version":"1.0"}'}</pre><p>{t.latencyFormat}</p><p>{t.denominator}</p></details>
    </section>
    {!runs.full && !runs.fast ? <p className="evaluation-empty">{t.empty}</p> : <>
      <div className="evaluation-run-picker" role="group" aria-label={t.summary}>{(['full', 'fast'] as const).map(slot => <button key={slot} aria-pressed={selected === slot} disabled={!runs[slot]} onClick={() => setSelected(slot)}>{slotNames[slot]}</button>)}</div>
      {result && run && <>
        <div className="evaluation-coverage"><strong>{t.coverage}: {result.covered}/{rows.length}</strong>{result.missing > 0 && <span>{t.partial}</span>}{run.unknownIdCount > 0 && <span>{t.ignored} {run.unknownIdCount}</span>}</div>
        <div className="evaluation-columns"><section><h3>{t.summary} · {slotNames[selected]}</h3><div className="evaluation-table-wrap" tabIndex={0} role="region" aria-label={t.summary}><table><thead><tr><th>{t.metric}</th><th>{t.value}</th></tr></thead><tbody>
          <tr><th scope="row">{t.primary}</th><td>{percent(result.overall.primaryAccuracy)}</td></tr><tr><th scope="row">{t.full}</th><td>{percent(result.overall.fullMatch)}</td></tr><tr><th scope="row">{t.recall}</th><td>{percent(result.multiIntentRecall)}</td></tr><tr><th scope="row">{t.missing}</th><td>{result.missing}</td></tr>
          <tr><th scope="row">{t.observed}</th><td>{percent(result.observed.fullMatch)} ({result.covered})</td></tr><tr><th scope="row">{t.clarify}</th><td>{percent(result.clarificationRate)}</td></tr><tr><th scope="row">{t.outOfScope}</th><td>{percent(result.outOfScopeRate)}</td></tr>
          <tr><th scope="row">{t.median}</th><td>{result.medianLatencyMs === null ? t.noTiming : <>{ms(result.medianLatencyMs)}<small>{result.timedCount} {t.supplied} · {run.latencyStage === 'unspecified' ? t.unspecified : run.latencyStage}</small></>}</td></tr>
        </tbody></table></div><p className="evaluation-note">{t.observedWarning} {t.rateNote}</p></section>
        <section><h3>{t.breakdown}</h3><div className="evaluation-table-wrap" tabIndex={0} role="region" aria-label={t.breakdown}><table><thead><tr><th>{t.group}</th><th>{t.n}</th><th>Primary</th><th>Full match</th></tr></thead><tbody>{result.byLanguage.map(group => breakdownRow(`${t.language}: ${group.key}`, group))}{result.byType.map(group => breakdownRow(group.key, group))}</tbody></table></div><p className="evaluation-note">{t.denominator}</p></section></div>
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
      {comparison.paired ? <><p className="evaluation-note">{t.pairedNote}</p><div className="evaluation-table-wrap" tabIndex={0} role="region" aria-label={t.comparison}><table><thead><tr><th>{t.metric}</th><th>Full path</th><th>Fast path</th><th>{t.difference}</th></tr></thead><tbody><tr><th scope="row">{t.primary}</th><td>{percent(comparison.full.primaryAccuracy)}</td><td>{percent(comparison.fast.primaryAccuracy)}</td><td>{difference(comparison.primaryAccuracyDelta)}</td></tr><tr><th scope="row">{t.full}</th><td>{percent(comparison.full.fullMatch)}</td><td>{percent(comparison.fast.fullMatch)}</td><td>{difference(comparison.fullMatchDelta)}</td></tr>{comparison.latency && <tr><th scope="row">{t.median} · {comparison.latency.stage}</th><td>{ms(comparison.latency.fullMedianMs)}</td><td>{ms(comparison.latency.fastMedianMs)}</td><td>{ms(comparison.latency.fastMedianMs - comparison.latency.fullMedianMs)}</td></tr>}</tbody></table></div><p>{t.wins}: {comparison.fastWins} · {t.losses}: {comparison.fastLosses}</p></> : <p>{t.noPaired}</p>}
      {comparison.latency ? <p>{t.timingDelta}: {ms(comparison.latency.medianDeltaMs)} ({comparison.latency.n} {t.supplied}).</p> : <p>{t.timingUnavailable}</p>}<p className="evaluation-note">{t.timingNote}</p>
    </>}</section><p className="evaluation-source">{t.source}</p>
  </section>
}
