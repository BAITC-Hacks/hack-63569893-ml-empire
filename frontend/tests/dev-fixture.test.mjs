import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startFixtureDev } from '../scripts/dev-fixture.mjs';

async function occupyPort() {
  const server = createServer((_request, response) => response.end('unrelated process'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

test('one-command launcher serves UI, synthetic API, and websocket; stop closes both', async (t) => {
  // Vite treats port 0 as its default; reserve an OS-selected candidate explicitly.
  const uiReservation = await occupyPort();
  await new Promise((resolve) => uiReservation.server.close(resolve));
  const service = await startFixtureDev({ apiPort: 0, uiPort: uiReservation.port });
  t.after(() => service.stop());
  assert.equal(new URL(service.apiUrl).hostname, '127.0.0.1');
  assert.equal(new URL(service.uiUrl).hostname, '127.0.0.1');
  const health = await fetch(`${service.apiUrl}/api/v1/health`);
  assert.equal(health.headers.get('x-voice-router-fixture'), 'true');
  assert.deepEqual(await health.json(), { status: 'ok' });
  const page = await fetch(service.uiUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /src\/main.tsx/);
  const module = await fetch(`${service.uiUrl}/src/api.ts`);
  assert.match(await module.text(), new RegExp(service.apiUrl.replaceAll('.', '\\.')));
  const created = await fetch(`${service.apiUrl}/api/v1/sessions`, { method: 'POST', body: '{}' }).then((response) => response.json());
  const socket = new WebSocket(`${service.apiUrl.replace('http:', 'ws:')}${created.ws_path}`);
  await once(socket, 'open');
  const messages = [];
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic audio turn timed out')), 2000);
    socket.on('message', (data, isBinary) => {
      const value = isBinary ? data : JSON.parse(data.toString());
      messages.push(value);
      if (value.type === 'turn.complete') { clearTimeout(timeout); resolve(); }
    });
  });
  socket.send(JSON.stringify({ type: 'turn.text', turn_id: 'socket-tone', payload: { text: '/audio' } }));
  await completed;
  assert.equal(messages.filter((item) => Buffer.isBuffer(item)).length, 3);
  assert.equal(messages.find((item) => item.type === 'audio.start').payload.sample_rate_hz, 24000);
  const snapshot = await fetch(`${service.apiUrl}/api/v1/sessions/${created.session_id}`).then((response) => response.json());
  assert.equal(snapshot.last_turn_id, 'socket-tone');
  assert.equal(snapshot.pending_confirmation, null);
  assert.deepEqual(snapshot.last_trace.actions, []);
  const closed = once(socket, 'close');
  await service.stop();
  await closed;
  await assert.rejects(fetch(`${service.apiUrl}/api/v1/health`));
  await assert.rejects(fetch(service.uiUrl));
  await service.stop(); // Shutdown is safe to call again from signal/cleanup races.
});

test('occupied API port is not killed or reused', async (t) => {
  const occupant = await occupyPort();
  t.after(() => occupant.server.close());
  await assert.rejects(startFixtureDev({ apiPort: occupant.port, uiPort: 0 }), /EADDRINUSE|already in use/);
  assert.equal(await fetch(`http://127.0.0.1:${occupant.port}`).then((response) => response.text()), 'unrelated process');
});

test('occupied UI port preserves occupant and releases the owned API port', async (t) => {
  const apiReservation = await occupyPort();
  const apiPort = apiReservation.port;
  await new Promise((resolve) => apiReservation.server.close(resolve));
  const uiOccupant = await occupyPort();
  t.after(() => uiOccupant.server.close());
  await assert.rejects(startFixtureDev({ apiPort, uiPort: uiOccupant.port }), /already in use/);
  assert.equal(await fetch(`http://127.0.0.1:${uiOccupant.port}`).then((response) => response.text()), 'unrelated process');
  const replacement = createServer();
  replacement.listen(apiPort, '127.0.0.1');
  await once(replacement, 'listening');
  await new Promise((resolve) => replacement.close(resolve));
});
