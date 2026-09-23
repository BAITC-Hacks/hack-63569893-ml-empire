import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as audio from '../src/audio.ts';
const { PcmPlayer, PcmRecorder } = audio;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const pcm = (...values) => new Int16Array(values).buffer;

// Only browser audio/permission/timer boundaries are replaced; sequencing, PCM
// conversion, cancellation and callbacks all run through the real audio classes.
function browserAudio(t, { resumes = [], permission, module } = {}) {
  const contexts = [];
  const nodes = [];
  const timers = new Map();
  const constraints = [];
  let timerId = 0;
  let now = 0;
  const stream = { tracks: [{ stopped: false, stop() { this.stopped = true; } }], getTracks() { return this.tracks; } };
  class AudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.destination = {};
      this.sources = [];
      this.audioWorklet = { addModule: () => module?.promise ?? Promise.resolve() };
      contexts.push(this);
    }
    resume() { return resumes.shift()?.promise ?? Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createBuffer(channels, length, sampleRate) {
      return { duration: length / sampleRate, sampleRate, samples: null, copyToChannel(samples) { this.samples = [...samples]; } };
    }
    createBufferSource() {
      const source = {
        buffer: null, onended: null, startAt: null, stopped: false,
        connect() {}, disconnect() {},
        start(at) { this.startAt = at; },
        stop() { this.stopped = true; this.onended?.(); },
        finish() { this.onended?.(); },
      };
      this.sources.push(source);
      return source;
    }
  }
  class AudioWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage: (data) => {
        if (data === 'flush') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'flushed' } }));
      } };
      nodes.push(this);
    }
    connect() {}
    disconnect() {}
  }
  const previous = new Map(['window', 'navigator', 'AudioContext', 'AudioWorkletNode'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: {
      AudioWorkletNode,
      setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
      clearTimeout: (id) => timers.delete(id),
    } },
    navigator: { configurable: true, value: { mediaDevices: { getUserMedia: (requested) => { constraints.push(requested); return permission?.promise ?? Promise.resolve(stream); } } } },
    AudioContext: { configurable: true, value: AudioContext },
    AudioWorkletNode: { configurable: true, value: AudioWorkletNode },
  });
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    contexts, nodes, stream, constraints,
    elapse(ms) {
      now += ms;
      contexts.forEach((context) => { if (context.state === 'running') context.currentTime += ms / 1000; });
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
  };
}

test('PCM chunks keep arrival order while the first AudioContext resume is pending', async (t) => {
  const gate = deferred();
  const browser = browserAudio(t, { resumes: [gate] });
  const player = new PcmPlayer();
  player.startStream('turn-1');
  const first = player.append(pcm(1000));
  const second = player.append(pcm(2000));
  assert.equal(player.isPlaying(), true, 'pending audio must block the next turn');
  await settle();
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(browser.contexts[0].sources.map((source) => source.buffer.samples[0]), [1000 / 32768, 2000 / 32768]);
  assert.ok(browser.contexts[0].sources[1].startAt >= browser.contexts[0].sources[0].startAt);
  await player.dispose();
});

test('completion waits for audio.end as well as the drained playback queue', async (t) => {
  const browser = browserAudio(t);
  const player = new PcmPlayer();
  const ended = [];
  player.onEnded = (turnId) => ended.push(turnId);
  player.startStream('turn-2');
  await player.append(pcm(300));
  browser.contexts[0].sources[0].finish();
  assert.deepEqual(ended, [], 'a network gap is not end of stream');
  await player.append(pcm(400));
  player.endStream();
  assert.deepEqual(ended, []);
  browser.contexts[0].sources[1].finish();
  assert.deepEqual(ended, ['turn-2']);
  player.endStream();
  assert.deepEqual(ended, ['turn-2']);
  await player.dispose();
});

test('audio.end cannot complete while an append is waiting for resume', async (t) => {
  const gate = deferred();
  const browser = browserAudio(t, { resumes: [gate] });
  const player = new PcmPlayer();
  const ended = [];
  player.onEnded = (id) => ended.push(id);
  player.startStream('pending');
  const append = player.append(pcm(900));
  player.endStream();
  assert.deepEqual(ended, []);
  gate.resolve();
  await append;
  assert.deepEqual(ended, []);
  browser.contexts[0].sources[0].finish();
  assert.deepEqual(ended, ['pending']);
  await player.dispose();
});

