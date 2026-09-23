import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Pause, Play, RotateCcw, Send, StepForward } from 'lucide-react';
import datasetSource from '../../../datas/dialogs_sample.json';
import {
  getClientSteps, getDatasetResults, isDatasetTurnTerminal, nextReferenceCount,
  parseDialogDataset, redactDatasetValue, serializeDatasetRun,
} from '../dataset-model';
import type { DatasetSubmission, DatasetTurn } from '../dataset-model';
import type { Turn } from '../types';
import '../dataset-player.css';

const dataset = parseDialogDataset(datasetSource);
const titles: Record<string, [string, string]> = {
  D01: ['Расчёт ОГПО и оформление', 'ОГПО есебі және рәсімдеу'],
  D02: ['Выплата по ОГПО виновника', 'Кінәлінің ОГПО-сы бойынша төлем'],
  D03: ['Смена темы и возврат к убытку', 'Тақырыпты ауыстыру және оралу'],
  D04: ['Запись по ДМС, смешанная речь', 'ДМС жазылу, аралас сөйлеу'],
  D05: ['Уточнение и повторная отправка', 'Нақтылау және қайта жіберу'],
  D06: ['Жалоба и передача оператору', 'Шағым және операторға беру'],
  D07: ['Расторжение КАСКО с согласием', 'Келісіммен КАСКО-ны тоқтату'],
  D08: ['Статус убытка и документы', 'Шығын мәртебесі мен құжаттар'],
  D09: ['Мошенничество и проверка полиса', 'Алаяқтық және полисті тексеру'],
  D10: ['Страховка поездки, смена языка', 'Сапар сақтандыруы, тілді ауыстыру'],
};
const tags: Record<string, [string, string]> = {
  scenario_switch: ['Смена сценария', 'Сценарий ауыстыру'], confirmation: ['Подтверждение', 'Растау'],
  kazakh: ['Казахский', 'Қазақша'], topic_switch: ['Смена темы', 'Тақырып ауыстыру'],
  context_return: ['Возврат контекста', 'Мәнмәтінге оралу'], multi_intent: ['Несколько намерений', 'Бірнеше ниет'],
  mixed_language: ['Смешанная речь', 'Аралас сөйлеу'], clarification: ['Уточнение', 'Нақтылау'],
  handoff: ['Оператор', 'Оператор'], emotional: ['Эмоции', 'Эмоциялар'],
  irreversible_action: ['Необратимое действие', 'Қайтымсыз әрекет'], context_carry: ['Память диалога', 'Диалог жады'],
  security: ['Безопасность', 'Қауіпсіздік'], language_switch: ['Смена языка', 'Тілді ауыстыру'],
};
const labels = {
  ru: {
    title: 'Проверка на диалогах', subtitle: '10 размеченных диалогов Saqta. Эталон и фактический ответ сервера всегда разделены.',
    dialog: 'Диалог', reference: 'Эталон', live: 'Прогон через API', client: 'Клиент', bot: 'Ответ из датасета',
    local: 'Локальный показ эталона. Это записанный текст, не ответ модели и не аудиозапись.',
    play: 'Показать по шагам', pause: 'Пауза', next: 'Следующая реплика', reset: 'В начало', all: 'Показать всё',
    details: 'Разметка: сценарии, слоты и действия', expected: 'Ожидаемые сценарии', actual: 'Фактические сценарии',
    start: 'Новая сессия для прогона', startNotice: 'Создаст отдельный разговор и очистит текущую историю. На API отправляется только синтетический текст клиента, без эталонных ответов и меток. Подключённый сервер может использовать платные AI-провайдеры.',
    oneStep: 'Каждая реплика отправляется только по нажатию. Автоматического подтверждения действий нет.',
    waiting: 'Ожидаем готовности новой сессии…', cancelWait: 'Отменить ожидание',
    offline: 'Сессия пока не готова. Проверьте подключение в разговоре или создайте новую сессию.',
    nextClient: 'Следующая реплика клиента', send: 'Отправить эту реплику', sending: 'Ожидаем ответ сервера…',
    review: 'Этот шаг может подтвердить действие. Я проверил фактический ответ и согласен отправить показанную реплику.',
    preview: 'Сервер ожидает подтверждение. Перед отправкой проверьте предпросмотр действия в разговоре.',
    complete: 'Все реплики отправлены.', measured: 'Совпадение набора сценариев', comparisonNotice: 'Сравнение только меток сценариев, не качества ответа, слотов или действий. Это диалоговый набор, не бенчмарк dev_utterances.',
    noResult: 'Результат ещё не получен', matched: 'Совпадает', mismatch: 'Не совпадает', reply: 'Фактический ответ',
    trace: 'Открыть трассировку', export: 'Скачать результаты JSON', empty: 'Нажмите «Показать по шагам» или откройте следующую реплику.',
    invalidated: 'Сессия изменилась. Для точного сопоставления начните новый прогон.',
    interrupted: 'Реплика прервана. Повторная отправка не выполняется автоматически. Начните новую сессию для воспроизводимого прогона.',
    unavailable: 'Связанный ответ отсутствует в истории. Начните новый прогон.',
    rejected: 'Не удалось отправить реплику. Она не добавлена в результаты, повторите после подключения.',
    primary: 'Первый сценарий', step: 'Шаг', serverError: 'Сервер завершил реплику с ошибкой.',
  },
  kk: {
    title: 'Диалогтармен тексеру', subtitle: 'Saqta-ның 10 белгіленген диалогы. Эталон мен сервердің нақты жауабы бөлек көрсетіледі.',
    dialog: 'Диалог', reference: 'Эталон', live: 'API арқылы тексеру', client: 'Клиент', bot: 'Датасеттегі жауап',
    local: 'Эталон жергілікті көрсетіледі. Бұл дайын мәтін, модель жауабы немесе аудиожазба емес.',
    play: 'Қадамдап көрсету', pause: 'Кідірту', next: 'Келесі реплика', reset: 'Басына', all: 'Барлығын көрсету',
    details: 'Белгілер: сценарийлер, слоттар және әрекеттер', expected: 'Күтілетін сценарийлер', actual: 'Нақты сценарийлер',
    start: 'Тексеруге жаңа сессия', startNotice: 'Бөлек сөйлесуді ашып, ағымдағы тарихты тазартады. API-ға эталон жауаптар мен белгілерсіз клиенттің синтетикалық мәтіні ғана жіберіледі. Сервер ақылы AI-провайдерлерді қолдануы мүмкін.',
    oneStep: 'Әр реплика тек батырманы басқанда жіберіледі. Әрекеттер автоматты түрде расталмайды.',
    waiting: 'Жаңа сессияның дайындығын күтеміз…', cancelWait: 'Күтуді тоқтату',
    offline: 'Сессия әлі дайын емес. Сөйлесудегі қосылымды тексеріңіз немесе жаңа сессия ашыңыз.',
    nextClient: 'Клиенттің келесі репликасы', send: 'Осы репликаны жіберу', sending: 'Сервер жауабын күтеміз…',
    review: 'Бұл қадам әрекетті растауы мүмкін. Нақты жауапты тексердім және осы репликаны жіберуге келісемін.',
    preview: 'Сервер растауды күтуде. Жібермес бұрын сөйлесуде әрекеттің алдын ала көрінісін тексеріңіз.',
    complete: 'Барлық репликалар жіберілді.', measured: 'Сценарийлер жиынының сәйкестігі', comparisonNotice: 'Тек сценарий белгілері салыстырылады, жауап, слот немесе әрекет сапасы емес. Бұл диалогтар жиыны, dev_utterances бенчмаркі емес.',
    noResult: 'Нәтиже әлі алынбады', matched: 'Сәйкес', mismatch: 'Сәйкес емес', reply: 'Нақты жауап',
    trace: 'Трассировканы ашу', export: 'JSON нәтижелерін жүктеу', empty: '«Қадамдап көрсету» түймесін басыңыз немесе келесі репликаны ашыңыз.',
    invalidated: 'Сессия өзгерді. Дәл салыстыру үшін жаңа тексеруді бастаңыз.',
    interrupted: 'Реплика үзілді. Ол автоматты түрде қайта жіберілмейді. Қайталанатын тексеру үшін жаңа сессия ашыңыз.',
    unavailable: 'Байланысты жауап тарихта жоқ. Жаңа тексеруді бастаңыз.',
    rejected: 'Реплика жіберілмеді және нәтижелерге қосылмады. Қосылымнан кейін қайталаңыз.',
    primary: 'Бірінші сценарий', step: 'Қадам', serverError: 'Сервер репликаны қатемен аяқтады.',
  },
};

