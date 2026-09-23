import { useState } from 'react';
import { Activity, ArrowRight, AudioLines, Check, CheckCircle2, CircleHelp, Clock3, Copy, Download, Filter, Headphones, ListChecks, ShieldCheck } from 'lucide-react';
import type { CatalogItem, Scenario, Turn } from '../types';
import { asRecord, displayTraceValue, filterTurns, finiteTiming, getActions, getHandoff, getScenarioView, getSessionMetrics, getSlots, maskTraceValue, serializeTrace } from '../supervisor-model';
import type { SlotView, TraceFilters } from '../supervisor-model';
import './supervisor.css';
import { AffectPanel } from './AffectPanel';

const labels = {
  ru: {
    eyebrow: 'ПАНЕЛЬ СУПЕРВИЗОРА', title: 'Трассировка решения', subtitle: 'Маршрут, действия и замеры каждой реплики',
    turn: 'Реплика', empty: 'Здесь появится решение', emptyHelp: 'Начните разговор. После ответа можно проверить его маршрут и действия.',
    unknown: 'Сервер не передал', none: 'Нет', transcript: 'Финальный транскрипт', restored: 'Восстановлена краткая сессия. Полный транскрипт может быть недоступен.',
    primary: 'Основной выбранный сценарий', additional: 'Дополнительные намерения', active: 'Активный сценарий', alternatives: 'Альтернативы, не выбраны',
    pending: 'Очередь следующих задач', suspended: 'Прерванные задачи', reason: 'Причина выбора', order: 'Порядок обработки получен от сервера.',
    priority: 'Приоритет', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный', confidence: 'Оценка модели', confidenceHelp: 'Не является вероятностью правильного ответа.',
    slots: 'Собранные данные', source: 'Источник', slotScenario: 'Сценарий', status: 'Статус', sourceUnknown: 'Источник не передан',
    found: 'Найден', from_profile: 'Из профиля', confirmed: 'Подтверждён', missing: 'Отсутствует', invalid: 'Некорректный',
    actions: 'Действия', mode: 'Режим', preview: 'Подготовка', execute: 'Выполнение', requested: 'Запрошено', awaiting_confirmation: 'Ожидает подтверждения',
    executing: 'Выполняется', completed: 'Выполнено', rejected: 'Отказ клиента', failed: 'Ошибка', arguments: 'Аргументы',
    noActions: 'Действия не переданы', unconfirmed: 'Подготовка не означает выполнение. Результат подтверждает сервер.',
    handoff: 'Передача оператору', queue: 'Очередь оператора', context: 'Контекст для оператора', handoffUnknown: 'Запрошена передача. Подробности сервер не передал.',
    clarification: 'Требуется уточнение', error: 'При обработке получена ошибка. Подробности доступны в диалоге.',
    llm: 'Новый выбор LLM', continuation: 'Продолжение сценария', confirmation: 'Обработка подтверждения', continuationFlag: 'Продолжение', yes: 'Да', no: 'Нет',
    latency: 'Задержка реплики', browserTime: 'До первого звука в браузере', browserText: 'От отправки текста до первого звука', serverTime: 'Серверный total',
    stt: 'Распознавание', triage: 'Проверка входа', router: 'Маршрутизатор', response: 'Подготовка ответа', tts_first_audio: 'Первый аудиочанк',
    timingHelp: 'Этапы измерены сервером. Первый звук измерен браузером; эти значения не суммируются. ∅ означает, что замер не получен.', noTiming: 'Замеры ещё не получены.',
    voiceTimingHelp: 'Граница речи: отпускание кнопки или последний активный кадр VAD. Браузер оценивает начало воспроизведения; физический момент звучания устройства не гарантируется.',
    filters: 'Фильтры', all: 'Все', language: 'Язык', scenario: 'Сценарий', noMatches: 'Нет реплик с такими фильтрами.', clearFilters: 'Сбросить фильтры',
    draft: 'Запись', processing: 'Обработка', answered: 'Ответ', clarify: 'Уточнение', interrupted: 'Прервано',
    copy: 'Копировать JSON', download: 'Скачать JSON', copied: 'Трассировка скопирована', copyError: 'Копирование недоступно. Скачайте JSON.',
    technical: 'Технические поля', exportNote: 'Телефон, ИИН, email и персональные поля замаскированы. Секреты и внутренние ошибки исключены.',
    stats: 'Метрики текущей сессии', voiceMedian: 'Первый звук: медиана голоса', textMedian: 'Первый звук: медиана текста', serverMedian: 'Медиана сервера', routerMedian: 'Медиана маршрутизатора', samples: 'замеров',
    statsHelp: 'Только полученные замеры; отсутствие звука не считается нулевой задержкой. Это не оценка точности маршрутизации.', previewMetrics: 'Иллюстративные значения примера, не результат замера.',
    calls: 'Реплик', clarifications: 'Уточнений', handoffs: 'Передач оператору', errors: 'Реплик с ошибкой', mixed: 'Смешанный', unknownLanguage: 'Не определён',
    providedStatus: 'Статус сервера', profile: 'Профиль', user: 'Клиент', confirmed_by_user: 'Подтверждено клиентом', errorState: 'Ошибка', demo: 'Пример',
    stage: 'Этап сервера', idle: 'Ожидает реплику', listening: 'Слушает', transcribing: 'Распознаёт речь', routing: 'Выбирает маршрут', identifying: 'Уточняет клиента', collecting_slots: 'Собирает данные', executing_action: 'Выполняет действие', responding: 'Готовит ответ', speaking: 'Воспроизводит ответ',
    queued: 'В очереди', connected: 'Соединён', transferred: 'Передан', cancelled: 'Отменён', pendingStatus: 'Ожидается', assigned: 'Назначен',
  },
  kk: {
    eyebrow: 'СУПЕРВАЙЗЕР ПАНЕЛІ', title: 'Шешімнің трассасы', subtitle: 'Әр репликаның бағыты, әрекеттері және өлшемдері',
    turn: 'Реплика', empty: 'Шешім осы жерде көрсетіледі', emptyHelp: 'Әңгімені бастаңыз. Жауаптан кейін бағыт пен әрекеттерді тексеруге болады.',
    unknown: 'Сервер жібермеді', none: 'Жоқ', transcript: 'Соңғы транскрипт', restored: 'Сессияның қысқаша күйі қалпына келтірілді. Толық транскрипт қолжетімсіз болуы мүмкін.',
    primary: 'Таңдалған негізгі сценарий', additional: 'Қосымша ниеттер', active: 'Белсенді сценарий', alternatives: 'Таңдалмаған баламалар',
    pending: 'Келесі тапсырмалар кезегі', suspended: 'Тоқтатылған тапсырмалар', reason: 'Таңдау себебі', order: 'Өңдеу реті серверден алынды.',
    priority: 'Басымдық', normal: 'Қалыпты', high: 'Жоғары', urgent: 'Шұғыл', confidence: 'Модель бағасы', confidenceHelp: 'Дұрыс жауаптың ықтималдығы емес.',
    slots: 'Жиналған деректер', source: 'Дереккөзі', slotScenario: 'Сценарий', status: 'Күйі', sourceUnknown: 'Дереккөзі берілмеді',
    found: 'Табылды', from_profile: 'Профильден', confirmed: 'Расталды', missing: 'Жоқ', invalid: 'Жарамсыз',
    actions: 'Әрекеттер', mode: 'Режим', preview: 'Дайындау', execute: 'Орындау', requested: 'Сұралды', awaiting_confirmation: 'Растау күтілуде',
    executing: 'Орындалуда', completed: 'Орындалды', rejected: 'Клиент бас тартты', failed: 'Қате', arguments: 'Аргументтер',
    noActions: 'Әрекеттер жіберілмеді', unconfirmed: 'Дайындау орындалуды білдірмейді. Нәтижені сервер растайды.',
    handoff: 'Операторға беру', queue: 'Оператор кезегі', context: 'Операторға арналған контекст', handoffUnknown: 'Операторға беру сұралды. Сервер толық ақпарат жібермеді.',
    clarification: 'Нақтылау қажет', error: 'Өңдеу кезінде қате алынды. Толық ақпарат диалогта көрсетілген.',
    llm: 'LLM жаңа таңдауы', continuation: 'Сценарийді жалғастыру', confirmation: 'Растауды өңдеу', continuationFlag: 'Жалғастыру', yes: 'Иә', no: 'Жоқ',
    latency: 'Реплика кідірісі', browserTime: 'Браузердегі алғашқы дыбысқа дейін', browserText: 'Мәтінді жіберуден алғашқы дыбысқа дейін', serverTime: 'Сервердің total уақыты',
    stt: 'Сөйлеуді тану', triage: 'Кірісті тексеру', router: 'Бағыттауыш', response: 'Жауап дайындау', tts_first_audio: 'Алғашқы аудиобөлік',
    timingHelp: 'Кезеңдерді сервер өлшейді. Алғашқы дыбысты браузер өлшейді; мәндер қосылмайды. ∅ өлшем алынбағанын білдіреді.', noTiming: 'Өлшемдер әлі алынбады.',
    voiceTimingHelp: 'Сөйлеу шекарасы: батырманы жіберу немесе VAD соңғы белсенді кадры. Браузер ойнату басталуын бағалайды; құрылғыдағы дыбыстың нақты сәтіне кепілдік берілмейді.',
    filters: 'Сүзгілер', all: 'Барлығы', language: 'Тіл', scenario: 'Сценарий', noMatches: 'Бұл сүзгілерге сәйкес репликалар жоқ.', clearFilters: 'Сүзгілерді тазалау',
    draft: 'Жазылуда', processing: 'Өңделуде', answered: 'Жауап', clarify: 'Нақтылау', interrupted: 'Үзілді',
    copy: 'JSON көшіру', download: 'JSON жүктеу', copied: 'Трасса көшірілді', copyError: 'Көшіру қолжетімсіз. JSON жүктеңіз.',
    technical: 'Техникалық өрістер', exportNote: 'Телефон, ЖСН, email және жеке өрістер жасырылды. Құпиялар мен ішкі қателер алынып тасталды.',
    stats: 'Ағымдағы сессия өлшемдері', voiceMedian: 'Алғашқы дыбыс: дауыс медианасы', textMedian: 'Алғашқы дыбыс: мәтін медианасы', serverMedian: 'Сервер медианасы', routerMedian: 'Бағыттауыш медианасы', samples: 'өлшем',
    statsHelp: 'Тек алынған өлшемдер. Дыбыстың болмауы нөлдік кідіріс емес. Бұл бағыттау дәлдігінің бағасы емес.', previewMetrics: 'Мысалдағы мәндер тек көрнекі, өлшем нәтижесі емес.',
    calls: 'Репликалар', clarifications: 'Нақтылаулар', handoffs: 'Операторға берулер', errors: 'Қатесі бар репликалар', mixed: 'Аралас', unknownLanguage: 'Анықталмады',
    providedStatus: 'Сервер күйі', profile: 'Профиль', user: 'Клиент', confirmed_by_user: 'Клиент растады', errorState: 'Қате', demo: 'Мысал',
    stage: 'Сервер кезеңі', idle: 'Реплика күтілуде', listening: 'Тыңдауда', transcribing: 'Сөйлеуді тануда', routing: 'Бағыт таңдауда', identifying: 'Клиентті нақтылауда', collecting_slots: 'Деректер жинауда', executing_action: 'Әрекет орындалуда', responding: 'Жауап дайындалуда', speaking: 'Жауап ойнатылуда',
    queued: 'Кезекте', connected: 'Қосылды', transferred: 'Берілді', cancelled: 'Бас тартылды', pendingStatus: 'Күтілуде', assigned: 'Тағайындалды',
  },
};
type Copy = typeof labels.ru;
type UiLanguage = 'ru' | 'kk';
const phrase = (value: string | null, t: Copy) => value ? value === 'error' ? t.errorState : value === 'pending' ? t.pendingStatus : (t[value as keyof Copy] ?? displayTraceValue(value)) : t.unknown;
const ms = (value: unknown) => { const valid = finiteTiming(value); return valid === null ? '∅' : `${Math.round(valid).toLocaleString('ru-RU')} ms`; };