test('stop and a new stream discard stale queued PCM and first-audio metrics', async (t) => {
  const gate = deferred();
  const browser = browserAudio(t, { resumes: [gate] });
  const player = new PcmPlayer();
  const started = [];
  player.onFirstAudio = (id) => started.push(id);
  player.startStream('old');
  const oldAppend = player.append(pcm(100));
  await settle();
  player.startStream('new');
  await player.append(pcm(200));
  gate.resolve();
  await oldAppend;
  browser.elapse(20);
  assert.deepEqual(started, ['new']);
  assert.deepEqual(browser.contexts[0].sources.map((source) => source.buffer.samples[0]), [200 / 32768]);
  player.stop();
  browser.elapse(100);
  assert.equal(player.isPlaying(), false);
  await player.dispose();
});

test('mute cancels scheduled metrics but caches stream audio for replay without new metrics', async (t) => {
  const browser = browserAudio(t);
  const player = new PcmPlayer();
  const started = [];
  const ended = [];
  player.onFirstAudio = (id) => started.push(id);
  player.onEnded = (id) => ended.push(id);
  player.startStream('muted-turn');
  await player.append(pcm(100), 16000);
  player.setMuted(true);
  await player.append(pcm(200), 16000);
  player.endStream();
  browser.elapse(50);
  assert.deepEqual(started, []);
  assert.deepEqual(ended, ['muted-turn']);
  assert.equal(player.hasAudio('muted-turn'), true);
  player.setMuted(false);
  await player.replay('muted-turn');
  browser.elapse(50);
  assert.deepEqual(started, [], 'replay must not replace latency of the original reply');
  assert.deepEqual(browser.contexts[0].sources.slice(-2).map((source) => source.buffer.sampleRate), [16000, 16000]);
  assert.deepEqual(browser.contexts[0].sources.slice(-2).map((source) => source.buffer.samples[0]), [100 / 32768, 200 / 32768]);
  player.clear();
  assert.equal(player.hasAudio('muted-turn'), false);
  await player.dispose();
});

test('stop suppresses a first-audio callback already scheduled on a timer', async (t) => {
  const browser = browserAudio(t);
  const player = new PcmPlayer();
  const started = [];
  player.onFirstAudio = (id) => started.push(id);
  player.startStream('stopped');
  await player.append(pcm(300));
  player.stop();
  browser.elapse(100);
  assert.deepEqual(started, []);
  await player.dispose();
});

test('muting invalidates pending playback even if unmuted before resume finishes', async (t) => {
  const gate = deferred();
  const browser = browserAudio(t, { resumes: [gate] });
  const player = new PcmPlayer();
  const started = [];
  player.onFirstAudio = (id) => started.push(id);
  player.startStream('mute-resume');
  const pending = player.append(pcm(500));
  await settle();
  player.setMuted(true);
  player.setMuted(false);
  gate.resolve();
  await pending;
  browser.elapse(100);
  assert.deepEqual(started, []);
  assert.equal(browser.contexts[0].sources.length, 0);
  await player.append(pcm(600));
  browser.elapse(100);
  assert.deepEqual(started, ['mute-resume']);
  await player.dispose();
});

test('a flush timeout rejects instead of permitting a commit with truncated audio', async (t) => {
  const browser = browserAudio(t);
  const recorder = new PcmRecorder();
  await recorder.start(() => {});
  browser.nodes[0].port.postMessage = () => {};
  const rejected = assert.rejects(recorder.stop(), /Не удалось завершить запись/);
  browser.elapse(1001);
  await rejected;
  assert.equal(browser.stream.tracks[0].stopped, true);
  assert.equal(browser.contexts[0].state, 'closed');
});

