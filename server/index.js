'use strict';
/**
 * Zvonitel.ru — сервер (Express + Socket.IO).
 * REST: аккаунты, профиль, история, лидерборды, метрики, админка.
 * Socket.IO: очередь, матчинг, сигналинг WebRTC, чат, модерация.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const store = require('./db');
const config = require('./config');
const gamify = require('./gamify');
const attachSocket = require('./socket-server');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const ADMIN_PASS = process.env.ADMIN_PASS || 'zvonitel';
const ADMIN_NICK = process.env.ADMIN_NICK || 'admin';

const app = express();
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');

// базовая безопасность
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true }, pingTimeout: 20_000 });

/**
 * CORS — только для публичных эндпоинтов (конфиг, метрики, лидерборд).
 * Нужно, чтобы сервис корректно работал во встраиваемом предпросмотре/виджетах,
 * где origin равен 'null' и браузер требует preflight.
 * Закрытые эндпоинты (/api/me, /api/admin/*) сюда НЕ входят — там токены.
 */
const PUBLIC_API = /^\/api\/(health|config|metrics|leaderboard|theme|public\/|users\/search)/;
app.use((req, res, next) => {
  if (PUBLIC_API.test(req.path)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

const baseUrl = () => PUBLIC_URL || `${req0Proto()}://${req0Host()}`;
let lastReq = null;
app.use((req, _res, next) => { lastReq = req; next(); });
function req0Proto() { return lastReq?.headers['x-forwarded-proto'] || 'http'; }
function req0Host() { return lastReq?.headers['x-forwarded-host'] || lastReq?.headers?.host || `localhost:${PORT}`; }

/* ================= bootstrap: админ и демо-данные ================= */

function bootstrap() {
  if (!store.users.getByNick(ADMIN_NICK)) {
    const admin = store.users.registerWithPassword({
      nick: ADMIN_NICK, password: ADMIN_PASS, age: 30, gender: 'other',
      languages: ['ru', 'en'], goals: ['chat'], topics: ['tech'], role: 'admin',
    });
    store.db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', admin.id);
    console.log(`[boot] создан админ: ${ADMIN_NICK} / ${ADMIN_PASS}`);
  }
  // счётчик «Уже N звонков» стартует не с нуля — соцдоказательство на лендинге
  if (store.stats.get('seeded') === null) {
    store.stats.set('seeded', true);
    if (!store.stats.get('totalCalls')) store.stats.set('totalCalls', 12_847);
  }
}
bootstrap();

/* ================= helpers ================= */

const requireUser = (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
  const user = token ? store.users.getByToken(token) : null;
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
};

const requireAdmin = (req, res, next) => {
  if (!['admin', 'moderator'].includes(req.user?.role)) return res.status(403).json({ error: 'forbidden' });
  next();
};

const cleanNick = (n) => String(n || '').trim().replace(/[^\p{L}\p{N}_\-. ]/gu, '').slice(0, 24);

/* ================= публичные эндпоинты ================= */

app.get('/api/health', (_req, res) => res.json({
  ok: true, uptime: process.uptime(), version: require('../package.json').version,
  queue: attach.engine?.size(false) ?? 0, online: attach.sessions?.size ?? 0,
}));

app.get('/api/config', (_req, res) => res.json({
  goals: config.GOALS, topics: config.TOPICS, styles: config.STYLES, languages: config.LANGUAGES,
  ageRanges: config.AGE_RANGES, genders: config.GENDERS, modes: config.MODES,
  reportReasons: config.REPORT_REASONS, ratingTags: config.RATING_TAGS,
  achievements: config.ACHIEVEMENTS, limits: config.LIMITS,
  plans: config.PLANS, v2: config.V2,
  todayTheme: gamify.todaysTheme(), dailyQuests: gamify.todaysQuests(),
}));

/**
 * Поиск пользователя по логину для адресного звонка.
 * Публичный, но урезанный: минимум 2 символа, максимум 8 результатов,
 * префиксное совпадение, скрытые (shadow-ban) не выдаются, плюс ограничение
 * по частоте — чтобы сервис нельзя было использовать как справочник ников.
 */
const searchHits = new Map();
app.get('/api/users/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ items: [] });

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const hits = (searchHits.get(ip) || 0) + 1;
  searchHits.set(ip, hits);
  if (hits > 120) return res.status(429).json({ error: 'too_many_requests', items: [] });

  res.json({ items: store.users.search(q, 8) });
});
setInterval(() => searchHits.clear(), 60_000).unref();

app.get('/api/metrics', (_req, res) => res.json({
  totalCalls: store.stats.get('totalCalls', 0),
  online: attach.sessions?.size || 0,
  inQueue: attach.engine?.size(false) || 0,
  activeCalls: attach.rooms?.activeCallCount() || 0,
  countries: 34, languages: config.LANGUAGES.length,
  avgCallSeconds: attach.computeMetrics().avgCallSeconds,
  dau: store.events.distinctUsers(0),
}));

/* ================= V2: перевод субтитров =================
 * Прокси к LibreTranslate-совместимому API. Ключ живёт на сервере и не светится
 * в браузере. Если TRANSLATE_URL не задан — честно отдаём 503, и клиент
 * показывает «перевод не настроен» вместо молчаливого игнора. */
const TRANSLATE_URL = process.env.TRANSLATE_URL || '';
const TRANSLATE_KEY = process.env.TRANSLATE_KEY || '';

app.get('/api/translate/status', (_req, res) => {
  res.json({ available: !!TRANSLATE_URL, provider: TRANSLATE_URL ? 'configured' : 'none' });
});

app.post('/api/translate', requireUser, async (req, res) => {
  if (!TRANSLATE_URL) return res.status(503).json({ error: 'translate_not_configured' });
  const { q, source = 'auto', target = 'ru' } = req.body || {};
  if (!q || String(q).length > 500) return res.status(400).json({ error: 'bad_input' });
  try {
    const upstream = await fetch(TRANSLATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(TRANSLATE_KEY ? { Authorization: `Bearer ${TRANSLATE_KEY}` } : {}) },
      body: JSON.stringify({ q: String(q), source, target, format: 'text' }),
    });
    if (!upstream.ok) return res.status(502).json({ error: 'upstream_failed' });
    const data = await upstream.json();
    res.json({ translatedText: data.translatedText || q });
  } catch {
    res.status(502).json({ error: 'upstream_unreachable' });
  }
});