function TechnicalDetails({ value, t }: { value: unknown; t: Copy }) {
  return <details className="sv-technical"><summary>{t.technical}</summary><pre>{JSON.stringify(maskTraceValue(value), null, 2)}</pre></details>;
}

function ScenarioLine({ item, t, focus = false }: { item: Scenario; t: Copy; focus?: boolean }) {
  return <div className={`sv-scenario ${focus ? 'sv-scenario-focus' : ''}`}>
    <div className="sv-scenario-title"><code>{displayTraceValue(item.scenario_id)}</code><strong>{displayTraceValue(item.name || item.scenario_id)}</strong></div>
    <span className={`sv-priority sv-priority-${item.priority ?? 'unknown'}`}>{t.priority}: {phrase(item.priority ?? null, t)}</span>
    {item.reason && <p>{displayTraceValue(item.reason)}</p>}
    {typeof item.confidence_estimate === 'number' && <p className="sv-confidence">{t.confidence}: <b>{item.confidence_estimate.toFixed(2)}</b>. {t.confidenceHelp}</p>}
  </div>;
}

function Slots({ slots, t }: { slots: SlotView[]; t: Copy }) {
  return <dl className="sv-slots">{slots.map((slot, index) => <div key={`${slot.name}-${index}`}>
    <dt>{displayTraceValue(slot.name.replaceAll('_', ' '))}</dt>
    <dd><strong>{displayTraceValue(slot.value, slot.name)}</strong><span>{t.status}: {phrase(slot.status, t)}</span><span>{t.source}: {phrase(slot.source, t)}</span>{slot.scenarioId && <span>{t.slotScenario}: {displayTraceValue(slot.scenarioId)}</span>}</dd>
  </div>)}</dl>;
}