test('malformed PCM rejects without playing or caching partial samples', async (t) => {
  const browser = browserAudio(t);
  const player = new PcmPlayer();
  player.startStream('invalid');
  await assert.rejects(player.append(new ArrayBuffer(3)), /PCM/);
  await assert.rejects(player.append(pcm(500), 0), /PCM/);
  assert.equal(player.hasAudio('invalid'), false);
  assert.equal(player.isPlaying(), false);
  assert.equal(browser.contexts.length, 0);
  await player.dispose();
});

test('recorder cancellation while permission is pending stops the late microphone stream', async (t) => {
  const permission = deferred();
  const browser = browserAudio(t, { permission });
  const recorder = new PcmRecorder();
  const start = recorder.start(() => assert.fail('cancelled recorder emitted a chunk'));
  const rejected = assert.rejects(start, { name: 'AbortError' });
  await recorder.dispose();
  permission.resolve(browser.stream);
  await rejected;
  assert.equal(browser.stream.tracks[0].stopped, true);
  assert.equal(browser.contexts.length, 0, 'cancelled start must not allocate an AudioContext');
});

test('recorder cancellation during worklet loading closes context and cannot reconnect tracks', async (t) => {
  const module = deferred();
  const browser = browserAudio(t, { module });
  const recorder = new PcmRecorder();
  const start = recorder.start(() => assert.fail('cancelled recorder emitted a chunk'));
  const rejected = assert.rejects(start, { name: 'AbortError' });
  await settle();
  await recorder.dispose();
  module.resolve();
  await rejected;
  assert.equal(browser.stream.tracks[0].stopped, true);
  assert.equal(browser.contexts[0].state, 'closed');
  assert.equal(browser.nodes.length, 0);
});

test('recorder stop is idempotent and delivers final chunk before resolving', async (t) => {
  const browser = browserAudio(t);
  const recorder = new PcmRecorder();
  const chunks = [];
  await recorder.start((bytes) => chunks.push(new Int16Array(bytes)[0]));
  let flushes = 0;
  browser.nodes[0].port.postMessage = () => {
    flushes++;
    queueMicrotask(() => {
      browser.nodes[0].port.onmessage?.({ data: { type: 'chunk', bytes: pcm(123) } });
      browser.nodes[0].port.onmessage?.({ data: { type: 'flushed' } });
    });
  };
  await Promise.all([recorder.stop(), recorder.stop()]);
  assert.deepEqual(chunks, [123]);
  assert.equal(flushes, 1);
  assert.equal(browser.stream.tracks[0].stopped, true);
});

test('worklet emits mono little-endian PCM at 24 kHz and no chunks after flush', async () => {
  const messages = [];
  let Processor;
  const source = await readFile(new URL('../public/pcm-recorder-worklet.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage: (message) => messages.push(message) }; } },
    registerProcessor(name, processor) { assert.equal(name, 'pcm-recorder'); Processor = processor; },
  });
  const processor = new Processor();
  const output = new Float32Array(128).fill(1);
  processor.process([[new Float32Array(128).fill(1), new Float32Array(128).fill(0)]], [[output]]);
  processor.port.onmessage({ data: 'flush' });
  assert.equal(messages[0].type, 'chunk');
  assert.equal(messages[0].bytes.byteLength, 64 * 2);
  assert.equal(new DataView(messages[0].bytes).getInt16(0, true), 16384);
  assert.equal(messages[1].type, 'flushed');
  assert.ok(output.every((sample) => sample === 0));
  for (let i = 0; i < 24; i++) processor.process([[new Float32Array(128).fill(1)]], [[output]]);
  assert.equal(messages.length, 2, 'flush must freeze capture before acknowledging the final frame');
});

test('recorder selects the requested input, reports bounded levels and resets the meter on stop', async (t) => {
  const browser = browserAudio(t);
  const recorder = new PcmRecorder();
  const levels = [];
  await recorder.start(() => {}, { deviceId: 'usb-mic', onLevel: (level) => levels.push(level) });
  assert.deepEqual(browser.constraints[0].audio.deviceId, { exact: 'usb-mic' });
  const emit = (level) => browser.nodes[0].port.onmessage({ data: { type: 'level', level, elapsedMs: 50 } });
  emit(0.3);
  emit(4);
  emit(-2);
  emit(NaN);
  await recorder.stop();
  assert.deepEqual(levels, [0.3, 1, 0, 0]);
});

