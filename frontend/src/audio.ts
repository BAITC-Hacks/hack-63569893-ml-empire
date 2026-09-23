const SAMPLE_RATE = 24000;

export interface SpeechEndOptions {
  threshold?: number;
  minSpeechMs?: number;
  silenceMs?: number;
}

/** Optional client-side end-of-speech hint, driven by captured audio time.
 * It cannot classify speech like a model: initial silence and short transients
 * never commit a turn, and a lower release threshold preserves quiet endings.
 */
export class SpeechEndDetector {
  private readonly threshold: number;
  private readonly minSpeechMs: number;
  private readonly silenceMs: number;
  private previousAt: number | null = null;
  private voicedMs = 0;
  private lastActiveAt: number | null = null;
  private speechDetected = false;
  private ended = false;
  private detectedSilenceMs = 0;

  /** Trailing silence at detection, for end-of-speech latency accounting. */
  get elapsedSilenceMs(): number { return this.detectedSilenceMs; }

  constructor(options: SpeechEndOptions = {}) {
    this.threshold = options.threshold ?? 0.025;
    this.minSpeechMs = options.minSpeechMs ?? 250;
    this.silenceMs = options.silenceMs ?? 1000;
    if (!Number.isFinite(this.threshold) || this.threshold <= 0 || this.threshold > 1
      || !Number.isFinite(this.minSpeechMs) || this.minSpeechMs <= 0
      || !Number.isFinite(this.silenceMs) || this.silenceMs <= 0) {
      throw new Error('Некорректные настройки определения конца речи');
    }
  }

  update(level: number, audioTimeMs: number): boolean {
    if (this.ended || !Number.isFinite(level) || !Number.isFinite(audioTimeMs) || audioTimeMs < 0
      || (this.previousAt !== null && audioTimeMs < this.previousAt)) return false;
    // A delayed/discontinuous report must not count as a long voiced segment.
    const elapsed = this.previousAt === null ? 0 : Math.min(100, audioTimeMs - this.previousAt);
    this.previousAt = audioTimeMs;
    if (level >= this.threshold) {
      this.voicedMs += elapsed;
      if (this.voicedMs >= this.minSpeechMs) this.speechDetected = true;
    } else if (level < this.threshold / 2 && !this.speechDetected) {
      this.voicedMs = 0;
    }
    if (level >= this.threshold / 2) this.lastActiveAt = audioTimeMs;
    if (!this.speechDetected || this.lastActiveAt === null || audioTimeMs - this.lastActiveAt < this.silenceMs) return false;
    this.detectedSilenceMs = audioTimeMs - this.lastActiveAt;
    this.ended = true;
    return true;
  }
}

export interface RecorderOptions {
  deviceId?: string;
  onLevel?: (level: number) => void;
  onUnexpectedEnd?: (error: Error) => void;
  silenceDetection?: SpeechEndOptions & { onSilence: (elapsedSilenceMs: number) => void };
}