function Latency({ turn, t }: { turn: Turn; t: Copy }) {
  const values = asRecord(turn.trace?.latency_ms);
  const stages = ['stt', 'triage', 'router', 'response', 'tts_first_audio'] as const;
  const max = Math.max(...stages.map(key => finiteTiming(values?.[key]) ?? 0), 1);
  return <section className="sv-section"><h3><Clock3 size={16} />{t.latency}</h3>
    <dl className="sv-timing-totals"><div><dt>{turn.mode === 'audio' ? t.browserTime : t.browserText}</dt><dd>{ms(turn.trace?.client_first_audio_ms)}</dd></div><div><dt>{t.serverTime}</dt><dd>{ms(values?.total)}</dd></div></dl>
    {values ? <ol className="sv-timing-stages">{stages.map(key => <li key={key}><span>{t[key]}</span><span className="sv-timing-track" aria-hidden="true"><i style={{ width: `${((finiteTiming(values[key]) ?? 0) / max) * 100}%` }} /></span><b>{ms(values[key])}</b></li>)}</ol> : <p className="sv-muted">{t.noTiming}</p>}
    <p className="sv-help">{t.timingHelp}</p>
    {turn.mode === 'audio' && <p className="sv-help">{t.voiceTimingHelp}</p>}
  </section>;
}

