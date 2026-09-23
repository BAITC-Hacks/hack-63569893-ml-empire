import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft, ArrowRight, AudioLines, Check,
  ChevronDown, ChevronRight, CircleHelp, Clock3, Headphones, Languages,
  Mic, Play, RotateCcw, Send, ShieldCheck, Square, PhoneOff, Settings2,
  Sparkles, Volume2, VolumeX, Wifi, WifiOff, X,
} from 'lucide-react';
import { maskPersonalData } from './session-state';
import { useVoiceSession } from './useVoiceSession';
import { SupervisorPanel, SessionMetrics } from './components/SupervisorPanel';
import { displayTraceValue } from './supervisor-model';
import { elapsedSeconds, errorText, formatDuration } from './client-state';
import type { CallPhase, ConnectionStatus, Turn } from './types';

const PREVIEW_TURN_ID = 'preview-turn';

const copy = {
  ru: {
    nav: 'Голосовой помощник', supervisor: 'Супервизор', newCall: 'Новый звонок',
    workspace: 'Рабочее пространство', headline: 'Один разговор. Правильный сценарий.',
    intro: 'Говорите как обычно. Помощник поймёт запрос на русском и казахском и покажет, как принял решение.',
    start: 'Начать разговор', preview: 'Посмотреть пример', previewTag: 'Пример интерфейса',
    previewHint: 'Это пример отображения. Маршрутизация здесь не выполняется.',
    connect: 'Подключаемся к серверу', offline: 'Нет подключения', preparing: 'Подключаем микрофон',
    ready: 'На связи', listening: 'Слушаю вас', processing: 'Обрабатываю запрос', speaking: 'Отвечаю',
    transcript: 'Разговор', emptyConversation: 'История разговора появится здесь',
    hold: 'Удерживайте, чтобы говорить', release: 'Отпустите, чтобы отправить',
    textPlaceholder: 'Или напишите сообщение…', send: 'Отправить',
    voiceDisclosure: 'Голос помощника синтезирован ИИ',
    trace: 'Трассировка решений', traceSub: 'После каждой реплики клиента',
    emptyTrace: 'Решение появится после первой реплики',
    scenario: 'Основной сценарий', more: 'Другие сценарии', alternatives: 'Альтернативы',
    reason: 'Почему выбран', source: 'Источник решения', slots: 'Найденные данные',
    actions: 'Действия', latency: 'Время ответа', serverTime: 'На сервере',
    browserTime: 'До первого звука в браузере', total: 'Всего',
    confirmTitle: 'Нужно подтверждение', confirmHelp: 'Действие ещё не выполнено.',
    confirm: 'Подтвердить', reject: 'Отказаться', handoff: 'Передача оператору',
    retry: 'Повторить', end: 'Завершить', listeningNow: 'Идёт запись',
    noConnection: 'Подключите сервер, чтобы начать реальный разговор.',
    textFallback: 'Текстовый ввод доступен при проблемах с микрофоном.',
    overview: 'Обзор', metrics: 'Метрики', details: 'Детали',
    selectedTurn: 'Реплика', modelEstimate: 'Оценка модели',
    replay: 'Воспроизвести ответ', unmute: 'Включить звук', mute: 'Отключить звук',
    restored: 'Восстановлено последнее состояние сессии. Полная история не хранится в браузере.',
    interrupted: 'Реплика прервана. Проверьте состояние в трассировке перед повтором.',
    noTranscript: 'Транскрипт не получен', recognizing: 'Распознаём речь…',
    failed: 'Не удалось обработать реплику', noReply: 'Текст ответа не получен',
    clarify: 'Нужно уточнение', reconnect: 'Подключиться снова',
    queued: 'В очереди', suspended: 'Приостановлено', waiting: 'Ожидаем решение маршрутизатора…',
    confidenceHelp: 'Оценка модели, не калиброванная вероятность',
    snapshotStatus: 'Доступна последняя трассировка. Статус прошлой реплики API не передаёт.',
  },
  kk: {
    nav: 'Дауыстық көмекші', supervisor: 'Супервизор', newCall: 'Жаңа қоңырау',
    workspace: 'Жұмыс кеңістігі', headline: 'Бір әңгіме. Дұрыс сценарий.',
    intro: 'Әдеттегідей сөйлесіңіз. Көмекші қазақша және орысша сұрауды түсініп, шешімін көрсетеді.',
    start: 'Әңгімені бастау', preview: 'Үлгіні көру', previewTag: 'Интерфейс үлгісі',
    previewHint: 'Бұл тек көрсету үлгісі. Сценарий таңдалмайды.',
    connect: 'Серверге қосылуда', offline: 'Байланыс жоқ', preparing: 'Микрофон қосылуда',
    ready: 'Байланыста', listening: 'Тыңдап тұрмын', processing: 'Сұрауды өңдеудемін', speaking: 'Жауап берудемін',
    transcript: 'Әңгіме', emptyConversation: 'Әңгіме тарихы осы жерде көрсетіледі',
    hold: 'Сөйлеу үшін басып тұрыңыз', release: 'Жіберу үшін босатыңыз',
    textPlaceholder: 'Немесе хабарлама жазыңыз…', send: 'Жіберу',
    voiceDisclosure: 'Көмекші дауысы ЖИ арқылы жасалған',
    trace: 'Шешімдер ізі', traceSub: 'Әр клиент репликасынан кейін',
    emptyTrace: 'Шешім бірінші репликадан кейін пайда болады',
    scenario: 'Негізгі сценарий', more: 'Басқа сценарийлер', alternatives: 'Балама нұсқалар',
    reason: 'Таңдау себебі', source: 'Шешім көзі', slots: 'Табылған деректер',
    actions: 'Әрекеттер', latency: 'Жауап уақыты', serverTime: 'Серверде',
    browserTime: 'Браузердегі алғашқы дыбысқа дейін', total: 'Барлығы',
    confirmTitle: 'Растау қажет', confirmHelp: 'Әрекет әлі орындалған жоқ.',
    confirm: 'Растау', reject: 'Бас тарту', handoff: 'Операторға беру',
    retry: 'Қайталау', end: 'Аяқтау', listeningNow: 'Жазылып жатыр',
    noConnection: 'Нақты сөйлесу үшін серверді қосыңыз.',
    textFallback: 'Микрофон жұмыс істемесе, мәтін енгізуге болады.',
    overview: 'Шолу', metrics: 'Метрикалар', details: 'Толығырақ',
    selectedTurn: 'Реплика', modelEstimate: 'Модель бағасы',
    replay: 'Жауапты тыңдау', unmute: 'Дыбысты қосу', mute: 'Дыбысты өшіру',
    restored: 'Сессияның соңғы күйі қалпына келтірілді. Толық тарих браузерде сақталмайды.',
    interrupted: 'Реплика үзілді. Қайталаудан бұрын шешімдер ізін тексеріңіз.',
    noTranscript: 'Транскрипт алынбады', recognizing: 'Сөйлеуді тану…',
    failed: 'Репликаны өңдеу мүмкін болмады', noReply: 'Жауап мәтіні алынбады',
    clarify: 'Нақтылау қажет', reconnect: 'Қайта қосылу',
    queued: 'Кезекте', suspended: 'Тоқтатылды', waiting: 'Маршрутизатор шешімін күтудеміз…',
    confidenceHelp: 'Модель бағасы, калибрленген ықтималдық емес',
    snapshotStatus: 'Соңғы шешімдер ізі қолжетімді. API алдыңғы реплика күйін бермейді.',
  },
};

