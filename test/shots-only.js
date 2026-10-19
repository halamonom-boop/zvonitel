'use strict';
/** Только скриншоты ключевых экранов: десктоп + телефон. */
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const SHOTS = path.join(__dirname, '..', 'shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  const open = async (opts) => {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], ...opts });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('zv_age18', String(Date.now())));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hero h1', { timeout: 15000 });
    return { ctx, page };
  };

  // --- десктоп ---
  let { ctx, page } = await open({ viewport: { width: 1440, height: 900 } });
  await sleep(1600);
  await page.screenshot({ path: path.join(SHOTS, '20-desktop-landing.png') });

  await page.evaluate(() => document.querySelector('#plans')?.scrollIntoView());
  await sleep(900);
  await page.screenshot({ path: path.join(SHOTS, '24-desktop-plans.png') });

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('[data-act="start"]');
  await page.waitForSelector('#goRandom', { timeout: 15000 });
  await sleep(1400);
  await page.screenshot({ path: path.join(SHOTS, '21-desktop-onboarding.png') });
  await ctx.close();

  // --- телефон ---
  ({ ctx, page } = await open({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  }));
  await sleep(1600);
  await page.screenshot({ path: path.join(SHOTS, '22-mobile-landing.png') });

  await page.evaluate(() => {
    const el = document.querySelector('.why') || document.querySelector('.faq');
    el?.scrollIntoView();
  });
  await sleep(900);
  await page.screenshot({ path: path.join(SHOTS, '25-mobile-why.png') });

  await page.evaluate(() => document.querySelector('#plans')?.scrollIntoView());
  await sleep(900);
  await page.screenshot({ path: path.join(SHOTS, '26-mobile-plans.png') });

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('[data-act="start"]');
  await page.waitForSelector('#goRandom', { timeout: 15000 });
  await sleep(1400);
  await page.screenshot({ path: path.join(SHOTS, '23-mobile-onboarding.png'), fullPage: true });
  await ctx.close();

  await browser.close();
  console.log('готово: shots/20..26');
})();
