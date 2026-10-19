'use strict';
/**
 * Проверка «как это видит пользователь»: открываем приложение ВНУТРИ iframe
 * (ровно так его показывает предпросмотр) и смотрим, грузится ли лендинг,
 * подключается ли Socket.IO и не падает ли JS.
 *
 * Запуск: node test/preview-check.js
 */
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');

const APP = process.env.APP_URL || 'http://127.0.0.1:3000';
const HARNESS_PORT = 3777;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// «рамка» предпросмотра: отдельный origin, iframe с sandbox="allow-scripts" (без allow-same-origin)
const harness = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><body style="margin:0;background:#111">
    <iframe id="f" src="${APP}/" sandbox="allow-scripts allow-forms"
      style="width:1280px;height:900px;border:0"></iframe>
  </body></html>`);
});

(async () => {
  harness.listen(HARNESS_PORT, '0.0.0.0');
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage({ viewport: { width: 1300, height: 920 } });

  const errors = [];
  const logs = [];
  page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', r => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  await page.goto(`http://127.0.0.1:${HARNESS_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(6000);

  const frame = page.frames().find(f => f.url().startsWith(APP));
  console.log('\n=== Проверка предпросмотра (приложение в iframe) ===\n');
  console.log('iframe найден:', !!frame, frame ? '→ ' + frame.url() : '');

  if (!frame) {
    console.log('❌ iframe с приложением не найден');
  } else {
    const probe = await frame.evaluate(() => ({
      title: document.title,
      hasNav: !!document.querySelector('.nav'),
      hasHero: !!document.querySelector('.hero h1'),
      heroText: document.querySelector('.hero h1')?.textContent?.trim().slice(0, 60) || null,
      hasSocketIo: typeof window.io === 'function',
      hasZVApp: !!window.ZVApp,
      cfgLoaded: !!window.ZVApp?.State?.cfg,
      online: window.ZVApp?.State?.stats?.online ?? null,
      gateVisible: !!document.querySelector('.gate'),
      bodyChars: document.body.innerText.trim().length,
    })).catch(e => ({ error: e.message }));

    const ok = (n, c, extra = '') => console.log(`  ${c ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`);
    ok('страница отрисована', probe.bodyChars > 200, `${probe.bodyChars} символов`);
    ok('заголовок', /Zvonitel/i.test(probe.title || ''), probe.title);
    ok('навигация видна', probe.hasNav);
    ok('лендинг отрисован', probe.hasHero, probe.heroText);
    ok('Socket.IO загружен', probe.hasSocketIo);
    ok('приложение инициализировано', probe.hasZVApp);
    ok('конфиг получен с сервера', probe.cfgLoaded);
    ok('счётчик онлайна получен', probe.online !== null, `online=${probe.online}`);
    ok('гейт 18+ показан', probe.gateVisible);

    // пробуем нажать «Начать» внутри iframe — самый частый сценарий
    const gated = await frame.evaluate(() => {
      const b = document.querySelector('.gate__actions .btn--primary');
      if (b) { b.click(); return 'gate closed'; }
      return 'no gate';
    });
    await sleep(500);
    const started = await frame.evaluate(() => {
      const btn = [...document.querySelectorAll('[data-act="start"]')].pop();
      btn?.click();
      return !!btn;
    });
    await sleep(4000);
    const afterStart = await frame.evaluate(() => ({
      screen: window.ZVApp?.State?.screen,
      hasPreview: !!document.querySelector('#previewVideo'),
      demo: window.ZVMedia?.isDemo,
      badge: document.querySelector('#deviceBadge')?.textContent?.trim() || null,
    })).catch(e => ({ error: e.message }));
    ok('кнопка «Начать» найдена', started);
    ok('открылся экран проверки камеры', afterStart.screen === 'onboarding', JSON.stringify(afterStart));
    ok('видео-превью есть', !!afterStart.hasPreview);
    console.log(`  ℹ️  режим камеры в iframe: ${afterStart.demo ? 'ДЕМО-поток (камера недоступна — ожидаемо)' : 'настоящая камера'}`);
    if (afterStart.badge) console.log(`  ℹ️  статус: ${afterStart.badge}`);
  }

  console.log('\n  ошибки консоли:', errors.length ? errors.slice(0, 6) : 'нет');
  const notable = logs.filter(l => /error|warn|fail/i.test(l));
  console.log('  предупреждения:', notable.length ? notable.slice(0, 6) : 'нет');

  await page.screenshot({ path: path.join(__dirname, '..', 'shots', '09-preview-iframe.png') });
  await browser.close();
  harness.close();
  console.log('\n  скриншот: shots/09-preview-iframe.png\n');
})();
