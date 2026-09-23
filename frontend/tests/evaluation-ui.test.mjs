import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server;
let EvaluationLab;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    logLevel: 'silent',
  });
  ({ EvaluationLab } = await server.ssrLoadModule('/src/components/EvaluationLab.tsx'));
});

after(async () => { await server?.close(); });

for (const language of ['ru', 'kk']) {
  test(`${language}: evaluation shares the page heading layout outside the results card`, () => {
    const markup = renderToStaticMarkup(createElement(EvaluationLab, { language }));
    const header = markup.match(/<header class="page-intro">([\s\S]*?)<\/header>/);
    assert.ok(header, 'evaluation has a dedicated page heading');
    const heading = header[1];
    const [title, subtitle] = language === 'ru'
      ? ['Качество маршрутизации', 'Точность, ошибки и скорость ответа на 104 тестовых репликах.']
      : ['Маршруттау сапасы', '104 тест репликасындағы дәлдік, қателер және жауап жылдамдығы.'];
    assert.ok(heading.includes(`<h1 id="evaluation-title">${title}</h1><p>${subtitle}</p>`));
    assert.equal([...markup.matchAll(/<h1\b/g)].length, 1);
    assert.match(markup, /^<section class="evaluation-page" aria-labelledby="evaluation-title">/);
    const cardIndex = markup.indexOf('<div class="evaluation-lab">');
    assert.ok(cardIndex >= header.index + header[0].length, 'the results card follows the complete page heading');
    assert.doesNotMatch(markup.slice(cardIndex), /page-intro|<h1\b/);
    assert.match(heading, /<button\b[^>]*class="evaluation-button"[^>]*disabled=""/);
    assert.match(heading, language === 'ru' ? /Скачать отчёт<\/button>/ : /Есепті жүктеу<\/button>/);
  });

  test(`${language}: evaluation keeps two result file inputs and no manual JSON editor`, () => {
    const markup = renderToStaticMarkup(createElement(EvaluationLab, { language }));
    assert.equal([...markup.matchAll(/<input\b[^>]*type="file"[^>]*>/g)].length, 2);
    assert.equal([...markup.matchAll(/accept="\.json,application\/json"/g)].length, 2);
    assert.doesNotMatch(markup, /<textarea|evaluation-paste|evaluation-target/);
    const labels = [...markup.matchAll(/<legend>([^<]+)<\/legend>/g)].map(match => match[1]);
    assert.deepEqual(labels, language === 'ru'
      ? ['Основной режим', 'Быстрый режим']
      : ['Негізгі режим', 'Жылдам режим']);
  });

  test(`${language}: evaluation does not expose developer instructions on the product screen`, () => {
    const markup = renderToStaticMarkup(createElement(EvaluationLab, { language }));
    assert.doesNotMatch(markup, /AI LAB|Full path|Fast path|evaluation-method|latency_ms|latency_stage|datas\/|backend|демонстрацион|үлгілік/);
  });

  test(`${language}: empty results stay honest and cannot be exported`, () => {
    const markup = renderToStaticMarkup(createElement(EvaluationLab, { language }));
    assert.match(markup, language === 'ru' ? /Результатов оценки пока нет\./ : /Бағалау нәтижелері әлі жоқ\./);
    assert.match(markup, /<button\b[^>]*class="evaluation-button"[^>]*disabled=""/);
    assert.doesNotMatch(markup, /<table|\b0%/);
    assert.match(markup, language === 'ru' ? /Сравнение режимов/ : /Режимдерді салыстыру/);
  });
}