test('unexpected microphone unplug reports once, releases resources, and rejects later chunks', async (t) => {
  const browser = browserAudio(t);
  const recorder = new PcmRecorder();
  const errors = [];
  await recorder.start(() => assert.fail('disconnected microphone emitted data'), { onUnexpectedEnd: (error) => errors.push(error.message) });
  assert.equal(typeof browser.stream.tracks[0].onended, 'function');
  const onEnded = browser.stream.tracks[0].onended;
  const onMessage = browser.nodes[0].port.onmessage;
  onEnded();
  onEnded();
  await settle();
  onMessage({ data: { type: 'chunk', bytes: pcm(500) } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /отключ|заверш/);
  assert.equal(browser.stream.tracks[0].stopped, true);
  assert.equal(browser.contexts[0].state, 'closed');
});

test('processor error reports an actionable failure but manual stop does not', async (t) => {
  const browser = browserAudio(t);
  const errors = [];
  const recorder = new PcmRecorder();
  await recorder.start(() => {}, { onUnexpectedEnd: (error) => errors.push(error.message) });
  assert.equal(typeof browser.nodes[0].onprocessorerror, 'function');
  browser.nodes[0].onprocessorerror();
  await settle();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /запис/);
  await recorder.start(() => {}, { onUnexpectedEnd: (error) => errors.push(error.message) });
  await recorder.stop();
  assert.equal(errors.length, 1);
  assert.equal(browser.nodes[1].onprocessorerror, null);
  assert.equal(browser.stream.tracks[0].onended, null);
});

test('silence detector never ends initial silence or a short transient and triggers once after speech', () => {
  assert.equal(typeof audio.SpeechEndDetector, 'function');
  const detector = new audio.SpeechEndDetector();
  for (let time = 0; time < 5000; time += 50) assert.equal(detector.update(0, time), false);
  assert.equal(detector.update(0.5, 5000), false);
  for (let time = 5050; time < 7000; time += 50) assert.equal(detector.update(0, time), false);
  for (let time = 7000; time <= 7300; time += 50) assert.equal(detector.update(0.05, time), false);
  for (let time = 7350; time < 8300; time += 50) assert.equal(detector.update(0, time), false);
  assert.equal(detector.elapsedSilenceMs, 0, 'no committed end boundary is exposed while still listening');
  assert.equal(detector.update(0, 8300), true);
  assert.equal(detector.elapsedSilenceMs, 1000);
  assert.equal(detector.update(0, 9000), false);
  assert.equal(detector.elapsedSilenceMs, 1000, 'the detected end boundary remains fixed');
});

test('silence detector retains quiet phrase endings and supports explicit tuning', () => {
  assert.equal(typeof audio.SpeechEndDetector, 'function');
  const detector = new audio.SpeechEndDetector({ threshold: 0.04, minSpeechMs: 100, silenceMs: 600 });
  for (let time = 0; time <= 200; time += 50) assert.equal(detector.update(0.08, time), false);
  for (let time = 250; time <= 1000; time += 50) assert.equal(detector.update(0.025, time), false, 'quiet ending counts as continuing speech');
  assert.equal(detector.update(0, 1500), false);
  assert.equal(detector.update(0, 1600), true);
});

test('silence detector ignores invalid/out-of-order reports and refuses unsafe settings', () => {
  for (const settings of [{ threshold: 0 }, { threshold: NaN }, { threshold: 2 }, { minSpeechMs: -1 }, { silenceMs: Infinity }]) {
    assert.throws(() => new audio.SpeechEndDetector(settings), /настройки/);
  }
  const detector = new audio.SpeechEndDetector();
  assert.equal(detector.update(0.1, 100), false);
  assert.equal(detector.update(0.1, 10_000), false, 'one delayed loud frame cannot qualify as sustained speech');
  assert.equal(detector.update(0, 11_000), false);
  assert.equal(detector.update(NaN, 12_000), false);
  assert.equal(detector.update(0.1, -1), false);
  assert.equal(detector.update(0.1, 1), false);
  assert.equal(detector.update(0, Infinity), false);
});

