'use strict';
/**
 * Ядро продукта: очередь + умный взаимный матчинг (ТЗ §4.1, §5).
 *
 * Правила:
 *  1. Пара создаётся только если фильтр A подходит профилю B И фильтр B подходит профилю A
 *     (взаимное соответствие).
 *  2. HARD-критерии (язык, цель, пол, возраст) не нарушаются никогда.
 *  3. SOFT-критерии (темы, стиль) в «гибком» режиме дают частичный скор.
 *  4. Приоритет очереди: premium > дольше ждёт > выше рейтинг.
 *  5. Запрет повторов 30 минут, чёрный список блокировок/жалоб, теневой бан — отдельная очередь.
 */
const { MATCH_WEIGHTS, FLEXIBLE_MIN_SCORE, COOLDOWN_MS } = require('./config');
const store = require('./db');

/** @typedef {{id:string, socketId:string, nick:string, isPremium:boolean, role:string,
 *   profile:object, filters:object, strict:boolean, mode:string, joinedAt:number,
 *   shadow?:boolean, rating?:number|null}} QueueEntry */

class MatchingEngine {
  constructor() {
    /** @type {Map<string, QueueEntry>} */
    this.queue = new Map();
    /** recentPairs: "a|b" -> ts */
    this.recentPairs = new Map();
    this.blockedPairs = new Map(); // "a|b" -> ts, после жалобы
    this.listeners = new Set();
  }

  onMatch(fn) { this.listeners.add(fn); }

  /* ---------- очередь ---------- */

  enqueue(entry) {
    entry.joinedAt = entry.joinedAt || Date.now();
    entry.shadow = !!entry.shadow;
    this.queue.set(entry.id, entry);
    return this.size(entry.shadow);
  }

  dequeue(id) {
    const e = this.queue.get(id);
    this.queue.delete(id);
    return e;
  }

  get(id) { return this.queue.get(id); }
  has(id) { return this.queue.has(id); }

  size(shadow = false) {
    let n = 0;
    for (const e of this.queue.values()) if (!!e.shadow === !!shadow) n++;
    return n;
  }

  snapshot() {
    return [...this.queue.values()].map(e => ({
      id: e.id, nick: e.nick, shadow: e.shadow, waitMs: Date.now() - e.joinedAt,
      strict: e.strict, mode: e.mode, premium: e.isPremium,
      filters: e.filters, profile: e.profile,
    }));
  }

  /* ---------- приоритет ---------- */

  priority(e, now = Date.now()) {
    const waitedSec = (now - e.joinedAt) / 1000;
    const premium = e.isPremium ? 10_000 : 0;                 // premium выше всех (ТЗ §4.1)
    const reputation = Math.max(0, (e.rating ?? 4) - 3) * 150; // высокий рейтинг выше
    return premium + Math.min(waitedSec, 600) * 10 + reputation;
  }

  /* ---------- совместимость ---------- */

  /** Подходит ли профиль `profile` под фильтр `filter`? Возвращает {ok, score, details}. */
  static fit(filter, profile) {
    const d = { language: 0, goal: 0, gender: 0, age: 0, topics: 0, style: 0 };
    let ok = true;

    // язык — HARD
    const fLang = filter.language || 'any';
    if (fLang !== 'any') {
      const langs = profile.languages || [];
      d.language = langs.includes(fLang) ? 1 : 0;
      if (!d.language) ok = false;
    } else d.language = 0.5;

    // цель — HARD (либо одинаковая, либо у кого-то "любая")
    const fGoal = filter.goal || 'any';
    const pGoals = profile.goals || [];
    if (fGoal !== 'any') {
      d.goal = pGoals.includes(fGoal) ? 1 : 0;
      if (!d.goal) ok = false;
    } else d.goal = 0.6;

    // пол — HARD (если не any)
    const fGender = filter.gender || 'any';
    if (fGender !== 'any') {
      d.gender = (profile.gender || 'other') === fGender ? 1 : 0;
      if (!d.gender) ok = false;
    } else d.gender = 0.5;

    // возраст — HARD (если не any)
    const fAge = filter.age || 'any';
    if (fAge !== 'any' && fAge !== '') {
      const range = { '18-25': [18, 25], '26-35': [26, 35], '36-50': [36, 50], '50+': [51, 120] }[fAge];
      const age = profile.age || 0;
      d.age = range && age >= range[0] && age <= range[1] ? 1 : 0;
      if (!d.age) ok = false;
    } else d.age = 0.5;

    // темы — SOFT: доля пересечения
    const fTopics = filter.topics || [];
    if (fTopics.length === 0) d.topics = 0.5;
    else {
      const pTopics = new Set(profile.topics || []);
      const hits = fTopics.filter(t => pTopics.has(t)).length;
      d.topics = fTopics.length ? hits / fTopics.length : 0;
    }

    // стиль — SOFT
    const fStyle = filter.style || 'any';
    if (fStyle === 'any') d.style = 0.5;
    else d.style = (profile.style || '') === fStyle ? 1 : 0;

    // «без политики» — жёсткое правило уважения
    const noPolitics = fStyle === 'nopolitics' || (profile.style === 'nopolitics');
    const wantsPolitics = (filter.topics || []).includes('politics') || (profile.topics || []).includes('politics');
    if (noPolitics && wantsPolitics) ok = false;

    const score = Math.round(
      d.language * MATCH_WEIGHTS.language +
      d.goal * MATCH_WEIGHTS.goal +
      d.gender * MATCH_WEIGHTS.gender +
      d.age * MATCH_WEIGHTS.age +
      d.topics * MATCH_WEIGHTS.topics +
      d.style * MATCH_WEIGHTS.style
    );
    return { ok, score, details: d };
  }

