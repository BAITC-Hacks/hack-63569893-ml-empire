import type { CatalogItem, CreatedSession, Language, RestoredSession, RouteDecision, ServerEvent } from './types';

const configuredBase = import.meta.env?.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '';
const apiBase = `${configuredBase}/api/v1`;
const requestTimeoutMs = 10_000;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message = status === 404 ? 'Сессия больше недоступна' : `Сервер вернул ошибку ${status}`) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isLanguage(value: unknown): value is Language {
  return value === null || value === 'ru' || value === 'kk' || value === 'mixed';
}

function isAudioFormat(value: unknown): boolean {
  return isRecord(value) && value.encoding === 'pcm_s16le' && value.sample_rate_hz === 24000 && value.channels === 1;
}

function isScenario(value: unknown): boolean {
  return isRecord(value) && isIdentifier(value.scenario_id)
    && (value.name === undefined || typeof value.name === 'string')
    && (value.reason === undefined || typeof value.reason === 'string')
    && (value.priority === undefined || ['normal', 'high', 'urgent'].includes(value.priority as string))
    && (value.confidence_estimate === undefined || (isDuration(value.confidence_estimate) && value.confidence_estimate <= 1));
}

function isScenarioReference(value: unknown): boolean {
  return isIdentifier(value) || isScenario(value);
}

function isPreview(value: unknown): boolean {
  return isRecord(value) && isIdentifier(value.name) && typeof value.summary === 'string'
    && (value.masked_args === undefined || isRecord(value.masked_args));
}

export function isRouteDecision(value: unknown): value is RouteDecision {
  return isRecord(value) && Array.isArray(value.scenarios) && value.scenarios.every(isScenario)
    && Array.isArray(value.alternatives) && value.alternatives.every(isScenarioReference)
    && isLanguage(value.language)
    && (value.reason === undefined || typeof value.reason === 'string')
    && (value.slots === undefined || isRecord(value.slots))
    && (value.source === undefined || ['llm', 'continuation', 'confirmation'].includes(value.source as string))
    && (value.active_scenario === undefined || value.active_scenario === null || isScenarioReference(value.active_scenario))
    && (value.pending_scenarios === undefined || (Array.isArray(value.pending_scenarios) && value.pending_scenarios.every(isScenarioReference)))
    && (value.suspended_scenarios === undefined || (Array.isArray(value.suspended_scenarios) && value.suspended_scenarios.every(isScenarioReference)));
}

function isTrace(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.actions !== undefined && (!Array.isArray(value.actions) || !value.actions.every((action) => typeof action === 'string' || isRecord(action)))) return false;
  if (value.latency_ms !== undefined && (!isRecord(value.latency_ms) || !Object.values(value.latency_ms).every(isDuration))) return false;
  if (value.client_first_audio_ms !== undefined && value.client_first_audio_ms !== null && !isDuration(value.client_first_audio_ms)) return false;
  return value.handoff === undefined || value.handoff === null || isRecord(value.handoff);
}