export class PcmRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private generation = 0;
  private starting = false;
  private stopping: Promise<void> | null = null;
  private cancelFlush: (() => void) | null = null;
  private options: RecorderOptions | null = null;

  async start(onChunk: (bytes: ArrayBuffer) => void, options: RecorderOptions = {}): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      throw new Error('Этот браузер не поддерживает запись микрофона');
    }
    if (this.starting || this.stream) throw new Error('Запись уже запущена');
    const speechEnd = options.silenceDetection ? new SpeechEndDetector(options.silenceDetection) : null;
    const generation = ++this.generation;
    this.starting = true;
    this.options = options;
    const ensureCurrent = () => {
      if (generation !== this.generation) throw new DOMException('Запись отменена', 'AbortError');
    };
    const unexpectedEnd = (message: string) => {
      if (generation !== this.generation) return;
      void this.dispose();
      options.onUnexpectedEnd?.(new Error(message));
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}) },
        video: false,
      });
      if (generation !== this.generation) stream.getTracks().forEach((track) => track.stop());
      ensureCurrent();
      this.stream = stream;
      for (const track of stream.getTracks()) {
        if (track.readyState === 'ended') throw new Error('Микрофон отключён. Выберите другое устройство или повторите запись.');
        track.onended = () => unexpectedEnd('Микрофон отключён или запись неожиданно завершилась. Выберите другое устройство или перейдите на текст.');
      }
      const context = new AudioContext();
      this.context = context;
      context.onstatechange = () => {
        if (context.state === 'closed') unexpectedEnd('Запись неожиданно завершилась. Повторите реплику или перейдите на текст.');
      };
      await context.audioWorklet.addModule('/pcm-recorder-worklet.js');
      ensureCurrent();
      this.source = context.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(context, 'pcm-recorder');
      this.node.onprocessorerror = () => unexpectedEnd('Не удалось продолжить запись микрофона. Повторите реплику или перейдите на текст.');
      this.node.port.onmessage = (event: MessageEvent<{ type: string; bytes?: ArrayBuffer; level?: number; elapsedMs?: number }>) => {
        if (generation !== this.generation) return;
        if (event.data.type === 'chunk' && event.data.bytes) onChunk(event.data.bytes);
        if (event.data.type === 'level' && typeof event.data.level === 'number' && Number.isFinite(event.data.level)) {
          const level = Math.max(0, Math.min(1, event.data.level));
          options.onLevel?.(level);
          if (generation === this.generation && typeof event.data.elapsedMs === 'number' && speechEnd?.update(level, event.data.elapsedMs)) options.silenceDetection?.onSilence(speechEnd.elapsedSilenceMs);
        }
      };
      this.source.connect(this.node);
      this.node.connect(context.destination);
      await context.resume();
      ensureCurrent();
    } catch (error) {
      if (generation !== this.generation) throw new DOMException('Запись отменена', 'AbortError');
      await this.dispose();
      if (error instanceof DOMException && error.name === 'NotAllowedError') throw new Error('Разрешите доступ к микрофону в браузере');
      if (error instanceof DOMException && error.name === 'NotFoundError') throw new Error('Микрофон не найден');
      if (error instanceof DOMException && error.name === 'OverconstrainedError') throw new Error('Выбранный микрофон недоступен. Выберите другое устройство.');
      if (error instanceof DOMException && error.name === 'NotReadableError') throw new Error('Микрофон занят или недоступен. Проверьте устройство или перейдите на текст.');
      throw error;
    } finally {
      if (generation === this.generation) this.starting = false;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const node = this.node;
    if (!node) return this.dispose();
    const generation = this.generation;
    const stopping = (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => {
            window.clearTimeout(timeout);
            this.cancelFlush = null;
            if (error) reject(error); else resolve();
          };
          const timeout = window.setTimeout(() => finish(new Error('Не удалось завершить запись. Повторите реплику.')), 1000);
          this.cancelFlush = () => finish(new DOMException('Запись отменена', 'AbortError'));
          const original = node.port.onmessage;
          node.port.onmessage = (event) => {
            original?.call(node.port, event);
            if (event.data?.type === 'flushed') finish();
          };
          node.port.postMessage('flush');
        });
      } finally {
        if (generation === this.generation) await this.dispose();
      }
    })();
    this.stopping = stopping;
    const clear = () => { if (this.stopping === stopping) this.stopping = null; };
    void stopping.then(clear, clear);
    return stopping;
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    this.starting = false;
    this.stopping = null;
    this.cancelFlush?.();
    this.cancelFlush = null;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.onprocessorerror = null;
    }
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    const context = this.context;
    if (context) context.onstatechange = null;
    const options = this.options;
    this.options = null;
    this.source = null;
    this.node = null;
    this.stream = null;
    this.context = null;
    options?.onLevel?.(0);
    await context?.close().catch(() => undefined);
  }
}

interface PcmChunk {
  samples: Float32Array;
  sampleRate: number;
}

interface PlaybackStream {
  turnId: string;
  receivedEnd: boolean;
  completed: boolean;
  suppressed: boolean;
  reportMetrics: boolean;
  firstReported: boolean;
  firstTimer: number | null;
  pending: number;
  tail: Promise<void>;
}

export class PcmPlayer {
  private context: AudioContext | null = null;
  private nextAt = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private muted = false;
  private stream: PlaybackStream | null = null;
  private chunks = new Map<string, PcmChunk[]>();
  private playbackGeneration = 0;
  onFirstAudio: ((turnId: string) => void) | null = null;
  onEnded: ((turnId: string) => void) | null = null;

  async unlock(): Promise<void> {
    this.context ??= new AudioContext();
    await this.context.resume();
  }

  startStream(turnId: string): void {
    this.stop();
    this.stream = this.createStream(turnId, true);
    this.chunks.set(turnId, []);
  }

  append(bytes: ArrayBuffer, sampleRate = SAMPLE_RATE): Promise<void> {
    const stream = this.stream;
    if (!stream || stream.receivedEnd || !bytes.byteLength) return Promise.resolve();
    if (bytes.byteLength % 2 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      return Promise.reject(new Error('Некорректный формат PCM-аудио'));
    }
    const view = new DataView(bytes);
    const samples = new Float32Array(bytes.byteLength / 2);
    for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
    const chunk = { samples, sampleRate };
    this.chunks.get(stream.turnId)?.push(chunk);
    return this.enqueue(stream, chunk);
  }

