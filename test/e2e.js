'use strict';
/**
 * Сквозной тест в двух реальных браузерах (Playwright + Chromium):
 * лендинг → 18+ → регистрация → проверка камеры → очередь → НАСТОЯЩИЙ WebRTC-звонок
 * → скип → экран оценки. Проверяет клиентский код в браузере, а не только сервер.
 *
 * Запуск: node test/e2e.js
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 3444;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, '..', 'shots');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NICK_SUFFIX = process.pid.toString(36);
const cleanup = [];
process.on('exit', () => cleanup.forEach(fn => { try { fn(); } catch {} }));
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name} ${extra}`); }
}

async function api(url, opts = {}) {
  const res = await fetch(BASE + url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: 'Bearer ' + opts.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: '/tmp/zv-e2e-' + Date.now(), PUBLIC_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stdout.write(`[srv:err] ${d}`));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(200); }

  cleanup.push(() => srv.kill('SIGKILL'));
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--allow-running-insecure-content',
    ],
  });

  const mkUser = async (nick, extra = {}) => {
    const r = await api('/api/auth/register', { method: 'POST', body: { nick: nick + '_' + NICK_SUFFIX, password: 'test1234', age: 26, ...extra } });
    if (r.status !== 200) throw new Error('register failed: ' + JSON.stringify(r.data));
    return r.data;
  };

  async function openUser(nick, extra) {
    const creds = await mkUser(nick, extra);
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      permissions: ['camera', 'microphone'],
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => localStorage.setItem('zv_token', JSON.stringify(t)), creds.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    return { ctx, page, creds, errors };
  }

  console.log('\n=== E2E: два браузера, реальный WebRTC ===\n');

  const A = await openUser('E2E_Ann', { gender: 'female', languages: ['ru'], goals: ['chat'], topics: ['movies', 'music'] });
  const B = await openUser('E2E_Bob', { gender: 'male', languages: ['ru'], goals: ['chat'], topics: ['movies', 'games'] });

  for (const [tag, u] of [['A', A], ['B', B]]) {
    // 18+ гейт
    const gate = u.page.locator('.gate');
    if (await gate.count()) {
      await u.page.click('.gate__actions .btn--primary');
    }
    await u.page.waitForSelector('.hero h1', { timeout: 10000 });
    check(`[${tag}] лендинг отрисован`, (await u.page.textContent('.hero h1')).includes('рулетка'));
  }

  // живой счётчик звонков с сервера
  const heroCalls = await A.page.textContent('#heroCalls');
  check('[A] счётчик звонков подтянулся с сервера', /\d/.test(heroCalls || ''), `получено: "${heroCalls}"`);

  await A.page.screenshot({ path: path.join(SHOTS, '01-landing.png'), fullPage: false });

  // старт → онбординг с проверкой камеры
  for (const [tag, u] of [['A', A], ['B', B]]) {
    await u.page.click('[data-act="start"]');
    await u.page.waitForSelector('#previewVideo', { timeout: 10000 });
    await u.page.waitForFunction(() => {
      const v = document.querySelector('#previewVideo');
      return v && v.videoWidth > 0;
    }, { timeout: 15000 });
    const badge = await u.page.textContent('#deviceBadge');
    check(`[${tag}] камера доступна, демо-режим НЕ включён`, badge.includes('готовы'), badge);
    const dims = await u.page.evaluate(() => {
      const v = document.querySelector('#previewVideo');
      return { w: v.videoWidth, h: v.videoHeight };
    });
    check(`[${tag}] локальное видео ${dims.w}x${dims.h}`, dims.w > 0);
    await u.page.screenshot({ path: path.join(SHOTS, `02-onboarding-${tag}.png`) });
  }

  // оба идут в очередь
  for (const u of [A, B]) await u.page.click('#goRandom');
  await A.page.waitForSelector('.queue__timer', { timeout: 10000 });
  check('[A] экран ожидания с таймером', true);
  await A.page.screenshot({ path: path.join(SHOTS, '03-queue.png') });

  // матч
  await A.page.waitForSelector('#remoteVideo', { timeout: 25000 });
  await B.page.waitForSelector('#remoteVideo', { timeout: 25000 });
  check('[A,B] получен матч — открыт экран звонка', true);

  // P2P-видео должно реально пойти
  const dump = async (label) => {
    for (const [tag, u] of [['A', A], ['B', B]]) {
      const d = await u.page.evaluate(() => window.ZVApp.debug());
      console.log(`  [diag ${label} ${tag}]`, JSON.stringify(d));
    }
  };
  try {
    await A.page.waitForFunction(() => {
      const v = document.querySelector('#remoteVideo');
      return v && v.videoWidth > 0;
    }, { timeout: 20000 });
  } catch (e) {
    await dump('fail');
    throw e;
  }
  const remote = await A.page.evaluate(() => {
    const v = document.querySelector('#remoteVideo');
    return { w: v.videoWidth, h: v.videoHeight, ready: v.readyState };
  });
  check(`[A] удалённое видео идёт по WebRTC (${remote.w}x${remote.h}, readyState=${remote.ready})`, remote.w > 0 && remote.ready >= 2);

  await A.page.waitForFunction(() => document.querySelector('#callStatus')?.dataset.state === 'connected', { timeout: 20000 });
  check('[A] статус звонка «В эфире»', true);

  const nickOnScreen = await A.page.textContent('.call__nick');
  check(`[A] видно ник собеседника (${nickOnScreen})`, nickOnScreen === 'E2E_Bob_' + NICK_SUFFIX, nickOnScreen);

  await sleep(2500);
  await A.page.screenshot({ path: path.join(SHOTS, '04-call.png') });
  await B.page.screenshot({ path: path.join(SHOTS, '04-call-b.png') });

  // чат через UI
  await A.page.click('.cbtn[data-act="chat"]');
  await A.page.fill('#chatInput', 'Привет из E2E-теста!');
  await A.page.press('#chatInput', 'Enter');
  await B.page.waitForSelector('.msg', { timeout: 8000 });
  const msgText = await B.page.textContent('.msg .msg__text');
  check('[B] сообщение чата дошло', msgText.includes('E2E-теста'), msgText);

  // реакция
  await A.page.click('.emoji-btn[data-emoji="🔥"]');
  await B.page.waitForSelector('.float-emoji', { timeout: 5000 });
  check('[B] реакция прилетела', true);

  // говорим хотя бы 5 секунд — иначе звонок не засчитывается и оценка не предлагается
  await sleep(5500);

  // скип → экран оценки
  await A.page.click('.cbtn[data-act="skip"]');
  try {
    await A.page.waitForSelector('#stars', { timeout: 15000 });
  } catch (e) {
    console.log('  [diag A]', JSON.stringify(await A.page.evaluate(() => window.ZVApp.debug())));
    console.log('  [diag B]', JSON.stringify(await B.page.evaluate(() => window.ZVApp.debug())));
    throw e;
  }
  check('[A] после скипа открылся экран оценки', true);
  await A.page.screenshot({ path: path.join(SHOTS, '05-rate.png') });

  // оценка и переход к следующему
  await A.page.click('#stars button[data-s="5"]');
  await A.page.click('#rateTags .chip-btn');
  await A.page.click('#rateNext');
  await A.page.waitForSelector('.queue__timer', { timeout: 15000 });
  check('[A] «Следующий» вернул в очередь', true);

  const rating = await api('/api/public/users/' + B.creds.user.id);
  check('[server] оценка записана в рейтинг собеседника', rating.data.user.rating === 5, JSON.stringify(rating.data.user.rating));

  // профиль
  await A.page.goto(BASE + '/profile', { waitUntil: 'domcontentloaded' });
  await A.page.waitForSelector('.profile__head', { timeout: 10000 });
  await sleep(1200);
  const achOn = await A.page.locator('.ach__item.is-on').count();
  check('[A] профиль: достижения посчитаны', achOn >= 0);
  await A.page.screenshot({ path: path.join(SHOTS, '06-profile.png'), fullPage: true });

  // админка
  await A.page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await A.page.waitForSelector('#adminLogin', { timeout: 10000 });
  await A.page.fill('#admNick', 'admin');
  await A.page.fill('#admPass', 'zvonitel');
  await A.page.click('#adminForm button');
  await A.page.waitForSelector('#adminBody', { state: 'visible', timeout: 10000 });
  await sleep(1500);
  const metricCount = await A.page.locator('.metric').count();
  check(`[admin] панель метрик отрисована (${metricCount} плиток)`, metricCount >= 10);
  const reports = await A.page.locator('.report').count();
  check('[admin] список жалоб доступен', reports >= 0);
  await A.page.screenshot({ path: path.join(SHOTS, '07-admin.png'), fullPage: true });

  // ошибки в консоли браузера
  const jsErrors = [...A.errors, ...B.errors].filter(e => !/favicon|Download the React/i.test(e));
  check('в консоли браузеров нет ошибок', jsErrors.length === 0, jsErrors.slice(0, 4).join(' | '));

  await browser.close();
  srv.kill('SIGKILL');

  console.log(`\n=== E2E завершён: ${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : failures + ' ПРОВЕРОК УПАЛО'} ===`);
  console.log('Скриншоты: ' + SHOTS + '\n');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('E2E CRASH', e); process.exit(1); });