/** Validate both server responses and untrusted sessionStorage before opening a socket. */
export function isCreatedSession(value: unknown): value is CreatedSession {
  if (!isRecord(value) || !isIdentifier(value.session_id) || typeof value.ws_path !== 'string') return false;
  if (!isAudioFormat(value.audio_input) || !isAudioFormat(value.audio_output)
    || typeof value.as_of_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.as_of_date)) return false;
  try {
    const expectedPath = `/api/v1/sessions/${encodeURIComponent(value.session_id)}/stream`;
    if (value.ws_path !== expectedPath) return false;
    const url = new URL(value.ws_path, 'https://session-validation.invalid');
    return url.origin === 'https://session-validation.invalid' && url.pathname === expectedPath && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isRestoredSession(value: unknown): value is RestoredSession {
  return isRecord(value) && isIdentifier(value.session_id) && isSequence(value.last_seq)
    && (value.last_turn_id === null || isIdentifier(value.last_turn_id))
    && (value.active_scenario === null || isScenarioReference(value.active_scenario))
    && (value.pending_confirmation === null || isPreview(value.pending_confirmation))
    && (value.last_trace === null || isTrace(value.last_trace));
}

function isCatalog(value: unknown): value is CatalogItem[] {
  return Array.isArray(value) && value.every((item) => isScenario(item) && isRecord(item)
    && typeof item.name === 'string' && ['normal', 'high', 'urgent'].includes(item.priority as string));
}

async function requestJson<T>(path: string, validate: (value: unknown) => value is T, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('Сервер не ответил за 10 секунд. Попробуйте ещё раз.', 'TimeoutError')), requestTimeoutMs);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      signal: controller.signal,
    });
    if (!response.ok) throw new ApiError(response.status);
    let value: unknown;
    try { value = await response.json(); }
    catch (error) {
      if (error instanceof SyntaxError) throw new ApiError(response.status, 'Сервер вернул некорректный формат JSON');
      throw error;
    }
    if (!validate(value)) throw new ApiError(response.status, 'Сервер вернул некорректный формат данных');
    return value;
  } catch (error) {
    // Preserve cancellation/timeout identity even when a browser rejects fetch with a generic error.
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function createSession(signal?: AbortSignal): Promise<CreatedSession> {
  return requestJson('/sessions', isCreatedSession, { method: 'POST', body: '{}' }, signal);
}

export function restoreSession(id: string, signal?: AbortSignal): Promise<RestoredSession> {
  return requestJson(`/sessions/${encodeURIComponent(id)}`, (value): value is RestoredSession => isRestoredSession(value) && value.session_id === id, undefined, signal);
}

/** A ready event from another session must never unlock this call's input. */
export function isSessionReadyFor(event: ServerEvent, created: CreatedSession): boolean {
  return event.type === 'session.ready' && event.turn_id === null && isSequence(event.seq)
    && isRecord(event.payload) && event.payload.session_id === created.session_id && isSequence(event.payload.last_seq);
}

export function fetchCatalog(signal?: AbortSignal): Promise<CatalogItem[]> {
  return requestJson('/catalog/scenarios', isCatalog, undefined, signal);
}

export function streamUrl(session: CreatedSession): string {
  if (!isCreatedSession(session)) throw new Error('Некорректные данные подключения к сессии');
  const base = configuredBase || window.location.origin;
  const url = new URL(session.ws_path, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function sendEvent(socket: WebSocket, type: string, turnId: string, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) throw new Error('Соединение с сервером потеряно');
  socket.send(JSON.stringify({ type, turn_id: turnId, payload }));
}

export function parseServerEvent(value: string): ServerEvent | null {
  try {
    const event: unknown = JSON.parse(value);
    if (!isRecord(event) || typeof event.type !== 'string' || !isSequence(event.seq) || !isRecord(event.payload)) return null;
    if (event.turn_id !== null && !isIdentifier(event.turn_id)) return null;
    if (event.type === 'session.ready' ? event.turn_id !== null : event.type !== 'error' && event.turn_id === null) return null;
    const payload = event.payload;
    let valid = false;
    switch (event.type) {
      case 'session.ready': valid = isIdentifier(payload.session_id) && isSequence(payload.last_seq); break;
      case 'transcript.partial': valid = typeof payload.text === 'string'; break;
      case 'transcript.final': valid = typeof payload.text === 'string' && isLanguage(payload.language); break;
      case 'agent.text': valid = typeof payload.text === 'string' && isLanguage(payload.language); break;
      case 'route.decision': valid = isRouteDecision(payload); break;
      case 'action.preview': valid = isPreview(payload); break;
      case 'audio.start': valid = isAudioFormat(payload); break;
      case 'audio.end': valid = true; break;
      case 'trace.updated': valid = isTrace(payload); break;
      case 'turn.complete': valid = ['answered', 'clarify', 'handoff', 'error'].includes(payload.status as string); break;
      case 'error': valid = isIdentifier(payload.code) && typeof payload.message === 'string' && typeof payload.recoverable === 'boolean'; break;
    }
    return valid ? event as unknown as ServerEvent : null;
  } catch {
    return null;
  }
}
