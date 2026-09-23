/** Local-only, bounded PCM cache. It never uploads or persists microphone data. */
export class CaptureBuffer {
  readonly chunks: ArrayBuffer[] = [];
  private bytes = 0;
  private readonly limit: number;
  constructor(maxSeconds = 15) {
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 60) throw new Error('Invalid duration');
    this.limit = Math.floor(maxSeconds * 24000) * 2;
  }
  get seconds(): number { return this.bytes / 48000; }
  append(chunk: ArrayBuffer): boolean {
    if (chunk.byteLength % 2) throw new Error('Invalid PCM');
    const remaining = this.limit - this.bytes;
    if (remaining <= 0) return false;
    const copy = chunk.slice(0, remaining);
    if (copy.byteLength) { this.chunks.push(copy); this.bytes += copy.byteLength; }
    return this.bytes < this.limit;
  }
  clear(): void { this.chunks.length = 0; this.bytes = 0; }
}

export function createTestTone(): ArrayBuffer {
  const count = 48000;
  const buffer = new ArrayBuffer(count * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < count; i++) {
    const fade = Math.min(1, i / 1200, (count - 1 - i) / 1200);
    view.setInt16(i * 2, Math.round(Math.sin(i * 2 * Math.PI * 440 / 24000) * .08 * 32767 * fade), true);
  }
  return buffer;
}

type DiagnosticPlayback = {
  unlock(): Promise<void>;
  startStream(id: string): void;
  append(chunk: ArrayBuffer): Promise<void>;
  endStream(): void;
  stop(): void;
};

/** Every browser resume can suspend. Check ownership after each await so a
 * stopped diagnostic cannot append to, finish, or interrupt its replacement. */
export async function playDiagnosticAudio(player: DiagnosticPlayback, chunks: readonly ArrayBuffer[], isCurrent: () => boolean): Promise<void> {
  try {
    await player.unlock();
    if (!isCurrent()) return;
    player.startStream('diagnostic');
    for (const chunk of chunks) {
      if (!isCurrent()) return;
      await player.append(chunk);
    }
    if (isCurrent()) player.endStream();
  } catch (error) {
    if (!isCurrent()) return;
    player.stop();
    throw error;
  }
}
