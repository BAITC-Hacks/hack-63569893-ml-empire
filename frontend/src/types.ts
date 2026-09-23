export type Language = 'ru' | 'kk' | 'mixed' | null;
export type ConnectionStatus = 'offline' | 'connecting' | 'ready' | 'reconnecting';
export type CallPhase = 'idle' | 'preparing' | 'recording' | 'processing' | 'speaking';
export type TurnStatus = 'draft' | 'processing' | 'answered' | 'clarify' | 'handoff' | 'error' | 'interrupted';

export interface AudioFormat {
  encoding: 'pcm_s16le';
  sample_rate_hz: number;
  channels: number;
}

export interface CreatedSession {
  session_id: string;
  ws_path: string;
  audio_input: AudioFormat;
  audio_output: AudioFormat;
  as_of_date: string;
}

export interface RestoredSession {
  session_id: string;
  last_seq: number;
  last_turn_id: string | null;
  active_scenario: Scenario | string | null;
  pending_confirmation: ActionPreview | null;
  last_trace: TracePayload | null;
}

export interface ServerEvent<T = Record<string, unknown>> {
  type: string;
  turn_id: string | null;
  seq: number;
  payload: T;
}

export interface Scenario {
  scenario_id: string;
  name?: string;
  priority?: 'normal' | 'high' | 'urgent';
  reason?: string;
  confidence_estimate?: number;
}

export interface RouteDecision {
  scenarios: Scenario[];
  alternatives: Array<Scenario | string>;
  reason?: string;
  language: Language;
  slots?: Record<string, unknown>;
  source?: 'llm' | 'continuation' | 'confirmation';
  active_scenario?: Scenario | string | null;
  pending_scenarios?: Array<Scenario | string>;
  suspended_scenarios?: Array<Scenario | string>;
}

export interface ActionPreview {
  name: string;
  summary: string;
  masked_args?: Record<string, unknown>;
}

export interface LatencyMetrics {
  stt?: number;
  triage?: number;
  router?: number;
  response?: number;
  tts_first_audio?: number;
  total?: number;
}

export interface TracePayload {
  actions?: Array<string | Record<string, unknown>>;
  latency_ms?: LatencyMetrics;
  client_first_audio_ms?: number | null;
  handoff?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface Turn {
  id: string;
  mode: 'audio' | 'text';
  text: string;
  partialText?: string;
  language: Language;
  reply: string;
  replyLanguage: Language;
  status: TurnStatus;
  route: RouteDecision | null;
  trace: TracePayload | null;
  preview: ActionPreview | null;
  error?: string;
  errorCode?: string;
  restored?: boolean;
  at: number;
}

export interface CatalogItem {
  scenario_id: string;
  name: string;
  priority: 'normal' | 'high' | 'urgent';
}