  endStream(): void {
    if (!this.stream) return;
    this.stream.receivedEnd = true;
    this.finishIfDrained(this.stream);
  }

  private createStream(turnId: string, reportMetrics: boolean): PlaybackStream {
    return { turnId, reportMetrics, receivedEnd: false, completed: false, suppressed: false, firstReported: false, firstTimer: null, pending: 0, tail: Promise.resolve() };
  }

  private enqueue(stream: PlaybackStream, chunk: PcmChunk): Promise<void> {
    if (stream.suppressed || this.muted) return Promise.resolve();
    const generation = this.playbackGeneration;
    stream.pending += 1;
    const queued = stream.tail.then(async () => {
      if (this.stream !== stream || generation !== this.playbackGeneration || this.muted || stream.suppressed) return;
      await this.unlock();
      if (this.stream === stream && generation === this.playbackGeneration && !this.muted && !stream.suppressed) this.schedule(stream, chunk);
    });
    // A failed resume must not reorder later frames or leave the queue stuck.
    stream.tail = queued.catch(() => undefined);
    return queued.finally(() => {
      if (generation !== this.playbackGeneration) return;
      stream.pending -= 1;
      this.finishIfDrained(stream);
    });
  }

  private schedule(stream: PlaybackStream, { samples, sampleRate }: PcmChunk): void {
    const context = this.context;
    if (!context || this.muted || !samples.length) return;
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = context.createBufferSource();
    const generation = this.playbackGeneration;
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.012, this.nextAt);
    this.nextAt = startAt + buffer.duration;
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (generation === this.playbackGeneration) this.finishIfDrained(stream);
    };
    this.sources.add(source);
    source.start(startAt);
    if (stream.reportMetrics && !stream.firstReported && stream.firstTimer === null) {
      const reportStart = () => {
        stream.firstTimer = null;
        if (this.stream !== stream || generation !== this.playbackGeneration || this.muted) return;
        // Timer delivery can precede the audio clock, or the browser can suspend
        // the context. Never record a first-sound metric before playback starts.
        if (context.state !== 'running' || context.currentTime < startAt) {
          stream.firstTimer = window.setTimeout(reportStart, Math.max(16, (startAt - context.currentTime) * 1000));
          return;
        }
        stream.firstReported = true;
        this.onFirstAudio?.(stream.turnId);
      };
      stream.firstTimer = window.setTimeout(reportStart, Math.max(0, (startAt - context.currentTime) * 1000));
    }
  }

  async replay(turnId: string): Promise<void> {
    const chunks = this.chunks.get(turnId);
    if (!chunks?.length || this.muted) return;
    this.stop();
    const stream = this.createStream(turnId, false);
    this.stream = stream;
    const queued = chunks.map((chunk) => this.enqueue(stream, chunk));
    this.endStream();
    await Promise.all(queued);
  }

  private finishIfDrained(stream: PlaybackStream): void {
    if (this.stream !== stream || stream.completed || !stream.receivedEnd || (stream.pending && !stream.suppressed) || this.sources.size) return;
    stream.completed = true;
    this.onEnded?.(stream.turnId);
  }

  hasAudio(turnId: string): boolean { return !!this.chunks.get(turnId)?.length; }

  isPlaying(): boolean { return this.sources.size > 0 || !!(this.stream && !this.stream.suppressed && this.stream.pending > 0); }

  /** Silence this answer without discarding its remaining receive-only PCM.
   * The transport must still deliver audio.end; replay then has the full reply.
   */
  stopCurrentPlayback(): void {
    if (!this.stream) return;
    this.stream.suppressed = true;
    this.stopSources();
    this.finishIfDrained(this.stream);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.stopSources();
      if (this.stream) this.finishIfDrained(this.stream);
    }
  }

  private stopSources(): void {
    this.playbackGeneration += 1;
    if (this.stream) {
      // A suspended resume promise belongs to the invalidated playback
      // generation. Do not let it block unmuted frames or hold the UI busy.
      this.stream.pending = 0;
      this.stream.tail = Promise.resolve();
    }
    if (this.stream?.firstTimer !== null && this.stream?.firstTimer !== undefined) {
      window.clearTimeout(this.stream.firstTimer);
      this.stream.firstTimer = null;
    }
    this.sources.forEach((source) => {
      try { source.stop(); } catch { /* source may have already ended */ }
    });
    this.sources.clear();
    this.nextAt = 0;
  }

  stop(): void {
    this.stopSources();
    this.stream = null;
  }

  clear(): void {
    this.stop();
    this.chunks.clear();
  }

  async dispose(): Promise<void> {
    this.clear();
    const context = this.context;
    this.context = null;
    await context?.close().catch(() => undefined);
  }
}
