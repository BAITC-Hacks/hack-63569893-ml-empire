import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server;
let CatalogEditor;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    logLevel: 'silent',
  });
  ({ CatalogEditor } = await server.ssrLoadModule('/src/components/CatalogEditor.tsx'));
});

after(async () => { await server?.close(); });

for (const language of ['ru', 'kk']) {
  test(`${language}: catalog shares the page heading layout with a title and customer-facing subtitle`, () => {
    const markup = renderToStaticMarkup(createElement(CatalogEditor, { language }));
    const header = markup.match(/<header class="page-intro">([\s\S]*?)<\/header>/);
    const [title, subtitle] = language === 'ru'
      ? ['Редактор сценариев', 'Настраивайте сценарии и ответы для каждого обращения.']
      : ['Сценарийлер редакторы', 'Әр өтінішке арналған сценарийлер мен жауаптарды баптаңыз.'];
    assert.ok(header, 'catalog has a dedicated heading');
    assert.equal(header[1], `<div><h1 id="catalog-title">${title}</h1><p>${subtitle}</p></div>`);
    assert.equal([...markup.matchAll(/<h1\b/g)].length, 1);
    assert.doesNotMatch(header[1], /CATALOG|LOCAL|Версия исходных данных|Локальная рабочая версия/);

    const editor = markup.slice(header.index + header[0].length);
    const toolbar = editor.match(/<div class="catalog-toolbar">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(toolbar, 'editing actions stay outside the page heading');
    const actions = language === 'ru'
      ? ['Новый сценарий', 'Импорт JSON', 'Экспорт JSON']
      : ['Жаңа сценарий', 'JSON импорттау', 'JSON экспорттау'];
    for (const action of actions) assert.ok(toolbar.includes(`${action}</button>`));
    assert.match(toolbar, /<input\b[^>]*type="file"[^>]*accept="application\/json,\.json"/);
    assert.match(editor, /<textarea\b[^>]*id="catalog-json"[^>]*>[\s\S]*?scenario_id[\s\S]*?<\/textarea>/);
  });
}
