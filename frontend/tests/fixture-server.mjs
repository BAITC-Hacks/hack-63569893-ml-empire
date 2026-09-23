/**
 * LOCAL QA FIXTURE ONLY — no LLM, STT, TTS or external actions.
 * Run manually: node tests/fixture-server.mjs
 * Frontend: VITE_API_BASE_URL=http://127.0.0.1:8011 npm run dev
 * The deterministic SC13/SC20 output tests transport/UI, not real routing.
 * /audio emits a quiet synthetic sine tone; it is not TTS or recorded speech.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const PREFIX = '[Тестовый сервер]';
const AUDIO_FORMAT = { encoding: 'pcm_s16le', sample_rate_hz: 24000, channels: 1 };
const CATALOG = [
  { scenario_id: 'SC13', name: 'Заявление об ущербе по КАСКО', priority: 'high' },
  { scenario_id: 'SC20', name: 'Запись на осмотр автомобиля', priority: 'normal' },
  { scenario_id: 'SC11', name: 'ДТП произошло только что', priority: 'urgent' },
];
const COMMANDS = new Set(['/handoff', '/slots', '/error', '/mixed', '/partial-metrics', '/context', '/audio', '/emotion']);

function fixtureRoute(language) {
  return {
    scenarios: CATALOG.slice(0, 2).map((scenario, index) => ({
      ...scenario, reason: `${PREFIX} Фиксированный сценарий №${index + 1} для проверки панели.`, confidence_estimate: index ? 0.72 : 0.86,
    })),
    alternatives: [CATALOG[2]],
    reason: `${PREFIX} Синтетическая трассировка: модель не вызывается.`,
    language, source: 'llm', is_continuation: false,
    slots: { policy_type: 'КАСКО', claim_id: 'FIXTURE-ONLY-001' },
    active_scenario: 'SC13', pending_scenarios: ['SC20'], suspended_scenarios: [],
  };
}

function syntheticTone() {
  // 300 ms, 440 Hz, quiet sine wave with short fades: a transport probe, not TTS.
  const samples = 7200;
  const bytes = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const fade = Math.min(index / 240, (samples - 1 - index) / 240, 1);
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / 24000) * 0.08 * fade * 32767), index * 2);
  }
  return [bytes.subarray(0, 4800), bytes.subarray(4800, 9600), bytes.subarray(9600)];
}

function commandTurn(session, turnId, command) {
  const language = command === '/mixed' ? 'mixed' : 'ru';
  const transcript = command === '/mixed' ? '[Синтетический пример] Кеше көлігімді соғып кетті, а полис КАСКО есть.' : command;
  const route = fixtureRoute(language);
  const actions = [];
  let handoff = null;
  let preview = null;
  let status = 'answered';
  let reply = `${PREFIX} Проверка ${command}. Ответ и маршрут заданы fixture-кодом; реальные модели и действия не вызываются.`;

  if (command === '/context') {
    route.active_scenario = 'SC11';
    route.suspended_scenarios = ['SC13'];
    route.source = 'continuation';
    route.is_continuation = true;
    reply = `${PREFIX} Тест контекста: выбран SC13, активен SC11, SC20 в очереди, SC13 приостановлен. Это не реальная маршрутизация.`;
  }
  if (command === '/slots') {
    route.slots = {
      phone: { value: '+7 *** *** ** **', status: 'from_profile', source: 'fixture_profile', scenario_id: 'SC13' },
      policy_number: { value: 'TEST-****-001', status: 'confirmed', source: 'user_confirmation', scenario_id: 'SC13' },
      inspection_date: { value: null, status: 'missing', source: null, scenario_id: 'SC20' },
      email: { value: 'invalid-synthetic-email', status: 'invalid', source: 'utterance', scenario_id: 'SC13' },
      insurance_type: { value: 'КАСКО', status: 'found', source: 'utterance', scenario_id: 'SC13' },
    };
    preview = {
      name: 'fixture_create_claim', summary: 'Подтвердите только синтетический preview. Реальные данные и действия отсутствуют.',
      masked_args: { policy_number: 'TEST-****-001' },
    };
    actions.push(
      { name: 'fixture_find_client', mode: 'requested', status: 'requested' },
      { name: 'fixture_validate_contact', mode: 'execute', status: 'failed', error: { code: 'invalid_input', message: 'Синтетический адрес не прошёл проверку' } },
      { name: 'fixture_create_claim', mode: 'preview', status: 'awaiting_confirmation', arguments: preview.masked_args },
    );
    status = 'clarify';
  }
  if (command === '/handoff') {
    handoff = {
      reason: 'Тестовая передача: synthetic capability check', queue: 'fixture_claims', status: 'context_received',
      active_scenario: 'SC13', slots: { policy_number: 'TEST-****-001' },
      summary: 'Синтетический контекст принят fixture-сервером; реальный оператор не подключён.',
      context: { summary: 'Синтетическое обращение по КАСКО и вопрос об осмотре.', active_scenario: 'SC13', slots: { policy_number: 'TEST-****-001' } },
    };
    status = 'handoff';
    reply = `${PREFIX} Тестовый контекст передан в fixture_claims. Реальный оператор не подключается.`;
  }
  if (command === '/audio') reply = `${PREFIX} Сейчас прозвучит тихий синтетический сигнал 300 мс. Это не TTS и не голосовой ответ модели.`;
  if (command === '/error') {
    route.scenarios = [];
    route.alternatives = [];
    route.active_scenario = null;
    route.pending_scenarios = [];
    status = 'error';
    reply = `${PREFIX} Проверяется безопасное отображение ошибки. Никакое действие не выполнялось.`;
  }
  session.active_scenario = route.active_scenario;
  session.pending_confirmation = preview;
  const events = [
    event(session, 'transcript.final', turnId, { text: transcript, language }),
    event(session, 'route.decision', turnId, route),
  ];
  if (preview) events.push(event(session, 'action.preview', turnId, preview));
  events.push(event(session, 'agent.text', turnId, { text: reply, language: language === 'mixed' ? 'ru' : language }));
  if (command === '/error') events.push(event(session, 'error', turnId, {
    code: 'router_unavailable', recoverable: true,
    message: 'DO_NOT_DISPLAY_FIXTURE_DIAGNOSTIC: token=FAKE_FIXTURE_TOKEN; system_prompt=FAKE_FIXTURE_PROMPT; stack at /fixture/internal/router.mjs:1',
  }));
  else if (command === '/audio') events.push(event(session, 'audio.start', turnId, AUDIO_FORMAT), ...syntheticTone(), event(session, 'audio.end', turnId, {}));
  else events.push(event(session, 'error', turnId, {
    code: 'tts_unavailable', message: `${PREFIX} Озвучивание не эмулируется.`, recoverable: true,
  }));
  session.last_trace = {
    ...route, transcript, actions, handoff,
    latency_ms: { stt: 0, triage: 5, router: 40, response: 8, tts_first_audio: 0, total: 53 },
    client_first_audio_ms: null,
    ...(command === '/emotion' ? { affect: { emotion:'concerned', response_tone:'empathetic', source:'text', confidence:.72 } } : {}),
  };
  if (command === '/partial-metrics') {
    events.push(event(session, 'trace.updated', turnId, { ...session.last_trace, latency_ms: { stt: 0, triage: 5, router: 40, tts_first_audio: 0 } }));
    events.push(event(session, 'trace.updated', turnId, { latency_ms: { response: 8, total: 53 } }));
  } else events.push(event(session, 'trace.updated', turnId, session.last_trace));
  events.push(event(session, 'turn.complete', turnId, { status }));
  return { events, disconnect: false };
}

export function createSession() {
  return {
    session_id: randomUUID(), last_seq: 0, last_turn_id: null,
    active_scenario: null, pending_confirmation: null, last_trace: null,
    seenTurns: new Set(), didDisconnect: false,
  };
}

export function sessionSnapshot(session) {
  const { session_id, last_seq, last_turn_id, active_scenario, pending_confirmation, last_trace } = session;
  return { session_id, last_seq, last_turn_id, active_scenario, pending_confirmation, last_trace };
}

function event(session, type, turnId, payload) {
  return { type, turn_id: turnId, seq: ++session.last_seq, payload };
}

export function textTurn(session, turnId, text) {
  if (session.seenTurns.has(turnId)) return { events: [], disconnect: false };
  session.seenTurns.add(turnId);
  session.last_turn_id = turnId;
  if (COMMANDS.has(text.trim())) return commandTurn(session, turnId, text.trim());
  const language = /[әғқңөұүһі]/i.test(text) ? 'kk' : 'ru';
  const events = [event(session, 'transcript.final', turnId, { text, language })];

  if (text.trim() === '/disconnect' && !session.didDisconnect) {
    session.didDisconnect = true;
    session.last_trace = { transcript: text, actions: [], latency_ms: { total: 0 }, handoff: null };
    events.push(event(session, 'agent.text', turnId, {
      text: `${PREFIX} Искусственный обрыв соединения. Ожидается восстановление сессии без повторной отправки реплики.`, language,
    }));
    return { events, disconnect: true };
  }

  const confirm = /^(да,?\s*подтверждаю|иә,?\s*растаймын)[.!]?$/i.test(text.trim());
  const reject = /^(?:нет|жоқ)(?:$|[\s,.!])/iu.test(text.trim());
  const isDecision = confirm || reject;
  const hadPending = !!session.pending_confirmation;
  const route = { ...fixtureRoute(language), source: isDecision ? 'confirmation' : 'llm' };
  session.active_scenario = 'SC13';
  events.push(event(session, 'route.decision', turnId, route));

  let actions;
  let reply;
  if (isDecision) {
    session.pending_confirmation = null;
    actions = hadPending ? [`fixture_create_claim:${confirm ? 'execute' : 'cancelled'}`] : [];
    reply = hadPending
      ? `${PREFIX} ${confirm ? 'Согласие получено, синтетическое действие отмечено выполненным.' : 'Синтетическое действие отменено.'} Реальное заявление не создавалось.`
      : `${PREFIX} Нет действия, ожидающего подтверждения. Ничего не выполнено.`;
  } else {
    session.pending_confirmation = {
      name: 'fixture_create_claim',
      summary: 'Создать синтетическое заявление FIXTURE-ONLY-001. Никакие данные не отправляются во внешние системы.',
      masked_args: { client: 'Тестовый клиент', policy: 'TEST-****-001', claim_id: 'FIXTURE-ONLY-001' },
    };
    actions = ['fixture_create_claim:preview'];
    events.push(event(session, 'action.preview', turnId, session.pending_confirmation));
    reply = `${PREFIX} Подготовлено синтетическое заявление по КАСКО и дополнительный сценарий осмотра. Подтвердите или отклоните тестовое действие. Реальные операции не выполняются.`;
  }
  events.push(event(session, 'agent.text', turnId, { text: reply, language }));
  events.push(event(session, 'error', turnId, {
    code: 'tts_unavailable', message: `${PREFIX} Озвучивание намеренно отключено: проверяется текстовый fallback.`, recoverable: true,
  }));
  session.last_trace = {
    ...route, transcript: text, actions, latency_ms: { stt: 0, triage: 5, router: 40, response: 8, tts_first_audio: 0, total: 53 },
    client_first_audio_ms: null, handoff: null,
  };
  events.push(event(session, 'trace.updated', turnId, session.last_trace));
  events.push(event(session, 'turn.complete', turnId, { status: isDecision ? 'answered' : 'clarify' }));
  return { events, disconnect: false };
}

function localOrigin(origin) {
  if (!origin) return true;
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname); }
  catch { return false; }
}

export function createFixtureServer() {
  const sessions = new Map();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Voice-Router-Fixture': 'true' });
      response.end(JSON.stringify(body));
    };
    if (!localOrigin(request.headers.origin)) return send(403, { detail: 'Fixture only accepts loopback browser origins' });
    if (request.headers.origin) response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
    const pathname = new URL(request.url, 'http://127.0.0.1:8011').pathname;
    if (request.method === 'GET' && pathname === '/api/v1/health') return send(200, { status: 'ok' });
    if (request.method === 'GET' && pathname === '/api/v1/catalog/scenarios') return send(200, CATALOG);
    if (request.method === 'POST' && pathname === '/api/v1/sessions') {
      if (sessions.size >= 100) return send(503, { detail: 'Restart the fixture to clear its 100-session limit' });
      try {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) return send(413, { detail: 'Request too large' });
        }
        if (body && (typeof JSON.parse(body) !== 'object' || JSON.parse(body) === null)) return send(400, { detail: 'Expected JSON object' });
      } catch { return send(400, { detail: 'Invalid JSON body' }); }
      const session = createSession();
      sessions.set(session.session_id, session);
      return send(200, {
        session_id: session.session_id, ws_path: `/api/v1/sessions/${session.session_id}/stream`,
        audio_input: AUDIO_FORMAT, audio_output: AUDIO_FORMAT, as_of_date: '2026-10-01',
      });
    }
    const sessionPath = pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
    if (request.method === 'GET' && sessionPath) {
      const session = sessions.get(sessionPath[1]);
      return session ? send(200, sessionSnapshot(session)) : send(404, { detail: 'Session not found' });
    }
    send(404, { detail: 'Fixture route not found' });
  });

  server.on('upgrade', (request, socket, head) => {
    const match = new URL(request.url, 'http://127.0.0.1:8011').pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/stream$/);
    const session = match && sessions.get(match[1]);
    if (!session || !localOrigin(request.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (connection) => {
      connection.send(JSON.stringify({ type: 'session.ready', turn_id: null, seq: session.last_seq, payload: { session_id: session.session_id, last_seq: session.last_seq } }));
      connection.on('error', () => { /* Local browser shutdown is not an external failure. */ });
      connection.on('message', (raw, isBinary) => {
        let message;
        try { if (!isBinary) message = JSON.parse(raw.toString()); } catch { /* Report malformed client data below. */ }
        if (message?.type === 'playback.started') return;
        if (message?.type !== 'turn.text' || typeof message.turn_id !== 'string' || !message.turn_id || typeof message.payload?.text !== 'string' || !message.payload.text.trim()) {
          connection.send(JSON.stringify(event(session, 'error', typeof message?.turn_id === 'string' ? message.turn_id : null, {
            code: 'invalid_event', message: `${PREFIX} Поддерживается только текстовый ввод; микрофон и аудио не эмулируются.`, recoverable: true,
          })));
          return;
        }
        const result = textTurn(session, message.turn_id, message.payload.text);
        for (const item of result.events) if (connection.readyState === WebSocket.OPEN) connection.send(Buffer.isBuffer(item) ? item : JSON.stringify(item));
        if (result.disconnect) connection.close(1012, 'Intentional one-time QA disconnect');
      });
    });
  });
  return { server, sockets, sessions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, sockets } = createFixtureServer();
  server.listen(8011, '127.0.0.1', () => {
    console.warn('\n⚠ LOCAL TEST FIXTURE ONLY: http://127.0.0.1:8011');
    console.warn('No LLM/STT/TTS or external actions. All responses are synthetic. Do not use real personal data.\n');
  });
  const shutdown = () => {
    for (const connection of sockets.clients) connection.terminate();
    sockets.close();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
