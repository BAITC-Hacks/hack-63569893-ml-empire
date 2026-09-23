import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft, ArrowRight, AudioLines, Check,
  ChevronDown, CircleHelp, Clock3, Headphones, Headset, Languages,
  Mic, Play, RotateCcw, Send, ShieldCheck, Square, PhoneOff, Settings2,
  Sparkles, Volume2, VolumeX, WifiOff, X,
} from 'lucide-react';
import { maskPersonalData } from './session-state';
import { useVoiceSession } from './useVoiceSession';
import { SupervisorPanel, SessionMetrics } from './components/SupervisorPanel';
import { displayTraceValue } from './supervisor-model';
import { elapsedSeconds, errorText, formatDuration } from './client-state';
import './lab.css';
import halykMark from './assets/halyk-mark.png';

const CatalogEditor = lazy(() => import('./components/CatalogEditor').then(module => ({default: module.CatalogEditor})));
const EvaluationLab = lazy(() => import('./components/EvaluationLab').then(module => ({default: module.EvaluationLab})));

const copy = {
  ru: {
    nav: 'Голосовой помощник', supervisor: 'Супервизор', newCall: 'Новый звонок',
    conversationPanels: 'Панели разговора', headline: 'Начните диалог',
    intro: 'Рядом, чтобы помочь',
    start: 'Начать разговор',
    connect: 'Подключаемся к серверу', offline: 'Нет подключения', preparing: 'Подключаем микрофон',
    ready: 'На связи', listening: 'Слушаю вас', processing: 'Обрабатываю запрос', speaking: 'Отвечаю',
    transcript: 'Чат', emptyConversation: 'Расскажите, чем мы можем помочь.',
    hold: 'Удерживайте, чтобы говорить', release: 'Отпустите, чтобы отправить',
    textPlaceholder: 'Или напишите сообщение…', send: 'Отправить',
    trace: 'Панель Трассировки', traceSub: 'После каждой реплики клиента',
    emptyTrace: 'Решение появится после первой реплики',
    scenario: 'Основной сценарий', more: 'Другие сценарии', alternatives: 'Альтернативы',
    reason: 'Почему выбран', source: 'Источник решения', slots: 'Найденные данные',
    actions: 'Действия', latency: 'Время ответа', serverTime: 'На сервере',
    browserTime: 'До первого звука в браузере', total: 'Всего',
    confirmTitle: 'Нужно подтверждение', confirmHelp: 'Действие ещё не выполнено.',
    confirm: 'Подтвердить', reject: 'Отказаться', handoff: 'Передача оператору',
    retry: 'Повторить', end: 'Завершить',
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
    conversationPanels: 'Әңгіме панельдері', headline: 'Диалогты бастаңыз',
    intro: 'Көмектесуге дайынбыз',
    start: 'Әңгімені бастау',
    connect: 'Серверге қосылуда', offline: 'Байланыс жоқ', preparing: 'Микрофон қосылуда',
    ready: 'Байланыста', listening: 'Тыңдап тұрмын', processing: 'Сұрауды өңдеудемін', speaking: 'Жауап берудемін',
    transcript: 'Чат', emptyConversation: 'Сізге қалай көмектесе аламыз?',
    hold: 'Сөйлеу үшін басып тұрыңыз', release: 'Жіберу үшін босатыңыз',
    textPlaceholder: 'Немесе хабарлама жазыңыз…', send: 'Жіберу',
    trace: 'Трассировка панелі', traceSub: 'Әр клиент репликасынан кейін',
    emptyTrace: 'Шешім бірінші репликадан кейін пайда болады',
    scenario: 'Негізгі сценарий', more: 'Басқа сценарийлер', alternatives: 'Балама нұсқалар',
    reason: 'Таңдау себебі', source: 'Шешім көзі', slots: 'Табылған деректер',
    actions: 'Әрекеттер', latency: 'Жауап уақыты', serverTime: 'Серверде',
    browserTime: 'Браузердегі алғашқы дыбысқа дейін', total: 'Барлығы',
    confirmTitle: 'Растау қажет', confirmHelp: 'Әрекет әлі орындалған жоқ.',
    confirm: 'Растау', reject: 'Бас тарту', handoff: 'Операторға беру',
    retry: 'Қайталау', end: 'Аяқтау',
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

function CallTimer({ startedAt, endedAt, label }: { startedAt: number; endedAt: number | null; label: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (endedAt !== null) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [endedAt]);
  return <span className="call-timer" aria-label={label}><Clock3 size={14} />{formatDuration(elapsedSeconds(startedAt, endedAt, now))}</span>;
}

export default function App() {
  const [language, setLanguage] = useState<'ru' | 'kk'>('ru');
  const [textInput, setTextInput] = useState('');
  const [mobileTab, setMobileTab] = useState<'conversation' | 'trace'>('conversation');
  const [section, setSection] = useState<'conversation'|'catalog'|'evaluation'>('conversation');
  const [visited, setVisited] = useState<string[]>([]);
  const {
    session, connection, phase, turns, selectedId, setSelectedId, catalog, error,
    pendingPreview, muted, beginCall, reconnect, endCall: finishCall, resetCall,
    ended, startedAt, endedAt, level, devices, deviceId, setDeviceId, micMode, setMicMode, silenceMs, setSilenceMs, speechThreshold, setSpeechThreshold, refreshDevices, stopPlayback,
    submitText: sendText, startRecording, finishRecording, replay, hasAudio,
    dismissError, toggleMuted,
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

  const canInteract = connection === 'ready' && phase === 'idle' && !ended;
  const hasSession = Boolean(session || connection === 'connecting');

  return <div className="app-shell">
    <header className="site-header"><div className="header-inner">
      <div className="brand"><img className="brand-mark" src={halykMark} alt="" width={36} height={36} /><span>Halyk</span><span className="brand-divider" /><span className="product-name">Voice Router</span></div>
      <nav className="workspace-navigation" aria-label={language === 'ru' ? 'Разделы приложения' : 'Қолданба бөлімдері'}>{([
        ['conversation', language === 'ru' ? 'Разговор' : 'Әңгіме'],
        ['catalog', language === 'ru' ? 'Сценарии' : 'Сценарийлер'],
        ['evaluation', language === 'ru' ? 'Оценка и сравнение' : 'Бағалау және салыстыру'],
      ] as const).map(([id,label]) => <button key={id} aria-current={section === id ? 'page' : undefined} disabled={section !== id && (phase !== 'idle')} onClick={() => {setVisited(current => current.includes(id) ? current : [...current,id]); setSection(id);}}>{label}</button>)}</nav>
      <div className="header-actions"><button className="language-button" onClick={() => setLanguage(language === 'ru' ? 'kk' : 'ru')} aria-label={language === 'ru' ? 'Переключить язык интерфейса' : 'Интерфейс тілін ауыстыру'}><Languages size={17} /><span>{language === 'ru' ? 'Рус' : 'Қаз'}</span><ChevronDown size={14} /></button>
        {hasSession && section === 'conversation' && <button className="header-new" aria-label={t.newCall} onClick={() => { void endCall(); }}><RotateCcw size={16} /><span>{t.newCall}</span></button>}
      </div>
    </div></header>

    <main className="page-main">
      {section === 'conversation' && <div className="page-intro"><div><h1>{t.nav}</h1><p>{t.intro}</p></div></div>}
      {import.meta.env.VITE_TEST_MODE === 'true' && <div className="preview-banner" role="status">{language === 'ru' ? 'Тестовый API: синтетические ответы, без LLM/STT/TTS и реальных операций.' : 'Тест API: синтетикалық жауаптар, LLM/STT/TTS және нақты операциялар жоқ.'}</div>}
      <Suspense fallback={<p role="status">{language === 'ru' ? 'Загружаем инструменты…' : 'Құралдар жүктелуде…'}</p>}>
        {visited.includes('catalog') && <div hidden={section !== 'catalog'}><CatalogEditor language={language} /></div>}
        {visited.includes('evaluation') && <div hidden={section !== 'evaluation'}><EvaluationLab language={language} /></div>}
      </Suspense>
      {section === 'conversation' && <>
      {ended && <div className="ended-notice" role="status"><PhoneOff size={17} />{language === 'ru' ? 'Звонок завершён. История и аудио сохранены до нового звонка или перезагрузки.' : 'Қоңырау аяқталды. Тарих пен аудио жаңа қоңырауға не бетті қайта жүктеуге дейін сақталады.'}</div>}
      {error && <div className="error-banner" role="alert"><WifiOff size={18} /><span>{errorText(error, language)}</span><button onClick={dismissError} aria-label={language === 'ru' ? 'Закрыть сообщение' : 'Хабарламаны жабу'}><X size={17} /></button></div>}
      {session && !ended && connection === 'offline' && <div className="reconnect-notice"><WifiOff size={17} /><span>{t.offline}</span><button onClick={() => void reconnect()}>{t.reconnect}</button></div>}
      <div className="mobile-tabs" aria-label={t.conversationPanels}><button aria-pressed={mobileTab === 'conversation'} className={mobileTab === 'conversation' ? 'is-active' : ''} onClick={() => setMobileTab('conversation')}>{t.transcript}</button><button aria-pressed={mobileTab === 'trace'} className={mobileTab === 'trace' ? 'is-active' : ''} onClick={() => setMobileTab('trace')}>{t.trace}</button></div>
      <div className={`workspace ${mobileTab === 'trace' ? 'show-trace' : ''}`}>
        <section className="conversation-panel">
          <div className="panel-heading"><div className="panel-heading-title"><h2>{t.transcript}</h2></div><div className="panel-heading-right">{startedAt !== null && <CallTimer startedAt={startedAt} endedAt={endedAt} label={language === 'ru' ? 'Длительность звонка' : 'Қоңырау ұзақтығы'} />}{session && !ended && <button className="end-call" onClick={() => { finishCall(); setDraftRetry(false); }} aria-label={language === 'ru' ? 'Завершить звонок' : 'Қоңырауды аяқтау'} title={t.end}><PhoneOff size={16} />{t.end}</button>}{hasSession && !ended && <span role="status" className={`live-indicator ${connection !== 'ready' ? 'is-offline' : ''}`}><span />{connection === 'ready' ? t.ready : connection === 'offline' ? t.offline : t.connect}</span>}</div></div>
          <div className={`conversation-body ${turns.length === 0 ? 'is-empty' : ''}`} ref={conversationRef} onScroll={handleConversationScroll} tabIndex={0} role="region" aria-label={t.transcript}>
            {turns.length === 0 ? <div className="welcome-state"><div className="welcome-symbol"><Headset size={38} strokeWidth={1.7} aria-hidden="true" /></div><h3>{t.headline}</h3><p role="status">{session ? (micMode === 'hold' ? t.hold : language === 'ru' ? 'Нажмите, чтобы говорить' : 'Сөйлеу үшін басыңыз') : t.emptyConversation}</p><div className="welcome-actions">{!session && <button className="primary-button" onClick={() => void beginCall()} disabled={connection === 'connecting' || connection === 'reconnecting'}><Mic size={18} />{t.start}<ArrowRight size={17} /></button>}</div></div> : <div className="turn-list">
              {turns.map((turn, index) => <div className="turn-group" key={turn.id}>
                <div className="turn-index"><span>{String(index + 1).padStart(2, '0')}</span><span>{new Date(turn.at).toLocaleTimeString(language === 'kk' ? 'kk-KZ' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })}</span></div>
                <div className="message user-message"><div className="message-author"><span className="avatar client-avatar"><ArrowDownLeft size={15} /></span><b>{language === 'kk' ? 'Клиент' : 'Клиент'}</b><span className="message-language">{turn.language?.toUpperCase() || (turn.mode === 'text' ? 'TEXT' : 'AUDIO')}</span></div><p>{maskPersonalData(turn.text || turn.partialText || (turn.restored ? t.restored : turn.status === 'error' || turn.status === 'interrupted' ? t.noTranscript : phase === 'preparing' ? t.preparing : t.recognizing))}</p></div>
                {turn.reply ? <div className="message agent-message"><div className="message-author"><span className="avatar agent-avatar"><AudioLines size={16} /></span><b>Halyk AI</b><span className="message-language">{turn.replyLanguage?.toUpperCase() || 'AI'}</span></div><p>{maskPersonalData(turn.reply)}</p><div className="message-tools">{hasAudio(turn.id) && <button onClick={() => void replay(turn.id)} disabled={phase !== 'idle' || muted} title={t.replay}><Play size={14} />{language === 'kk' ? 'Қайта тыңдау' : 'Повторить звук'}</button>}<span><Sparkles size={13} /> AI voice</span></div></div> : <div className="reply-pending">{turn.status === 'processing' && <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>}{turn.status === 'processing' ? t.processing : turn.status === 'interrupted' ? (turn.restored ? t.snapshotStatus : t.interrupted) : turn.status === 'error' ? t.failed : t.noReply}</div>}
                {(turn.errorCode || turn.error) && <p className="turn-error">{errorText(turn.errorCode, language)}</p>}
                {(turn.status === 'error' || turn.status === 'interrupted') && turn.text && !turn.restored && <button className="retry-draft" disabled={!canInteract} onClick={() => { setTextInput(turn.text); setDraftRetry(true); inputRef.current?.focus(); }}>{language === 'ru' ? 'Вернуть текст в поле ввода' : 'Мәтінді енгізу өрісіне қайтару'}</button>}
                {turn.status === 'clarify' && <div className="handoff-note"><CircleHelp size={17} />{t.clarify}</div>}
                {turn.status === 'handoff' && <div className="handoff-note"><Headphones size={17} />{t.handoff}</div>}
              </div>)}
            </div>}
          </div>
          <div className="composer-area">
            <div className="sr-only" aria-live="polite" aria-atomic="true">{phase === 'processing' ? t.processing : phase === 'recording' ? t.listening : turns.at(-1)?.reply ? maskPersonalData(turns.at(-1)!.reply) : ''}</div>
            {draftRetry && <p className="retry-warning">{language === 'ru' ? 'Текст не отправлен повторно. Проверьте результат прошлой операции в трассировке: повтор может создать дубликат.' : 'Мәтін қайта жіберілмеді. Шешімдер ізінен алдыңғы әрекетті тексеріңіз: қайталау көшірме тудыруы мүмкін.'}</p>}
            {pendingPreview && <div className="confirmation-strip"><div><ShieldCheck size={20} /><span><strong>{t.confirmTitle}</strong><small>{displayTraceValue(pendingPreview.summary)} {t.confirmHelp}<br /><code>{displayTraceValue(pendingPreview.name)}</code>{pendingPreview.masked_args && <span className="confirmation-args">{Object.entries(pendingPreview.masked_args).map(([key, value]) => <span key={key}>{key}: {displayTraceValue(value, key)} </span>)}</span>}</small></span></div><div><button className="confirm-button" onClick={() => submitText(undefined, language === 'kk' ? 'Иә, растаймын' : 'Да, подтверждаю')} disabled={!canInteract}><Check size={16} />{t.confirm}</button><button className="reject-button" onClick={() => submitText(undefined, language === 'kk' ? 'Жоқ, бас тартамын' : 'Нет, отказываюсь')} disabled={!canInteract}>{t.reject}</button></div></div>}
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
              {micMode === 'auto' && <label>{language === 'ru' ? 'Порог речи: ниже для тихого голоса' : 'Сөйлеу шегі: баяу дауыс үшін төмендетіңіз'}: {speechThreshold.toFixed(3)}<input type="range" min="0.005" max="0.08" step="0.005" value={speechThreshold} disabled={phase !== 'idle'} onChange={event => setSpeechThreshold(Number(event.target.value))}/></label>}
              <button onClick={() => void refreshDevices()}>{language === 'ru' ? 'Обновить устройства' : 'Құрылғыларды жаңарту'}</button><p>{language === 'ru' ? 'Имена устройств появятся после разрешения доступа. Определение тишины работает локально; шум может помешать. Реплику всегда можно завершить вручную.' : 'Құрылғы атаулары рұқсат берілгеннен кейін көрінеді. Тыныштық жергілікті анықталады; шу кедергі болуы мүмкін. Репликаны қолмен аяқтауға болады.'}</p>
            </div></details>
          </div>
        </section>
        <SupervisorPanel turn={selectedTurn} turns={turns} selectedId={selectedId} onSelect={setSelectedId} catalog={catalog} language={language} />
      </div>
      <SessionMetrics turns={turns} language={language} />
      </>}
    </main>
  </div>;
}
