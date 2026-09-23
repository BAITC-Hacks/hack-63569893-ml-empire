import { useEffect, useRef, useState } from 'react';
import { PcmPlayer, PcmRecorder } from '../audio';
import { CaptureBuffer, createTestTone, playDiagnosticAudio } from '../diagnostics-model';
import { errorText, localErrorCode } from '../client-state';
import '../lab.css';

type State = 'idle'|'requesting'|'recording'|'finishing'|'playing';
export function AudioDiagnostics({ language, onBusyChange }: { language: 'ru'|'kk'; onBusyChange: (busy: boolean) => void }) {
  const ru = language === 'ru';
  const [state, setState] = useState<State>('idle');
  const [permission, setPermission] = useState('unknown');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState('');
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [threshold, setThreshold] = useState(.025);
  const [silenceMs, setSilenceMs] = useState(1500);
  const [automatic, setAutomatic] = useState(true);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [firstAudio, setFirstAudio] = useState<number|null>(null);
  const recorder = useRef<PcmRecorder|null>(null);
  const player = useRef<PcmPlayer|null>(null);
  const cache = useRef(new CaptureBuffer());
  const stopping = useRef(false);
  const alive = useRef(true);
  const timeout = useRef<ReturnType<typeof setTimeout>|null>(null);
  const startAt = useRef(0);
  const playbackGeneration = useRef(0);

  async function refresh() {
    try { const list = await navigator.mediaDevices?.enumerateDevices(); if (alive.current) setDevices(list?.filter(item => item.kind === 'audioinput') ?? []); }
    catch { if (alive.current) setError('mic_unavailable'); }
  }
  useEffect(() => {
    alive.current = true;
    const audio = new PcmPlayer(); player.current = audio;
    audio.onFirstAudio = () => { if (alive.current) setFirstAudio(Math.round(performance.now() - startAt.current)); };
    audio.onEnded = () => { if (alive.current) setState('idle'); };
    void refresh();
    let status: PermissionStatus|undefined;
    void navigator.permissions?.query({name:'microphone' as PermissionName}).then(value => {
      if (!alive.current) return; status = value; setPermission(value.state);
      value.onchange = () => { if (alive.current) setPermission(value.state); };
    }).catch(() => undefined);
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => {
      alive.current = false;
      playbackGeneration.current += 1;
      if (status) status.onchange = null;
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
      if (timeout.current) clearTimeout(timeout.current);
      void recorder.current?.dispose(); recorder.current = null;
      audio.dispose(); cache.current.clear();
    };
  }, []);
  useEffect(() => { onBusyChange(state !== 'idle'); }, [state, onBusyChange]);

  async function finish(reason: string) {
    const active = recorder.current;
    if (!active || stopping.current) return;
    stopping.current = true;
    if (timeout.current) clearTimeout(timeout.current);
    setState('finishing');
    try { await active.stop(); if (alive.current && recorder.current === active) setResult(reason); }
    catch { if (alive.current && recorder.current === active) setError('recording_cancelled'); }
    finally {
      if (alive.current && recorder.current === active) {
        recorder.current = null; setSeconds(cache.current.seconds); setLevel(0); setState('idle'); stopping.current = false;
      }
    }
  }
  async function start() {
    if (recorder.current) return;
    const active = new PcmRecorder(); recorder.current = active; stopping.current = false;
    cache.current.clear(); player.current?.clear(); setSeconds(0); setPeak(0); setLevel(0); setFirstAudio(null); setError(''); setResult(''); setState('requesting');
    // Also bounds a stalled browser permission request; a late grant is cancelled.
    timeout.current = setTimeout(() => { void finish('limit'); }, 20000);
    try {
      await active.start(bytes => {
        if (!alive.current || recorder.current !== active) return;
        const more = cache.current.append(bytes); setSeconds(cache.current.seconds);
        if (!more) void finish('limit');
      }, { deviceId: device || undefined,
        onLevel: value => { if (alive.current && recorder.current === active) { setLevel(value); setPeak(previous => Math.max(previous,value)); } },
        onUnexpectedEnd: () => {
          if (!alive.current || recorder.current !== active) return;
          if (timeout.current) clearTimeout(timeout.current);
          recorder.current = null; setState('idle'); setLevel(0); setError('mic_disconnected'); setResult('disconnected'); void refresh();
        },
        silenceDetection: automatic ? {threshold, silenceMs, onSilence: () => { void finish('silence'); }} : undefined,
      });
      if (!alive.current || recorder.current !== active || stopping.current) { await active.dispose(); return; }
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => { void finish('limit'); }, 15000);
      setState('recording'); setPermission('granted'); void refresh();
    } catch (cause) {
      if (!alive.current || recorder.current !== active) return;
      if (timeout.current) clearTimeout(timeout.current);
      recorder.current = null; setState('idle'); setError(localErrorCode(cause));
    }
  }
  async function play(tone: boolean) {
    const audio = player.current; if (!audio || state !== 'idle' || muted) return;
    const generation = ++playbackGeneration.current;
    setError(''); setFirstAudio(null); setState('playing'); startAt.current = performance.now();
    try {
      await playDiagnosticAudio(audio, tone ? [createTestTone()] : cache.current.chunks,
        () => alive.current && generation === playbackGeneration.current);
    } catch { if (alive.current && generation === playbackGeneration.current) { setError('playback_failed'); setState('idle'); } }
  }
  const statuses = ru ? {idle:'Микрофон освобождён',requesting:'Ожидаем разрешение',recording:'Запись только в памяти браузера',finishing:'Освобождаем микрофон',playing:'Воспроизведение'} : {idle:'Микрофон босатылды',requesting:'Рұқсат күтілуде',recording:'Жазба тек браузер жадында',finishing:'Микрофон босатылуда',playing:'Ойнату'};
  const results: Record<string,string> = ru ? {manual:'Остановлено вручную',silence:'Автозавершение после тишины',limit:'Достигнут предел записи',disconnected:'Устройство отключено'} : {manual:'Қолмен тоқтатылды',silence:'Тыныштықтан кейін аяқталды',limit:'Жазба шегі жетті',disconnected:'Құрылғы ажыратылды'};
  return <section className="lab-panel" aria-labelledby="diagnostics-title"><p className="eyebrow">LOCAL AUDIO CHECK</p><h2 id="diagnostics-title">{ru ? 'Проверка микрофона и звука' : 'Микрофон мен дыбысты тексеру'}</h2>
    <p>{ru ? 'До 15 секунд, только в памяти этой вкладки. Аудио не передаётся серверу и удаляется при выходе из проверки. Используются те же PCM-рекордер, детектор тишины и проигрыватель, что в разговоре.' : '15 секундқа дейін, тек осы қойынды жадында. Аудио серверге жіберілмейді, тексеруден шыққанда жойылады. Әңгімедегі PCM жазғышы, тыныштық детекторы мен ойнатқыш қолданылады.'}</p>
    <p role="status"><strong>{statuses[state]}</strong> · {ru ? 'Доступ' : 'Рұқсат'}: {permission === 'granted' ? (ru ? 'разрешён' : 'берілді') : permission === 'denied' ? (ru ? 'запрещён' : 'тыйым салынды') : (ru ? 'потребуется запрос' : 'сұрау қажет')}</p>
    {error && <p role="alert" className="lab-error">{errorText(error,language)}</p>}
    <div className="lab-form-grid"><label>{ru ? 'Устройство' : 'Құрылғы'}<select disabled={state !== 'idle'} value={device} onChange={event => setDevice(event.target.value)}><option value="">{ru ? 'Системный микрофон' : 'Жүйелік микрофон'}</option>{devices.filter(item => item.deviceId && item.deviceId !== 'default').map((item,index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `Microphone ${index+1}`}</option>)}</select></label>
      <label>{ru ? 'Порог речи (RMS)' : 'Сөйлеу шегі (RMS)'}: {threshold.toFixed(3)}<input aria-label={ru ? 'Порог речи' : 'Сөйлеу шегі'} type="range" min="0.005" max="0.08" step="0.005" value={threshold} disabled={state !== 'idle'} onChange={event => setThreshold(Number(event.target.value))}/></label>
      <label>{ru ? 'Пауза' : 'Үзіліс'}: {silenceMs} ms<input type="range" min="800" max="2500" step="100" value={silenceMs} disabled={state !== 'idle'} onChange={event => setSilenceMs(Number(event.target.value))}/></label>
      <label className="lab-check"><input type="checkbox" checked={automatic} disabled={state !== 'idle'} onChange={event => setAutomatic(event.target.checked)}/>{ru ? 'Автозавершение после речи' : 'Сөйлеуден кейін автоаяқтау'}</label>
    </div>
    <p>{ru ? 'Для тихого голоса уменьшите порог; слишком низкий порог может принимать шум за речь. Начальная тишина сама не завершает запись.' : 'Баяу дауыс үшін шекті азайтыңыз; тым төмен шек шуды сөйлеу деп қабылдауы мүмкін. Бастапқы тыныштық жазбаны аяқтамайды.'}</p>
    <label>{ru ? 'Уровень сигнала' : 'Сигнал деңгейі'}<meter min="0" max="1" value={Math.min(1,level*4)} aria-label={ru ? 'Уровень сигнала' : 'Сигнал деңгейі'}/></label>
    <p className="lab-numbers">PCM 24 kHz · {seconds.toFixed(2)} s · RMS {level.toFixed(4)} · {ru ? 'Пик' : 'Шың'} {peak.toFixed(4)}</p>
    <div className="lab-actions"><button disabled={state !== 'idle'} onClick={() => void start()}>{ru ? 'Записать тест' : 'Тест жазу'}</button><button disabled={!['requesting','recording'].includes(state)} onClick={() => void finish('manual')}>{ru ? 'Остановить запись' : 'Жазбаны тоқтату'}</button><button disabled={state !== 'idle'} onClick={() => void refresh()}>{ru ? 'Обновить устройства' : 'Құрылғыларды жаңарту'}</button></div>
    {result && <p role="status">{results[result]} · {ru ? 'микрофон освобождён' : 'микрофон босатылды'}</p>}
    <hr/><h3>{ru ? 'Проверка воспроизведения' : 'Ойнатуды тексеру'}</h3>
    <div className="lab-actions"><button disabled={state !== 'idle' || muted} onClick={() => void play(true)}>{ru ? 'Тестовый звук · 2 s' : 'Тест дыбысы · 2 s'}</button><button disabled={state !== 'idle' || muted || !seconds} onClick={() => void play(false)}>{ru ? 'Прослушать запись' : 'Жазбаны тыңдау'}</button><button disabled={state !== 'playing'} onClick={() => { playbackGeneration.current += 1; player.current?.stop(); setState('idle'); }}>{ru ? 'Остановить звук' : 'Дыбысты тоқтату'}</button><button aria-pressed={muted} onClick={() => {playbackGeneration.current += 1; player.current?.setMuted(!muted); setMuted(!muted); if (state === 'playing') setState('idle');}}>{muted ? (ru ? 'Включить звук' : 'Дыбысты қосу') : (ru ? 'Выключить звук' : 'Дыбысты өшіру')}</button></div>
    <p>{ru ? 'До первого звука по часам браузера' : 'Браузер сағаты бойынша алғашқы дыбысқа дейін'}: {firstAudio === null ? '∅' : `${firstAudio} ms`}. {ru ? 'Это локальный тест проигрывателя, не задержка AI и не измерение физического динамика.' : 'Бұл жергілікті ойнатқыш тесті, ЖИ кідірісі немесе динамиктің физикалық өлшемі емес.'}</p>
  </section>;
}
