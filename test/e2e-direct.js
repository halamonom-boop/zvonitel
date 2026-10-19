'use strict';
/**
 * E2E интерфейса адресного звонка и квот (реальный браузер, реальный WebRTC).
 *
 * Проверяем главное:
 *   • по логину можно дозвониться напрямую, собеседник видит, кто звонит, и может отказать;
 *   • квота видна человеку заранее и честно списывается после состоявшегося разговора;
 *   • лендинг объясняет сервис и показывает три тарифа.
 *
 * Запуск: node test/e2e-direct.js
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 3779;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, '..', 'shots');
const SUFFIX = process.pid.toString(36);
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
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: '/tmp/zv-direct-' + Date.now(), PUBLIC_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stdout.write(`[srv:err] ${d}`));
  const cleanup = [() => srv.kill('SIGKILL')];
  process.on('exit', () => cleanup.forEach(f => { try { f(); } catch {} }));

  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(200); }

  console.log('\n=== E2E: звонок по логину и квоты ===\n');

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  cleanup.push(() => browser.close());

  const register = async (nick) =>
    (await api('/api/auth/register', { method: 'POST', body: { nick: nick + '_' + SUFFIX, password: 'test1234', age: 27 } })).data;

  async function openUser(creds) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera', 'microphone'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(([t]) => {
      localStorage.setItem('zv_token', JSON.stringify(t));
      localStorage.setItem('zv_age18', JSON.stringify(Date.now()));
    }, [creds.token]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hero h1', { timeout: 15000 });
    return { page, ctx, errors };
  }

  const toOnboarding = async (u) => {
    await u.page.click('[data-act="start"]');
    await u.page.waitForSelector('#goRandom', { timeout: 15000 });
  };

  /* ================= 1. лендинг ================= */
  console.log('— главная страница —');
  {
    const A = await openUser(await register('Land'));
    const counts = await A.page.evaluate(() => ({
      plans: document.querySelectorAll('#plansGrid .plan').length,
      why: document.querySelectorAll('.why__item').length,
      faq: document.querySelectorAll('.faq__item').length,
      steps: document.querySelectorAll('.step').length,
      planCalls: [...document.querySelectorAll('.plan__calls')].map(n => n.textContent.trim()),
      hasLead: !!document.querySelector('.section-lead'),
    }));
    check('три тарифа на главной', counts.plans === 3, JSON.stringify(counts.plans));
    check('расписано, зачем сервис (блок «Зачем это нужно»)', counts.why >= 5, String(counts.why));
    check('есть ответы на частые вопросы', counts.faq >= 5, String(counts.faq));
    check('есть пошаговое «как это работает»', counts.steps >= 4, String(counts.steps));
    check('квоты видны прямо в тарифах', counts.planCalls.length === 3, JSON.stringify(counts.planCalls));
    check('у раздела есть поясняющий текст', counts.hasLead);
    await A.page.screenshot({ path: path.join(SHOTS, '14-landing-plans.png'), fullPage: false });
    check('без ошибок в консоли', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    await A.ctx.close();
  }

  /* ================= 2. поиск и звонок по логину ================= */
  console.log('\n— звонок по логину: поиск, вызов, согласие —');
  const ann = await register('Ann');
  const bob = await register('Bob');

  {
    const A = await openUser(ann);
    const B = await openUser(bob);
    await toOnboarding(A); await toOnboarding(B);

    // поле поиска есть
    check('в подготовке к звонку есть поле «позвонить по логину»', await A.page.locator('#dirNick').count() === 1);

    // набираем логин — появляется подсказка
    await A.page.fill('#dirNick', bob.user.nick.slice(0, 4));
    await A.page.waitForSelector('#dirResults.is-open .dir__item', { timeout: 6000 });
    const found = await A.page.locator('#dirResults .dir__nick').allTextContents();
    check('поиск находит собеседника по логину', found.includes(bob.user.nick), JSON.stringify(found));

    // жмём на найденного — логин подставляется
    await A.page.click(`#dirResults .dir__item:has-text("${bob.user.nick}")`);
    check('клик по результату подставляет логин', (await A.page.inputValue('#dirNick')) === bob.user.nick);

    // звоним
    await A.page.click('#dirCall');
    await A.page.waitForSelector('#ringOut', { timeout: 6000 });
    check('инициатор видит, что звонок идёт', await A.page.locator('#ringOut').count() === 1);

    await B.page.waitForSelector('#ringIn', { timeout: 6000 });
    const incomingNick = await B.page.locator('#ringIn h3').textContent();
    check('собеседник видит, кто именно звонит', incomingNick.trim() === ann.user.nick, incomingNick);
    check('есть кнопка отклонить', await B.page.locator('#ringIn .btn--danger').count() === 1);
    await B.page.screenshot({ path: path.join(SHOTS, '15-direct-incoming.png') });

    // принимаем
    await B.page.click('#ringIn .btn--primary');
    await A.page.waitForSelector('#remoteVideo', { timeout: 25000 });
    await B.page.waitForSelector('#remoteVideo', { timeout: 25000 });
    await A.page.waitForFunction(() => {
      const v = document.querySelector('#remoteVideo');
      return v && v.videoWidth > 0;
    }, { timeout: 25000 });
    await A.page.waitForFunction(() => document.querySelector('#callStatus')?.dataset.state === 'connected', { timeout: 25000 });
    check('адресный звонок соединился — видео идёт', true);

    const quotaA = await A.page.evaluate(() => window.ZVApp.State.quota);
    const quotaB = await B.page.evaluate(() => window.ZVApp.State.quota);
    check('после звонка у инициатора 99 из 100', quotaA && quotaA.left === 99, JSON.stringify(quotaA));
    check('после звонка у принявшего 99 из 100', quotaB && quotaB.left === 99, JSON.stringify(quotaB));

    const chip = await A.page.textContent('#navQuota');
    check('остаток квоты виден в навигации', /99/.test(chip || ''), chip);

    await A.page.screenshot({ path: path.join(SHOTS, '16-direct-call.png') });
    check('без ошибок в консоли', A.errors.length === 0 && B.errors.length === 0,
      [...A.errors, ...B.errors].slice(0, 2).join(' | '));
    await A.ctx.close(); await B.ctx.close();
  }

  /* ================= 3. отказ ================= */
  console.log('\n— отказ от адресного звонка —');
  {
    const A = await openUser(ann);
    const B = await openUser(bob);
    await toOnboarding(A); await toOnboarding(B);

    await A.page.fill('#dirNick', bob.user.nick);
    await A.page.click('#dirCall');
    await B.page.waitForSelector('#ringIn', { timeout: 8000 });
    await B.page.click('#ringIn .btn--danger');             // отклонить

    await A.page.waitForSelector('#ringOut', { state: 'detached', timeout: 8000 });
    check('экран «звоним» закрылся после отказа', await A.page.locator('#ringOut').count() === 0);

    const toastText = await A.page.locator('.toast').last().textContent().catch(() => '');
    check('инициатор понял, что звонок отклонили', /отклонил/i.test(toastText || ''), toastText);
    check('звонок не начался', await A.page.locator('#remoteVideo').count() === 0);

    check('без ошибок в консоли', A.errors.length === 0 && B.errors.length === 0,
      [...A.errors, ...B.errors].slice(0, 2).join(' | '));
    await A.ctx.close(); await B.ctx.close();
  }

  /* ================= 4. неизвестный логин ================= */
  console.log('\n— звонок несуществующему пользователю —');
  {
    const A = await openUser(ann);
    await toOnboarding(A);
    await A.page.fill('#dirNick', 'NoSuchUser' + SUFFIX);
    await A.page.click('#dirCall');
    await A.page.waitForSelector('.toast', { timeout: 6000 });
    const t = await A.page.locator('.toast').last().textContent();
    check('честно сообщаем, что логин не найден', /не найден/i.test(t || ''), t);
    check('звонок не начался', await A.page.locator('#remoteVideo').count() === 0);
    check('без ошибок в консоли', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    await A.ctx.close();
  }

  /* ================= 5. гостю предлагают регистрацию ================= */
  console.log('\n— гость и квоты —');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera', 'microphone'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('zv_age18', String(Date.now())));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hero h1', { timeout: 15000 });

    const q = await page.evaluate(() => window.ZVApp.State.quota);
    check('гость видит, что у него 1 звонок', q && q.left === 1 && q.calls === 1, JSON.stringify(q));

    await page.click('[data-act="start"]');
    await page.waitForSelector('#goRandom', { timeout: 15000 });
    const nudge = await page.textContent('#quotaNudge');
    check('на экране старта видно остаток звонков', /1/.test(nudge || ''), nudge);

    const locked = await page.locator('.dir__locked').count();
    check('гостю объясняют, что звонок по логину доступен после регистрации', locked === 1);
    await page.screenshot({ path: path.join(SHOTS, '17-guest-quota.png') });

    check('без ошибок в консоли', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  console.log(`\n=== E2E звонок по логину: ${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : failures + ' ПРОВЕРОК УПАЛО'} ===`);
  console.log('Скриншоты: shots/14-landing-plans.png, 15-direct-incoming.png, 16-direct-call.png, 17-guest-quota.png\n');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('DIRECT CRASH', e); process.exit(1); });
