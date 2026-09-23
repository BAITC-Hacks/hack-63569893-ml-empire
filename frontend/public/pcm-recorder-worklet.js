class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.position = 0;
    this.stopped = false;
    this.ratio = sampleRate / 24000;
    this.meterSamples = 0;
    this.meterSquares = 0;
    this.totalSamples = 0;
    this.meterWindowSamples = Math.round(sampleRate * 0.05);
    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        if (this.stopped) return;
        this.stopped = true;
        this.sendPending();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  sendPending() {
    if (!this.pending.length) return;
    const bytes = new ArrayBuffer(this.pending.length * 2);
    const view = new DataView(bytes);
    this.pending.forEach((sample, index) => view.setInt16(index * 2, sample, true));
    this.pending = [];
    this.port.postMessage({ type: 'chunk', bytes }, [bytes]);
  }

  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    if (this.stopped) return false;
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const length = input[0].length;
    // RMS is measured from the captured, downmixed signal, not simulated UI
    // motion. Report about every 50ms; capture time also drives optional VAD.
    for (let index = 0; index < length; index++) {
      let mono = 0;
      for (const channel of input) mono += channel[index] || 0;
      mono = Math.max(-1, Math.min(1, mono / input.length));
      this.meterSquares += mono * mono;
    }
    this.meterSamples += length;
    this.totalSamples += length;
    if (this.meterSamples >= this.meterWindowSamples) {
      this.port.postMessage({ type: 'level', level: Math.sqrt(this.meterSquares / this.meterSamples), elapsedMs: this.totalSamples / sampleRate * 1000 });
      this.meterSamples = 0;
      this.meterSquares = 0;
    }
    for (; this.position < length; this.position += this.ratio) {
      const index = Math.min(Math.floor(this.position), length - 1);
      let mono = 0;
      for (const channel of input) mono += channel[index] || 0;
      mono = Math.max(-1, Math.min(1, mono / input.length));
      this.pending.push(mono < 0 ? Math.round(mono * 32768) : Math.round(mono * 32767));
    }
    this.position -= length;
    if (this.pending.length >= 1200) this.sendPending();
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