test('recorder applies opt-in silence detection using worklet audio time and not a recording timer', async (t) => {
  const browser = browserAudio(t);
  const recorder = new PcmRecorder();
  const detections = [];
  await recorder.start(() => {}, { silenceDetection: { minSpeechMs: 100, silenceMs: 500, onSilence: (elapsedSilenceMs) => detections.push(elapsedSilenceMs) } });
  const emit = (level, elapsedMs) => browser.nodes[0].port.onmessage({ data: { type: 'level', level, elapsedMs } });
  browser.elapse(60_000);
  assert.deepEqual(detections, [], 'elapsed wall time must never commit speech');
  for (let time = 0; time <= 200; time += 50) emit(0.1, time);
  emit(0, 650);
  assert.deepEqual(detections, []);
  emit(0, 725);
  emit(0, 750);
  assert.deepEqual(detections, [525], 'latency can include measured trailing silence, including render-block overshoot');
  await recorder.dispose();
});

test('worklet meters real mono PCM around 20Hz without changing the audio stream', async () => {
  const messages = [];
  let Processor;
  const source = await readFile(new URL('../public/pcm-recorder-worklet.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage: (message) => messages.push(message) }; } },
    registerProcessor(_name, processor) { Processor = processor; },
  });
  const processor = new Processor();
  for (let index = 0; index < 40; index++) processor.process([[new Float32Array(128).fill(0.5)]], [[new Float32Array(128)]]);
  const levels = messages.filter((message) => message.type === 'level');
  assert.equal(levels.length, 2, '5120 samples at 48 kHz are two 50ms meter windows');
  assert.ok(levels.every((message) => Math.abs(message.level - 0.5) < 0.000001));
  assert.ok(levels[0].elapsedMs >= 50 && levels[0].elapsedMs < 53);
  assert.ok(levels[1].elapsedMs >= 100 && levels[1].elapsedMs < 107);
  processor.port.onmessage({ data: 'flush' });
  const count = messages.length;
  processor.process([[new Float32Array(128).fill(0.5)]], [[new Float32Array(128)]]);
  assert.equal(messages.length, count);
});

test('worklet preserves 24kHz PCM sample count across fractional 44.1kHz render blocks', async () => {
  const messages = [];
  let Processor;
  const source = await readFile(new URL('../public/pcm-recorder-worklet.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    sampleRate: 44100,
    AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage: (message) => messages.push(message) }; } },
    registerProcessor(_name, processor) { Processor = processor; },
  });
  const processor = new Processor();
  let remaining = 44100;
  while (remaining > 0) {
    const length = Math.min(128, remaining);
    processor.process([[new Float32Array(length).fill(-0.5)]], [[new Float32Array(length)]]);
    remaining -= length;
  }
  processor.port.onmessage({ data: 'flush' });
  const chunks = messages.filter((message) => message.type === 'chunk');
  const samples = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength / 2, 0);
  assert.ok(Math.abs(samples - 24000) <= 1, 'fractional position must carry across render blocks');
  assert.ok(chunks.every((chunk) => new DataView(chunk.bytes).getInt16(0, true) === -16384));
});

test('stopping a pending playback immediately clears busy state and preserves replayable audio', async (t) => {
  const gate = deferred();
  const browser = browserAudio(t, { resumes: [gate] });
  const player = new PcmPlayer();
  const starts = [];
  player.onFirstAudio = (turnId) => starts.push(turnId);
  player.startStream('stop-before-resume');
  const pending = player.append(pcm(1200));
  await settle();
  player.stop();
  assert.equal(player.isPlaying(), false);
  assert.equal(player.hasAudio('stop-before-resume'), true);
  gate.resolve();
  await pending;
  browser.elapse(1000);
  assert.deepEqual(starts, []);
  assert.equal(browser.contexts[0].sources.length, 0);
  await player.replay('stop-before-resume');
  assert.equal(player.isPlaying(), true);
  assert.equal(browser.contexts[0].sources[0].buffer.samples[0], 1200 / 32768);
  await player.dispose();
});

