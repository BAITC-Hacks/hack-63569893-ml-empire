export const emotions = ['neutral', 'concerned', 'frustrated', 'angry', 'sad', 'positive'] as const;
export const tones = ['neutral', 'empathetic', 'calm', 'reassuring', 'concise'] as const;
export interface Affect {
  emotion: typeof emotions[number] | null;
  tone: typeof tones[number] | null;
  source: 'audio' | 'text' | 'multimodal' | null;
  confidence: number | null;
}
export function readAffect(trace: unknown): Affect | null {
  if (!trace || typeof trace !== 'object') return null;
  const value = (trace as Record<string, unknown>).affect;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const emotion = emotions.find(item => item === data.emotion) ?? null;
  const tone = tones.find(item => item === data.response_tone) ?? null;
  if (!emotion && !tone) return null;
  return { emotion, tone,
    source: data.source === 'audio' || data.source === 'text' || data.source === 'multimodal' ? data.source : null,
    confidence: typeof data.confidence === 'number' && Number.isFinite(data.confidence) && data.confidence >= 0 && data.confidence <= 1 ? data.confidence : null,
  };
}