interface DatasetPlayerProps {
  language: 'ru' | 'kk'; turns: Turn[]; sessionId: string | null; canSend: boolean; pendingConfirmation: boolean;
  onSend(text: string): string | null; onNewSession(): void; onSelectTurn(id: string): void;
}
const safeText = (value: string) => String(redactDatasetValue(value));

function ReferenceTurn({ turn, index, language }: { turn: DatasetTurn; index: number; language: 'ru' | 'kk' }) {
  const t = labels[language];
  return <li className={`dataset-reference-turn is-${turn.role}`}>
    <div className="dataset-turn-top"><span>{String(index + 1).padStart(2, '0')}</span><strong>{turn.role === 'client' ? t.client : t.bot}</strong><span>{turn.lang.toUpperCase()}</span></div>
    <p>{safeText(turn.text)}</p>
    {turn.role === 'client' && <div className="dataset-scenarios" aria-label={t.expected}>{turn.scenarios.map(id => <code key={id}>{id}</code>)}</div>}
    <details><summary>{t.details}</summary><pre>{JSON.stringify(redactDatasetValue(turn.role === 'client' ? { scenarios: turn.scenarios, slots: turn.slots } : { actions: turn.actions }), null, 2)}</pre></details>
  </li>;
}

export default function DatasetPlayer({ language, turns, sessionId, canSend, pendingConfirmation, onSend, onNewSession, onSelectTurn }: DatasetPlayerProps) {
  const t = labels[language], localIndex = language === 'ru' ? 0 : 1;
  const [dialogId, setDialogId] = useState('D01');
  const [mode, setMode] = useState<'reference' | 'live'>('reference');
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [submissions, setSubmissions] = useState<DatasetSubmission[]>([]);
  const [runSessionId, setRunSessionId] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [sendError, setSendError] = useState(false);
  const previousSessionId = useRef<string | null>(null);
  const submittedSynchronously = useRef(false);
  const dialog = dataset.dialogs.find(item => item.dialog_id === dialogId)!;
  const steps = useMemo(() => getClientSteps(dialog), [dialog]);
  const results = useMemo(() => getDatasetResults(dialog, submissions, turns), [dialog, submissions, turns]);
  const lastResult = results.at(-1);
  const awaitingResult = Boolean(lastResult?.turn && !isDatasetTurnTerminal(lastResult.turn) && lastResult.turn.status !== 'interrupted');
  const interrupted = lastResult?.turn?.status === 'interrupted';
  const missingResult = Boolean(lastResult && !lastResult.turn);
  const invalidated = Boolean(runSessionId && runSessionId !== sessionId);
  const completed = results.filter(result => result.comparison !== null);
  const next = steps[submissions.length];
  const needsReview = Boolean(next?.requiresReview || pendingConfirmation);
  const canAdvance = Boolean(runSessionId && !invalidated && canSend && !waiting && !awaitingResult && !missingResult && !interrupted && next);

  useEffect(() => {
    if (!playing || shown >= dialog.turns.length) return;
    const timer = window.setTimeout(() => setShown(value => nextReferenceCount(value, dialog.turns.length)), 1800);
    return () => window.clearTimeout(timer);
  }, [playing, shown, dialog.turns.length]);
  useEffect(() => { if (shown >= dialog.turns.length) setPlaying(false); }, [shown, dialog.turns.length]);
  useEffect(() => {
    if (waiting && sessionId && sessionId !== previousSessionId.current && canSend && turns.length === 0) {
      setRunSessionId(sessionId); setWaiting(false);
    }
  }, [waiting, sessionId, canSend, turns.length]);
  useEffect(() => { submittedSynchronously.current = false; }, [submissions.length]);

  function changeDialog(id: string) {
    setDialogId(id); setShown(0); setPlaying(false); setSubmissions([]); setRunSessionId(null); setReviewed(false); setSendError(false);
  }
  function startRun() {
    previousSessionId.current = sessionId;
    setSubmissions([]); setRunSessionId(null); setReviewed(false); setSendError(false); setWaiting(true);
    onNewSession();
  }
  function sendNext() {
    if (!canAdvance || !next || (needsReview && !reviewed) || submittedSynchronously.current) return;
    submittedSynchronously.current = true;
    // No reference replies, expected scenario IDs, slots or tags cross this boundary.
    const id = onSend(next.client.text);
    if (!id) { setSendError(true); submittedSynchronously.current = false; return; }
    setSubmissions(items => [...items, { sourceIndex: next.sourceIndex, turnId: id }]); setReviewed(false); setSendError(false);
  }
  function downloadResults() {
    const url = URL.createObjectURL(new Blob([serializeDatasetRun(dialog, submissions, turns)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${dialog.dialog_id}-results.json`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="dataset-player" aria-labelledby="dataset-title">
    <header className="dataset-heading"><div><p className="eyebrow">DATASET · 10</p><h2 id="dataset-title">{t.title}</h2><p>{t.subtitle}</p></div></header>
    <div className="dataset-layout">
      <aside className="dataset-library">
        <label htmlFor="dataset-dialog">{t.dialog}</label>
        <select id="dataset-dialog" value={dialogId} disabled={waiting || awaitingResult} onChange={event => changeDialog(event.target.value)}>
          {dataset.dialogs.map(item => <option key={item.dialog_id} value={item.dialog_id}>{item.dialog_id} · {titles[item.dialog_id]?.[localIndex] ?? item.title}</option>)}
        </select>
        <h3>{titles[dialog.dialog_id]?.[localIndex] ?? dialog.title}</h3>
        <div className="dataset-tags">{dialog.tags.map(tag => <span key={tag}>{tags[tag]?.[localIndex] ?? tag}</span>)}</div>
        <p className="dataset-meta">{steps.length} {language === 'ru' ? 'реплик клиента' : 'клиент репликасы'} · {dialog.turns.length} {language === 'ru' ? 'шагов эталона' : 'эталон қадамы'}</p>
        <div className="dataset-mode" aria-label={language === 'ru' ? 'Режим проверки' : 'Тексеру режимі'}>
          <button type="button" aria-pressed={mode === 'reference'} disabled={waiting || awaitingResult} onClick={() => { setMode('reference'); setPlaying(false); }}>{t.reference}</button>
          <button type="button" aria-pressed={mode === 'live'} onClick={() => { setMode('live'); setPlaying(false); }}>{t.live}</button>
        </div>
      </aside>
      <div className="dataset-stage">
        {mode === 'reference' ? <>
          <p className="dataset-notice">{t.local}</p>
          <div className="dataset-toolbar">
            <button type="button" onClick={() => { if (shown >= dialog.turns.length) setShown(0); setPlaying(value => !value); }}>{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? t.pause : t.play}</button>
            <button type="button" disabled={shown >= dialog.turns.length} onClick={() => { setPlaying(false); setShown(value => nextReferenceCount(value, dialog.turns.length)); }}><StepForward size={16} />{t.next}</button>
            <button type="button" disabled={shown === 0} onClick={() => { setPlaying(false); setShown(0); }}><RotateCcw size={16} />{t.reset}</button>
            <button type="button" disabled={shown >= dialog.turns.length} onClick={() => { setPlaying(false); setShown(dialog.turns.length); }}>{t.all}</button>
            <output aria-live="polite">{shown} / {dialog.turns.length}</output>
          </div>
          {shown === 0 && <p className="dataset-empty">{t.empty}</p>}
          <ol className="dataset-reference-list">{dialog.turns.slice(0, shown).map((turn, index) => <ReferenceTurn key={`${dialogId}-${index}`} turn={turn} index={index} language={language} />)}</ol>
        </> : <>
          <p className="dataset-notice">{t.oneStep}</p>
          <p className="dataset-muted">{t.startNotice}</p>
          <div className="dataset-toolbar"><button type="button" disabled={waiting || awaitingResult} onClick={startRun}><RotateCcw size={16} />{t.start}</button>
            {submissions.length > 0 && <button type="button" onClick={downloadResults}><Download size={16} />{t.export}</button>}
          </div>
          {waiting && <p role="status" className="dataset-status">{t.waiting} <button type="button" className="text-button" onClick={() => setWaiting(false)}>{t.cancelWait}</button></p>}
          {invalidated && <p role="status" className="dataset-warning">{t.invalidated}</p>}
          {runSessionId && !invalidated && !canSend && !awaitingResult && <p role="status" className="dataset-warning">{t.offline}</p>}
          {interrupted && <p role="status" className="dataset-warning">{t.interrupted}</p>}
          {missingResult && <p role="status" className="dataset-warning">{t.unavailable}</p>}
          {sendError && <p role="alert" className="dataset-warning">{t.rejected}</p>}
          {runSessionId && !invalidated && <div className="dataset-run-progress">
            <span>{t.step} {completed.length} / {steps.length}</span>
            <progress max={steps.length} value={completed.length} aria-label={t.step} />
            <span>{t.measured}: {completed.filter(result => result.comparison?.exactMatch).length} / {completed.length}</span>
          </div>}
          <div className="dataset-results">{results.map((result, index) => <article key={result.turnId} className="dataset-result">
            <div className="dataset-turn-top"><strong>{t.client} {index + 1}</strong><span>{result.step.client.lang.toUpperCase()}</span></div>
            <p>{safeText(result.step.client.text)}</p>
            <dl className="dataset-comparison"><div><dt>{t.expected}</dt><dd>{result.step.client.scenarios.join(', ')}</dd></div><div><dt>{t.actual}</dt><dd>{result.comparison ? result.comparison.predicted.join(', ') || '∅' : t.noResult}</dd></div></dl>
            {result.comparison && <p className={`dataset-outcome ${result.comparison.exactMatch ? 'is-match' : 'is-mismatch'}`}>{result.comparison.exactMatch ? t.matched : t.mismatch} · {t.primary}: {result.comparison.primaryMatch ? t.matched : t.mismatch}</p>}
            {result.turn?.reply && <div className="dataset-actual-reply"><strong>{t.reply}</strong><p>{safeText(result.turn.reply)}</p></div>}
            {result.turn?.status === 'error' && <p className="dataset-warning">{t.serverError}</p>}
            {result.turn && <button type="button" className="text-button" onClick={() => onSelectTurn(result.turnId)}>{t.trace}</button>}
          </article>)}</div>
          {awaitingResult && <p role="status" className="dataset-status">{t.sending}</p>}
          {runSessionId && !invalidated && next && !awaitingResult && <section className="dataset-next" aria-label={t.nextClient}>
            <h3>{t.nextClient} · {submissions.length + 1} / {steps.length}</h3><p>{safeText(next.client.text)}</p>
            {pendingConfirmation && <p className="dataset-warning">{t.preview}</p>}
            {needsReview && <label className="dataset-review"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />{t.review}</label>}
            <button type="button" className="primary-button" disabled={!canAdvance || (needsReview && !reviewed)} onClick={sendNext}><Send size={16} />{t.send}</button>
          </section>}
          {runSessionId && !invalidated && !next && !awaitingResult && !interrupted && !missingResult && <p role="status" className="dataset-status">{t.complete}</p>}
          <p className="dataset-muted">{t.comparisonNotice}</p>
        </>}
      </div>
    </div>
  </section>;
}
