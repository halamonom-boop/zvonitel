'use strict';
/**
 * Автомодерация (ТЗ §4.4).
 *  - фильтр оскорблений/спама в текстовом чате;
 *  - детекция рекламы (ссылки, телефоны, @username, «переходи»);
 *  - серверная часть NSFW-детекции: клиент шлёт скор кадра (скин-пиксели),
 *    сервер считает скользящее среднее и выдаёт страйки;
 *  - детекция «громкого звука» (клиент меряет RMS через AnalyserNode);
 *  - страйки -> варн -> бан (таблица наказаний).
 */
const store = require('./db');

const RU_INSULTS = ['дурак','дура','идиот','идиотка','тупая','тупой','чмо','мразь','гнида','ублюдок','сука','блядь','блять','хуй','пизд','ебать','нахуй','пошел на','пошёл на','долбоеб','долбоёб','уебан','пидор','пидар','шлюха','лох','бот тупой'];
const EN_INSULTS = ['idiot','stupid bitch','faggot','retard','dumbass','slut','whore','kill yourself','kys'];
const SPAM_WORDS = ['переходи','заработок','крипта','инвест','подпишись на','напиши в тг','напиши в телеграм','бесплатно раздаю','казино','ставка','промокод','заработай','onlyfans','продам','закажи','скидка 90'];

const URL_RE = /(https?:\/\/|www\.)/i;
const PHONE_RE = /(\+?\d[\d\s()-]{9,}\d)/;
const HANDLE_RE = /(@[a-zA-Z0-9_]{4,}|t\.me\/|telegram\.me\/|wa\.me\/)/i;

/**
 * Проверяет сообщение чата.
 * @returns {{ok:boolean, reason?:string, masked?:string, severity:'low'|'medium'|'high'}}
 */
function checkMessage(text = '') {
  const t = String(text).slice(0, 500);
  const lower = t.toLowerCase();

  if (HANDLE_RE.test(t) || URL_RE.test(t)) {
    return { ok: false, reason: 'ads', severity: 'medium', masked: mask(t) };
  }
  if (PHONE_RE.test(t)) {
    return { ok: false, reason: 'ads', severity: 'medium', masked: mask(t) };
  }
  const spam = SPAM_WORDS.find(w => lower.includes(w));
  if (spam) return { ok: false, reason: 'spam', severity: 'medium', masked: mask(t) };
  const insult = [...RU_INSULTS, ...EN_INSULTS].find(w => lower.includes(w));
  if (insult) return { ok: false, reason: 'insults', severity: 'medium', masked: maskWord(t, insult) };

  return { ok: true, masked: t };
}

function mask(t) { return '⛔ ' + t.replace(/[^\s]/g, '•').slice(0, 120); }
function maskWord(t, word) {
  const i = t.toLowerCase().indexOf(word);
  if (i < 0) return t;
  return t.slice(0, i) + '•'.repeat(word.length) + t.slice(i + word.length);
}

/* ---------- NSFW / громкость: скользящее окно по клиентским метрикам ---------- */

const windows = new Map(); // sessionId -> {frames:[], loud:[]}

function pushFrame(sessionId, { nsfwScore = 0, loud = false } = {}) {
  let w = windows.get(sessionId);
  if (!w) { w = { frames: [], loud: 0, warned: false }; windows.set(sessionId, w); }
  w.frames.push(nsfwScore);
  if (w.frames.length > 20) w.frames.shift();
  if (loud) w.loud++;
  const avg = w.frames.reduce((a, b) => a + b, 0) / w.frames.length;
  return { avg, count: w.frames.length, loud: w.loud, suspicious: avg > 0.55 && w.frames.length >= 8 };
}

function clearWindow(sessionId) { windows.delete(sessionId); }

/* ---------- наказания ---------- */

/**
 * Страйк-система:
 *  1 страйк  -> предупреждение
 *  2 страйка -> бан 1 час
 *  3 страйка -> бан 24 часа
 *  4+        -> перманентный бан (для 'minor'/'violence' — сразу перманентный)
 */
function applyStrike(userId, reason, opts = {}) {
  const u = store.users.get(userId);
  const severity = opts.severity || 'medium';
  const now = Date.now();
  const result = { action: 'none', until: 0 };

  if (!u) return result; // гость: только кик из очереди (обрабатывается снаружи)

  store.users.addStats(userId, { reports: 1 });

  if (severity === 'critical' || severity === 'high') {
    store.users.ban(userId, now + 7 * 864e5);
    store.events.log('ban_auto', userId, { reason, severity });
    return { action: 'ban', until: now + 7 * 864e5, days: 7 };
  }

  const strikes = (u.strikes || 0) + 1;
  store.users.addStats(userId, { strikes: 1 });

  if (strikes === 1) {
    result.action = 'warn';
  } else if (strikes === 2) {
    store.users.ban(userId, now + HOUR);
    result.action = 'ban'; result.until = now + HOUR;
  } else if (strikes === 3) {
    store.users.ban(userId, now + 24 * HOUR);
    result.action = 'ban'; result.until = now + 24 * HOUR;
  } else {
    store.users.ban(userId, now + 3650 * 864e5);
    result.action = 'permaban'; result.until = now + 3650 * 864e5;
  }
  store.events.log(result.action, userId, { reason, strikes });
  return result;
}

const HOUR = 36e5;

module.exports = { checkMessage, pushFrame, clearWindow, applyStrike, maskWord, mask };
