import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createSession, fetchCatalog, isCreatedSession, parseServerEvent, restoreSession, streamUrl } from '../src/api.ts';
import * as api from '../src/api.ts';

const audio = { encoding: 'pcm_s16le', sample_rate_hz: 24000, channels: 1 };
const session = {
  session_id: 'session-1', ws_path: '/api/v1/sessions/session-1/stream',
  audio_input: audio, audio_output: audio, as_of_date: '2026-10-01',
};
const restored = {
  session_id: 'session-1', last_seq: 8, last_turn_id: 'turn-1', active_scenario: 'SC13',
  pending_confirmation: { name: 'create_claim', summary: 'Создать обращение', masked_args: { phone: '+7 ***' } },
  last_trace: { actions: ['create_claim:preview'], latency_ms: { total: 1234 }, handoff: null },
};
const event = (type, payload, turnId = 'turn-1') => ({ type, turn_id: turnId, seq: 1, payload });
const parse = (value) => parseServerEvent(JSON.stringify(value));

test('validates every documented server event without dropping optional metadata', () => {
  const fixtures = [
    event('session.ready', { session_id: 'session-1', last_seq: 0 }, null),
    event('transcript.partial', { text: 'КАСКО' }),
    event('transcript.final', { text: 'КАСКО бар', language: 'kk' }),
    event('transcript.final', { text: 'КАСКО бар, нужен осмотр', language: 'mixed' }),
    event('route.decision', {
      scenarios: [{ scenario_id: 'SC13', reason: 'Есть КАСКО', confidence_estimate: 0.83 }],
      alternatives: ['SC11'], reason: 'Основной запрос', language: 'mixed', slots: { policy_number: null },
      source: 'llm', pending_scenarios: ['SC20'], suspended_scenarios: [],
    }),
    event('action.preview', restored.pending_confirmation),
    event('agent.text', { text: 'Подтвердите действие', language: 'ru' }),
    event('audio.start', audio), event('audio.end', {}),
    event('trace.updated', { ...restored.last_trace, client_first_audio_ms: 1400, transcript: 'КАСКО бар' }),
    event('turn.complete', { status: 'clarify' }),
    event('error', { code: 'tts_unavailable', message: 'Нет аудио', recoverable: true }),
    event('error', { code: 'session_not_found', message: 'Нет сессии', recoverable: false }, null),
  ];
  for (const fixture of fixtures) assert.deepEqual(parse(fixture), fixture, fixture.type);
});

test('rejects invalid envelopes, unsupported events, and missing turn ids', () => {
  const valid = event('transcript.partial', { text: 'Здравствуйте' });
  const invalid = [null, [], {}, { ...valid, seq: -1 }, { ...valid, seq: 1.1 },
    { ...valid, seq: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, seq: Infinity },
    { ...valid, turn_id: 1 }, { ...valid, turn_id: '' }, { ...valid, turn_id: null },
    { ...valid, turn_id: undefined }, { ...valid, payload: [] }, { ...valid, payload: null },
    { ...valid, type: 'unknown.event' }, event('session.ready', { session_id: 'a', last_seq: 0 }, 'turn-1')];
  for (const fixture of invalid) assert.equal(parse(fixture), null, JSON.stringify(fixture));
  assert.equal(parseServerEvent('{bad json'), null);
});

test('rejects malformed payloads before they can reach rendering or audio code', () => {
  const malformed = [
    event('session.ready', { session_id: {}, last_seq: 0 }, null),
    event('transcript.partial', { text: {} }),
    event('transcript.final', { text: 'Hello', language: 'en' }),
    event('route.decision', { scenarios: {}, alternatives: [], language: 'ru' }),
    event('route.decision', { scenarios: [null], alternatives: [], language: 'ru' }),
    event('route.decision', { scenarios: [{ scenario_id: 'SC13', name: {} }], alternatives: [], language: 'ru' }),
    event('route.decision', { scenarios: [], alternatives: [null], language: 'ru' }),
    event('route.decision', { scenarios: [], alternatives: [], language: 'ru', suspended_scenarios: [null] }),
    event('action.preview', { name: 'claim', summary: {} }),
    event('agent.text', { text: 'Hello', language: {} }),
    event('audio.start', { ...audio, sample_rate_hz: 48000 }),
    event('trace.updated', { actions: 'claim' }),
    event('trace.updated', { latency_ms: { total: -10 } }),
    event('trace.updated', { handoff: [] }),
    event('turn.complete', { status: 'unknown' }),
    event('error', { code: 'busy', message: 'Busy', recoverable: 'yes' }),
  ];
  for (const fixture of malformed) assert.equal(parse(fixture), null, JSON.stringify(fixture));
});

