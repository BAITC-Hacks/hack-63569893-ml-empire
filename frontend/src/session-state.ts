import type { ActionPreview, Language, RestoredSession, RouteDecision, ServerEvent, TracePayload, Turn } from './types';
import { isLanguage, isRouteDecision } from './api.ts';

export function maskPersonalData(value: string): string {
  return value
    .replace(/\b\d{12}\b/g, '************')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, (email) => {
      const [name, domain] = email.split('@');
      return `${name.slice(0, 1)}***@${domain}`;
    })
    .replace(/(?<!\d)(?:\+?7|8)[\s()-]*\d(?:[\s()-]*\d){9}(?!\d)/g, (phone) => `${phone.startsWith('+') ? '+7' : phone[0]} *** *** ** **`);
}

function mergeTrace(previous: TracePayload | null, next: TracePayload): TracePayload {
  return {
    ...previous, ...next,
    ...((previous?.latency_ms || next.latency_ms) ? { latency_ms: { ...previous?.latency_ms, ...next.latency_ms } } : {}),
    client_first_audio_ms: next.client_first_audio_ms ?? previous?.client_first_audio_ms,
  };
}

// Events have already passed the protocol validator. Keep this reducer synchronous
// so several WebSocket frames in one React render cannot overwrite each other.
export function shouldApplyTurnEvent(turn: Turn, event: ServerEvent): boolean {
  if (turn.id !== event.turn_id) return false;
  const isTerminal = turn.status !== 'draft' && turn.status !== 'processing';
  // Apply this same boundary to hook side effects, especially confirmations.
  return !isTerminal || event.type === 'trace.updated'
    || (event.type === 'error' && event.payload.code === 'tts_unavailable' && turn.status !== 'error');
}

export function applyTurnEvent(turns: Turn[], event: ServerEvent): Turn[] {
  return turns.map((turn) => {
    if (!shouldApplyTurnEvent(turn, event)) return turn;
    const p = event.payload;
    switch (event.type) {
      case 'transcript.partial': return { ...turn, partialText: String(p.text) };
      case 'transcript.final': return { ...turn, text: String(p.text), partialText: '', language: p.language as Language };
      case 'route.decision': return { ...turn, route: p as unknown as RouteDecision, language: p.language as Language };
      case 'action.preview': return { ...turn, preview: p as unknown as ActionPreview };
      case 'agent.text': return { ...turn, reply: String(p.text), replyLanguage: p.language as Language };
      case 'trace.updated': return { ...turn, trace: mergeTrace(turn.trace, p as TracePayload) };
      case 'turn.complete': return { ...turn, status: p.status === 'clarify' || p.status === 'handoff' || p.status === 'error' ? p.status : 'answered' };
      case 'error': {
        const safeTurn = { ...turn };
        delete safeTurn.error;
        return { ...safeTurn, errorCode: String(p.code), status: p.code === 'tts_unavailable' ? turn.status : 'error' };
      }
      default: return turn;
    }
  });
}

export function interruptTurns(turns: Turn[]): Turn[] {
  return turns.map((turn) => turn.status === 'processing' || turn.status === 'draft' ? { ...turn, status: 'interrupted' } : turn);
}

export function isCurrentSnapshot(state: RestoredSession, latestTurnId: string | undefined, lastSeq: number): boolean {
  return state.last_turn_id === latestTurnId && state.last_seq >= lastSeq;
}

// The snapshot is not a conversation archive and has no terminal-turn status.
// Never invent a reply or claim an interrupted action failed/succeeded.
export function restoreTurns(turns: Turn[], state: RestoredSession, now = Date.now()): Turn[] {
  if (!state.last_turn_id) return turns;
  const existing = turns.find((turn) => turn.id === state.last_turn_id);
  const base: Turn = existing ?? {
    id: state.last_turn_id, mode: 'text', text: '', reply: '', language: null, replyLanguage: null,
    status: 'interrupted', route: null, trace: null, preview: null, restored: true, at: now,
  };
  const traceTranscript = state.last_trace?.transcript;
  const transcript = typeof traceTranscript === 'string' ? { text: traceTranscript } : (
    traceTranscript && typeof traceTranscript === 'object' && !Array.isArray(traceTranscript)
    && 'text' in traceTranscript && typeof traceTranscript.text === 'string'
    && 'language' in traceTranscript && isLanguage(traceTranscript.language)
      ? { text: traceTranscript.text, language: traceTranscript.language } : null
  );
  const traceRoute = state.last_trace?.route;
  const knownRoute = isRouteDecision(traceRoute) ? traceRoute : base.route;
  const route: RouteDecision = {
    ...(knownRoute ?? { scenarios: [], alternatives: [], language: transcript?.language ?? base.language }),
    // Active execution can differ from the primary classification. A snapshot
    // without a route does not justify inventing a primary scenario.
    active_scenario: state.active_scenario,
  };
  const restored: Turn = {
    ...base, route,
    text: transcript?.text ?? base.text,
    language: transcript?.language ?? knownRoute?.language ?? base.language,
    status: base.status === 'processing' ? 'interrupted' : base.status,
    preview: state.pending_confirmation,
    trace: state.last_trace ? mergeTrace(base.trace, state.last_trace) : base.trace,
  };
  return existing ? turns.map((turn) => turn.id === existing.id ? restored : turn) : [...turns, restored];
}
