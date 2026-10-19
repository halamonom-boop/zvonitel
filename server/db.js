'use strict';
/**
 * Слой данных. PostgreSQL-совместимая схема, но на SQLite (better-sqlite3) —
 * чтобы MVP поднимался одной командой без внешних сервисов.
 * Приватность (ТЗ §4.4): видео не храним, только метаданные звонков.
 */
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'zvonitel.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  token         TEXT,
  nick          TEXT NOT NULL,
  pass_hash     TEXT,
  salt          TEXT,
  avatar_hue    INTEGER DEFAULT 200,
  age           INTEGER,
  gender        TEXT,
  country       TEXT,
  city          TEXT,
  languages     TEXT DEFAULT '["ru"]',
  goals         TEXT DEFAULT '["chat"]',
  topics        TEXT DEFAULT '[]',
  style         TEXT,
  mode          TEXT DEFAULT 'classic',
  bio           TEXT DEFAULT '',
  role          TEXT DEFAULT 'user',
  premium_until INTEGER DEFAULT 0,
  coins         INTEGER DEFAULT 0,
  rating_sum    REAL DEFAULT 0,
  rating_count  INTEGER DEFAULT 0,
  calls_total   INTEGER DEFAULT 0,
  talk_seconds  INTEGER DEFAULT 0,
  skip_count    INTEGER DEFAULT 0,
  reports_received INTEGER DEFAULT 0,
  strikes       INTEGER DEFAULT 0,
  banned_until  INTEGER DEFAULT 0,
  shadow_ban    INTEGER DEFAULT 0,
  streak        INTEGER DEFAULT 0,
  best_streak   INTEGER DEFAULT 0,
  last_active_day TEXT,
  invited_by    TEXT,
  invited_count INTEGER DEFAULT 0,
  created_at    INTEGER,
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  a_id TEXT, b_id TEXT,
  started_at INTEGER, ended_at INTEGER, duration_ms INTEGER DEFAULT 0,
  connected INTEGER DEFAULT 0,
  mode TEXT, end_reason TEXT,
  rating_a INTEGER, rating_b INTEGER,
  match_score INTEGER, wait_ms_a INTEGER, wait_ms_b INTEGER
);
CREATE INDEX IF NOT EXISTS idx_calls_a ON calls(a_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_b ON calls(b_id, started_at);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  call_id TEXT,
  reporter_id TEXT,
  target_id TEXT,
  reason TEXT,
  comment TEXT,
  status TEXT DEFAULT 'new',
  action TEXT,
  moderator TEXT,
  created_at INTEGER,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT, blocked_id TEXT, created_at INTEGER,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS friends (
  user_id TEXT, friend_id TEXT, status TEXT DEFAULT 'pending', created_at INTEGER,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS achievements (
  user_id TEXT, ach_id TEXT, unlocked_at INTEGER,
  PRIMARY KEY (user_id, ach_id)
);

CREATE TABLE IF NOT EXISTS quests_progress (
  user_id TEXT, day TEXT, quest_id TEXT, progress INTEGER DEFAULT 0, done INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, day, quest_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT, ts INTEGER, type TEXT, user_id TEXT, meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_day ON events(day, type);

CREATE TABLE IF NOT EXISTS stats (
  key TEXT PRIMARY KEY, value TEXT
);
`);

const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const uid = (p = 'u') => p + '_' + crypto.randomBytes(9).toString('base64url');

/** Начало текущего календарного месяца (локальное время сервера). */
const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };

// Миграция для уже существующих баз: колонка connected нужна для честного учёта квот.
try { db.prepare('ALTER TABLE calls ADD COLUMN connected INTEGER DEFAULT 0').run(); } catch {}

const parseJson = (s, fallback) => { try { return JSON.parse(s) || fallback; } catch { return fallback; } };

const USER_COLUMNS = `id, nick, avatar_hue, age, gender, country, city, languages, goals, topics, style, mode,
  bio, role, premium_until, coins, rating_sum, rating_count, calls_total, talk_seconds, skip_count,
  reports_received, strikes, banned_until, shadow_ban, streak, best_streak, last_active_day,
  invited_by, invited_count, created_at`;

function rowToUser(row) {
  if (!row) return null;
  const u = { ...row };
  u.languages = parseJson(row.languages, ['ru']);
  u.goals = parseJson(row.goals, ['chat']);
  u.topics = parseJson(row.topics, []);
  u.rating = row.rating_count > 0 ? +(row.rating_sum / row.rating_count).toFixed(2) : null;
  u.isPremium = row.premium_until > now();
  u.isBanned = row.banned_until > now();
  return u;
}

const users = {
  create({ nick, age, gender, country, languages, goals, topics, style, invitedBy, role = 'user' }) {
    const id = uid('u');
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare(`INSERT INTO users
      (id, token, nick, avatar_hue, age, gender, country, languages, goals, topics, style, role, created_at, updated_at, invited_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, token, nick, Math.floor(Math.random() * 360), age || null, gender || null, country || null,
        JSON.stringify(languages || ['ru']), JSON.stringify(goals || ['chat']), JSON.stringify(topics || []),
        style || null, role, now(), now(), invitedBy || null);
    if (invitedBy) db.prepare('UPDATE users SET invited_count = invited_count + 1 WHERE id = ?').run(invitedBy);
    return users.get(id);
  },

  get(id) { return rowToUser(db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id)); },
  getByToken(token) { return rowToUser(db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE token = ?`).get(token)); },
  getByNick(nick) { return rowToUser(db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE lower(nick) = lower(?)`).get(nick)); },

  registerWithPassword({ nick, password, ...rest }) {
    const salt = crypto.randomBytes(12).toString('hex');
    const hash = crypto.scryptSync(password, salt, 32).toString('hex');
    const u = users.create({ nick, ...rest });
    db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, u.id);
    return users.get(u.id);
  },

  checkPassword(id, password) {
    const row = db.prepare('SELECT pass_hash, salt FROM users WHERE id = ?').get(id);
    if (!row || !row.pass_hash) return false;
    const hash = crypto.scryptSync(password, row.salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(row.pass_hash));
  },

  tokenOf(id) { return db.prepare('SELECT token FROM users WHERE id = ?').get(id)?.token || null; },

  update(id, patch) {
    const allowed = ['nick', 'age', 'gender', 'country', 'city', 'languages', 'goals', 'topics', 'style', 'mode', 'bio', 'avatar_hue'];
    const sets = []; const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?`);
      vals.push(Array.isArray(v) ? JSON.stringify(v) : v);
    }
    if (!sets.length) return users.get(id);
    sets.push('updated_at = ?'); vals.push(now()); vals.push(id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return users.get(id);
  },

  grantPremium(id, ms) {
    const cur = db.prepare('SELECT premium_until FROM users WHERE id = ?').get(id);
    const base = Math.max(now(), cur?.premium_until || 0);
    db.prepare('UPDATE users SET premium_until = ?, role = ? WHERE id = ?').run(base + ms, 'premium', id);
    return users.get(id);
  },

  addCoins(id, delta) { db.prepare('UPDATE users SET coins = MAX(0, coins + ?) WHERE id = ?').run(delta, id); },

  addRating(id, stars) {
    db.prepare('UPDATE users SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE id = ?').run(stars, id);
  },

  addStats(id, { calls = 0, seconds = 0, skips = 0, reports = 0, strikes = 0 } = {}) {
    db.prepare(`UPDATE users SET calls_total = calls_total + ?, talk_seconds = talk_seconds + ?,
      skip_count = skip_count + ?, reports_received = reports_received + ?, strikes = strikes + ?, updated_at = ? WHERE id = ?`)
      .run(calls, seconds, skips, reports, strikes, now(), id);
  },

  ban(id, untilTs, shadow = false) {
    db.prepare('UPDATE users SET banned_until = ?, shadow_ban = ? WHERE id = ?').run(untilTs, shadow ? 1 : 0, id);
  },

  touchActivity(id) {
    const u = db.prepare('SELECT last_active_day, streak, best_streak FROM users WHERE id = ?').get(id);
    if (!u) return 0;
    const t = today();
    if (u.last_active_day === t) return u.streak;
    const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const streak = u.last_active_day === y ? (u.streak || 0) + 1 : 1;
    db.prepare('UPDATE users SET last_active_day = ?, streak = ?, best_streak = MAX(best_streak, ?) WHERE id = ?')
      .run(t, streak, streak, id);
    return streak;
  },

  list({ limit = 100, q = '' } = {}) {
    const rows = q
      ? db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE nick LIKE ? ORDER BY created_at DESC LIMIT ?`).all(`%${q}%`, limit)
      : db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at DESC LIMIT ?`).all(limit);
    return rows.map(rowToUser);
  },

  /**
   * Поиск по логину для звонка по нику.
   * Только префиксное совпадение и не больше `limit` — чтобы сервис нельзя
   * было использовать как полный справочник пользователей.
   */
  search(q, limit = 8) {
    const s = String(q || '').trim().toLowerCase();
    if (s.length < 2) return [];
    const rows = db.prepare(`SELECT id, nick, avatar_hue, premium_until, role FROM users
      WHERE lower(nick) LIKE ? AND shadow_ban = 0
      ORDER BY (lower(nick) = ?) DESC, length(nick) ASC, nick ASC LIMIT ?`)
      .all(s + '%', s, limit);
    const t = now();
    return rows.map(r => ({
      id: r.id, nick: r.nick, avatarHue: r.avatar_hue,
      isPremium: r.premium_until > t || r.role === 'premium',
    }));
  },

  leaderboard(metric = 'calls_total', limit = 10) {
    const col = ['calls_total', 'talk_seconds', 'streak', 'rating_sum'].includes(metric) ? metric : 'calls_total';
    return db.prepare(`SELECT id, nick, avatar_hue, ${col} AS value, rating_count, streak, calls_total
      FROM users WHERE shadow_ban = 0 ORDER BY ${col} DESC, created_at ASC LIMIT ?`).all(limit);
  },
};

const calls = {
  create({ aId, bId, mode, matchScore, waitMsA, waitMsB }) {
    const id = uid('c');
    db.prepare(`INSERT INTO calls (id, a_id, b_id, started_at, mode, match_score, wait_ms_a, wait_ms_b)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, aId, bId, now(), mode, matchScore, waitMsA, waitMsB);
    return id;
  },
  finish(id, { durationMs, endReason, ratingA = null, ratingB = null }) {
    db.prepare(`UPDATE calls SET ended_at = ?, duration_ms = ?, end_reason = ?, rating_a = ?, rating_b = ? WHERE id = ?`)
      .run(now(), durationMs, endReason, ratingA, ratingB, id);
  },
  get(id) { return db.prepare('SELECT * FROM calls WHERE id = ?').get(id); },
  recentForUser(id, limit = 20) {
    return db.prepare(`SELECT * FROM calls WHERE a_id = ? OR b_id = ? ORDER BY started_at DESC LIMIT ?`).all(id, id, limit);
  },
  countAll() { return db.prepare('SELECT COUNT(*) AS n FROM calls').get().n; },
  /**
   * Отмечает, что P2P-соединение реально установилось.
   * Только такие звонки расходуют квоту — неудачное подключение бесплатно.
   */
  markConnected(id) {
    db.prepare('UPDATE calls SET connected = 1 WHERE id = ?').run(id);
  },
  /** Сколько СОСТОЯВШИХСЯ звонков у пользователя с момента `sinceTs`. */
  countConnectedSince(userId, sinceTs) {
    return db.prepare(`SELECT COUNT(*) AS n FROM calls
      WHERE (a_id = ? OR b_id = ?) AND connected = 1 AND started_at >= ?`)
      .get(userId, userId, sinceTs).n;
  },
};

