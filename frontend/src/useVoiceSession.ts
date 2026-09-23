import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, createSession, fetchCatalog, isCreatedSession, isSessionReadyFor, parseServerEvent, restoreSession, sendEvent, streamUrl } from './api';
import { PcmPlayer, PcmRecorder } from './audio';
import { applyTurnEvent, interruptTurns, isCurrentSnapshot, restoreTurns, shouldApplyTurnEvent } from './session-state';
import { localErrorCode } from './client-state';
import type { ActionPreview, CallPhase, CatalogItem, ConnectionStatus, CreatedSession, RestoredSession, ServerEvent, Turn } from './types';

const STORAGE_KEY = 'voice-router-session';
const interruptedMessage = 'disconnected';
const errorMessage = localErrorCode;

function saveSession(session: CreatedSession | null, startedAt?: number) {
  // Private browsing/storage policy must not prevent a live call.
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...session, client_started_at: startedAt }));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* Reload recovery is unavailable when storage is blocked. */ }
}

function newTurn(mode: 'audio' | 'text', text = ''): Turn {
  return { id: crypto.randomUUID(), mode, text, language: null, reply: '', replyLanguage: null, status: 'processing', route: null, trace: null, preview: null, at: Date.now() };
}

export function useVoiceSession() {
  const [session, setSession] = useState<CreatedSession | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('offline');
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [error, setError] = useState('');
  const [pendingPreview, setPendingPreview] = useState<ActionPreview | null>(null);
  const [muted, setMuted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [micMode, setMicMode] = useState<'hold' | 'auto'>('hold');
  const [silenceMs, setSilenceMs] = useState(1500);
  const [speechThreshold, setSpeechThreshold] = useState(0.025);
  const sessionRef = useRef<CreatedSession | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  const activeTurnRef = useRef<string | null>(null);
  const audioTurnRef = useRef<string | null>(null);
  const audioSentStartRef = useRef(false);
  const releaseRequestedRef = useRef(false);
  const recordingStopRef = useRef(false);
  const endOfSpeechRef = useRef(new Map<string, number>());
  const lastSeqRef = useRef(0);
  const lastActivityRef = useRef(0);
  const epochRef = useRef(0);
  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const updateTurns = useCallback((update: (current: Turn[]) => Turn[]) => {
    const next = update(turnsRef.current);
    turnsRef.current = next;
    setTurns(next);
  }, []);

  const cancelRecording = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    audioSentStartRef.current = false;
    recordingStopRef.current = false;
    setLevel(0);
    void recorder?.dispose();
  }, []);

  const applySnapshot = useCallback((state: RestoredSession) => {
    lastSeqRef.current = Math.max(lastSeqRef.current, state.last_seq);
    updateTurns((current) => restoreTurns(current, state));
    setPendingPreview(state.pending_confirmation);
    if (state.last_turn_id) setSelectedId(state.last_turn_id);
  }, [updateTurns]);

  const reconcileConfirmation = useCallback((id: string) => {
    const created = sessionRef.current;
    const epoch = epochRef.current;
    if (!created) return;
    void restoreSession(created.session_id, requestRef.current?.signal).then((state) => {
      if (epoch !== epochRef.current || activeTurnRef.current || state.last_turn_id !== id || !isCurrentSnapshot(state, turnsRef.current.at(-1)?.id, lastSeqRef.current)) return;
      setPendingPreview(state.pending_confirmation);
    }).catch(() => { /* Reconnection performs authoritative recovery if transport fails. */ });
  }, []);

  const handleServerEvent = useCallback((event: ServerEvent) => {
    // A new socket can acknowledge the same seq seen in its preceding snapshot.
    if (event.type === 'session.ready') {
      if (!sessionRef.current || !isSessionReadyFor(event, sessionRef.current)) {
        setError('invalid_event'); socketRef.current?.close(); return;
      }
      lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
      setConnection('ready');
      setError(current => current === 'disconnected' || current === 'reconnect_failed' ? '' : current);
      return;
    }
    if (event.seq <= lastSeqRef.current) return;
    lastSeqRef.current = event.seq;
    const id = event.turn_id;
    const payload = event.payload;
    if (event.type === 'error' && !id) {
      setError(String(payload.code));
      if (payload.recoverable === false || activeTurnRef.current) socketRef.current?.close();
      return;
    }
    const currentTurn = turnsRef.current.find(turn => turn.id === id);
    if (!id || !currentTurn || (!shouldApplyTurnEvent(currentTurn, event) && !(event.type === 'audio.end' && audioTurnRef.current === id))) return;
    updateTurns((current) => applyTurnEvent(current, event));
    if (event.type === 'route.decision' && activeTurnRef.current === id) setSelectedId(id);
    if (event.type === 'action.preview' && activeTurnRef.current === id) setPendingPreview(payload as unknown as ActionPreview);
    if (event.type === 'audio.start' && activeTurnRef.current === id) {
      audioTurnRef.current = id;
      playerRef.current?.startStream(id);
      setPhase('speaking');
    }
    if (event.type === 'audio.end' && audioTurnRef.current === id) {
      audioTurnRef.current = null;
      playerRef.current?.endStream();
    }
    if (event.type === 'turn.complete' && activeTurnRef.current === id) {
      activeTurnRef.current = null;
      setPhase(audioTurnRef.current || playerRef.current?.isPlaying() ? 'speaking' : 'idle');
      reconcileConfirmation(id);
    }
    if (event.type === 'error') {
      setError(String(payload.code));
      if (payload.code !== 'tts_unavailable' && activeTurnRef.current === id) {
        activeTurnRef.current = null;
        cancelRecording();
        playerRef.current?.stop();
        audioTurnRef.current = null;
        setPhase('idle');
        reconcileConfirmation(id);
      }
      if (payload.recoverable === false) socketRef.current?.close();
    }
  }, [cancelRecording, reconcileConfirmation, updateTurns]);

  const openSocket = useCallback((created: CreatedSession, epoch: number) => {
    if (epoch !== epochRef.current) return;
    const socket = new WebSocket(streamUrl(created));
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    let stableTimer: number | undefined;
    const isCurrent = () => epoch === epochRef.current && socketRef.current === socket;
    const readyTimeout = window.setTimeout(() => socket.close(), 10000);

    const scheduleReconnect = () => {
      if (epoch !== epochRef.current) return;
      if (reconnectCountRef.current >= 4) {
        setConnection('offline');
        setError('reconnect_failed');
        return;
      }
      const delay = Math.min(1000 * 2 ** reconnectCountRef.current++, 8000);
      reconnectTimerRef.current = window.setTimeout(async () => {
        try {
          const state = await restoreSession(created.session_id, requestRef.current?.signal);
          if (epoch !== epochRef.current) return;
          applySnapshot(state);
          openSocket(created, epoch);
        } catch (cause) {
          if (epoch !== epochRef.current) return;
          if (cause instanceof ApiError && cause.status === 404) {
            setConnection('offline');
            setError('session_expired');
          } else scheduleReconnect();
        }
      }, delay);
    };

    socket.onmessage = (message) => {
      if (!isCurrent()) return;
      lastActivityRef.current = performance.now();
      if (typeof message.data === 'string') {
        const event = parseServerEvent(message.data);
        if (!event) { setError('invalid_event'); socket.close(); return; }
        if (event.type === 'session.ready') {
          clearTimeout(readyTimeout);
          clearTimeout(stableTimer);
          stableTimer = window.setTimeout(() => { if (isCurrent()) reconnectCountRef.current = 0; }, 5000);
        }
        handleServerEvent(event);
      } else if (message.data instanceof ArrayBuffer && audioTurnRef.current) {
        void playerRef.current?.append(message.data, created.audio_output.sample_rate_hz).catch(() => {
          if (isCurrent()) {
            setError('playback_failed');
            if (!activeTurnRef.current) setPhase('idle');
          }
        });
      }
    };
    socket.onclose = () => {
      clearTimeout(readyTimeout);
      clearTimeout(stableTimer);
      if (!isCurrent()) return;
      socketRef.current = null;
      setConnection('reconnecting');
      setPhase('idle');
      setError(current => ['mic_disconnected', 'invalid_event', 'timeout'].includes(current) ? current : interruptedMessage);
      updateTurns(interruptTurns);
      cancelRecording();
      playerRef.current?.stop();
      activeTurnRef.current = null;
      audioTurnRef.current = null;
      scheduleReconnect();
    };
    socket.onerror = () => { /* onclose handles bounded recovery. */ };
  }, [applySnapshot, cancelRecording, handleServerEvent, updateTurns]);

  const endCall = useCallback(() => {
    epochRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = new AbortController();
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
    cancelRecording();
    playerRef.current?.stop();
    activeTurnRef.current = null;
    audioTurnRef.current = null;
    endOfSpeechRef.current.clear();
    lastSeqRef.current = 0;
    reconnectCountRef.current = 0;
    sessionRef.current = null;
    saveSession(null);
    setConnection('offline'); setPhase('idle'); setLevel(0);
    setEnded(true); setEndedAt(Date.now()); setPendingPreview(null); setError('');
    updateTurns(interruptTurns);
  }, [cancelRecording, updateTurns]);

  const reset = useCallback(() => {
    endCall();
    playerRef.current?.clear();
    setSession(null); setEnded(false); setStartedAt(null); setEndedAt(null);
    setSelectedId(null);
    updateTurns(() => []);
  }, [endCall, updateTurns]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput')); }
    catch { /* Device labels can remain hidden before permission; recording reports actionable errors. */ }
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  useEffect(() => {
    if (phase !== 'processing' && phase !== 'speaking') return;
    const epoch = epochRef.current;
    const timer = window.setInterval(() => {
      if (epoch !== epochRef.current || (!activeTurnRef.current && !audioTurnRef.current) || performance.now() - lastActivityRef.current < 60000) return;
      setError('timeout'); socketRef.current?.close();
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    const player = new PcmPlayer();
    playerRef.current = player;
    player.onFirstAudio = (id) => {
      const socket = socketRef.current;
      const started = endOfSpeechRef.current.get(id);
      if (playerRef.current !== player || !socket || socket.readyState !== WebSocket.OPEN || started === undefined) return;
      const latency = Math.round(performance.now() - started);
      sendEvent(socket, 'playback.started', id, { latency_ms: latency });
      endOfSpeechRef.current.delete(id);
      updateTurns((current) => current.map((turn) => turn.id === id ? { ...turn, trace: { ...turn.trace, client_first_audio_ms: latency } } : turn));
    };
    player.onEnded = () => { if (!activeTurnRef.current) setPhase('idle'); };
    void fetchCatalog(controller.signal).then(setCatalog).catch(() => undefined);
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (isCreatedSession(saved)) {
        const time = (saved as CreatedSession & { client_started_at?: number }).client_started_at;
        setStartedAt(typeof time === 'number' && Number.isFinite(time) && time > 0 && time <= Date.now() ? time : Date.now());
        setConnection('connecting');
        sessionRef.current = saved; setSession(saved);
        void restoreSession(saved.session_id, controller.signal).then((state) => {
          if (epoch !== epochRef.current) return;
          applySnapshot(state);
          openSocket(saved, epoch);
        }).catch((cause) => {
          if (epoch !== epochRef.current) return;
          setConnection('offline');
          setError(cause instanceof ApiError && cause.status === 404 ? 'session_expired' : 'connection_failed');
        });
      } else saveSession(null);
    } catch { saveSession(null); }
    return () => {
      epochRef.current += 1;
      requestRef.current?.abort();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
      cancelRecording();
      playerRef.current = null;
      void player.dispose();
    };
  }, [applySnapshot, cancelRecording, openSocket, updateTurns]);

  async function beginCall() {
    if (connection === 'connecting' || connection === 'reconnecting') return;
    reset();
    const epoch = epochRef.current;
    setConnection('connecting');
    try {
      const created = await createSession(requestRef.current?.signal);
      if (epoch !== epochRef.current) return;
      const started = Date.now(); setStartedAt(started);
      saveSession(created, started);
      sessionRef.current = created; setSession(created);
      openSocket(created, epoch);
      void fetchCatalog(requestRef.current?.signal).then(setCatalog).catch(() => undefined);
    } catch (cause) {
      if (epoch !== epochRef.current) return;
      setConnection('offline'); setError(errorMessage(cause));
    }
  }

  async function reconnect() {
    const created = sessionRef.current;
    if (!created || connection !== 'offline') return;
    const epoch = epochRef.current;
    reconnectCountRef.current = 0;
    setConnection('connecting'); setError('');
    try {
      const state = await restoreSession(created.session_id, requestRef.current?.signal);
      if (epoch !== epochRef.current) return;
      applySnapshot(state); openSocket(created, epoch);
    } catch (cause) {
      if (epoch !== epochRef.current) return;
      setConnection('offline'); setError(errorMessage(cause));
    }
  }

  function submitText(text: string): string | null {
    const socket = socketRef.current;
    if (!text.trim() || connection !== 'ready' || phase !== 'idle' || activeTurnRef.current || !socket) return null;
    const turn = newTurn('text', text.trim());
    try {
      sendEvent(socket, 'turn.text', turn.id, { text: turn.text });
      activeTurnRef.current = turn.id;
      lastActivityRef.current = performance.now();
      endOfSpeechRef.current.set(turn.id, performance.now());
      updateTurns((current) => [...current, turn]);
      setSelectedId(turn.id); setPendingPreview(null); setError(''); setPhase('processing');
      void playerRef.current?.unlock().catch(() => setError('playback_failed'));
      return turn.id;
    } catch (cause) { setError(errorMessage(cause)); return null; }
  }

  function startRecording() {
    const socket = socketRef.current;
    if (phase !== 'idle' || connection !== 'ready' || activeTurnRef.current || !socket) return;
    const turn = newTurn('audio');
    const recorder = new PcmRecorder();
    const epoch = epochRef.current;
    const queued: ArrayBuffer[] = [];
    recorderRef.current = recorder;
    activeTurnRef.current = turn.id;
    releaseRequestedRef.current = false;
    audioSentStartRef.current = false;
    recordingStopRef.current = false;
    updateTurns((current) => [...current, turn]); setSelectedId(turn.id);
    setPhase('preparing'); setError('');
    const isCurrent = () => epoch === epochRef.current && recorderRef.current === recorder && socketRef.current === socket;
    void playerRef.current?.unlock().catch(() => undefined);
    void recorder.start((bytes) => {
      if (!isCurrent()) return;
      if (audioSentStartRef.current && socket.readyState === WebSocket.OPEN) socket.send(bytes);
      else queued.push(bytes);
    }, {
      deviceId: deviceId || undefined,
      onLevel: value => { if (isCurrent()) setLevel(value); },
      onUnexpectedEnd: () => {
        if (!isCurrent()) return;
        cancelRecording(); updateTurns(interruptTurns);
        setError('mic_disconnected'); activeTurnRef.current = null; setPhase('idle');
        socket.close(); // Discard partial PCM on the server; never commit a broken recording.
      },
      silenceDetection: micMode === 'auto' ? { silenceMs, threshold: speechThreshold, onSilence: (elapsed: number) => { if (isCurrent()) void finishRecording(elapsed); } } : undefined,
    }).then(() => {
      if (!isCurrent()) return recorder.dispose();
      sendEvent(socket, 'turn.start', turn.id, { mode: 'audio' });
      audioSentStartRef.current = true;
      queued.forEach((bytes) => socket.send(bytes));
      queued.length = 0;
      setPendingPreview(null); setPhase('recording');
      void refreshDevices();
      if (releaseRequestedRef.current) void finishRecording();
    }).catch((cause) => {
      if (!isCurrent()) return;
      cancelRecording();
      updateTurns((current) => current.map((item) => item.id === turn.id ? { ...item, status: 'error', errorCode: errorMessage(cause) } : item));
      setError(errorMessage(cause)); activeTurnRef.current = null; setPhase('idle');
    });
  }

  async function finishRecording(silenceElapsedMs = 0) {
    releaseRequestedRef.current = true;
    const recorder = recorderRef.current;
    const socket = socketRef.current;
    const id = activeTurnRef.current;
    if (!recorder || !socket || !id || recordingStopRef.current) return;
    if (!audioSentStartRef.current) {
      cancelRecording(); activeTurnRef.current = null; setPhase('idle');
      updateTurns(current => current.map(turn => turn.id === id ? { ...turn, status: 'interrupted', errorCode: 'recording_cancelled' } : turn));
      return; // A late permission grant must not start a recording after release.
    }
    recordingStopRef.current = true;
    lastActivityRef.current = performance.now();
    endOfSpeechRef.current.set(id, performance.now() - Math.max(0, silenceElapsedMs));
    setPhase('processing');
    try {
      await recorder.stop();
      if (recorderRef.current !== recorder || socketRef.current !== socket) return;
      sendEvent(socket, 'turn.commit', id, {});
      recorderRef.current = null; audioSentStartRef.current = false;
      setLevel(0);
    } catch (cause) {
      if (recorderRef.current !== recorder) return;
      cancelRecording();
      updateTurns(interruptTurns);
      setError(errorMessage(cause)); activeTurnRef.current = null; setPhase('idle');
      socket.close();
    } finally { if (recorderRef.current === recorder || !recorderRef.current) recordingStopRef.current = false; }
  }

  async function replay(id: string) {
    if (phase !== 'idle' || activeTurnRef.current || muted || !playerRef.current?.hasAudio(id)) return;
    setPhase('speaking');
    try { await playerRef.current.replay(id); }
    catch { setError('playback_failed'); setPhase('idle'); }
  }

  return {
    session, connection, phase, turns, selectedId, setSelectedId, catalog, error,
    pendingPreview, muted, beginCall, reconnect, endCall, resetCall: reset, submitText, startRecording, finishRecording, replay,
    ended, startedAt, endedAt, level, devices, deviceId, setDeviceId, micMode, setMicMode, silenceMs, setSilenceMs, speechThreshold, setSpeechThreshold, refreshDevices,
    stopPlayback: () => { playerRef.current?.stopCurrentPlayback(); setPhase(activeTurnRef.current || audioTurnRef.current ? 'processing' : 'idle'); },
    hasAudio: (id: string) => playerRef.current?.hasAudio(id) ?? false,
    dismissError: () => setError(''),
    toggleMuted: () => { playerRef.current?.setMuted(!muted); setMuted(!muted); if (!activeTurnRef.current && !audioTurnRef.current) setPhase('idle'); },
  };
}
