import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureBuffer, createTestTone, playDiagnosticAudio } from '../src/diagnostics-model.ts';

test('local capture caps memory, counts PCM seconds and drops overflow', () => {
  const buffer = new CaptureBuffer(1);
  assert.equal(buffer.append(new ArrayBuffer(24000)), true);
  assert.equal(buffer.seconds, .5);
  assert.equal(buffer.append(new ArrayBuffer(24000)), false);
  assert.equal(buffer.seconds, 1);
  assert.equal(buffer.append(new ArrayBuffer(48000)), false);
  assert.equal(buffer.chunks.length, 2);
  buffer.clear();
  assert.equal(buffer.seconds, 0);
});
test('capture rejects malformed frames and clones supplied bytes', () => {
  const buffer = new CaptureBuffer();
  assert.throws(() => buffer.append(new ArrayBuffer(3)));
  const samples = new Int16Array([100]); buffer.append(samples.buffer); samples[0] = 50;
  assert.equal(new Int16Array(buffer.chunks[0])[0], 100);
});
test('a PCM frame crossing the recording limit is truncated on a whole sample boundary', () => {
  const buffer = new CaptureBuffer(.001);
  const frame = new Int16Array(100).map((_, index) => index);
  assert.equal(buffer.append(frame.buffer), false);
  assert.equal(buffer.seconds, .001);
  assert.equal(buffer.chunks[0].byteLength, 48);
  assert.equal(new Int16Array(buffer.chunks[0]).at(-1), 23);
  buffer.clear();
  assert.equal(buffer.chunks.length, 0);
  assert.equal(buffer.append(new Int16Array([7]).buffer), true);
});
test('local capture refuses invalid or unbounded durations', () => {
  for (const duration of [0, -1, NaN, Infinity, 61]) assert.throws(() => new CaptureBuffer(duration));
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const playbackPort = (events, overrides = {}) => ({
  unlock: async () => { events.push('unlock'); },
  startStream: id => { events.push(`start:${id}`); },
  append: async bytes => { events.push(`append:${bytes.byteLength}`); },
  endStream: () => { events.push('end'); },
  stop: () => { events.push('stop'); },
  ...overrides,
});

test('diagnostic playback cancelled during unlock never starts a stream', async () => {
  const gate = deferred(); const events = []; let current = true;
  const pending = playDiagnosticAudio(playbackPort(events, { unlock: () => gate.promise }), [new ArrayBuffer(2)], () => current);
  current = false; gate.resolve(); await pending;
  assert.deepEqual(events, []);
});
test('a stopped diagnostic loop cannot append to or end a replacement stream after a late resume', async () => {
  const gate = deferred(); const events = []; let current = true;
  const pending = playDiagnosticAudio(playbackPort(events, { append: async bytes => { events.push(`append:${bytes.byteLength}`); await gate.promise; } }), [new ArrayBuffer(2), new ArrayBuffer(4)], () => current);
  await Promise.resolve(); await Promise.resolve();
  current = false; gate.resolve(); await pending;
  assert.deepEqual(events, ['unlock', 'start:diagnostic', 'append:2']);
});
test('a diagnostic failure stops already scheduled chunks and propagates only the current error', async () => {
  const events = []; let index = 0;
  await assert.rejects(playDiagnosticAudio(playbackPort(events, { append: async () => { events.push('append'); if (++index === 2) throw new Error('autoplay blocked'); } }), [new ArrayBuffer(2), new ArrayBuffer(2)], () => true), /autoplay blocked/);
  assert.deepEqual(events, ['unlock', 'start:diagnostic', 'append', 'append', 'stop']);
});
test('obsolete diagnostic failure cannot stop a new playback or surface a stale error', async () => {
  const gate = deferred(); const events = []; let current = true;
  const pending = playDiagnosticAudio(playbackPort(events, { unlock: () => gate.promise }), [], () => current);
  current = false; gate.reject(new Error('old request failed'));
  await pending;
  assert.deepEqual(events, []);
});
test('successful diagnostic playback appends every cached chunk in order and ends the stream', async () => {
  const events = [];
  await playDiagnosticAudio(playbackPort(events), [new ArrayBuffer(2), new ArrayBuffer(4)], () => true);
  assert.deepEqual(events, ['unlock', 'start:diagnostic', 'append:2', 'append:4', 'end']);
});
test('quiet diagnostic tone is finite, bounded PCM, fades at endpoints', () => {
  const samples = new Int16Array(createTestTone());
  assert.equal(samples.length, 48000);
  assert.equal(samples[0], 0);
  assert.ok(Math.max(...samples) <= 2622);
  assert.ok(Math.abs(samples.at(-1)) < 2);
});