const previewTurn: Turn = {
  id: PREVIEW_TURN_ID,
  mode: 'audio',
  text: 'Кеше көлігімді соғып кетті, КАСКО бар. Осмотрға қалай жазыламын?',
  language: 'mixed',
  reply: 'Помогу оформить обращение по КАСКО. Сначала уточню номер полиса, затем запишу вас на осмотр.',
  replyLanguage: 'ru',
  status: 'answered',
  at: Date.now(),
  preview: null,
  route: {
    scenarios: [
      { scenario_id: 'SC13', name: 'Ущерб по КАСКО', priority: 'high', reason: 'Клиент сообщает об ущербе своему автомобилю и упоминает КАСКО.', confidence_estimate: 0.86 },
      { scenario_id: 'SC20', name: 'Запись на осмотр', priority: 'normal', reason: 'Клиент также спрашивает, как записаться на осмотр.' },
    ],
    alternatives: [{ scenario_id: 'SC11', name: 'ДТП только что' }],
    reason: 'Основной запрос касается ущерба по КАСКО; запись на осмотр остаётся следующим вопросом.',
    language: 'mixed',
    source: 'llm',
    slots: { insurance_type: 'КАСКО', policy_number: null },
    pending_scenarios: [{ scenario_id: 'SC20', name: 'Запись на осмотр' }],
  },
  trace: {
    actions: ['find_client:requested'],
    latency_ms: { stt: 210, triage: 5, router: 540, response: 92, tts_first_audio: 280, total: 1280 },
    client_first_audio_ms: 1410,
  },
};

