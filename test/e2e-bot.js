'use strict';
/**
 * E2E демо-бота: один пользователь зовёт бота и получает настоящий WebRTC-звонок.
 * Проверяет анти-«пустой сервис» сценарий, ради которого бот и сделан.
 * Запуск: node test/e2e-bot.js
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3555;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name} ${extra}`); }
};

async function api(url, opts = {}) {
  const res = await fetch(BASE + url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: 'Bearer ' + opts.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: '/tmp/zv-bot-' + Date.now(), PUBLIC_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', d => process.stdout.write(`[srv] ${d}`));
  srv.stderr.on('data', d => process.stdout.write(`[srv:err] ${d}`));
  const cleanup = [() => srv.kill('SIGKILL')];
  process.on('exit', () => cleanup.forEach(f => { try { f(); } catch {} }));

  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(200); }

  console.log('\n=== E2E: демо-бот ===\n');

  const admin = await api('/api/auth/login', { method: 'POST', body: { nick: 'admin', password: 'zvonitel' } });
  const started = await api('/api/admin/bots', { method: 'POST', token: admin.data.token, body: { on: true, count: 1 } });
  check('админ запустил бота', started.status === 200 && started.data.started >= 1, JSON.stringify(started.data));

  // ждём, пока бот подключится по Socket.IO и сядет в очередь
  let status = null;
  for (let i = 0; i < 40; i++) {
    status = (await api('/api/admin/bots', { token: admin.data.token })).data;
    if (status.available) break;
    await sleep(500);
  }
  check('бот доступен в пуле', !!status?.available, JSON.stringify(status));

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  cleanup.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  const user = await api('/api/auth/register', { method: 'POST', body: { nick: 'Solo_' + process.pid.toString(36), password: 'test1234', age: 25 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([t]) => {
    localStorage.setItem('zv_token', JSON.stringify(t));
    localStorage.setItem('zv_age18', JSON.stringify(Date.now())); // подтверждение 18+
  }, [user.data.token]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.hero h1', { timeout: 15000 });

  await page.click('[data-act="start"]');
  await page.waitForSelector('#goRandom', { timeout: 15000 });
  await page.click('#goRandom');
  await page.waitForSelector('.queue__timer', { timeout: 10000 });
  check('одинокий пользователь попал в очередь', true);

  // через ~12 секунд появляется предложение позвать бота
  await page.waitForSelector('#callBot', { timeout: 25000 });
  check('появилось предложение демо-бота', true);

  await page.click('#callBot');
  await page.waitForSelector('#remoteVideo', { timeout: 20000 });
  check('звонок с ботом начался', true);

  try {
    await page.waitForFunction(() => {
      const v = document.querySelector('#remoteVideo');
      return v && v.videoWidth > 0;
    }, { timeout: 25000 });
  } catch (e) {
    console.log('  [diag user]', JSON.stringify(await page.evaluate(() => window.ZVApp.debug())));
    throw e;
  }
  const remote = await page.evaluate(() => {
    const v = document.querySelector('#remoteVideo');
    const d = window.ZVApp.debug();
    return { w: v.videoWidth, h: v.videoHeight, pc: d.pcState, nick: document.querySelector('.call__nick')?.textContent };
  });
  check(`видео бота идёт по WebRTC (${remote.w}x${remote.h}, pc=${remote.pc})`, remote.w > 0 && remote.pc === 'connected', JSON.stringify(remote));
  check('ник бота честный: ' + remote.nick, /бот/i.test(remote.nick || ''), remote.nick);

  // бот сам начинает разговор
  await page.click('.cbtn[data-act="chat"]');
  await page.waitForSelector('#chatLog .msg', { timeout: 25000 });
  const botSaid = await page.textContent('#chatLog .msg .msg__text');
  check('бот первым написал в чат', botSaid.length > 10, botSaid);
  check('бот честно признаётся, что он бот', /бот/i.test(botSaid), botSaid);

  await page.screenshot({ path: path.join(__dirname, '..', 'shots', '08-bot-call.png') });

  // звонок короче 5 секунд не засчитывается и экран оценки не показывается
  await sleep(5500);

  await page.click('.cbtn[data-act="hangup"]');
  await page.waitForSelector('#stars', { timeout: 15000 });
  check('после завершения — экран оценки', true);

  // бот освободился и готов к следующему звонку
  await sleep(2000);
  const after = (await api('/api/admin/bots', { token: admin.data.token })).data;
  check('бот освободился после звонка', after.idle >= 1, JSON.stringify(after));

  check('в консоли нет ошибок', errors.length === 0, errors.slice(0, 3).join(' | '));

  await api('/api/admin/bots', { method: 'POST', token: admin.data.token, body: { on: false } });
  console.log(`\n=== E2E-бот: ${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : failures + ' ПРОВЕРОК УПАЛО'} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('E2E BOT CRASH', e); process.exit(1); });