  /** Взаимная совместимость пары. */
  static mutual(a, b) {
    const ab = MatchingEngine.fit(a.filters, b.profile); // фильтр A vs профиль B
    const ba = MatchingEngine.fit(b.filters, a.profile); // фильтр B vs профиль A
    const bothOk = ab.ok && ba.ok;
    const score = Math.round((ab.score + ba.score) / 2);
    const mutualTopics = [...new Set((a.profile.topics || [])).values()]
      .filter(t => (b.profile.topics || []).includes(t));
    return {
      ok: bothOk,
      score,
      strictOk: bothOk && score >= 85 && mutualTopics.length >= 1,
      flexibleOk: bothOk && score >= FLEXIBLE_MIN_SCORE,
      mutualTopics,
      breakdown: { ab: ab.details, ba: ba.details },
    };
  }

  /* ---------- ограничения ---------- */

  pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

  rememberPair(a, b, ts = Date.now()) { this.recentPairs.set(this.pairKey(a, b), ts); }
  blacklistPair(a, b) { this.blockedPairs.set(this.pairKey(a, b), Date.now()); }

  _prune() {
    const cutoff = Date.now() - COOLDOWN_MS;
    for (const [k, ts] of this.recentPairs) if (ts < cutoff) this.recentPairs.delete(k);
  }

  /** Можно ли вообще соединять этих двоих (без учёта фильтров). */
  pairAllowed(aId, bId) {
    if (aId === bId) return false;
    const key = this.pairKey(aId, bId);
    if (this.blockedPairs.has(key)) return false;
    const last = this.recentPairs.get(key);
    if (last && Date.now() - last < COOLDOWN_MS) return false;
    // блокировки хранятся только для зарегистрированных
    if (aId.startsWith('u_') && bId.startsWith('u_') && store.blocks.anyBetween(aId, bId)) return false;
    return true;
  }

  /* ---------- цикл матчинга ---------- */

  /**
   * Один проход. Возвращает массив созданных пар.
   * Алгоритм: сортируем по приоритету, для каждого ищем лучшего взаимно-совместимого партнёра.
   */
  tick() {
    this._prune();
    const now = Date.now();
    const matched = [];

    for (const shadowLane of [false, true]) {
      // Теневой бан: своя изолированная очередь (ТЗ §1.10).
      // Боты в общий пул не попадают: их зовут адресно через bot:request.
      const pool = [...this.queue.values()]
        .filter(e => !!e.shadow === shadowLane && !e.bot)
        .sort((x, y) => this.priority(y, now) - this.priority(x, now));

      const used = new Set();

      for (const a of pool) {
        if (used.has(a.id)) continue;
        let best = null; let bestScore = -1; let bestMutual = null;

        for (const b of pool) {
          if (b.id === a.id || used.has(b.id)) continue;
          if (!this.pairAllowed(a.id, b.id)) continue;

          const m = MatchingEngine.mutual(a, b);
          const acceptable = a.strict && b.strict ? m.strictOk : m.flexibleOk;
          if (!acceptable) continue;

          // бонус за долготу ожидания партнёра — не даём никому «протухнуть»
          const waitBonus = Math.min((now - b.joinedAt) / 1000, 60) * 0.15;
          const total = m.score + waitBonus + (m.mutualTopics.length * 2);
          if (total > bestScore) { bestScore = total; best = b; bestMutual = m; }
        }

        if (best) {
          used.add(a.id); used.add(best.id);
          this.queue.delete(a.id); this.queue.delete(best.id);
          this.rememberPair(a.id, best.id, now);
          matched.push({ a, b: best, score: Math.round(bestScore), mutual: bestMutual, shadow: shadowLane });
        }
      }
    }

    for (const pair of matched) for (const fn of this.listeners) {
      try { fn(pair); } catch (e) { console.error('[match listener]', e.message); }
    }
    return matched;
  }

  /** Для тех, кто ждёт дольше порога — какие фильтры стоит расслабить. */
  relaxationAdvice(entry) {
    const tips = [];
    const f = entry.filters || {};
    if (f.age && f.age !== 'any') tips.push({ key: 'age', value: 'any' });
    if (f.gender && f.gender !== 'any') tips.push({ key: 'gender', value: 'any' });
    if (f.topics?.length) tips.push({ key: 'topics', value: [] });
    if (f.language && f.language !== 'any') tips.push({ key: 'language', value: 'any' });
    return tips.slice(0, 3);
  }
}

module.exports = { MatchingEngine };
