import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallStart } from '../src/voice-call-start.ts';

test('a voice click waits for this connection readiness and authorizes recording once', () => {
  const start = new VoiceCallStart();
  assert.equal(start.begin(4, true), true);
  assert.equal(start.takeRecording(4), false);
  start.ready(4);
  assert.equal(start.takeRecording(4), true);
  assert.equal(start.takeRecording(4), false);
});

test('rapid clicks cannot create duplicate sessions or replace a pending request', () => {
  const start = new VoiceCallStart();
  assert.equal(start.begin(7, true), true);
  assert.equal(start.begin(7, true), false);
  assert.equal(start.begin(8, true), false);
  assert.equal(start.isStarting, true);
  start.ready(7);
  assert.equal(start.isStarting, true);
  assert.equal(start.begin(7, true), false);
  assert.equal(start.begin(8, false), false);
  assert.equal(start.takeRecording(7), true);
  assert.equal(start.isStarting, false);
  assert.equal(start.takeRecording(7), false);
});

test('restore, ordinary call start, and automatic reconnect never authorize the microphone', () => {
  const start = new VoiceCallStart();
  start.ready(1);
  assert.equal(start.takeRecording(1), false);
  start.begin(2, false);
  start.ready(2);
  assert.equal(start.takeRecording(2), false);
  start.ready(2);
  assert.equal(start.takeRecording(2), false);
});

test('stale readiness cannot release a newer request or enable recording', () => {
  const start = new VoiceCallStart();
  start.begin(3, true);
  start.cancel();
  start.begin(4, true);
  start.ready(3);
  assert.equal(start.isStarting, true);
  assert.equal(start.takeRecording(3), false);
  assert.equal(start.takeRecording(4), false);
  start.ready(4);
  assert.equal(start.takeRecording(4), true);
});

test('cancelled, failed or disconnected attempts cannot resume recording on a late ready', () => {
  for (const state of ['connecting', 'ready']) {
    const start = new VoiceCallStart();
    start.begin(5, true);
    if (state === 'ready') start.ready(5);
    start.cancel();
    start.ready(5);
    assert.equal(start.takeRecording(5), false);
    assert.equal(start.isStarting, false);
    assert.equal(start.begin(6, true), true);
  }
});