test('only trusts session metadata with supported PCM and a same-origin session stream path', () => {
  assert.equal(isCreatedSession(session), true);
  for (const value of [null, {}, { ...session, session_id: '' }, { ...session, session_id: '\ud800' },
    { ...session, audio_input: { ...audio, channels: 2 } },
    { ...session, audio_output: { ...audio, encoding: 'mp3' } },
    { ...session, audio_output: { ...audio, sample_rate_hz: 48000 } },
    { ...session, as_of_date: {} },
    ...['https://example.com/stream', '//example.com/stream', '/\\example.com/stream',
      'stream', '/api/v1/sessions/other/stream', '/api/v1/sessions/session-1/stream#hash']
      .map((ws_path) => ({ ...session, ws_path })),
  ]) assert.equal(isCreatedSession(value), false, JSON.stringify(value));
});

test('streamUrl uses the page origin and never accepts an untrusted stored URL', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://voice.example' } } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
  assert.equal(streamUrl(session), 'wss://voice.example/api/v1/sessions/session-1/stream');
  assert.throws(() => streamUrl({ ...session, ws_path: '//evil.example/stream' }));
});

test('HTTP requests validate real response bodies and encode the restoration id', async (t) => {
  const matchingRestore = { ...restored, session_id: 'one/two' };
  const responses = [session, matchingRestore, [{ scenario_id: 'SC13', name: 'КАСКО', priority: 'high' }]];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return Response.json(responses.shift());
  });
  assert.deepEqual(await createSession(), session);
  assert.deepEqual(await restoreSession('one/two'), matchingRestore);
  assert.deepEqual(await fetchCatalog(), [{ scenario_id: 'SC13', name: 'КАСКО', priority: 'high' }]);
  assert.equal(requests[0].url, '/api/v1/sessions');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.body, '{}');
  assert.equal(requests[1].url, '/api/v1/sessions/one%2Ftwo');
});

test('restoration rejects a structurally valid response belonging to a different session', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(restored));
  await assert.rejects(restoreSession('another-session'), (error) => error instanceof ApiError && /формат/i.test(error.message));
});

test('session.ready is accepted only for the exact created session', () => {
  assert.equal(typeof api.isSessionReadyFor, 'function');
  const ready = event('session.ready', { session_id: 'session-1', last_seq: 0 }, null);
  assert.equal(api.isSessionReadyFor(ready, session), true);
  for (const wrong of [
    event('session.ready', { session_id: 'other', last_seq: 0 }, null),
    event('session.ready', { session_id: 'session-1', last_seq: -1 }, null),
    event('session.ready', { session_id: 'session-1', last_seq: 0 }),
    event('turn.complete', { status: 'answered' }),
  ]) assert.equal(api.isSessionReadyFor(wrong, session), false);
});

test('rejects unsafe HTTP payloads for sessions, restored state, and catalogs', async (t) => {
  const responses = [{ ...session, ws_path: '//evil.example/ws' }, { ...restored, pending_confirmation: { summary: {} } }, [{ scenario_id: 'SC13', name: {} }]];
  t.mock.method(globalThis, 'fetch', async () => Response.json(responses.shift()));
  await assert.rejects(createSession(), /формат/i);
  await assert.rejects(restoreSession('session-1'), /формат/i);
  await assert.rejects(fetchCatalog(), /формат/i);
});

test('HTTP failures expose status so missing sessions are distinct from network outages', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  await assert.rejects(restoreSession('missing'), (error) => error instanceof ApiError && error.status === 404);
});

test('non-JSON HTTP success responses are treated as protocol errors', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Proxy error</html>', { status: 200 }));
  await assert.rejects(createSession(), (error) => error instanceof ApiError && /формат/i.test(error.message));
});

test('caller cancellation aborts an in-flight fetch with AbortError', async (t) => {
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const request = createSession(controller.signal);
  const rejected = assert.rejects(request, { name: 'AbortError' });
  controller.abort();
  await rejected;
});

test('already-aborted requests never start a network operation', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('fetch must not run'));
  await assert.rejects(fetchCatalog(AbortSignal.abort()), { name: 'AbortError' });
});

test('requests time out after ten seconds and abort the stalled network operation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    requestSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const rejected = assert.rejects(createSession(), { name: 'TimeoutError' });
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(requestSignal.aborted, true);
});

test('completed requests release their timeout and caller cancellation listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    requestSignal = signal;
    return Response.json(session);
  });
  const controller = new AbortController();
  await createSession(controller.signal);
  controller.abort();
  t.mock.timers.tick(10_000);
  assert.equal(requestSignal.aborted, false);
});
