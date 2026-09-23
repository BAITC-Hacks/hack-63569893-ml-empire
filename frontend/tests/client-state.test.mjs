import test from 'node:test';
import assert from 'node:assert/strict';
import { errorText, localErrorCode, elapsedSeconds, formatDuration } from '../src/client-state.ts';

test('unknown server diagnostics never become UI messages', () => {
  const secret = 'sk-testsecret123456 system prompt stacktrace';
  assert.equal(errorText(secret, 'ru'), errorText('unknown', 'ru'));
  assert.ok(!errorText(secret, 'kk').includes(secret));
  assert.equal(localErrorCode(new Error(secret)), 'connection_failed');
});
test('known microphone and provider failures have actionable bilingual copy', () => {
  assert.equal(localErrorCode(new DOMException('private data', 'NotAllowedError')), 'mic_permission');
  assert.equal(localErrorCode(new Error('Микрофон не найден')), 'mic_missing');
  assert.notEqual(errorText('tts_unavailable', 'ru'), errorText('tts_unavailable', 'kk'));
  assert.match(errorText('mic_permission', 'ru'), /доступ/);
});
test('call clock freezes at ending, clamps bad timing, allows long calls', () => {
  assert.equal(elapsedSeconds(null, null, 10000), 0);
  assert.equal(elapsedSeconds(1000, null, 6500), 5);
  assert.equal(elapsedSeconds(1000, 6000, 99999), 5);
  assert.equal(elapsedSeconds(6000, null, 1000), 0);
  assert.equal(formatDuration(3661), '61:01');
});
