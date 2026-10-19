'use strict';
/**
 * E2E для фич V2: субтитры и запись по взаимному согласию.
 *
 * Главное, что проверяем (ТЗ §4.4): запись НЕ начинается без согласия обоих.
 * И отдельно — что файл остаётся у пользователя и не уходит на сервер.
 *
 * Запуск: node test/e2e-v2.js
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 3777;
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
    env: { ...process.env, PORT: String(PORT), DATA_DIR: '/tmp/zv-v2-' + Date.now(), PUBLIC_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stdout.write(`[srv:err] ${d}`));
  const cleanup = [() => srv.kill('SIGKILL')];
  process.on('exit', () => cleanup.forEach(f => { try { f(); } catch {} }));

  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(200); }

  console.log('\n=== E2E V2: субтитры и запись ===\n');

  const admin = (await api('/api/auth/login', { method: 'POST', body: { nick: 'admin', password: 'zvonitel' } })).data.token;

  const mkPremium = async (nick) => {
    const r = await api('/api/auth/register', { method: 'POST', body: { nick: nick + '_' + SUFFIX, password: 'test1234', age: 27 } });
    await api(`/api/admin/users/${r.data.user.id}/premium`, { method: 'POST', token: admin, body: { ms: 86400000 } });
    return r.data;
  };

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  cleanup.push(() => browser.close());

  async function openUser(creds, tag) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      permissions: ['camera', 'microphone'],
      acceptDownloads: true,
    });
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
    return { page, ctx, errors, tag };
  }

  /** Поднимает звонок между двумя пользователями. */
  async function makeCall(A, B) {
    for (const u of [A, B]) {
      await u.page.click('[data-act="start"]');
      await u.page.waitForSelector('#goRandom', { timeout: 15000 });
      await u.page.click('#goRandom');
    }
    await A.page.waitForSelector('#remoteVideo', { timeout: 25000 });
    await B.page.waitForSelector('#remoteVideo', { timeout: 25000 });
    await A.page.waitForFunction(() => {
      const v = document.querySelector('#remoteVideo');
      return v && v.videoWidth > 0;
    }, { timeout: 25000 });
    await A.page.waitForFunction(() => document.querySelector('#callStatus')?.dataset.state === 'connected', { timeout: 25000 });
  }

  const openMore = async (u) => {
    await u.page.click('.cbtn[data-act="more"]');
    await u.page.waitForSelector('#morePanel.is-open', { timeout: 5000 });
  };

  /* ---------- 1. субтитры ---------- */
  {
    const c1 = await mkPremium('V2Ann');
    const c2 = await mkPremium('V2Bob');
    const A = await openUser(c1, 'A');
    const B = await openUser(c2, 'B');
    await makeCall(A, B);
    console.log('— субтитры —');

    await openMore(A);
    const hasCaptionBtn = await A.page.locator('[data-act="captions"]').count();
    const hasRecBtn = await A.page.locator('[data-act="record"]').count();
    check('в меню есть кнопка «Субтитры»', hasCaptionBtn > 0);
    check('в меню есть кнопка «Запись звонка»', hasRecBtn > 0);

    await A.page.click('[data-act="captions"]');
    await sleep(1200);
    const capState = await A.page.evaluate(() => ({
      on: !!document.querySelector('.call__captions.is-on'),
      running: !!window.ZVApp.State.captions?.running,
      supported: window.ZVApp.State.captions?.supported,
      hasToast: !!document.querySelector('.toast'),
      toastText: document.querySelector('.toast')?.textContent || '',
    }));

    // В headless-браузере распознавания речи обычно нет — проверяем честное поведение
    if (capState.supported === false) {
      check('если распознавание не поддерживается — показано понятное сообщение', capState.hasToast && /браузер|распознав/i.test(capState.toastText), capState.toastText);
    } else {
      check('субтитры включились', capState.on && capState.running, JSON.stringify(capState));
    }

    // реле субтитров проверяем независимо от поддержки речи — напрямую через сокет
    const relayed = await (async () => {
      const got = B.page.waitForFunction(
        () => (document.querySelector('#capPeer')?.textContent || '').length > 0,
        { timeout: 6000 },
      ).then(() => true).catch(() => false);
      await A.page.evaluate(() => window.ZVApp.State.socket.emit('caption', { callId: window.ZVApp.State.callData.callId, text: 'Привет из теста', final: true }));
      return got;
    })();
    check('субтитр собеседника дошёл и отобразился', relayed);

    // перевод: без настроенного сервера должен честно говорить, что не настроен
    await openMore(A);
    await A.page.click('[data-act="translate"]');
    await sleep(1500);
    const trState = await A.page.evaluate(() => ({
      on: !!window.ZVApp.State.translateOn,
      toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '),
    }));
    check('перевод без настроенного сервера честно сообщает об этом', !trState.on && /не настроен|TRANSLATE_URL/i.test(trState.toast), trState.toast);

    await A.page.screenshot({ path: path.join(SHOTS, '10-v2-captions.png') });
    check('[субтитры] без ошибок в консоли', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    await A.ctx.close(); await B.ctx.close();
  }

  /* ---------- 2. запись: отказ (главное правило) ---------- */
  {
    const c1 = await mkPremium('V2No');
    const c2 = await mkPremium('V2Decline');
    const A = await openUser(c1, 'A');
    const B = await openUser(c2, 'B');
    await makeCall(A, B);
    console.log('\n— запись: отказ собеседника —');

    await openMore(A);
    await A.page.click('[data-act="record"]');
    await B.page.waitForSelector('#recConsent', { timeout: 8000 });
    check('собеседнику пришёл запрос согласия', true);

    // Главное правило защиты: до согласия MediaRecorder не стартует.
    // Индикатор при этом честно показывает «Запрос записи…», а не «REC».
    const before = await A.page.evaluate(() => ({
      recState: window.ZVApp.State.recorder?.state,
      badgeOn: !!document.querySelector('#recBadge')?.classList.contains('is-on'),
      badgePending: !!document.querySelector('#recBadge')?.classList.contains('is-pending'),
      badgeText: document.querySelector('#recBadge')?.textContent || '',
    }));
    check('до согласия запись НЕ идёт (recorder не в recording)', before.recState !== 'recording', JSON.stringify(before.recState));
    check('индикатор помечен как «запрос», а не как REC', before.badgePending && /запрос/i.test(before.badgeText), before.badgeText);

    // и у собеседника ещё ничего не пишется
    const bBefore = await B.page.evaluate(() => window.ZVApp.State.recorder?.state);
    check('у собеседника запись тоже не идёт до его согласия', bBefore !== 'recording', String(bBefore));

    await B.page.click('#recConsent .btn--ghost'); // Отклонить
    await sleep(1500);
    const afterDecline = await Promise.all([A, B].map(u => u.page.evaluate(() => ({
      badge: document.querySelector('#recBadge')?.classList.contains('is-on'),
      recState: window.ZVApp.State.recorder?.state,
    }))));
    check('после отказа запись не началась у инициатора', !afterDecline[0].badge, JSON.stringify(afterDecline[0]));
    check('после отказа запись не началась у собеседника', !afterDecline[1].badge, JSON.stringify(afterDecline[1]));
    const declinedToast = await A.page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
    check('инициатор видит, что запись отклонена', /отклонил/i.test(declinedToast), declinedToast);

    await A.ctx.close(); await B.ctx.close();
  }

  /* ---------- 3. запись: согласие и сохранение файла ---------- */
  {
    const c1 = await mkPremium('V2Rec1');
    const c2 = await mkPremium('V2Rec2');
    const A = await openUser(c1, 'A');
    const B = await openUser(c2, 'B');
    await makeCall(A, B);
    console.log('\n— запись: согласие и сохранение —');

    await openMore(A);
    await A.page.click('[data-act="record"]');
    await B.page.waitForSelector('#recConsent', { timeout: 8000 });
    await B.page.click('#recConsent .btn--primary'); // Разрешить

    // у ОБОИХ должен появиться индикатор
    const badges = await Promise.all([
      A.page.waitForFunction(() => document.querySelector('#recBadge')?.classList.contains('is-on'), { timeout: 8000 }).then(() => true).catch(() => false),
      B.page.waitForFunction(() => document.querySelector('#recBadge')?.classList.contains('is-on'), { timeout: 8000 }).then(() => true).catch(() => false),
    ]);
    check('у инициатора появился индикатор REC', badges[0]);
    check('у собеседника появился индикатор REC', badges[1]);

    const recStates = await Promise.all([A, B].map(u => u.page.evaluate(() => window.ZVApp.State.recorder?.state)));
    check('рекордер в состоянии recording у обоих', recStates.every(s => s === 'recording'), JSON.stringify(recStates));

    await sleep(3000); // пишем хотя бы пару секунд

    const label = await A.page.evaluate(() => document.querySelector('#recLabel')?.textContent || '');
    check('кнопка переключилась на «Остановить запись»', /остановить/i.test(label), label);

    await A.page.screenshot({ path: path.join(SHOTS, '11-v2-recording.png') });

    // останавливаем и ждём файл
    const downloadPromise = A.page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await openMore(A);
    await A.page.click('[data-act="record"]');
    const download = await downloadPromise;

    check('файл записи сохранён', !!download, download ? '' : 'download не получен');
    if (download) {
      const name = download.suggestedFilename();
      check('имя файла осмысленное (zvonitel-…)', /^zvonitel-.*\.(webm|mp4)$/.test(name), name);
      const saved = path.join('/tmp', name);
      await download.saveAs(saved);
      const size = fs.existsSync(saved) ? fs.statSync(saved).size : 0;
      check('файл не пустой', size > 2000, `${size} байт`);
      console.log(`  ℹ️  файл: ${name}, ${(size / 1024).toFixed(1)} КБ`);
      try { fs.unlinkSync(saved); } catch {}
    }

    const stopped = await Promise.all([A, B].map(u => u.page.evaluate(() => !document.querySelector('#recBadge')?.classList.contains('is-on'))));
    check('индикатор REC погас у обоих', stopped.every(Boolean), JSON.stringify(stopped));

    check('[запись] без ошибок в консоли', [...A.errors, ...B.errors].length === 0, [...A.errors, ...B.errors].slice(0, 2).join(' | '));
    await A.ctx.close(); await B.ctx.close();
  }

  /* ---------- 4. запись недоступна без Premium ---------- */
  {
    const c1 = await api('/api/auth/register', { method: 'POST', body: { nick: 'Free1_' + SUFFIX, password: 'test1234', age: 27 } });
    const c2 = await api('/api/auth/register', { method: 'POST', body: { nick: 'Free2_' + SUFFIX, password: 'test1234', age: 27 } });
    const A = await openUser(c1.data, 'A');
    const B = await openUser(c2.data, 'B');
    await makeCall(A, B);
    console.log('\n— запись без Premium —');

    await openMore(A);
    await A.page.click('[data-act="record"]');
    await sleep(1200);
    const state = await A.page.evaluate(() => ({
      recState: window.ZVApp.State.recorder?.state,
      toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '),
      upsell: !!document.querySelector('.modal'),
    }));
    check('без Premium запись не начинается', state.recState !== 'recording' && state.recState !== 'pending', JSON.stringify(state.recState));
    check('показано объяснение про Premium', /premium/i.test(state.toast), state.toast);
    await A.ctx.close(); await B.ctx.close();
  }

  console.log(`\n=== E2E V2: ${failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : failures + ' ПРОВЕРОК УПАЛО'} ===`);
  console.log('Скриншоты: shots/10-v2-captions.png, shots/11-v2-recording.png\n');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('E2E V2 CRASH', e); process.exit(1); });