app.get('/api/leaderboard', (req, res) => {
  const metric = req.query.metric || 'calls_total';
  res.json({ items: store.users.leaderboard(metric, 10), metric });
});

app.get('/api/theme', (_req, res) => res.json({
  theme: gamify.todaysTheme(), quests: gamify.todaysQuests(),
  question: gamify.randomQuestion('chat', Date.now()),
}));

/* ================= аккаунты ================= */

app.post('/api/auth/register', (req, res) => {
  const { nick, password, age, gender, languages, goals, topics, style, ref } = req.body || {};
  const n = cleanNick(nick);
  if (n.length < 2) return res.status(400).json({ error: 'nick_short' });
  if (String(password || '').length < 4) return res.status(400).json({ error: 'password_short' });
  if (store.users.getByNick(n)) return res.status(409).json({ error: 'nick_taken' });

  const inviter = ref ? findUserByRef(ref) : null;
  const user = store.users.registerWithPassword({
    nick: n, password: String(password), age: +age || null, gender, languages, goals, topics, style,
    invitedBy: inviter?.id || null,
  });
  store.events.log('register', user.id);
  store.users.addCoins(user.id, 20); // приветственный бонус
  if (inviter) gamify.applyReferralRewards(user.id, 'registered');
  res.json({ token: store.users.tokenOf(user.id), user: publicUser(store.users.get(user.id)) });
});

app.post('/api/auth/login', (req, res) => {
  const { nick, password } = req.body || {};
  const user = store.users.getByNick(cleanNick(nick));
  if (!user) {
    // админ по логину из ENV
    if (cleanNick(nick) === ADMIN_NICK && password === ADMIN_PASS) {
      const admin = store.users.getByNick(ADMIN_NICK);
      return res.json({ token: store.users.tokenOf(admin.id), user: publicUser(admin) });
    }
    return res.status(401).json({ error: 'not_found' });
  }
  if (!store.users.checkPassword(user.id, String(password || ''))) return res.status(401).json({ error: 'bad_password' });
  if (user.banned_until > Date.now()) return res.status(403).json({ error: 'banned', until: user.banned_until });
  store.events.log('login', user.id);
  res.json({ token: store.users.tokenOf(user.id), user: publicUser(user) });
});

app.get('/api/me', requireUser, (req, res) => {
  const u = store.users.get(req.user.id);
  res.json({
    user: publicUser(u),
    level: gamify.level(u),
    quests: gamify.questsState(u.id),
    achievements: gamify.achievementsState(u.id),
    friends: store.friends.list(u.id),
    blocked: store.blocks.listFor(u.id),
    history: store.calls.recentForUser(u.id, 20),
    referral: { code: gamify.referralCode(u.id), link: `${baseUrl()}/?ref=${gamify.referralCode(u.id)}` },
    token: store.users.tokenOf(u.id),
  });
});

app.patch('/api/me', requireUser, (req, res) => {
  const u = store.users.update(req.user.id, req.body || {});
  // смена профиля может открыть достижения («Полиглот» за второй язык и т.п.)
  const unlocked = gamify.evaluate(req.user.id);
  res.json({ user: publicUser(store.users.get(req.user.id)), unlocked });
});

app.post('/api/me/coins-to-premium', requireUser, (req, res) => {
  const u = store.users.get(req.user.id);
  const price = 500;
  if (u.coins < price) return res.status(400).json({ error: 'not_enough_coins', need: price - u.coins });
  store.users.addCoins(u.id, -price);
  const fresh = store.users.grantPremium(u.id, gamify.DAY);
  store.events.log('premium_coins', u.id);
  res.json({ user: publicUser(fresh) });
});