export function SessionMetrics({ turns, language, preview = false }: { turns: Turn[]; language: UiLanguage; preview?: boolean }) {
  const t = labels[language];
  const metrics = getSessionMetrics(preview ? [] : turns);
  return <details className="sv-session-metrics"><summary><Clock3 size={16} />{t.stats}<span>{preview ? t.demo : `${metrics.turns} ${t.calls.toLowerCase()}`}</span></summary>
    {preview ? <p className="sv-help">{t.previewMetrics}</p> : <><dl className="sv-session-timings">{([
      [t.voiceMedian, metrics.voiceFirstAudio], [t.textMedian, metrics.textFirstAudio], [t.serverMedian, metrics.serverTotal], [t.routerMedian, metrics.router],
    ] as const).map(([label, metric]) => <div key={label}><dt>{label}</dt><dd><strong>{ms(metric.median)}</strong><span>{metric.count} {t.samples}</span></dd></div>)}</dl>
      <p className="sv-session-counts">{t.clarifications}: {metrics.clarifications} · {t.handoffs}: {metrics.handoffs} · {t.errors}: {metrics.errors}</p><p className="sv-help">{t.statsHelp}</p></>}
  </details>;
}

export function SupervisorPanel({ turn, turns, selectedId, onSelect, catalog, language }: {
  turn: Turn | null; turns: Turn[]; selectedId: string | null; onSelect: (id: string) => void; catalog: CatalogItem[]; language: UiLanguage;
}) {
  const t = labels[language];
  const [filters, setFilters] = useState<TraceFilters>({ language: '', scenario: '', status: '' });
  const [copyMessage, setCopyMessage] = useState('');
  const filtered = filterTurns(turns, filters);
  const visibleTurn = turn && filtered.some(item => item.id === turn.id) ? turn : null;
  const scenarios = visibleTurn ? getScenarioView(visibleTurn, catalog) : null;
  const route = asRecord(visibleTurn?.route);
  const trace = asRecord(visibleTurn?.trace);
  const slots = getSlots(route?.slots ?? trace?.slots);
  const actions = getActions(trace?.actions, visibleTurn?.preview);
  const handoff = getHandoff(trace?.handoff);
  const agentState = typeof trace?.agent_state === 'string' && ['idle', 'listening', 'transcribing', 'routing', 'identifying', 'collecting_slots', 'awaiting_confirmation', 'executing_action', 'responding', 'speaking', 'handoff', 'completed', 'error'].includes(trace.agent_state) ? trace.agent_state : null;
  const continuation = typeof trace?.is_continuation === 'boolean' ? trace.is_continuation : typeof route?.is_continuation === 'boolean' ? route.is_continuation : route?.source === 'continuation' ? true : null;
  const usedScenarios = [...new Set(turns.flatMap(item => { const view = getScenarioView(item); return [view.primary, view.active, ...view.additional, ...view.pending, ...view.suspended].flatMap(scenario => scenario ? [scenario.scenario_id] : []); }))];
  function changeFilters(next: TraceFilters) {
    setFilters(next); setCopyMessage('');
    const nextTurns = filterTurns(turns, next);
    if (!nextTurns.some(item => item.id === selectedId) && nextTurns.length) onSelect(nextTurns[nextTurns.length - 1].id);
  }
  async function copyTrace() {
    if (!visibleTurn) return;
    try { await navigator.clipboard.writeText(serializeTrace(visibleTurn)); setCopyMessage(t.copied); }
    catch { setCopyMessage(t.copyError); }
  }
  function downloadTrace() {
    if (!visibleTurn) return;
    const url = URL.createObjectURL(new Blob([serializeTrace(visibleTurn)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `voice-router-trace-${visibleTurn.id.replace(/[^\w-]/g, '').slice(0, 64)}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <aside className="supervisor-panel rich-supervisor" aria-label={t.eyebrow}>
    <div className="supervisor-topline"><div><p className="eyebrow">{t.eyebrow}</p><h2>{t.title}</h2><p>{t.subtitle}</p></div><Activity size={20} aria-hidden="true" /></div>
    {turns.length > 0 && <><details className="sv-filters"><summary><Filter size={14} />{t.filters}<span>{filtered.length}/{turns.length}</span></summary><div className="sv-filter-fields">
      <label>{t.language}<select value={filters.language} onChange={event => changeFilters({ ...filters, language: event.target.value })}><option value="">{t.all}</option><option value="ru">Русский</option><option value="kk">Қазақша</option><option value="mixed">{t.mixed}</option><option value="unknown">{t.unknownLanguage}</option></select></label>
      <label>{t.scenario}<select value={filters.scenario} onChange={event => changeFilters({ ...filters, scenario: event.target.value })}><option value="">{t.all}</option>{usedScenarios.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
      <label>{t.status}<select value={filters.status} onChange={event => changeFilters({ ...filters, status: event.target.value })}><option value="">{t.all}</option>{['draft', 'processing', 'answered', 'clarify', 'handoff', 'error', 'interrupted'].map(status => <option value={status} key={status}>{phrase(status, t)}</option>)}</select></label>
    </div></details><nav className="turn-picker" aria-label={t.turn}>{filtered.map(item => <button type="button" aria-pressed={visibleTurn?.id === item.id} aria-label={`${t.turn} ${turns.indexOf(item) + 1}`} className={visibleTurn?.id === item.id ? 'is-selected' : ''} key={item.id} onClick={() => { onSelect(item.id); setCopyMessage(''); }}>{String(turns.indexOf(item) + 1).padStart(2, '0')}</button>)}</nav></>}
    {!visibleTurn || !scenarios ? <div className="empty-trace"><div className="empty-orbit"><AudioLines size={26} /></div><h3>{turns.length ? t.noMatches : t.empty}</h3>{turns.length ? <button type="button" className="sv-text-button" onClick={() => changeFilters({ language: '', scenario: '', status: '' })}>{t.clearFilters}</button> : <p>{t.emptyHelp}</p>}</div> : <div className="trace-content sv-content">
      <div className="sv-meta"><span>{t.turn} {turns.indexOf(visibleTurn) + 1}</span><span>{phrase(visibleTurn.route?.language ?? visibleTurn.language ?? 'unknownLanguage', t)}</span><span>{phrase(visibleTurn.status, t)}</span></div>
      {agentState && <p className="sv-server-state">{t.stage}: <strong>{phrase(agentState, t)}</strong></p>}
      <section className="sv-section sv-transcript"><h3>{t.transcript}</h3><p>{visibleTurn.text ? displayTraceValue(visibleTurn.text) : t.unknown}</p>{visibleTurn.restored && <p className="sv-help">{t.restored}</p>}<dl className="sv-pairs"><div><dt>{t.source}</dt><dd>{phrase(typeof route?.source === 'string' ? route.source : null, t)}</dd></div><div><dt>{t.continuationFlag}</dt><dd>{continuation === null ? t.unknown : continuation ? t.yes : t.no}</dd></div></dl></section>
      <section className="sv-section"><h3><ShieldCheck size={16} />{t.primary}</h3>{scenarios.primary ? <ScenarioLine item={scenarios.primary} t={t} focus /> : <p className="sv-muted">{t.unknown}</p>}</section>
      <section className="sv-section sv-active"><h3><CheckCircle2 size={16} />{t.active}</h3>{scenarios.active ? <ScenarioLine item={scenarios.active} t={t} /> : <p className="sv-muted">{scenarios.activeKnown ? t.none : t.unknown}</p>}</section>
      {scenarios.additional.length > 0 && <section className="sv-section"><h3><ArrowRight size={16} />{t.additional}</h3>{scenarios.additional.map((item, index) => <ScenarioLine item={item} t={t} key={`${item.scenario_id}-${index}`} />)}<p className="sv-help">{t.order}</p></section>}
      {([[t.pending, scenarios.pending, scenarios.pendingKnown], [t.suspended, scenarios.suspended, scenarios.suspendedKnown]] as const).map(([title, items, known]) => <section className="sv-section" key={title}><h3><ListChecks size={16} />{title}</h3>{items.length ? items.map((item, index) => <ScenarioLine item={item} t={t} key={`${item.scenario_id}-${index}`} />) : <p className="sv-muted">{known ? t.none : t.unknown}</p>}</section>)}
      <section className="sv-section"><h3><CircleHelp size={16} />{t.alternatives}</h3>{scenarios.alternatives.length ? scenarios.alternatives.map((item, index) => <ScenarioLine item={item} t={t} key={`${item.scenario_id}-${index}`} />) : <p className="sv-muted">{route && Array.isArray(route.alternatives) ? t.none : t.unknown}</p>}</section>
      {typeof route?.reason === 'string' && <section className="sv-section"><h3>{t.reason}</h3><p>{displayTraceValue(route.reason)}</p></section>}
      <section className="sv-section"><h3><CheckCircle2 size={16} />{t.slots}</h3>{slots.length ? <Slots slots={slots} t={t} /> : <p className="sv-muted">{route?.slots || trace?.slots ? t.none : t.unknown}</p>}</section>
      <section className="sv-section"><h3><Activity size={16} />{t.actions}</h3>{actions.length ? <><ol className="sv-actions">{actions.map((action, index) => <li key={`${action.name}-${index}`}><strong>{displayTraceValue(action.name)}</strong><dl className="sv-pairs"><div><dt>{t.mode}</dt><dd>{phrase(action.mode, t)}</dd></div><div><dt>{t.status}</dt><dd className={`sv-action-state sv-state-${action.status ?? 'unknown'}`}>{phrase(action.status, t)}</dd></div></dl>{action.summary && <p>{displayTraceValue(action.summary)}</p>}{action.args != null && <details className="sv-technical"><summary>{t.arguments}</summary><pre>{JSON.stringify(maskTraceValue(action.args), null, 2)}</pre></details>}{action.error != null && <p className="sv-error">{t.failed}</p>}<TechnicalDetails value={{ name: action.name, mode: action.mode, status: action.status, arguments: action.args }} t={t} /></li>)}</ol><p className="sv-help">{t.unconfirmed}</p></> : <p className="sv-muted">{Array.isArray(trace?.actions) ? t.none : t.noActions}</p>}</section>
      {visibleTurn.status === 'clarify' && <section className="sv-section"><h3><CircleHelp size={16} />{t.clarification}</h3><p>{visibleTurn.reply ? displayTraceValue(visibleTurn.reply) : t.unknown}</p></section>}
      {(handoff || visibleTurn.status === 'handoff') && <section className="sv-section sv-handoff"><h3><Headphones size={16} />{t.handoff}</h3>{handoff ? <><dl className="sv-pairs"><div><dt>{t.reason}</dt><dd>{handoff.reason ? displayTraceValue(handoff.reason) : t.unknown}</dd></div><div><dt>{t.queue}</dt><dd>{handoff.queue ? displayTraceValue(handoff.queue) : t.unknown}</dd></div><div><dt>{t.status}</dt><dd>{phrase(handoff.status, t)}</dd></div><div><dt>{t.context}</dt><dd>{handoff.context == null ? t.unknown : displayTraceValue(handoff.context)}</dd></div><div><dt>{t.active}</dt><dd>{handoff.activeScenario == null ? t.unknown : displayTraceValue(handoff.activeScenario)}</dd></div></dl>{handoff.slots.length > 0 && <Slots slots={handoff.slots} t={t} />}</> : <p>{t.handoffUnknown}</p>}</section>}
      {(visibleTurn.error || asRecord(visibleTurn)?.errorCode || visibleTurn.status === 'error') && <p className="sv-error" role="status">{t.error}</p>}
      <AffectPanel trace={visibleTurn.trace} language={language} />
      <Latency turn={visibleTurn} t={t} />
      <section className="sv-export"><div><button type="button" onClick={() => void copyTrace()}><Copy size={14} />{t.copy}</button><button type="button" onClick={downloadTrace}><Download size={14} />{t.download}</button></div><p className="sv-help">{t.exportNote}</p>{copyMessage && <p role="status" className="sv-copy-status"><Check size={14} />{copyMessage}</p>}</section>
    </div>}
  </aside>;
}