function HalykMark() {
  return <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>;
}

function StatusPill({ status, phase, preview, t }: {
  status: ConnectionStatus; phase: CallPhase; preview: boolean; t: typeof copy.ru;
}) {
  const title = preview ? t.previewTag : status === 'connecting' || status === 'reconnecting' ? t.connect : status === 'offline' ? t.offline : phase === 'preparing' ? t.preparing : phase === 'recording' ? t.listening : phase === 'processing' ? t.processing : phase === 'speaking' ? t.speaking : t.ready;
  return <span role="status" className={`status-pill ${status === 'offline' && !preview ? 'is-offline' : ''} ${phase === 'recording' ? 'is-recording' : ''}`}>
    <span className="status-dot" />{title}
  </span>;
}

function CallTimer({ startedAt, endedAt, label }: { startedAt: number; endedAt: number | null; label: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (endedAt !== null) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [endedAt]);
  return <span className="call-timer" aria-label={label}><Clock3 size={14} />{formatDuration(elapsedSeconds(startedAt, endedAt, now))}</span>;
}

export default function App() {
  const [language, setLanguage] = useState<'ru' | 'kk'>('ru');
  const [textInput, setTextInput] = useState('');
  const [mobileTab, setMobileTab] = useState<'conversation' | 'trace'>('conversation');
  const {
    session, connection, phase, turns, selectedId, setSelectedId, catalog, error,
    preview, pendingPreview, muted, beginCall, reconnect, endCall: finishCall, resetCall,
    ended, startedAt, endedAt, level, devices, deviceId, setDeviceId, micMode, setMicMode, silenceMs, setSilenceMs, refreshDevices, stopPlayback,
    submitText: sendText, startRecording, finishRecording, replay, hasAudio,
    dismissError, toggleMuted, showPreview: enterPreview,
  } = useVoiceSession();
  const t = copy[language];
  const conversationRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draftRetry, setDraftRetry] = useState(false);
  const wasNearBottomRef = useRef(true);
  const selectedTurn = useMemo(() => turns.find((turn) => turn.id === selectedId) ?? turns.at(-1) ?? null, [turns, selectedId]);

  function endCall() {
    resetCall(); setTextInput(''); setMobileTab('conversation');
    wasNearBottomRef.current = true;
  }
  function showPreview() { enterPreview(previewTurn); setMobileTab('conversation'); }
  function submitText(event?: React.FormEvent, override?: string) {
    event?.preventDefault();
    if (sendText(override ?? textInput)) { setTextInput(''); setDraftRetry(false); }
  }
  function handleConversationScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    wasNearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }
  useEffect(() => {
    const element = conversationRef.current;
    if (element && wasNearBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [turns]);
  useEffect(() => { document.documentElement.lang = language; }, [language]);

  const canInteract = connection === 'ready' && phase === 'idle' && !preview && !ended;
  const hasSession = Boolean(session || preview || connection === 'connecting');

  return <div className="app-shell">
    <header className="site-header"><div className="header-inner">
      <div className="brand"><HalykMark /><span>Halyk</span><span className="brand-divider" /><span className="product-name">Voice Router</span></div>
      <nav className="header-nav" aria-label={t.workspace}><span className="nav-active">{t.workspace}</span><span className="nav-muted">AI Lab</span></nav>
      <div className="header-actions"><button className="language-button" onClick={() => setLanguage(language === 'ru' ? 'kk' : 'ru')} aria-label={language === 'ru' ? 'Переключить язык интерфейса' : 'Интерфейс тілін ауыстыру'}><Languages size={17} /><span>{language === 'ru' ? 'Рус' : 'Қаз'}</span><ChevronDown size={14} /></button>
        {hasSession && <button className="header-new" aria-label={t.newCall} onClick={() => { void endCall(); }}><RotateCcw size={16} /><span>{t.newCall}</span></button>}
      </div>
    </div></header>

    <main className="page-main">
      <div className="page-intro"><div><p className="eyebrow">HALYK · AI EXPERIENCE</p><h1>{t.nav}</h1><p>{t.intro}</p></div><StatusPill status={connection} phase={phase} preview={preview} t={t} /></div>
      <div className="data-disclosure"><ShieldCheck size={18} /><p>{language === 'ru' ? 'Учебный прототип для трека Halyk на вымышленных сценариях Saqta Insurance. Только синтетические данные: не сообщайте реальные ИИН, телефоны, номера полисов и не загружайте записи клиентов. Это не банковский сервис.' : 'Halyk трегіне арналған Saqta Insurance ойдан шығарылған сценарийлері бар оқу прототипі. Тек синтетикалық деректер: нақты ЖСН, телефон, полис нөмірлері мен клиент жазбаларын қолданбаңыз. Бұл банк қызметі емес.'}</p></div>
      {import.meta.env.VITE_TEST_MODE === 'true' && <div className="preview-banner" role="status">{language === 'ru' ? 'Тестовый API: синтетические ответы, без LLM/STT/TTS и реальных операций.' : 'Тест API: синтетикалық жауаптар, LLM/STT/TTS және нақты операциялар жоқ.'}</div>}
      {ended && <div className="ended-notice" role="status"><PhoneOff size={17} />{language === 'ru' ? 'Звонок завершён. История и аудио сохранены до нового звонка или перезагрузки.' : 'Қоңырау аяқталды. Тарих пен аудио жаңа қоңырауға не бетті қайта жүктеуге дейін сақталады.'}</div>}
      {error && <div className="error-banner" role="alert"><WifiOff size={18} /><span>{errorText(error, language)}</span><button onClick={dismissError} aria-label={language === 'ru' ? 'Закрыть сообщение' : 'Хабарламаны жабу'}><X size={17} /></button></div>}
      {session && !ended && connection === 'offline' && <div className="reconnect-notice"><WifiOff size={17} /><span>{t.offline}</span><button onClick={() => void reconnect()}>{t.reconnect}</button></div>}
      {preview && <div className="preview-banner"><Sparkles size={17} /><span>{t.previewHint}</span><button onClick={endCall}>{t.end}</button></div>}
      <div className="mobile-tabs" aria-label={t.workspace}><button aria-pressed={mobileTab === 'conversation'} className={mobileTab === 'conversation' ? 'is-active' : ''} onClick={() => setMobileTab('conversation')}>{t.transcript}</button><button aria-pressed={mobileTab === 'trace'} className={mobileTab === 'trace' ? 'is-active' : ''} onClick={() => setMobileTab('trace')}>{t.trace}</button></div>
      <div className={`workspace ${mobileTab === 'trace' ? 'show-trace' : ''}`}>
        <section className="conversation-panel">
          <div className="panel-heading"><div><p className="eyebrow">01 / CLIENT CONVERSATION</p><h2>{t.transcript}</h2></div><div className="panel-heading-right">{startedAt !== null && <CallTimer startedAt={startedAt} endedAt={endedAt} label={language === 'ru' ? 'Длительность звонка' : 'Қоңырау ұзақтығы'} />}{session && !ended && <button className="end-call" onClick={() => { finishCall(); setDraftRetry(false); }} aria-label={language === 'ru' ? 'Завершить звонок' : 'Қоңырауды аяқтау'} title={t.end}><PhoneOff size={16} />{t.end}</button>}<span className={`live-indicator ${connection !== 'ready' && !preview ? 'is-offline' : ''}`}><span />{preview ? t.previewTag : connection === 'ready' ? t.ready : connection === 'offline' ? t.offline : t.connect}</span></div></div>
          <div className={`conversation-body ${turns.length === 0 ? 'is-empty' : ''}`} ref={conversationRef} onScroll={handleConversationScroll} tabIndex={0} role="region" aria-label={t.transcript}>
            {turns.length === 0 ? <div className="welcome-state"><div className="welcome-symbol"><AudioLines size={38} strokeWidth={1.7} /><i className="pulse-one" /><i className="pulse-two" /></div><span className="welcome-kicker">VOICE ROUTER</span><h3>{t.headline}</h3><p>{session ? (micMode === 'hold' ? t.hold : language === 'ru' ? 'Нажмите, чтобы говорить' : 'Сөйлеу үшін басыңыз') : t.emptyConversation}</p><div className="welcome-actions">{!session && <button className="primary-button" onClick={() => void beginCall()} disabled={connection === 'connecting' || connection === 'reconnecting'}><Mic size={18} />{t.start}<ArrowRight size={17} /></button>}{!session && <button className="text-button" onClick={showPreview} disabled={connection !== 'offline'}>{t.preview}<ChevronRight size={16} /></button>}</div></div> : <div className="turn-list">
              {turns.map((turn, index) => <div className="turn-group" key={turn.id}>
                <div className="turn-index"><span>{String(index + 1).padStart(2, '0')}</span><span>{new Date(turn.at).toLocaleTimeString(language === 'kk' ? 'kk-KZ' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })}</span></div>
                <div className="message user-message"><div className="message-author"><span className="avatar client-avatar"><ArrowDownLeft size={15} /></span><b>{language === 'kk' ? 'Клиент' : 'Клиент'}</b><span className="message-language">{turn.language?.toUpperCase() || (turn.mode === 'text' ? 'TEXT' : 'AUDIO')}</span></div><p>{maskPersonalData(turn.text || turn.partialText || (turn.restored ? t.restored : turn.status === 'error' || turn.status === 'interrupted' ? t.noTranscript : phase === 'preparing' ? t.preparing : t.recognizing))}</p></div>
                {turn.reply ? <div className="message agent-message"><div className="message-author"><span className="avatar agent-avatar"><AudioLines size={16} /></span><b>Halyk AI</b><span className="message-language">{turn.replyLanguage?.toUpperCase() || 'AI'}</span></div><p>{maskPersonalData(turn.reply)}</p><div className="message-tools">{!preview && hasAudio(turn.id) && <button onClick={() => void replay(turn.id)} disabled={phase !== 'idle' || muted} title={t.replay}><Play size={14} />{language === 'kk' ? 'Қайта тыңдау' : 'Повторить звук'}</button>}<span><Sparkles size={13} /> AI voice</span></div></div> : <div className="reply-pending">{turn.status === 'processing' && <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>}{turn.status === 'processing' ? t.processing : turn.status === 'interrupted' ? (turn.restored ? t.snapshotStatus : t.interrupted) : turn.status === 'error' ? t.failed : t.noReply}</div>}
                {(turn.errorCode || turn.error) && <p className="turn-error">{errorText(turn.errorCode, language)}</p>}
                {(turn.status === 'error' || turn.status === 'interrupted') && turn.text && !turn.restored && !preview && <button className="retry-draft" disabled={!canInteract} onClick={() => { setTextInput(turn.text); setDraftRetry(true); inputRef.current?.focus(); }}>{language === 'ru' ? 'Вернуть текст в поле ввода' : 'Мәтінді енгізу өрісіне қайтару'}</button>}
                {turn.status === 'clarify' && <div className="handoff-note"><CircleHelp size={17} />{t.clarify}</div>}
                {turn.status === 'handoff' && <div className="handoff-note"><Headphones size={17} />{t.handoff}</div>}
              </div>)}
            </div>}
          </div>
          <div className="composer-area">
            <div className="sr-only" aria-live="polite" aria-atomic="true">{phase === 'processing' ? t.processing : phase === 'recording' ? t.listening : turns.at(-1)?.reply ? maskPersonalData(turns.at(-1)!.reply) : ''}</div>
            {draftRetry && <p className="retry-warning">{language === 'ru' ? 'Текст не отправлен повторно. Проверьте результат прошлой операции в трассировке: повтор может создать дубликат.' : 'Мәтін қайта жіберілмеді. Шешімдер ізінен алдыңғы әрекетті тексеріңіз: қайталау көшірме тудыруы мүмкін.'}</p>}
            {pendingPreview && !preview && <div className="confirmation-strip"><div><ShieldCheck size={20} /><span><strong>{t.confirmTitle}</strong><small>{displayTraceValue(pendingPreview.summary)} {t.confirmHelp}<br /><code>{displayTraceValue(pendingPreview.name)}</code>{pendingPreview.masked_args && <span className="confirmation-args">{Object.entries(pendingPreview.masked_args).map(([key, value]) => <span key={key}>{key}: {displayTraceValue(value, key)} </span>)}</span>}</small></span></div><div><button className="confirm-button" onClick={() => submitText(undefined, language === 'kk' ? 'Иә, растаймын' : 'Да, подтверждаю')} disabled={!canInteract}><Check size={16} />{t.confirm}</button><button className="reject-button" onClick={() => submitText(undefined, language === 'kk' ? 'Жоқ, бас тартамын' : 'Нет, отказываюсь')} disabled={!canInteract}>{t.reject}</button></div></div>}
            <div className="composer-main"><button className={`mic-button ${phase === 'recording' ? 'is-recording' : ''}`} title={micMode === 'auto' ? (language === 'ru' ? 'Нажмите для начала или завершения записи' : 'Жазуды бастау не аяқтау үшін басыңыз') : phase === 'recording' ? t.release : t.hold} aria-label={micMode === 'auto' ? (phase === 'recording' || phase === 'preparing' ? (language === 'ru' ? 'Завершить запись' : 'Жазуды аяқтау') : (language === 'ru' ? 'Начать запись' : 'Жазуды бастау')) : phase === 'recording' ? t.release : t.hold} aria-pressed={phase === 'recording' || phase === 'preparing'} disabled={!canInteract && phase !== 'recording' && phase !== 'preparing'}
              onClick={event => { if (micMode === 'auto' || event.detail === 0 && phase === 'idle') { if (phase === 'recording' || phase === 'preparing') void finishRecording(); else startRecording(); } }}
              onPointerDown={event => { if (micMode !== 'hold' || event.pointerType === 'mouse' && event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); startRecording(); }}
              onPointerUp={() => { if (micMode === 'hold') void finishRecording(); }}
              onPointerCancel={() => { void finishRecording(); }} onLostPointerCapture={() => { if (micMode === 'hold') void finishRecording(); }} onBlur={() => { if (micMode === 'hold') void finishRecording(); }}
              onKeyDown={event => { if (micMode === 'hold' && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); if (!event.repeat) startRecording(); } }}
              onKeyUp={event => { if (micMode === 'hold' && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); void finishRecording(); } }}
            ><Mic size={21} /></button>
              <form className="text-form" onSubmit={(event) => submitText(event)}><input ref={inputRef} value={textInput} onChange={(event) => setTextInput(event.target.value)} maxLength={4000} placeholder={t.textPlaceholder} aria-label={t.textPlaceholder} disabled={!canInteract} /><button type="submit" aria-label={t.send} disabled={!canInteract || !textInput.trim()}><Send size={18} /></button></form>
              <button className="sound-button" onClick={toggleMuted} aria-pressed={muted} aria-label={muted ? t.unmute : t.mute} title={muted ? t.unmute : t.mute}>{muted ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
            </div>
            {(phase === 'recording' || phase === 'preparing') && <div className="recording-controls"><label>{language === 'ru' ? 'Уровень микрофона' : 'Микрофон деңгейі'}<meter min={0} max={1} value={Math.min(1, level * 4)} aria-label={language === 'ru' ? 'Уровень микрофона' : 'Микрофон деңгейі'} /></label><button onClick={() => void finishRecording()}>{language === 'ru' ? 'Завершить реплику' : 'Репликаны аяқтау'}</button></div>}
            {phase === 'speaking' && <button className="stop-audio" onClick={stopPlayback}><Square size={13} />{language === 'ru' ? 'Остановить звук' : 'Дыбысты тоқтату'}</button>}
            <details className="audio-settings"><summary><Settings2 size={14} />{language === 'ru' ? 'Настройки микрофона' : 'Микрофон баптаулары'}</summary><div>
              <label>{language === 'ru' ? 'Микрофон' : 'Микрофон'}<select disabled={phase !== 'idle'} value={deviceId} onChange={event => setDeviceId(event.target.value)}><option value="">{language === 'ru' ? 'Системный по умолчанию' : 'Жүйелік әдепкі'}</option>{devices.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${language === 'ru' ? 'Микрофон' : 'Микрофон'} ${index + 1}`}</option>)}</select></label>
              <label>{language === 'ru' ? 'Режим записи' : 'Жазу режимі'}<select disabled={phase !== 'idle'} value={micMode} onChange={event => setMicMode(event.target.value as 'hold' | 'auto')}><option value="hold">{language === 'ru' ? 'Удерживать кнопку' : 'Батырманы басып тұру'}</option><option value="auto">{language === 'ru' ? 'Завершать после тишины' : 'Тыныштықтан кейін аяқтау'}</option></select></label>
              {micMode === 'auto' && <label>{language === 'ru' ? 'Пауза до завершения' : 'Аяқтау алдындағы үзіліс'}: {silenceMs / 1000} s<input type="range" min={800} max={2500} step={100} value={silenceMs} disabled={phase !== 'idle'} onChange={event => setSilenceMs(Number(event.target.value))} /></label>}
              <button onClick={() => void refreshDevices()}>{language === 'ru' ? 'Обновить устройства' : 'Құрылғыларды жаңарту'}</button><p>{language === 'ru' ? 'Имена устройств появятся после разрешения доступа. Определение тишины работает локально; шум может помешать. Реплику всегда можно завершить вручную.' : 'Құрылғы атаулары рұқсат берілгеннен кейін көрінеді. Тыныштық жергілікті анықталады; шу кедергі болуы мүмкін. Репликаны қолмен аяқтауға болады.'}</p>
            </div></details>
            <div className="composer-foot"><span><span className={`tiny-dot ${phase === 'recording' ? 'recording' : ''}`} />{phase === 'preparing' ? t.preparing : phase === 'recording' ? t.listeningNow : micMode === 'hold' ? t.hold : (language === 'ru' ? 'Нажмите, чтобы говорить' : 'Сөйлеу үшін басыңыз')}</span><span>{t.voiceDisclosure}</span></div>
          </div>
        </section>
        <SupervisorPanel turn={selectedTurn} turns={turns} selectedId={selectedId} onSelect={setSelectedId} catalog={catalog} language={language} />
      </div>
      <SessionMetrics turns={turns} language={language} preview={preview} />
      <footer className="page-footer"><span>Halyk × Voice Router</span><span>{t.voiceDisclosure}</span><span><Wifi size={14} /> {session?.session_id ? `${session.session_id.slice(0, 8)}…` : 'Demo workspace'}</span></footer>
    </main>
  </div>;
}
