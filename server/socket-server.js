'use strict';
/**
 * Сигналинг + очередь + матчинг + модерация (Socket.IO).
 * WebRTC-медиа идёт напрямую P2P (PeerConnection), сервер передаёт только SDP/ICE.
 */
const crypto = require('crypto');
const store = require('./db');
const config = require('./config');
const gamify = require('./gamify');
const automod = require('./automod');
const { MatchingEngine } = require('./matching');
const { RoomManager } = require('./rooms');

const HOUR = 36e5;
const DAY = 864e5;
const CONNECTION_TIMEOUT_MS = 25_000;

/** Приводит конфиг ICE-серверов к формату RTCIceServer ({urls, username, credential}). */
function normalizeIce(raw) {
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    const list = (Array.isArray(parsed) ? parsed : []).map(item => {
      if (typeof item === 'string') return { urls: item };
      if (item && typeof item === 'object' && item.urls) {
        const out = { urls: item.urls };
        if (item.username) out.username = item.username;
        if (item.credential) out.credential = item.credential;
        return out;
      }
      return null;
    }).filter(Boolean);
    return list.length ? list : fallback;
  } catch {
    return fallback;
  }
}

module.exports = function attachSocket(io, { baseUrl, botPool }) {
  // baseUrl может быть строкой (задан PUBLIC_URL) или функцией — тогда адрес берётся
  // из фактического хоста запроса и работает за любым прокси/предпросмотром.
  const resolveBase = typeof baseUrl === 'function' ? baseUrl : () => baseUrl;

  const engine = new MatchingEngine();
  const rooms = new RoomManager();

  /** socketId -> session */
  const sessions = new Map();
  /** guestId -> {skips:[ts], attempts:[ts], captchaOk:boolean, ip} */
  const guestLedger = new Map();
  /** userId -> Set<socketId> */
  const userSockets = new Map();

  const nowTs = () => Date.now();

  /* ================= утилиты ================= */

  const pub = (u) => u && ({
    id: u.id, nick: u.nick, avatarHue: u.avatar_hue, age: u.age, gender: u.gender,
    country: u.country, city: u.city, languages: u.languages, goals: u.goals, topics: u.topics,
    style: u.style, mode: u.mode, bio: u.bio, rating: u.rating, ratingCount: u.rating_count,
    calls: u.calls_total, talkSeconds: u.talk_seconds, coins: u.coins, streak: u.streak,
    bestStreak: u.best_streak, invitedCount: u.invited_count, role: u.role,
    isPremium: u.premium_until > nowTs(), premiumUntil: u.premium_until,
    isBanned: u.banned_until > nowTs(), bannedUntil: u.banned_until,
  });

  /* ================= квоты на звонки =================
     Монетизация по трём уровням:
       гость              — 1 звонок total   (книга гостя в памяти, ключ = guestId)
       зарегистрированный — 100 звонков в месяц (считаем по таблице calls)
       премиум / бот      — безлимит
     Расходуется только СОСТОЯВШИЙСЯ звонок: P2P реально соединился.
     Неудачное подключение или мгновенный скип квоту не сжигают. */

  const isRegistered = (session) => !!session.userId && String(session.userId).startsWith('u_');

  /** Начало следующего календарного месяца — момент сброса месячной квоты. */
  function nextMonthTs() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  }

  /** Сколько звонков уже израсходовано в текущем периоде. */
  function quotaUsed(session) {
    if (!isRegistered(session)) return ledgerFor(session.guestId, session.ip).calls || 0;
    return store.calls.countConnectedSince(session.userId, store.monthStart());
  }

  /** Полное состояние квоты: уходит на клиент, чтобы он показывал остаток. */
  function quotaState(session) {
    const q = config.QUOTAS[session.role] || config.QUOTAS.guest;
    const unlimited = q.calls === Infinity;
    const used = quotaUsed(session);
    return {
      role: session.role,
      period: q.period,
      label: q.ru,
      calls: unlimited ? null : q.calls,
      used,
      left: unlimited ? null : Math.max(0, q.calls - used),
      unlimited,
      resetAt: q.period === 'month' ? nextMonthTs() : null,
    };
  }

  const hasQuota = (session) => {
    const s = quotaState(session);
    return s.unlimited || s.left > 0;
  };

  /** Списывает один звонок у гостя; у зарегистрированных учёт идёт по таблице calls. */
  function consumeQuota(session) {
    if (!isRegistered(session)) {
      const l = ledgerFor(session.guestId, session.ip);
      l.calls = (l.calls || 0) + 1;
    }
  }

  function toUser(session, socket) {
    return session.user ? socket.to(session.user.id) : null;
  }

  function sendToUser(userId, event, payload) {
    const set = userSockets.get(userId);
    if (set) for (const sid of set) io.to(sid).emit(event, payload);
  }

  function entryFromSession(session) {
    const s = session;
    return {
      id: s.userId,
      socketId: s.socketId,
      nick: s.nick,
      isPremium: s.isPremium,
      role: s.role,
      rating: s.user?.rating ?? null,
      shadow: !!s.shadow,
      bot: !!s.isBot,
      mode: s.mode || 'classic',
      strict: !!s.strict,
      profile: {
        nick: s.nick, age: s.profile.age, gender: s.profile.gender,
        languages: s.profile.languages, goals: s.profile.goals,
        topics: s.profile.topics, style: s.profile.style,
      },
      filters: s.filters,
      joinedAt: s.queuedAt,
    };
  }

  function defaultProfile() {
    return { age: null, gender: null, languages: ['ru'], goals: ['chat'], topics: [], style: null };
  }

  function defaultFilters() {
    return { language: 'ru', goal: 'any', gender: 'any', age: 'any', topics: [], style: 'any', any: false };
  }

  /* ================= статистика очереди ================= */

  function queueStats() {
    return {
      online: sessions.size,
      queue: engine.size(false),
      calls: rooms.activeCallCount(),
      totalCalls: store.stats.get('totalCalls', 0),
      queueShadow: engine.size(true),
    };
  }

  function broadcastStats() { io.emit('stats', queueStats()); }

  /* ================= лимиты гостей (антибот, ТЗ §4.4) ================= */

  function ledgerFor(guestId, ip) {
    let l = guestLedger.get(guestId);
    if (!l) { l = { skips: [], attempts: [], captchaOk: false, ip }; guestLedger.set(guestId, l); }
    return l;
  }

  function makeCaptcha() {
    const a = 1 + crypto.randomInt(9), b = 1 + crypto.randomInt(9);
    const id = 'cap_' + crypto.randomBytes(6).toString('hex');
    return { id, question: `${a} + ${b}`, answer: a + b };
  }
  const captchaStore = new Map();

  /* ================= жизненный цикл звонка ================= */

  function otherOf(call, userId) { return call.a === userId ? call.b : call.a; }
  function socketOf(userId) {
    const set = userSockets.get(userId);
    return set && set.size ? [...set][0] : null;
  }

  /**
   * Жёсткая проверка квоты для обоих участников.
   * Возвращает массив сессий, которым не хватает квоты (пустой = всё можно).
   */
  function quotaBlocked(sessions) {
    return sessions.filter(s => !hasQuota(s));
  }

  function startCall(aSession, bSession, meta) {
    // Защита последнего рубежа: без квоты звонок не начинается ни при каком сценарии —
    // ни через матчинг, ни через приватную комнату, ни через звонок по логину.
    const blocked = quotaBlocked([aSession, bSession]);
    if (blocked.length) {
      for (const s of blocked) io.to(s.socketId).emit('quota:exceeded', { quota: quotaState(s) });
      return null;
    }

    const reg = rooms.registerCall({
      id: 'call_' + crypto.randomBytes(8).toString('hex'),
      a: aSession.userId, b: bSession.userId,
      aNick: aSession.nick, bNick: bSession.nick,
      mode: meta.mode, score: meta.score, state: 'connecting',
      room: meta.room || null, mutualTopics: meta.mutualTopics || [],
    });
    const call = reg.call;
    const callId = reg.id;
    call.dbId = store.calls.create({
      aId: aSession.userId, bId: bSession.userId, mode: meta.mode,
      matchScore: meta.score ?? 0, waitMsA: meta.waitMsA ?? 0, waitMsB: meta.waitMsB ?? 0,
    });

    aSession.call = { id: callId, peer: bSession.userId, peerNick: bSession.nick, since: nowTs(), connected: false };
    bSession.call = { id: callId, peer: aSession.userId, peerNick: aSession.nick, since: nowTs(), connected: false };
    aSession.lastPeer = bSession.userId;
    bSession.lastPeer = aSession.userId;
    aSession.state = bSession.state = 'in_call';
    automod.clearWindow(aSession.userId); automod.clearWindow(bSession.userId);

    const payloadFor = (self, peer) => ({
      callId,
      self: { id: self.userId, nick: self.nick, premium: self.isPremium },
      peer: { id: peer.userId, nick: peer.nick, premium: peer.isPremium, avatarHue: peer.avatarHue || 200 },
      mode: meta.mode,
      score: meta.score,
      mutualTopics: meta.mutualTopics || [],
      initiator: self.userId === aSession.userId,
      question: gamify.randomQuestion(self.mode || 'chat', nowTs()),
      room: meta.room || null,
      direct: !!meta.direct,
      startedAt: nowTs(),
      blindRevealMs: meta.mode === 'blind' ? config.BLIND_REVEAL_MS : 0,
    });

    io.to(aSession.socketId).emit('matched', payloadFor(aSession, bSession));
    io.to(bSession.socketId).emit('matched', payloadFor(bSession, aSession));
    store.events.log('match', aSession.userId, { callId, score: meta.score });

    // watchdog: если P2P не поднялся — возвращаем обоих в очередь
    call.watchdog = setTimeout(() => {
      const c = rooms.getCall(callId);
      if (!c || c.state === 'connected') return;
      finishCall(callId, 'timeout', { silentRating: true });
    }, CONNECTION_TIMEOUT_MS);

    return call;
  }

  function finishCall(callId, reason, opts = {}) {
    const call = rooms.getCall(callId);
    if (!call) return null;
    clearTimeout(call.watchdog);
    clearTimeout(call.reconnectTimer);
    const ended = rooms.endCall(callId, { state: 'ended', endReason: reason });

    // запись всегда прекращается вместе со звонком, даже если её «забыли» остановить
    if (ended.recState === 'recording') {
      for (const uid of [ended.a, ended.b]) {
        const s = socketOf(uid);
        if (s) io.to(s).emit('rec:stop', { callId, stoppedAt: Date.now(), auto: true });
      }
      store.events.log('recording_stop', ended.a, { callId, auto: true });
    }

    const durationMs = ended.durationMs || 0;
    store.calls.finish(ended.dbId, { durationMs, endReason: reason });

    for (const uid of [ended.a, ended.b]) {
      const s = sessions.get(socketOf(uid));
      if (s) { s.call = null; s.state = s.user ? 'ready' : 'idle'; }
      automod.clearWindow(uid);
    }

    const counted = durationMs >= 5_000; // «звонок состоялся», если говорили хотя бы 5 секунд
    if (counted) {
      store.stats.inc('totalCalls');
      store.stats.inc('totalTalkMs', durationMs);
      for (const uid of [ended.a, ended.b]) {
        if (!uid.startsWith('u_')) continue;
        const u = store.users.get(uid);
        if (!u) continue;
        store.users.addStats(uid, { calls: 1, seconds: Math.round(durationMs / 1000) });
        store.users.touchActivity(uid);
        gamify.bumpQuest(uid, 'call_1'); gamify.bumpQuest(uid, 'call_3');
        gamify.bumpQuest(uid, 'talk_10', Math.floor(durationMs / 60000));
        const fresh = store.users.get(uid);
        // пересчёт достижений именно по факту завершённого звонка (ТЗ §4.6)
        const nightCalls = store.db.prepare(
          `SELECT COUNT(*) AS n FROM calls WHERE (a_id = ? OR b_id = ?)
           AND CAST(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) < 5`).get(uid, uid).n;
        const unlocked = gamify.evaluate(uid, { nightCalls });
        const reward = gamify.applyReferralRewards(uid, 'calls3');
        const s = sessions.get(socketOf(uid));
        if (s) {
          s.profile.streak = fresh.streak;
          io.to(s.socketId).emit('call:ended', {
            callId, durationMs, endReason: reason,
            peer: { id: otherOf(ended, uid), nick: otherOf(ended, uid) === ended.a ? ended.aNick : ended.bNick },
            level: gamify.level(fresh),
            quests: gamify.questsState(uid),
            achievements: gamify.achievementsState(uid),
            unlocked, referralReward: reward, coins: fresh.coins,
            quota: quotaState(s),
          });
        }
      }
      store.events.log('call_completed', ended.a, { durationMs });
    } else {
      for (const uid of [ended.a, ended.b]) {
        const s = sessions.get(socketOf(uid));
        if (s) io.to(s.socketId).emit('call:ended', { callId, durationMs, endReason: reason, tooShort: true, quota: quotaState(s) });
      }
    }

    if (reason === 'skip') store.events.log('skip', ended.a);

    // демо-бот освобождается и готов к следующему звонку
    if (botPool) {
      for (const uid of [ended.a, ended.b]) botPool.releaseByUser(uid).catch(() => {});
    }

    // ТЗ §3.6 / §5: после пропуска, таймаута коннекта и обрыва связи — оба сразу обратно в очередь.
    // 'hangup' сюда не входит: человек завершил разговор осознанно и сейчас оценивает собеседника.
    const AUTO_REQUEUE = new Set(['skip', 'timeout', 'disconnect']);
    if (AUTO_REQUEUE.has(reason)) {
      for (const uid of [ended.a, ended.b]) {
        const sock = socketOf(uid);
        const s = sock && sessions.get(sock);
        if (s && s.state !== 'banned') requeue(s, 'after_' + reason);
      }
    }

    broadcastStats();
    return ended;
  }

  function requeue(session, reason) {
    if (!session || session.state === 'banned') return;
    session.queuedAt = nowTs();
    session.state = 'in_queue';
    engine.enqueue(entryFromSession(session));
    io.to(session.socketId).emit('queue:joined', { waitMs: 0, reason, stats: queueStats() });
  }

  /* ================= цикл матчинга ================= */

  engine.onMatch((pair) => {
    const aSession = sessions.get(pair.a.socketId);
    const bSession = sessions.get(pair.b.socketId);
    if (!aSession || !bSession) return;

    // Квоту проверяем ДО того, как пара считается состоявшейся: тот, кому
    // квоты хватает, возвращается в очередь, а не «повисает» без собеседника.
    const blocked = quotaBlocked([aSession, bSession]);
    if (blocked.length) {
      const blockedIds = new Set(blocked.map(s => s.userId));
      for (const s of [aSession, bSession]) {
        if (blockedIds.has(s.userId)) { engine.dequeue(s.userId); continue; }
        requeue(s, 'peer_quota');
      }
      return;
    }

    startCall(aSession, bSession, {
      mode: pair.a.mode === pair.b.mode ? pair.a.mode : 'classic',
      score: pair.mutual ? pair.mutual.score : pair.score,
      mutualTopics: pair.mutual?.mutualTopics || [],
      waitMsA: nowTs() - pair.a.joinedAt,
      waitMsB: nowTs() - pair.b.joinedAt,
    });
  });

  const matchTimer = setInterval(() => {
    try { engine.tick(); } catch (e) { console.error('[tick]', e); }
  }, config.TICK_MS);

  const statsTimer = setInterval(broadcastStats, 3000);

  // проверка «ждёт дольше 30 секунд — предложить расширить фильтры»
  const relaxTimer = setInterval(() => {
    const t = nowTs();
    for (const s of sessions.values()) {
      if (s.state !== 'in_queue' || s.relaxOffered) continue;
      if (t - s.queuedAt >= config.RELAX_PROMPT_AFTER_MS) {
        s.relaxOffered = true;
        const entry = engine.get(s.userId);
        io.to(s.socketId).emit('queue:relax', {
          waitedMs: t - s.queuedAt,
          advice: entry ? engine.relaxationAdvice(entry) : [],
        });
      }
    }
  }, 5000);

  /* ================= подключение ================= */

  io.on('connection', (socket) => {
    /**
     * Обёртка над socket.on: исключение в обработчике не должно ронять весь сервер
     * (иначе один битый клиент обрушит сервис всем).
     */
    const on = (event, handler) => socket.on(event, (...args) => {
      const last = args[args.length - 1];
      const ack = typeof last === 'function' ? last : null;
      try {
        const out = handler(...args);
        if (out && typeof out.catch === 'function') out.catch(e => handleError(event, e, ack));
      } catch (e) { handleError(event, e, ack); }
    });

    function handleError(event, err, ack) {
      console.error(`[socket:${event}]`, err);
      try { ack?.({ ok: false, error: 'server_error' }); } catch {}
      try { socket.emit('toast', { type: 'error', text: 'Внутренняя ошибка сервера. Попробуйте ещё раз.' }); } catch {}
    }

    const auth = socket.handshake.auth || {};
    const ip = (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').toString().split(',')[0].trim();
    const session = {
      socketId: socket.id, ip, userId: null, user: null, token: auth.token || null,
      nick: auth.nick || `Гость-${crypto.randomInt(1000, 9999)}`,
      state: 'idle', profile: defaultProfile(), filters: defaultFilters(),
      strict: false, mode: 'classic', call: null, room: null,
      queuedAt: 0, relaxOffered: false, isPremium: false, role: 'guest',
      avatarHue: crypto.randomInt(0, 360), guestId: auth.guestId || 'g_' + crypto.randomBytes(6).toString('hex'),
      connectedAt: nowTs(),
    };
    sessions.set(socket.id, session);

    // авторизация по токену
    if (session.token) {
      const u = store.users.getByToken(session.token);
      if (u) {
        session.user = u; session.userId = u.id; session.nick = u.nick;
        session.isPremium = u.premium_until > nowTs();
        session.role = u.role === 'premium' && session.isPremium ? 'premium' : (u.role || 'user');
        session.shadow = !!u.shadow_ban;
        session.avatarHue = u.avatar_hue;
        session.profile = { age: u.age, gender: u.gender, languages: u.languages, goals: u.goals, topics: u.topics, style: u.style };
        if (u.mode) session.mode = u.mode;
        store.events.log('login', u.id);
        if (u.banned_until > nowTs()) {
          session.state = 'banned';
          socket.emit('banned', { until: u.banned_until, reason: 'Автоматическая блокировка за нарушения правил' });
        }
      }
    }
    if (!session.userId) {
      // гость: виртуальный id для матчинга и кулдаунов
      session.userId = 'g_' + crypto.randomBytes(8).toString('hex');
      session.role = 'guest';
    }

    // Адресация по userId нужна всем — и гостям, и ботам: иначе сигналинг их не находит.
    if (!userSockets.has(session.userId)) userSockets.set(session.userId, new Set());
    userSockets.get(session.userId).add(socket.id);

    // Демо-бот: отдельная роль, в общий пул матчинга не попадает (зовут адресно)
    if (typeof session.token === 'string' && session.token.startsWith('bot_')) {
      session.isBot = true;
      session.role = 'bot';
      session.nick = auth.nick || 'Демо-бот';
      session.profile = { age: 25, gender: 'other', languages: ['ru', 'en'], goals: ['chat', 'topic'], topics: ['movies', 'music', 'tech', 'travel'], style: 'fun' };
      botPool?.attach?.(session.nick, session);
    }

    socket.emit('welcome', {
      socketId: socket.id,
      guestId: session.guestId,
      user: pub(session.user),
      role: session.role,
      nick: session.nick,
      limits: config.LIMITS[session.role] || config.LIMITS.guest,
      quota: quotaState(session),
      streak: session.user?.streak || 0,
      quests: session.user ? gamify.questsState(session.user.id) : null,
      achievements: session.user ? gamify.achievementsState(session.user.id) : null,
      level: session.user ? gamify.level(session.user) : null,
      referral: session.user ? { code: gamify.referralCode(session.user.id), link: `${resolveBase()}/?ref=${gamify.referralCode(session.user.id)}` } : null,
      stats: queueStats(),
      bots: botPool ? botPool.status() : { available: false, total: 0, idle: 0, names: [] },
      todayTheme: gamify.todaysTheme(),
      dailyQuests: gamify.todaysQuests(),
      config: {
        goals: config.GOALS, topics: config.TOPICS, styles: config.STYLES, languages: config.LANGUAGES,
        ageRanges: config.AGE_RANGES, genders: config.GENDERS, modes: config.MODES,
        reportReasons: config.REPORT_REASONS, ratingTags: config.RATING_TAGS, achievements: config.ACHIEVEMENTS,
        v2: config.V2, plans: config.PLANS,
        // RTCConfiguration требует объекты {urls}, поэтому нормализуем строки из ENV.
        // Пример: ICE_SERVERS='["stun:stun.l.google.com:19302",{"urls":"turn:turn.example.com","username":"u","credential":"p"}]'
        iceServers: normalizeIce(process.env.ICE_SERVERS),
        relaxAfterMs: config.RELAX_PROMPT_AFTER_MS,
      },
    });
    broadcastStats();

    /* ---------- профиль и фильтры ---------- */

    on('profile:set', (data = {}, ack) => {
      const patch = {};
      if (typeof data.nick === 'string' && data.nick.trim().length >= 2) patch.nick = data.nick.trim().slice(0, 24);
      if (Number.isFinite(+data.age)) patch.age = Math.min(99, Math.max(18, +data.age));
      if (data.gender) patch.gender = data.gender;
      if (Array.isArray(data.languages)) patch.languages = data.languages.slice(0, 4);
      if (Array.isArray(data.goals)) patch.goals = data.goals.slice(0, 8);
      if (Array.isArray(data.topics)) patch.topics = data.topics.slice(0, 14);
      if (data.style) patch.style = data.style;
      if (data.mode) patch.mode = data.mode;
      if (typeof data.bio === 'string') patch.bio = data.bio.slice(0, 160);

      if (session.user) {
        const u = store.users.update(session.user.id, patch);
        session.user = u; session.nick = u.nick;
        session.profile = { age: u.age, gender: u.gender, languages: u.languages, goals: u.goals, topics: u.topics, style: u.style };
        if (u.mode) session.mode = u.mode;
      } else {
        if (patch.nick) session.nick = patch.nick;
        Object.assign(session.profile, {
          age: patch.age ?? session.profile.age,
          gender: patch.gender ?? session.profile.gender,
          languages: patch.languages ?? session.profile.languages,
          goals: patch.goals ?? session.profile.goals,
          topics: patch.topics ?? session.profile.topics,
          style: patch.style ?? session.profile.style,
        });
        if (patch.mode) session.mode = patch.mode;
      }
      ack?.({ ok: true, nick: session.nick, profile: session.profile, mode: session.mode });
    });

    /* ---------- капча для гостей ---------- */

    on('captcha:get', (_d, ack) => {
      const cap = makeCaptcha();
      captchaStore.set(cap.id, cap);
      setTimeout(() => captchaStore.delete(cap.id), 5 * 60_000);
      ack?.({ id: cap.id, question: cap.question });
    });

    function captchaGate(ok) {
      if (session.role !== 'guest') return true;
      const l = ledgerFor(session.guestId, session.ip);
      if (l.captchaOk) return true;
      if (!ok) { socket.emit('captcha:required', {}); return false; }
      return true;
    }

    on('captcha:solve', ({ id, answer } = {}, ack) => {
      const cap = captchaStore.get(id);
      const ok = !!cap && Number(answer) === cap.answer;
      if (ok) {
        ledgerFor(session.guestId, session.ip).captchaOk = true;
        captchaStore.delete(id);
      }
      ack?.({ ok });
    });

    /* ---------- очередь ---------- */

    on('queue:join', (data = {}, ack) => {
      if (session.state === 'banned') { ack?.({ ok: false, error: 'banned' }); return; }
      if (!captchaGate(data.captchaSolved)) { ack?.({ ok: false, error: 'captcha' }); return; }

      // квота на звонки: гость 1, пользователь 100/мес, премиум — безлимит.
      // Проверяем до постановки в очередь, чтобы человек не ждал зря.
      if (!hasQuota(session)) { ack?.({ ok: false, error: 'quota', quota: quotaState(session) }); return; }

      // лимит попыток для гостей (антибот)
      const l = ledgerFor(session.guestId, session.ip);
      if (session.role === 'guest') {
        l.attempts = l.attempts.filter(t => nowTs() - t < HOUR);
        if (l.attempts.length >= 40) { ack?.({ ok: false, error: 'ratelimit' }); return; }
        l.attempts.push(nowTs());
      }

      const role = session.role;
      const limits = config.LIMITS[role] || config.LIMITS.guest;
      const f = data.filters || {};

      if (!limits.filters) {
        // гость: фильтров нет — только язык (ТЗ §2)
        session.filters = { ...defaultFilters(), language: f.language || 'ru', any: true };
        session.strict = false;
      } else {
        session.filters = {
          language: f.language || 'any',
          goal: f.goal || 'any',
          gender: f.gender || 'any',
          age: f.age || 'any',
          topics: Array.isArray(f.topics) ? f.topics.slice(0, 14) : [],
          style: f.style || 'any',
          any: !!f.any,
        };
        session.strict = !!data.strict;
        // премиум-фильтры (гео, точный возраст) — только для premium
        if (!limits.premiumFeatures) { delete session.filters.country; delete session.filters.city; }
      }
      if (data.mode && config.MODES[data.mode]) session.mode = data.mode;
      if (session.user) store.users.update(session.user.id, { mode: session.mode });

      session.queuedAt = nowTs();
      session.relaxOffered = false;
      session.state = 'in_queue';
      engine.enqueue(entryFromSession(session));
      store.events.log('queue_join', session.userId, { filters: session.filters, mode: session.mode });
      ack?.({ ok: true, stats: queueStats() });
      socket.emit('queue:joined', { waitMs: 0, stats: queueStats() });
    });

    on('queue:leave', (_d, ack) => {
      engine.dequeue(session.userId);
      session.state = session.user ? 'ready' : 'idle';
      ack?.({ ok: true });
    });

    on('queue:relax', (data = {}, ack) => {
      const entry = engine.get(session.userId);
      if (!entry) { ack?.({ ok: false }); return; }
      const patch = data.patch || {};
      entry.filters = { ...entry.filters, ...patch };
      if (patch.age) session.filters.age = patch.age;
      if (patch.gender) session.filters.gender = patch.gender;
      if (patch.language) session.filters.language = patch.language;
      if (patch.topics) session.filters.topics = patch.topics;
      session.strict = false;
      session.relaxOffered = false;
      session.queuedAt = nowTs(); // сброс ожидания — человек согласился на компромисс
      entry.joinedAt = session.queuedAt;
      ack?.({ ok: true, filters: session.filters });
      socket.emit('queue:relaxed', { filters: session.filters });
    });

    /* ---------- звонок по логину (адресный вызов) ----------
       Позвонить можно только зарегистрированному пользователю, который сейчас
       в сети. Звонок возможен лишь по обоюдному желанию: вызываемый видит,
       кто звонит, и может отклонить. Блокировки уважаются в обе стороны. */

    const RING_TIMEOUT_MS = 30_000;

    function clearRing(s) {
      if (s && s.ring) { clearTimeout(s.ring.timer); s.ring = null; }
    }

    /** Снимает ожидание и уведомляет вызываемого, что звонок отменён. */
    function cancelRing(s, notifyPeer = true) {
      if (!s || !s.ring) return;
      const peer = sessions.get(socketOf(s.ring.to));
      clearRing(s);
      s.state = s.user ? 'ready' : 'idle';
      if (notifyPeer && peer) io.to(peer.socketId).emit('direct:cancelled', { nick: s.nick });
    }

    on('direct:call', ({ nick } = {}, ack) => {
      // адресный звонок — привилегия зарегистрированных (и драйвер регистрации)
      if (!session.user) { ack?.({ ok: false, error: 'login_required' }); return; }
      if (session.state === 'banned') { ack?.({ ok: false, error: 'banned' }); return; }
      if (session.state === 'in_call') { ack?.({ ok: false, error: 'busy' }); return; }
      if (!hasQuota(session)) { ack?.({ ok: false, error: 'quota', quota: quotaState(session) }); return; }

      const target = store.users.getByNick(String(nick || '').trim());
      if (!target) { ack?.({ ok: false, error: 'not_found' }); return; }
      if (target.id === session.userId) { ack?.({ ok: false, error: 'self' }); return; }
      if (target.banned_until > nowTs()) { ack?.({ ok: false, error: 'unavailable' }); return; }
      if (store.blocks.anyBetween(session.userId, target.id)) { ack?.({ ok: false, error: 'blocked' }); return; }

      const tSocket = socketOf(target.id);
      const tSession = tSocket ? sessions.get(tSocket) : null;
      if (!tSession) { ack?.({ ok: false, error: 'offline' }); return; }
      if (tSession.state === 'in_call') { ack?.({ ok: false, error: 'busy' }); return; }
      if (session.ring && session.ring.to === target.id) { ack?.({ ok: false, error: 'ringing' }); return; }

      clearRing(session);
      const ring = { to: target.id, from: session.userId, timer: null };
      session.ring = ring;
      session.state = 'ringing';
      ring.timer = setTimeout(() => {
        if (session.ring !== ring) return;
        session.ring = null;
        session.state = session.user ? 'ready' : 'idle';
        socket.emit('direct:timeout', { nick: target.nick });
        const p = sessions.get(socketOf(target.id));
        if (p) io.to(p.socketId).emit('direct:cancelled', { nick: session.nick, timeout: true });
      }, RING_TIMEOUT_MS);

      io.to(tSession.socketId).emit('direct:incoming', {
        from: {
          id: session.userId, nick: session.nick,
          avatarHue: session.avatarHue, isPremium: session.isPremium,
        },
        timeoutMs: RING_TIMEOUT_MS,
      });
      store.events.log('direct_call', session.userId, { to: target.id });
      ack?.({ ok: true, ringing: true, nick: target.nick });
    });

    on('direct:accept', ({ fromId } = {}, ack) => {
      const callerSocket = socketOf(fromId);
      const caller = callerSocket ? sessions.get(callerSocket) : null;
      if (!caller || !caller.ring || caller.ring.to !== session.userId) { ack?.({ ok: false, error: 'no_ring' }); return; }
      if (session.state === 'in_call') { ack?.({ ok: false, error: 'busy' }); return; }

      // квота нужна обоим: вызываемый тоже тратит один из своих звонков
      if (!hasQuota(session)) { ack?.({ ok: false, error: 'quota', quota: quotaState(session) }); return; }
      if (!hasQuota(caller)) {
        clearRing(caller);
        caller.state = caller.user ? 'ready' : 'idle';
        io.to(caller.socketId).emit('quota:exceeded', { quota: quotaState(caller) });
        ack?.({ ok: false, error: 'caller_quota' });
        return;
      }

      clearRing(caller);
      if (engine.get(session.userId)) engine.dequeue(session.userId);
      if (engine.get(caller.userId)) engine.dequeue(caller.userId);
      startCall(caller, session, {
        mode: caller.mode || 'classic', score: 100, mutualTopics: [], direct: true,
      });
      ack?.({ ok: true });
    });

    on('direct:decline', ({ fromId } = {}, ack) => {
      const callerSocket = socketOf(fromId);
      const caller = callerSocket ? sessions.get(callerSocket) : null;
      clearRing(caller);
      if (caller) {
        caller.state = caller.user ? 'ready' : 'idle';
        io.to(caller.socketId).emit('direct:declined', { nick: session.nick });
      }
      ack?.({ ok: true });
    });

    on('direct:cancel', (_d, ack) => {
      if (!session.ring) { ack?.({ ok: false, error: 'no_ring' }); return; }
      cancelRing(session, true);
      ack?.({ ok: true });
    });

    /* ---------- V2: субтитры (реле текста, не медиа) ---------- */

    on('caption', ({ callId, text, final } = {}) => {
      const call = callOf(session);
      if (!call || call.id !== callId) return;
      // На сервер уходит только распознанный текст, никогда — аудио или видео.
      const peerSocket = socketOf(otherOf(call, session.userId));
      if (peerSocket) io.to(peerSocket).emit('caption', { text: String(text || '').slice(0, 200), final: !!final });
    });

    /* ---------- V2: запись только по взаимному согласию (ТЗ §4.4) ---------- */

    on('rec:request', ({ callId } = {}, ack) => {
      const call = callOf(session);
      if (!call || call.id !== callId) { ack?.({ ok: false }); return; }
      if (!session.isPremium) { ack?.({ ok: false, error: 'premium' }); return; }
      if (call.recState && call.recState !== 'idle') { ack?.({ ok: false, error: 'in_progress' }); return; }

      call.recState = 'pending';
      call.recRequestedBy = session.userId;
      const peerSocket = socketOf(otherOf(call, session.userId));
      if (!peerSocket) { call.recState = 'idle'; ack?.({ ok: false, error: 'no_peer' }); return; }
      io.to(peerSocket).emit('rec:request', { callId, by: session.nick });
      ack?.({ ok: true, pending: true });
    });

    on('rec:response', ({ callId, accept } = {}, ack) => {
      const call = callOf(session);
      if (!call || call.id !== callId || call.recState !== 'pending') { ack?.({ ok: false }); return; }
      // согласиться должен именно тот, кого попросили, а не инициатор
      if (call.recRequestedBy === session.userId) { ack?.({ ok: false, error: 'not_yours' }); return; }

      if (!accept) {
        call.recState = 'idle';
        const requester = socketOf(call.recRequestedBy);
        if (requester) io.to(requester).emit('rec:declined', { callId, by: session.nick });
        ack?.({ ok: true, accepted: false });
        return;
      }

      call.recState = 'recording';
      call.recStartedAt = nowTs();
      const startedAt = call.recStartedAt;
      for (const uid of [call.a, call.b]) {
        const s = socketOf(uid);
        if (s) io.to(s).emit('rec:start', { callId, startedAt, maxMs: config.V2.maxRecordingMs });
      }
      store.events.log('recording_start', session.userId, { callId });
      ack?.({ ok: true, accepted: true });
    });

    on('rec:stop', ({ callId } = {}, ack) => {
      const call = callOf(session);
      if (!call || call.id !== callId) { ack?.({ ok: false }); return; }
      if (call.recState !== 'recording') { ack?.({ ok: false }); return; }
      call.recState = 'idle';
      const stoppedAt = nowTs();
      for (const uid of [call.a, call.b]) {
        const s = socketOf(uid);
        if (s) io.to(s).emit('rec:stop', { callId, stoppedAt, by: session.nick });
      }
      store.events.log('recording_stop', session.userId, { callId });
      ack?.({ ok: true });
    });

    /* ---------- демо-бот (когда в очереди пусто) ---------- */

    on('bot:request', async (_d, ack) => {
      if (!botPool) { ack?.({ ok: false, error: 'disabled' }); return; }
      if (session.isBot) { ack?.({ ok: false, error: 'nope' }); return; }
      if (session.call) { ack?.({ ok: false, error: 'in_call' }); return; }

      const bot = await botPool.acquire();
      if (!bot) { ack?.({ ok: false, error: 'busy' }); return; }
      const botSession = bot.session;
      if (!botSession) { await botPool.release(bot); ack?.({ ok: false, error: 'unavailable' }); return; }

      engine.dequeue(session.userId);
      engine.dequeue(botSession.userId);
      startCall(session, botSession, { mode: 'classic', score: 100, mutualTopics: [] });
      store.events.log('bot_call', session.userId);
      ack?.({ ok: true, nick: botSession.nick });
    });

    /* ---------- сигналинг WebRTC ---------- */

    function callOf(session) { return session.call ? rooms.getCall(session.call.id) : null; }

    on('rtc:signal', ({ callId, type, data: payload } = {}) => {
      const call = callOf(session);
      if (!call || call.id !== callId) return;
      const peerSocket = socketOf(otherOf(call, session.userId));
      if (!peerSocket) return;
      io.to(peerSocket).emit('rtc:signal', { callId, type, data: payload, from: session.userId });
      if (type === 'answer') {
        // ответ получен — P2P почти наверняка поднимется
        if (!call.state || call.state === 'connecting') { /* ждём connected */ }
      }
    });

    on('rtc:state', ({ callId, state } = {}) => {
      const call = callOf(session);
      if (!call || call.id !== callId) return;
      const prev = call.state;
      if (state === 'connected') {
        call.state = 'connected';
        clearTimeout(call.watchdog);
        const my = sessions.get(socketOf(session.userId));
        if (my) my.call.connected = true;
        if (prev !== 'connected') {
          // только теперь звонок считается состоявшимся — списываем квоту обоим
          store.calls.markConnected(call.dbId);
          store.events.log('call_connected', session.userId, { callId });
          for (const uid of [call.a, call.b]) {
            const s = sessions.get(socketOf(uid));
            if (!s) continue;
            consumeQuota(s);
            io.to(s.socketId).emit('call:connected', { callId, at: nowTs(), quota: quotaState(s) });
          }
        }
      } else if (state === 'failed') {
        const peerSocket = socketOf(otherOf(call, session.userId));
        if (peerSocket) io.to(peerSocket).emit('rtc:peer-failed', { callId });
        finishCall(callId, 'failed');
      }
    });

    on('rtc:quality', ({ callId, rtt, quality, nsfwScore, loud } = {}) => {
      const call = callOf(session);
      if (!call || call.id !== callId) return;
      const peerSocket = socketOf(otherOf(call, session.userId));
      if (peerSocket) io.to(peerSocket).emit('rtc:peer-quality', { rtt, quality });

      // автомодерация кадра (клиент шлёт скор, видео на сервер не уходит)
      if (typeof nsfwScore === 'number' || loud) {
        const res = automod.pushFrame(session.userId, { nsfwScore: nsfwScore || 0, loud: !!loud });
        if (res.suspicious && !call.autoWarned) {
          call.autoWarned = true;
          io.to(socket.id).emit('moderation:warning', {
            reason: 'nsfw', text: 'Автомодерация: подозрение на неприемлемый контент. Камера будет отключена.',
          });
          const peerS = socketOf(otherOf(call, session.userId));
          if (peerS) io.to(peerS).emit('moderation:peer', { reason: 'nsfw', text: 'У собеседника сработала автомодерация.' });
          store.reports.create({
            callId: call.dbId, reporterId: 'system:automod', targetId: session.userId,
            reason: 'nsfw', comment: `avg=${res.avg.toFixed(2)} frames=${res.count}`,
          });
          io.to(socket.id).emit('call:end', { callId, reason: 'automod', forced: true });
          finishCall(callId, 'automod');
        }
      }
    });

    /* ---------- действия в звонке ---------- */

    on('call:skip', ({ callId } = {}, ack) => {
      const call = callOf(session);
      if (!call || call.id !== callId) { ack?.({ ok: false }); return; }
      const l = ledgerFor(session.guestId, session.ip);
      l.skips = l.skips.filter(t => nowTs() - t < HOUR);
      const limit = (config.LIMITS[session.role] || config.LIMITS.guest).skipsPerHour;
      if (l.skips.length >= limit) {
        socket.emit('toast', { type: 'error', text: `Лимит пропусков исчерпан (${limit}/час). Зарегистрируйтесь, чтобы получить больше.` });
        ack?.({ ok: false, error: 'limit' });
        return;
      }
      l.skips.push(nowTs());
      if (session.user) store.users.addStats(session.user.id, { skips: 1 });
      const peerSocket = socketOf(otherOf(call, session.userId));
      if (peerSocket) io.to(peerSocket).emit('call:skipped', { callId, by: session.nick });
      engine.blacklistPair(call.a, call.b); // не соединять тут же повторно (ТЗ §3.6)
      finishCall(callId, 'skip');           // вернёт обоих в очередь
      ack?.({ ok: true });
    });

    on('call:hangup', ({ callId } = {}, ack) => {
      const call = callOf(session);
      if (!call || call.id !== callId) { ack?.({ ok: false }); return; }
      const peerSocket = socketOf(otherOf(call, session.userId));
      if (peerSocket) io.to(peerSocket).emit('call:peer-left', { callId });
      finishCall(callId, 'hangup');
      ack?.({ ok: true });
    });

    on('call:sos', ({ callId } = {}, ack) => {
      const call = callOf(session);
      if (!call || call.id !== callId) { ack?.({ ok: false }); return; }
      store.reports.create({ callId: call.dbId, reporterId: session.userId, targetId: otherOf(call, session.userId), reason: 'violence', comment: 'SOS' });
      automod.applyStrike(otherOf(call, session.userId), 'sos', { severity: 'high' });
      finishCall(callId, 'sos');
      ack?.({ ok: true });
    });

    /* ---------- чат и реакции ---------- */

    on('chat:message', ({ callId, text } = {}, ack) => {
      const call = callOf(session);
      if (!call || call.id !== callId) { ack?.({ ok: false }); return; }
      const check = automod.checkMessage(text);
      if (!check.ok) {
        ack?.({ ok: false, reason: check.reason, masked: check.masked });
        socket.emit('toast', { type: 'warn', text: 'Сообщение скрыто автомодерацией (спам/оскорбления/контакты).' });
        if (check.severity === 'medium') {
          store.reports.create({ callId: call.dbId, reporterId: 'system:chat', targetId: session.userId, reason: check.reason, comment: text.slice(0, 200) });
        }
        return;
      }
      const peerSocket = socketOf(otherOf(call, session.userId));
      const msg = { id: crypto.randomBytes(5).toString('hex'), from: session.userId, nick: session.nick, text: check.masked, ts: nowTs() };
      if (peerSocket) io.to(peerSocket).emit('chat:message', msg);
      ack?.({ ok: true, message: msg });
    });

    on('reaction', ({ callId, emoji } = {}) => {
      const call = callOf(session);
      if (!call || call.id !== callId) return;
      const peerSocket = socketOf(otherOf(call, session.userId));
      if (peerSocket) io.to(peerSocket).emit('reaction', { emoji, from: session.nick });
      if (session.user) gamify.bumpQuest(session.user.id, 'react_5');
    });

    /* ---------- оценка ---------- */

    on('rate', ({ callId, stars, tags = [] } = {}, ack) => {
      const peerId = callId ? (rooms.getCall(callId) ? otherOf(rooms.getCall(callId), session.userId) : null) : null;
      const target = peerId || session.lastPeer;
      if (!target || !target.startsWith('u_')) { ack?.({ ok: true, skipped: true }); return; }
      const s = Math.max(1, Math.min(5, Number(stars) || 0));
      if (!s) { ack?.({ ok: false }); return; }
      store.users.addRating(target, s);
      const negative = tags.filter(t => ['toxic', 'spammer', 'rude'].includes(t));
      if (negative.length >= 2) {
        store.reports.create({ callId: callId || null, reporterId: session.userId, targetId: target, reason: 'insults', comment: 'auto: negative tags' });
      }
      if (session.user) {
        gamify.bumpQuest(session.user.id, 'rate_3');
        const unlocked = gamify.evaluate(session.user.id);
        if (unlocked.length) socket.emit('achievements:unlocked', { items: unlocked });
      }
      const fresh = store.users.get(target);
      sendToUser(target, 'rating:received', { stars: s, rating: fresh?.rating ?? null });
      ack?.({ ok: true });
    });

    /* ---------- друзья ---------- */

    on('friend:request', ({ target } = {}, ack) => {
      if (!session.user) { ack?.({ ok: false, error: 'login_required' }); return; }
      if (!target || !target.startsWith('u_')) { ack?.({ ok: false, error: 'guest' }); return; }
      const res = store.friends.request(session.user.id, target);
      session.lastPeer = target;
      sendToUser(target, 'friend:requested', { from: pub(session.user), status: res });
      ack?.({ ok: true, status: res });
      if (res === 'accepted') {
        socket.emit('friend:accepted', { user: pub(store.users.get(target)) });
        if (session.user) {
          const unlocked = gamify.evaluate(session.user.id);
          if (unlocked.length) socket.emit('achievements:unlocked', { items: unlocked });
        }
      }
    });

    on('friend:accept', ({ target } = {}, ack) => {
      if (!session.user) return;
      store.friends.accept(session.user.id, target);
      sendToUser(target, 'friend:accepted', { user: pub(session.user) });
      const unlocked = gamify.evaluate(session.user.id);
      if (unlocked.length) socket.emit('achievements:unlocked', { items: unlocked });
      ack?.({ ok: true });
    });

    on('friend:decline', ({ target } = {}, ack) => {
      if (!session.user) return;
      store.friends.decline(session.user.id, target);
      sendToUser(target, 'friend:declined', { user: pub(session.user) });
      ack?.({ ok: true });
    });

    /* ---------- блокировки ---------- */

    on('block', ({ target, callId } = {}, ack) => {
      const call = callId ? rooms.getCall(callId) : null;
      const t = target || (call ? otherOf(call, session.userId) : null);
      if (!t) { ack?.({ ok: false }); return; }
      if (session.user) store.blocks.add(session.user.id, t);
      engine.blacklistPair(session.userId, t);
      if (call) {
        finishCall(call.id, 'block');
        sendToUser(t, 'toast', { type: 'warn', text: 'Собеседник завершил разговор.' });
      }
      ack?.({ ok: true });
    });

    on('block:list', (_d, ack) => ack?.({ ok: true, items: session.user ? store.blocks.listFor(session.user.id) : [] }));
    on('block:remove', ({ target } = {}, ack) => {
      if (session.user) store.blocks.remove(session.user.id, target);
      ack?.({ ok: true });
    });

    /* ---------- жалобы ---------- */

    on('report', ({ target, reason, comment, callId } = {}, ack) => {
      const call = callId ? rooms.getCall(callId) : null;
      const t = target || (call ? otherOf(call, session.userId) : null);
      if (!t) { ack?.({ ok: false }); return; }
      const reasonMeta = config.REPORT_REASONS.find(r => r.id === reason) || config.REPORT_REASONS.at(-1);
      const rep = store.reports.create({
        callId: call?.dbId || null, reporterId: session.userId, targetId: t,
        reason: reasonMeta.id, comment: (comment || '').slice(0, 500),
      });
      const verdict = automod.applyStrike(t, reasonMeta.id, { severity: reasonMeta.severity });
      store.events.log('report', session.userId, { reason: reasonMeta.id, target: t });
      if (call) finishCall(call.id, 'report');

      // уведомляем нарушителя и выкидываем из очереди
      const targetSocket = socketOf(t);
      const targetSession = targetSocket ? sessions.get(targetSocket) : null;
      if (targetSession) {
        engine.dequeue(t);
        io.to(targetSocket).emit('moderation:action', {
          action: verdict.action, until: verdict.until, reason: reasonMeta.id,
          text: verdict.action === 'warn'
            ? 'Вы получили предупреждение за нарушение правил сообщества.'
            : `Аккаунт заблокирован за нарушение правил (жалоба: ${reasonMeta.ru}).`,
        });
        if (verdict.action !== 'warn') { targetSession.state = 'banned'; targetSession.shadow = false; }
      }
      io.to('moderators').emit('reports:new', { report: rep, verdict });
      ack?.({ ok: true, id: rep.id });
    });

    /* ---------- приватные комнаты ---------- */

    on('room:create', ({ mode } = {}, ack) => {
      const room = rooms.create({ hostId: session.userId, hostNick: session.nick, mode: mode || session.mode });
      session.room = room.code;
      ack?.({ ok: true, room, link: `${resolveBase()}/r/${room.code}` });
    });

    on('room:join', ({ code } = {}, ack) => {
      const c = String(code || '').toLowerCase().trim();
      const room = rooms.join(c, { userId: session.userId, nick: session.nick, socketId: socket.id });
      if (!room) { ack?.({ ok: false, error: 'not_found' }); return; }
      if (room.error === 'full') { ack?.({ ok: false, error: 'full' }); return; }
      session.room = c;
      const others = room.members.filter(m => m !== session.userId);
      for (const o of others) {
        const os = sessions.get(socketOf(o));
        if (os) startCall(os, session, { mode: room.mode || 'classic', score: 100, room: c, mutualTopics: [] });
      }
      ack?.({ ok: true, room });
      store.events.log('room_join', session.userId, { code: c });
    });

    on('room:leave', (_d, ack) => {
      if (session.room) { rooms.leave(session.room, session.userId); session.room = null; }
      ack?.({ ok: true });
    });

    /* ---------- админ/модерация ---------- */

    on('admin:subscribe', (_d, ack) => {
      if (session.user?.role !== 'admin' && session.user?.role !== 'moderator') { ack?.({ ok: false }); return; }
      socket.join('moderators');
      ack?.({
        ok: true,
        reports: store.reports.list('all', 100),
        counts: store.reports.counts(),
        users: store.users.list({ limit: 50 }),
        queue: engine.snapshot(),
        calls: rooms.activeCalls(),
        metrics: computeMetrics(),
      });
    });

    on('admin:act', ({ reportId, action, userId, banMs, shadow } = {}, ack) => {
      if (session.user?.role !== 'admin' && session.user?.role !== 'moderator') { ack?.({ ok: false }); return; }
      if (reportId) {
        const rep = store.reports.resolve(reportId, {
          status: action === 'dismiss' ? 'rejected' : 'resolved',
          action, moderator: session.user.nick,
        });
        const target = rep.target_id;
        if (target?.startsWith('u_') && action !== 'dismiss') {
          if (action === 'ban') store.users.ban(target, nowTs() + (banMs || 24 * HOUR), !!shadow);
          if (action === 'shadow') store.users.ban(target, nowTs() + 7 * DAY, true);
          if (action === 'warn') store.users.addStats(target, { strikes: 1 });
          const ts = socketOf(target);
          if (ts) io.to(ts).emit('moderation:action', { action, until: nowTs() + (banMs || 24 * HOUR), text: 'Решение модератора по вашей жалобе.' });
        }
        io.to('moderators').emit('reports:update', { report: rep });
      }
      if (userId && action === 'premium') store.users.grantPremium(userId, DAY);
      ack?.({ ok: true, counts: store.reports.counts(), users: store.users.list({ limit: 50 }), metrics: computeMetrics() });
    });

    /* ---------- разрыв ---------- */

    on('disconnect', () => {
      const call = session.call ? rooms.getCall(session.call.id) : null;
      if (call) {
        const peerId = otherOf(call, session.userId);
        const peerSocket = socketOf(peerId);
        if (peerSocket) io.to(peerSocket).emit('call:peer-dropped', { callId: call.id, graceMs: config.RECONNECT_GRACE_MS });
        // 10 секунд на переподключение (ТЗ §5.10)
        call.reconnectTimer = setTimeout(() => {
          if (rooms.getCall(call.id)) finishCall(call.id, 'disconnect');
        }, config.RECONNECT_GRACE_MS);
      }
      // отменяем незавершённый адресный звонок, чтобы собеседник не «висел» на гудке
      if (session.ring) {
        const peer = sessions.get(socketOf(session.ring.to));
        if (peer) io.to(peer.socketId).emit('direct:cancelled', { nick: session.nick, gone: true });
        clearRing(session);
      }
      engine.dequeue(session.userId);
      if (session.room) rooms.leave(session.room, session.userId);
      const set = userSockets.get(session.userId);
      if (set) { set.delete(socket.id); if (!set.size) userSockets.delete(session.userId); }
      if (session.isBot && botPool) botPool.releaseByUser(session.userId).catch(() => {});
      sessions.delete(socket.id);
      broadcastStats();
    });
  });

  /* ================= метрики (ТЗ §9) ================= */

  function computeMetrics() {
    const todayEv = store.events.byDay(0);
    const yEv = store.events.byDay(1);
    const totalCalls = store.stats.get('totalCalls', 0);
    const talkMs = store.stats.get('totalTalkMs', 0);
    const dau = store.events.distinctUsers(0);
    const reports = store.reports.counts();
    const reportTotal = Object.values(reports).reduce((a, b) => a + b, 0);
    return {
      online: sessions.size,
      inQueue: engine.size(false),
      activeCalls: rooms.activeCallCount(),
      totalCalls,
      dau,
      dauPrev: store.events.distinctUsers(1),
      avgCallSeconds: totalCalls ? Math.round(talkMs / totalCalls / 1000) : 0,
      skipsToday: todayEv.skip || 0,
      matchesToday: todayEv.match || 0,
      skipRate: todayEv.match ? +((todayEv.skip || 0) / todayEv.match).toFixed(2) : 0,
      avgWaitSeconds: avgWait(),
      reportsPer1000: totalCalls ? +((reportTotal / totalCalls) * 1000).toFixed(1) : 0,
      reports,
      registrationsToday: todayEv.register || 0,
      viralCoefficient: viralCoefficient(),
      connectionsToday: todayEv.connection || 0,
      yesterdayMatches: yEv.match || 0,
    };
  }

  function avgWait() {
    const rows = store.db.prepare('SELECT wait_ms_a, wait_ms_b FROM calls ORDER BY started_at DESC LIMIT 200').all();
    if (!rows.length) return 0;
    const all = rows.flatMap(r => [r.wait_ms_a || 0, r.wait_ms_b || 0]).filter(Boolean);
    return all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length / 1000) : 0;
  }

  function viralCoefficient() {
    const invited = store.db.prepare('SELECT SUM(invited_count) AS s FROM users').get().s || 0;
    const users = store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n || 1;
    return +(invited / users).toFixed(2);
  }

  const metricsTimer = setInterval(() => {
    io.to('moderators').emit('admin:metrics', computeMetrics());
    io.emit('metrics:public', {
      totalCalls: store.stats.get('totalCalls', 0),
      online: sessions.size,
      inQueue: engine.size(false),
      activeCalls: rooms.activeCallCount(),
    });
  }, 10_000);

  io.engine.on('connection_error', (err) => console.error('[engine]', err.message));

  return {
    engine, rooms, sessions, computeMetrics,
    shutdown() { clearInterval(matchTimer); clearInterval(statsTimer); clearInterval(relaxTimer); clearInterval(metricsTimer); },
  };
};