test('stopping current playback keeps receiving the complete answer for replay without metrics', async (t) => {
  const browser = browserAudio(t);
  const player = new PcmPlayer();
  const metrics = [];
  const ended = [];
  player.onFirstAudio = (turnId) => metrics.push(turnId);
  player.onEnded = (turnId) => ended.push(turnId);
  player.startStream('stopped-live');
  await player.append(pcm(100));
  assert.equal(typeof player.stopCurrentPlayback, 'function');
  player.stopCurrentPlayback();
  assert.equal(player.isPlaying(), false);
  assert.deepEqual(ended, [], 'a stopped receive stream remains open until audio.end');
  await player.append(pcm(200));
  await player.append(pcm(300));
  browser.elapse(1000);
  assert.equal(browser.contexts[0].sources.length, 1, 'later chunks are cached but never scheduled');
  assert.deepEqual(metrics, []);
  player.endStream();
  assert.deepEqual(ended, ['stopped-live']);
  await player.replay('stopped-live');
  assert.deepEqual(browser.contexts[0].sources.slice(1).map((source) => source.buffer.samples[0]), [100 / 32768, 200 / 32768, 300 / 32768]);
  browser.elapse(1000);
  assert.deepEqual(metrics, [], 'replay must not report original first-sound latency');
  player.startStream('next-live');
  await player.append(pcm(400));
  browser.elapse(1000);
  assert.deepEqual(metrics, ['next-live'], 'suppression applies only to the stopped reply');
  await player.dispose();
});

test('stopping the receive stream drains logically without waiting for a suspended context resume', async (t) => {
  const gate = deferred();
  const browser = browserAudio(t, { resumes: [gate] });
  const player = new PcmPlayer();
  const ended = [];
  player.onEnded = (turnId) => ended.push(turnId);
  player.startStream('pending-stop');
  const pending = player.append(pcm(700));
  await settle();
  assert.equal(typeof player.stopCurrentPlayback, 'function');
  player.stopCurrentPlayback();
  await player.append(pcm(800));
  player.endStream();
  assert.equal(player.isPlaying(), false);
  assert.deepEqual(ended, ['pending-stop']);
  gate.resolve();
  await pending;
  assert.equal(browser.contexts[0].sources.length, 0);
  assert.deepEqual(ended, ['pending-stop']);
  await player.replay('pending-stop');
  assert.deepEqual(browser.contexts[0].sources.map((source) => source.buffer.samples[0]), [700 / 32768, 800 / 32768]);
  await player.dispose();
});

test('mute discards pending resume work so an ended stream cannot leave playback busy', async (t) => {
  const gate = deferred();
  browserAudio(t, { resumes: [gate] });
  const player = new PcmPlayer();
  const ended = [];
  player.onEnded = (id) => ended.push(id);
  player.startStream('muted-pending');
  const pending = player.append(pcm(900));
  await settle();
  player.setMuted(true);
  player.endStream();
  const playingBeforeResume = player.isPlaying();
  const endedBeforeResume = [...ended];
  gate.resolve();
  await pending;
  assert.equal(playingBeforeResume, false);
  assert.deepEqual(endedBeforeResume, ['muted-pending']);
  assert.deepEqual(ended, ['muted-pending']);
  await player.dispose();
});

test('unmute starts new-generation chunks without waiting on an obsolete resume promise', async (t) => {
  const gate = deferred();
  const browser = browserAudio(t, { resumes: [gate] });
  const player = new PcmPlayer();
  player.startStream('mute-generation');
  const oldPending = player.append(pcm(900));
  await settle();
  player.setMuted(true);
  player.setMuted(false);
  const newPending = player.append(pcm(1000));
  await settle();
  const samplesBeforeOldResume = browser.contexts[0].sources.map((source) => source.buffer.samples[0]);
  gate.resolve();
  await Promise.all([oldPending, newPending]);
  assert.deepEqual(samplesBeforeOldResume, [1000 / 32768]);
  player.endStream();
  browser.contexts[0].sources[0].finish();
  assert.equal(player.isPlaying(), false, 'obsolete completion cannot corrupt current pending counts');
  await player.dispose();
});
