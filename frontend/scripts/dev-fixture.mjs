/** Local UI/transport QA only. Never starts a real LLM/STT/TTS provider. */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createFixtureServer } from '../tests/fixture-server.mjs';

const frontendRoot = fileURLToPath(new URL('../', import.meta.url));

export async function startFixtureDev({ apiPort = 8011, uiPort = 5175 } = {}) {
  const fixture = createFixtureServer();
  let vite;
  let stopping;
  const stop = () => stopping ??= (async () => {
    for (const connection of fixture.sockets.clients) connection.terminate();
    await new Promise((resolve) => fixture.sockets.close(resolve));
    await Promise.all([
      vite?.close(),
      new Promise((resolve) => {
        fixture.server.close(resolve);
        fixture.server.closeAllConnections();
      }),
    ]);
  })();

  try {
    await new Promise((resolve, reject) => {
      const failed = (error) => reject(error);
      fixture.server.once('error', failed);
      fixture.server.listen(apiPort, '127.0.0.1', () => {
        fixture.server.off('error', failed);
        resolve();
      });
    });
    const apiUrl = `http://127.0.0.1:${fixture.server.address().port}`;
    // Vite captures env during configuration. Restore it so importing this launcher
    // never leaves global configuration behind for unrelated local tooling.
    const previousBase = process.env.VITE_API_BASE_URL;
    process.env.VITE_API_BASE_URL = apiUrl;
    try {
      vite = await createViteServer({
        root: frontendRoot,
        configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
        server: { host: '127.0.0.1', port: uiPort, strictPort: true, open: false },
        logLevel: 'error',
        define: { 'import.meta.env.VITE_TEST_MODE': JSON.stringify('true') },
      });
    } finally {
      if (previousBase === undefined) delete process.env.VITE_API_BASE_URL;
      else process.env.VITE_API_BASE_URL = previousBase;
    }
    await vite.listen();
    const uiUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;
    return { apiUrl, uiUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.warn('\n⚠ ONLY SYNTHETIC LOCAL TEST / ТОЛЬКО СИНТЕТИЧЕСКИЕ ТЕСТОВЫЕ ДАННЫЕ');
  console.warn('No LLM, STT, TTS or real operations. Never enter real personal data.');
  let service;
  let stopping = false;
  const shutdown = async () => {
    stopping = true;
    await service?.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    service = await startFixtureDev();
    if (stopping) await service.stop();
    else {
      console.log(`\nUI: ${service.uiUrl}\nTest API: ${service.apiUrl}`);
      console.log('Commands: /handoff /slots /error /mixed /partial-metrics /context /audio /disconnect');
      console.log('/audio plays a synthetic 300 ms tone, not TTS. Microphone input is not emulated.');
      console.log('Ctrl+C stops both owned services. Occupied ports are never killed or replaced.\n');
    }
  } catch (error) {
    console.error(`Local fixture failed to start: ${error instanceof Error ? error.message : 'Unknown startup error'}`);
    console.error('Check ports 8011 and 5175; unrelated processes have not been stopped.');
    process.exitCode = 1;
  }
}