/* ================= админка ================= */

app.get('/api/admin/reports', requireUser, requireAdmin, (req, res) => {
  res.json({ items: store.reports.list(req.query.status || 'all'), counts: store.reports.counts() });
});

app.get('/api/admin/users', requireUser, requireAdmin, (req, res) => {
  res.json({ items: store.users.list({ limit: 200, q: req.query.q || '' }) });
});

app.get('/api/admin/metrics', requireUser, requireAdmin, (_req, res) => res.json(attach.computeMetrics()));

app.get('/api/admin/queue', requireUser, requireAdmin, (_req, res) => res.json({
  queue: attach.engine.snapshot(), calls: attach.rooms.activeCalls(),
  sessions: [...attach.sessions.values()].map(s => ({
    id: s.userId, nick: s.nick, role: s.role, state: s.state,
    waitMs: s.state === 'in_queue' ? Date.now() - s.queuedAt : 0, ip: s.ip,
  })),
}));

app.post('/api/admin/reports/:id', requireUser, requireAdmin, (req, res) => {
  const rep = store.reports.resolve(req.params.id, {
    status: req.body.action === 'dismiss' ? 'rejected' : 'resolved',
    action: req.body.action, moderator: req.user.nick,
  });
  res.json({ report: rep });
});

app.post('/api/admin/users/:id/ban', requireUser, requireAdmin, (req, res) => {
  const ms = Number(req.body.ms || 864e5);
  store.users.ban(req.params.id, Date.now() + ms, !!req.body.shadow);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/premium', requireUser, requireAdmin, (req, res) => {
  const u = store.users.grantPremium(req.params.id, Number(req.body.ms || gamify.DAY));
  res.json({ user: publicUser(u) });
});

/* ================= статика ================= */

app.get('/api/public/users/:id', (req, res) => {
  const u = store.users.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  res.json({ user: publicUser(u) });
});

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], index: 'index.html' }));

// SPA fallback: /r/CODE, /admin, /u/nick
app.get(/^\/(r|admin|u|profile|rules|premium)(\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, nick: u.nick, avatarHue: u.avatar_hue, age: u.age, gender: u.gender,
    country: u.country, city: u.city, languages: u.languages, goals: u.goals, topics: u.topics,
    style: u.style, mode: u.mode, bio: u.bio, rating: u.rating, ratingCount: u.rating_count,
    calls: u.calls_total, talkSeconds: u.talk_seconds, coins: u.coins, streak: u.streak,
    bestStreak: u.best_streak, invitedCount: u.invited_count, role: u.role,
    isPremium: u.premium_until > Date.now(), premiumUntil: u.premium_until,
    isBanned: u.banned_until > Date.now(), strikes: u.strikes, reports: u.reports_received,
  };
}

function findUserByRef(code) {
  if (!code) return null;
  const id = 'u_' + String(code).trim();
  const u = store.users.get(id);
  if (u) return u;
  // рефкод = хвост id; ищем перебором по короткой таблице
  const rows = store.db.prepare('SELECT id FROM users').all();
  const hit = rows.find(r => r.id.replace('u_', '').slice(0, 10) === String(code).trim());
  return hit ? store.users.get(hit.id) : null;
}

/* ================= старт ================= */

const { BotPool } = require('./bots');

// Демо-боты живут в headless-браузере на той же машине — подключаются к 127.0.0.1
const botPool = new BotPool({
  baseUrl: PUBLIC_URL || `http://localhost:${PORT}`,
  appUrl: `http://127.0.0.1:${PORT}`,
});

// PUBLIC_URL задан явно — используем его, иначе строим адрес по фактическому хосту
// запроса: так реферальные ссылки и ссылки комнат работают за любым прокси.
const attach = attachSocket(io, { baseUrl: PUBLIC_URL ? () => PUBLIC_URL : baseUrl, botPool });

// Демо-ботов включаем вручную: POST /api/admin/bots {"on":true,"count":1}
app.post('/api/admin/bots', requireUser, requireAdmin, async (req, res) => {
  if (req.body?.on) {
    const n = await botPool.warm(Number(req.body.count) || 1);
    res.json({ ok: true, started: n, ...botPool.status() });
  } else {
    await botPool.shutdown();
    res.json({ ok: true, ...botPool.status() });
  }
});

app.get('/api/admin/bots', requireUser, requireAdmin, (_req, res) => res.json(botPool.status()));

server.listen(PORT, HOST, () => {
  console.log(`\n  Zvonitel.ru готов → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Админка: /admin (логин ${ADMIN_NICK} / ${ADMIN_PASS})`);
  console.log(`  Данные: ${store.DATA_DIR}\n`);
});

process.on('SIGTERM', async () => { attach.shutdown(); await botPool.shutdown(); server.close(() => process.exit(0)); });
process.on('SIGINT', async () => { attach.shutdown(); await botPool.shutdown(); server.close(() => process.exit(0)); });

// Сервис публичный: одиночная ошибка не должна уносить весь процесс.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  store.events.log('uncaught_exception', null, { message: err.message });
});
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