const reports = {
  create({ callId, reporterId, targetId, reason, comment }) {
    const id = uid('r');
    db.prepare(`INSERT INTO reports (id, call_id, reporter_id, target_id, reason, comment, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(id, callId, reporterId, targetId, reason, comment || null, now());
    return db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  },
  list(status = 'all', limit = 200) {
    const rows = status === 'all'
      ? db.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
    return rows;
  },
  resolve(id, { status, action, moderator }) {
    db.prepare('UPDATE reports SET status = ?, action = ?, moderator = ?, resolved_at = ? WHERE id = ?')
      .run(status, action || null, moderator || 'system', now(), id);
    return db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  },
  counts() {
    return db.prepare('SELECT status, COUNT(*) AS n FROM reports GROUP BY status').all()
      .reduce((acc, r) => (acc[r.status] = r.n, acc), {});
  },
};

const blocks = {
  add(blockerId, blockedId) {
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)').run(blockerId, blockedId, now());
  },
  remove(blockerId, blockedId) { db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId); },
  listFor(id) { return db.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?').all(id).map(r => r.blocked_id); },
  /** взаимная или односторонняя блокировка — не соединяем (ТЗ §1.9). */
  anyBetween(a, b) {
    return !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)')
      .get(a, b, b, a);
  },
};

const friends = {
  request(from, to) {
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, status, created_at) VALUES (?,?,?,?)')
      .run(from, to, 'pending', now());
    const back = db.prepare('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?').get(to, from);
    if (back && back.status === 'pending') {
      db.prepare('UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?').run('accepted', to, from);
      db.prepare('UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?').run('accepted', from, to);
      return 'accepted';
    }
    return 'pending';
  },
  accept(user, friend) {
    db.prepare('UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?').run('accepted', friend, user);
    db.prepare('UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?').run('accepted', user, friend);
  },
  decline(user, friend) { db.prepare('DELETE FROM friends WHERE user_id IN (?,?) AND friend_id IN (?,?)').run(user, friend, user, friend); },
  list(id) {
    return db.prepare(`SELECT f.friend_id, f.status, u.nick, u.avatar_hue, u.rating_count, u.rating_sum, u.calls_total
      FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY f.created_at DESC`).all(id);
  },
  countAccepted(id) { return db.prepare(`SELECT COUNT(*) AS n FROM friends WHERE user_id = ? AND status = 'accepted'`).get(id).n; },
};

const achievementsDb = {
  unlock(userId, achId) {
    const r = db.prepare('INSERT OR IGNORE INTO achievements (user_id, ach_id, unlocked_at) VALUES (?,?,?)')
      .run(userId, achId, now());
    return r.changes > 0;
  },
  list(userId) { return db.prepare('SELECT ach_id, unlocked_at FROM achievements WHERE user_id = ?').all(userId); },
  top(limit = 10) {
    return db.prepare('SELECT u.nick, u.avatar_hue, COUNT(*) AS n FROM achievements a JOIN users u ON u.id = a.user_id GROUP BY a.user_id ORDER BY n DESC LIMIT ?').all(limit);
  },
};

const questsDb = {
  get(userId, day) { return db.prepare('SELECT * FROM quests_progress WHERE user_id = ? AND day = ?').all(userId, day); },
  bump(userId, day, questId, delta, target) {
    db.prepare(`INSERT INTO quests_progress (user_id, day, quest_id, progress, done) VALUES (?,?,?,?,0)
      ON CONFLICT(user_id, day, quest_id) DO UPDATE SET progress = progress + ?`)
      .run(userId, day, questId, 0, delta);
    const row = db.prepare('SELECT * FROM quests_progress WHERE user_id = ? AND day = ? AND quest_id = ?').get(userId, day, questId);
    const done = row && row.progress >= target ? 1 : 0;
    if (done && !row.done) db.prepare('UPDATE quests_progress SET done = 1 WHERE user_id = ? AND day = ? AND quest_id = ?').run(userId, day, questId);
    return { progress: row?.progress || 0, done: !!done, justCompleted: !!done && !row.done };
  },
};

const events = {
  log(type, userId, meta) {
    db.prepare('INSERT INTO events (day, ts, type, user_id, meta) VALUES (?,?,?,?,?)')
      .run(today(), now(), type, userId || null, meta ? JSON.stringify(meta) : null);
  },
  byDay(dayOffset = 0) {
    const day = new Date(Date.now() - dayOffset * 864e5).toISOString().slice(0, 10);
    return db.prepare('SELECT type, COUNT(*) AS n FROM events WHERE day = ? GROUP BY type').all(day)
      .reduce((acc, r) => (acc[r.type] = r.n, acc), {});
  },
  distinctUsers(dayOffset = 0) {
    const day = new Date(Date.now() - dayOffset * 864e5).toISOString().slice(0, 10);
    return db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE day = ? AND user_id IS NOT NULL').get(day).n;
  },
};

const statsKv = {
  get(key, fallback = null) {
    const r = db.prepare('SELECT value FROM stats WHERE key = ?').get(key);
    return r ? JSON.parse(r.value) : fallback;
  },
  set(key, value) {
    db.prepare('INSERT INTO stats (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  },
  inc(key, delta = 1) { statsKv.set(key, (statsKv.get(key, 0) || 0) + delta); },
};

module.exports = {
  db, now, today, uid, monthStart, users, calls, reports, blocks, friends,
  achievements: achievementsDb, quests: questsDb, events, stats: statsKv,
  DATA_DIR,
};
