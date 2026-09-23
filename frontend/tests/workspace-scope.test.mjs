import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server;
let markup;

before(async () => {
  // Render the real app and hook without mounting effects or opening a browser.
  // No microphone, AI provider, or API request is needed for the initial state.
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    logLevel: 'silent',
  });
  const { default: App } = await server.ssrLoadModule('/src/App.tsx');
  markup = renderToStaticMarkup(createElement(App));
});

after(async () => { await server?.close(); });

test('workspace navigation contains only conversation, catalog and evaluation', () => {
  const navigations = [...markup.matchAll(/<nav class="workspace-navigation"[^>]*>([\s\S]*?)<\/nav>/g)];
  assert.equal(navigations.length, 1, 'section navigation is rendered exactly once');
  const [navigationMarkup, navigation] = navigations[0];
  const header = markup.match(/<header class="site-header">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header?.includes(navigationMarkup), 'section navigation lives in the top navbar');
  const main = markup.match(/<main class="page-main">([\s\S]*?)<\/main>/)?.[1];
  assert.ok(main, 'page content remains in the main landmark');
  assert.doesNotMatch(main, /workspace-navigation/);
  const labels = [...navigation.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(labels, ['Разговор', 'Сценарии', 'Оценка и сравнение']);
  assert.match(navigation, /<button\b[^>]*aria-current="page"[^>]*>Разговор<\/button>/);
  assert.equal([...navigation.matchAll(/aria-current="page"/g)].length, 1);
  assert.match(main, /<header class="page-intro"><div><h1>Голосовой помощник<\/h1><p>Рядом, чтобы помочь<\/p><\/div><\/header>/);
  assert.equal([...main.matchAll(/<h1\b/g)].length, 1, 'the initial section has one page title');
});

test('initial conversation offers a real call without a prerecorded example', () => {
  const supportSymbol = markup.match(/<button\b[^>]*class="welcome-symbol"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(supportSymbol, 'the support icon is a keyboard-accessible button');
  assert.match(supportSymbol, /^<button\b[^>]*type="button"/);
  assert.match(supportSymbol, /aria-label="Начать голосовой разговор"/);
  assert.match(supportSymbol, /aria-busy="false"/);
  assert.doesNotMatch(supportSymbol.split('>')[0], /disabled|aria-hidden/);
  assert.match(supportSymbol, /<svg\b[^>]*class="[^"]*\blucide-headset\b[^"]*"/);
  assert.match(supportSymbol, /<svg\b[^>]*aria-hidden="true"/);
  assert.equal(/welcome-kicker|pulse-one|pulse-two|VOICE ROUTER/.test(markup), false);
  assert.match(markup, /<h3>Начните диалог<\/h3>/);
  assert.match(markup, /Расскажите, чем мы можем помочь\./);
  assert.equal(/Один разговор\. Правильный сценарий\.|История разговора появится здесь/.test(markup), false);
  assert.match(markup, /Начать разговор/);
  assert.match(markup, /Здесь появится решение/);
  assert.equal(/Посмотреть пример|Пример интерфейса|preview-turn|Микрофон и звук|Диалоги датасета/.test(markup), false);
});

test('core microphone settings, text fallback and sound controls remain available', () => {
  const settingsTrigger = markup.match(/<button\b[^>]*class="mic-settings-trigger"[^>]*>/)?.[0];
  assert.ok(settingsTrigger, 'microphone settings open from the chat header button');
  assert.match(settingsTrigger, /aria-haspopup="dialog"/);
  assert.match(settingsTrigger, /aria-expanded="false"/);
  assert.match(settingsTrigger, /aria-label="Настройки микрофона"/);
  const settingsDialog = markup.match(/<dialog\b[^>]*class="mic-settings-dialog"[^>]*>[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(settingsDialog, 'microphone settings live in a native dialog');
  assert.doesNotMatch(settingsDialog.split('>')[0], /\bopen(?:=|\s|$)/);
  const controlsId = settingsTrigger.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controlsId);
  assert.ok(settingsDialog.includes(`id="${controlsId}"`));
  assert.doesNotMatch(markup, /<details class="audio-settings"/);
  assert.match(markup, /<div class="panel-heading-title"><h2>Чат<\/h2><\/div>/);
  const rightControls = markup.match(/<div class="panel-heading-right">([\s\S]*?<\/dialog>)<\/div>/)?.[1];
  assert.ok(rightControls, 'microphone settings belong to the right-aligned header controls');
  assert.ok(rightControls.includes(settingsTrigger));
  assert.ok(rightControls.endsWith(settingsDialog), 'the settings dialog is last in the right-aligned controls');
  assert.match(rightControls, /<button\b[^>]*class="mic-settings-trigger"[^>]*>[\s\S]*?<\/button><dialog\b[^>]*class="mic-settings-dialog"[^>]*>[\s\S]*?<\/dialog>$/);
  assert.match(markup, /Настройки микрофона/);
  assert.match(markup, /Удерживать кнопку/);
  assert.match(markup, /Завершать после тишины/);
  assert.match(markup, /Обновить устройства/);
  assert.match(markup, /aria-label="Или напишите сообщение…"/);
  assert.match(markup, /aria-label="Отключить звук"/);
});

test('product shell has no lab placeholder, prototype banner or demo footer', () => {
  assert.match(markup, /Рядом, чтобы помочь/);
  assert.equal(/HALYK · AI EXPERIENCE|Говорите как обычно\. Помощник поймёт запрос/.test(markup), false);
  assert.equal(/AI Lab|Demo workspace|Учебный прототип|data-disclosure|page-footer|status-pill/.test(markup), false);
  assert.equal(/composer-foot|tiny-dot|Голос помощника синтезирован ИИ/.test(markup), false);
  assert.match(markup, /<h2>Чат<\/h2>/);
  assert.match(markup, /<div class="supervisor-topline"><h2>Панель Трассировки<\/h2><\/div>/);
  assert.equal(/01 \/ CLIENT CONVERSATION|ПАНЕЛЬ СУПЕРВИЗОРА|Маршрут, действия и замеры каждой реплики/.test(markup), false);
});

test('session metrics remain collapsed above tracing in the same supervisor column', () => {
  const metricsSections = [...markup.matchAll(/<details\b[^>]*class="sv-session-metrics"[^>]*>[\s\S]*?<\/details>/g)];
  assert.equal(metricsSections.length, 1, 'session metrics are rendered exactly once');
  const metrics = metricsSections[0][0];
  assert.doesNotMatch(metrics.split('>')[0], /\bopen(?:=|\s|$)/, 'session metrics are collapsed initially');
  assert.match(metrics, /<summary\b[^>]*>[\s\S]*?Метрики текущей сессии[\s\S]*?<\/summary>/);
  assert.match(metrics, /0 реплик/);
  assert.match(metrics, /Первый звук: медиана голоса/);
  assert.match(metrics, /Первый звук: медиана текста/);
  assert.match(metrics, /Медиана сервера/);
  assert.match(metrics, /Медиана маршрутизатора/);
  assert.match(metrics, /Уточнений: 0 · Передач оператору: 0 · Реплик с ошибкой: 0/);
  assert.match(metrics, /Только полученные замеры; отсутствие звука не считается нулевой задержкой/);
  const column = markup.match(/<div class="supervisor-column">\s*(<details\b[^>]*class="sv-session-metrics"[^>]*>[\s\S]*?<\/details>)\s*(<aside\b[^>]*class="supervisor-panel rich-supervisor"[^>]*>[\s\S]*?<\/aside>)\s*<\/div>/);
  assert.ok(column, 'metrics must precede the tracing panel inside their shared column');
  assert.equal(column[1], metrics);
  assert.match(column[2], /Панель Трассировки/);
});

test('before a call there is no connection badge or invented online status', () => {
  assert.equal(/Нет подключения|На связи|class="live-indicator/.test(markup), false);
  assert.match(markup, /<input[^>]*aria-label="Или напишите сообщение…"[^>]*disabled/);
});

test('header uses a local Halyk image without repeating the visible brand name', () => {
  const header = markup.match(/<header class="site-header">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header, 'product header is rendered');
  const brandImage = header.match(/<img\b[^>]*class="brand-mark"[^>]*>/)?.[0];
  assert.ok(brandImage, 'the supplied Halyk image replaces the CSS-drawn mark');
  assert.match(brandImage, /src="\/[^"\s]*halyk-mark\.png(?:\?[^"\s]*)?"/);
  assert.match(brandImage, /alt=""/);
  assert.match(brandImage, /width="[1-9]\d*"/);
  assert.match(brandImage, /height="[1-9]\d*"/);
  assert.match(header, /<span>Halyk<\/span>/);
  assert.match(header, /class="product-name">Voice Router<\/span>/);
});

test('header drops the workspace placeholder while keeping language selection and panel labels', () => {
  assert.equal(/header-nav|Рабочее пространство|Жұмыс кеңістігі/.test(markup), false);
  assert.match(markup, /<button[^>]*class="language-button"[^>]*aria-label="Переключить язык интерфейса"/);
  assert.match(markup, /class="mobile-tabs" aria-label="Панели разговора"/);
});

test('microphone settings retain the chosen device and automatic mode while recording locks both fields', async () => {
  const { MicrophoneSettings } = await server.ssrLoadModule('/src/components/MicrophoneSettings.tsx');
  const device = { deviceId: 'usb-microphone', groupId: 'usb-group', kind: 'audioinput', label: 'USB Microphone' };
  const settings = renderToStaticMarkup(createElement(MicrophoneSettings, {
    language: 'ru', devices: [{ ...device, toJSON: () => device }], deviceId: device.deviceId,
    onDeviceChange: () => {}, micMode: 'auto', onModeChange: () => {},
    disabled: true, onRefreshDevices: async () => {},
  }));
  const selects = [...settings.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)].map(match => match[0]);
  assert.equal(selects.length, 2);
  for (const select of selects) assert.match(select.split('>')[0], /\bdisabled=""/);
  assert.match(selects[0], /<option\b[^>]*value="usb-microphone"[^>]*selected=""[^>]*>USB Microphone<\/option>/);
  assert.match(selects[1], /<option\b[^>]*value="auto"[^>]*selected=""[^>]*>Завершать после тишины<\/option>/);
  const trigger = settings.match(/<button\b[^>]*class="mic-settings-trigger"[^>]*>/)?.[0];
  assert.ok(trigger);
  assert.doesNotMatch(trigger, /\bdisabled/);
});

test('microphone settings provide Kazakh dialog, close and recording-mode labels', async () => {
  const { MicrophoneSettings } = await server.ssrLoadModule('/src/components/MicrophoneSettings.tsx');
  const settings = renderToStaticMarkup(createElement(MicrophoneSettings, {
    language: 'kk', devices: [], deviceId: '', onDeviceChange: () => {},
    micMode: 'hold', onModeChange: () => {}, disabled: false, onRefreshDevices: async () => {},
  }));
  assert.match(settings, /aria-label="Микрофон баптаулары"/);
  assert.match(settings, /<h2\b[^>]*>Микрофон баптаулары<\/h2>/);
  assert.match(settings, /aria-label="Микрофон баптауларын жабу"/);
  assert.match(settings, /<label>Жазу режимі<select/);
  assert.match(settings, /<option\b[^>]*value="hold"[^>]*selected=""[^>]*>Батырманы басып тұру<\/option>/);
  assert.match(settings, /<option value="auto">Тыныштықтан кейін аяқтау<\/option>/);
  assert.match(settings, /Жүйелік әдепкі/);
  assert.match(settings, /Құрылғыларды жаңарту/);
  assert.doesNotMatch(settings, /Настройки микрофона|Режим записи|Закрыть настройки/);
});
