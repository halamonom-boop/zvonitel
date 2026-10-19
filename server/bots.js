'use strict';
/**
 * Демо-боты (анти-«пустой сервис»).
 *
 * Проблема продукта: новому пользователю не с кем говорить, пока нет аудитории —
 * и он уходит навсегда. Решение: пул ботов, которые честно подписаны как боты
 * («Демо-бот Алиса», в профиле роль «bot»). Никакого обмана: собеседник видит имя и метку.
 *
 * Технически бот — это отдельный headless-браузер (playwright), который держит
 * Socket.IO-сессию и настоящий PeerConnection с canvas-видео. То есть тракт звонка
 * ровно тот же, что у человека: если работает с ботом, работает и с человеком.
 */
const path = require('path');
const { spawn } = require('child_process');

const BOT_NAMES = [
  { nick: 'Демо-бот Алиса', hue: 300, topics: ['movies', 'music', 'travel'], style: 'fun', goal: 'chat' },
  { nick: 'Демо-бот Марк', hue: 200, topics: ['tech', 'science', 'games'], style: 'deep', goal: 'topic' },
];

class BotPool {
  constructor({ baseUrl, appUrl }) {
    this.baseUrl = baseUrl;      // внешний адрес (для ссылок)
    this.appUrl = appUrl;        // http://127.0.0.1:PORT — куда подключается бот
    this.pool = [];              // [{browser, page, persona, busy, session}]
    this.orphans = new Map();    // ник -> сессия, если сокет подключился раньше записи в пуле
    this.available = false;
  }

  /** Пытается поднять браузер. Если playwright не установлен — просто отключает фичу. */
  async warm(count = 1) {
    if (this.pool.length) return this.pool.length;
    let chromium;
    try {
      ({ chromium } = require('playwright'));
    } catch {
      console.warn('[bots] playwright не установлен — демо-боты отключены');
      return 0;
    }
    for (let i = 0; i < count; i++) {
      const persona = BOT_NAMES[(this.pool.length + i) % BOT_NAMES.length];
      // Запись в пул создаём ДО открытия страницы: бот подключается к Socket.IO мгновенно
      // и сервер зовёт attach() ещё во время загрузки — иначе гонка и бот «невидим».
      const entry = { browser: null, page: null, persona, busy: false, session: null };
      this.pool.push(entry);
      try {
        entry.browser = await chromium.launch({
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
        });
        const ctx = await entry.browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 640, height: 480 } });
        entry.page = await ctx.newPage();
        entry.page.on('pageerror', e => console.warn('[bot:pageerror]', e.message));
        if (process.env.BOT_DEBUG) entry.page.on('console', m => console.log('[bot]', m.text()));
        const token = 'bot_' + Buffer.from(persona.nick).toString('base64url');
        await entry.page.goto(`${this.appUrl}/bot.html?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
        await entry.page.waitForFunction(() => window.ZVBot && window.ZVBot.ready, { timeout: 20000 });
        // на случай, если attach() отработал до создания записи — подбираем «сироту»
        if (!entry.session && this.orphans.has(persona.nick)) {
          entry.session = this.orphans.get(persona.nick);
          this.orphans.delete(persona.nick);
        }
        console.log(`[bots] запущен ${persona.nick}${entry.session ? '' : ' (ожидает подключения)'}`);
      } catch (e) {
        this.pool = this.pool.filter(x => x !== entry);
        try { await entry.browser?.close(); } catch {}
        console.warn(`[bots] не удалось запустить бота: ${e.message}`);
      }
    }
    this.available = this.pool.length > 0;
    return this.pool.length;
  }

  /** Сервер сообщает, что бот с таким ником подключился по Socket.IO. */
  attach(nick, session) {
    const bot = this.pool.find(b => b.persona.nick === nick && !b.session);
    if (bot) { bot.session = session; return true; }
    this.orphans.set(nick, session); // подключение пришло раньше записи в пуле
    return false;
  }

  async acquire() {
    if (!this.pool.length) await this.warm(1);
    const free = this.pool.find(b => !b.busy && b.session);
    if (!free) return null;
    free.busy = true;
    return free;
  }

  async release(bot) {
    if (!bot) return;
    bot.busy = false;
    try { await bot.page.evaluate(() => window.ZVBot.reset()); } catch {}
  }

  /** Освободить бота, когда его звонок закончился (ищет по id собеседника). */
  async releaseByUser(userId) {
    const bot = this.pool.find(b => b.session && b.session.userId === userId);
    if (bot) await this.release(bot);
  }

  status() {
    return {
      available: this.pool.some(b => !b.busy && b.session),
      total: this.pool.length,
      idle: this.pool.filter(b => !b.busy && b.session).length,
      names: this.pool.map(b => b.persona.nick),
    };
  }

  async shutdown() {
    for (const b of this.pool) { try { await b.browser.close(); } catch {} }
    this.pool = [];
  }
}

module.exports = { BotPool, BOT_NAMES };
