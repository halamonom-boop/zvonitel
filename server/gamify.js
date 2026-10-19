'use strict';
/**
 * Геймификация и виральность (ТЗ §4.6, §4.7):
 * достижения, ежедневные задания, серии (streak), рефералы, челлендж дня.
 */
const store = require('./db');
const { ACHIEVEMENTS } = require('./config');

const DAY = 864e5;
const HOUR = 36e5;

/* ---------- ежедневные задания ---------- */

const QUEST_POOL = [
  { id: 'call_1',   ru: 'Сделай 1 звонок',              en: 'Make 1 call',            target: 1,  reward: 10 },
  { id: 'call_3',   ru: 'Сделай 3 звонка',              en: 'Make 3 calls',           target: 3,  reward: 30 },
  { id: 'talk_10',  ru: 'Наговори 10 минут',            en: 'Talk for 10 minutes',    target: 10, reward: 25 },
  { id: 'rate_3',   ru: 'Оцени 3 собеседника',          en: 'Rate 3 people',          target: 3,  reward: 15 },
  { id: 'react_5',  ru: 'Отправь 5 реакций',            en: 'Send 5 reactions',       target: 5,  reward: 10 },
  { id: 'topic_2',  ru: 'Обсуди 2 разные темы',         en: 'Discuss 2 topics',       target: 2,  reward: 20 },
  { id: 'lang_1',   ru: 'Поговори на другом языке',     en: 'Speak another language', target: 1,  reward: 30 },
];

function todaysQuests(seedDay) {
  // Детерминированный выбор 3 заданий на день — у всех пользователей одинаковые (честный лидерборд)
  const dayStr = seedDay || store.today();
  let h = 0;
  for (const ch of dayStr) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const picked = [];
  const pool = [...QUEST_POOL];
  for (let i = 0; i < 3 && pool.length; i++) picked.push(pool.splice(h % pool.length, 1)[0]);
  return picked;
}

/** «Челлендж дня» для лендинга — тема дня (ТЗ §4.6 «Тематические вечера»). */
const THEME_EVENINGS = [
  { id: 'movies',   ru: 'Кино-вечер',        en: 'Movie night',     emoji: '🎬' },
  { id: 'travel',   ru: 'Вечер путешествий', en: 'Travel night',    emoji: '✈️' },
  { id: 'music',    ru: 'Музыкальный вечер', en: 'Music night',     emoji: '🎧' },
  { id: 'tech',     ru: 'Tech-вечер',        en: 'Tech night',      emoji: '💻' },
  { id: 'psychology', ru: 'Вечер психологии', en: 'Psychology night', emoji: '🧠' },
  { id: 'games',    ru: 'Геймерский вечер',  en: 'Gaming night',    emoji: '🎮' },
  { id: 'humor',    ru: 'Вечер юмора',       en: 'Comedy night',    emoji: '😂' },
];
function todaysTheme(seedDay) {
  const dayStr = seedDay || store.today();
  let h = 0;
  for (const ch of dayStr) h = (h * 17 + ch.charCodeAt(0)) >>> 0;
  return THEME_EVENINGS[h % THEME_EVENINGS.length];
}

/* ---------- прогресс заданий ---------- */

function bumpQuest(userId, questId, delta = 1) {
  if (!userId) return null;
  const day = store.today();
  const quest = todaysQuests(day).find(q => q.id === questId);
  if (!quest) return null;
  const res = store.quests.bump(userId, day, questId, delta, quest.target);
  if (res.justCompleted) store.users.addCoins(userId, quest.reward);
  return { quest, ...res };
}

function questsState(userId) {
  const day = store.today();
  const rows = store.quests.get(userId, day);
  return todaysQuests(day).map(q => {
    const row = rows.find(r => r.quest_id === q.id);
    return {
      ...q,
      progress: row?.progress || 0,
      done: !!(row?.done),
    };
  });
}

/* ---------- достижения ---------- */

function evaluate(userId, extra = {}) {
  const u = store.users.get(userId);
  if (!u) return [];
  const friends = store.friends.countAccepted(userId);
  const ctx = {
    calls: u.calls_total,
    langs: (u.languages || []).length,
    streak: u.streak,
    friends,
    invited: u.invited_count,
    deep: extra.topicSeconds?.deep || 0,
    night: extra.nightCalls || 0,
  };
  const unlocked = [];
  for (const ach of ACHIEVEMENTS) {
    let ok = false;
    const m = ach.condition.match(/^(\w+)(:(\w+))?(>=)(\d+)$/);
    if (m) {
      const key = m[1];
      const val = ctx[key] ?? 0;
      ok = val >= Number(m[5]);
    }
    if (ok && store.achievements.unlock(userId, ach.id)) unlocked.push(ach);
  }
  return unlocked;
}

function achievementsState(userId) {
  const owned = new Set(store.achievements.list(userId).map(r => r.ach_id));
  return ACHIEVEMENTS.map(a => ({ ...a, unlocked: owned.has(a.id) }));
}

function level(user) {
  // Уровень от общего времени разговоров + звонков
  const xp = (user?.talk_seconds || 0) / 60 + (user?.calls_total || 0) * 5;
  const lvl = Math.floor(Math.sqrt(xp / 12)) + 1;
  const cur = Math.pow(lvl - 1, 2) * 12;
  const next = Math.pow(lvl, 2) * 12;
  return { level: lvl, xp: Math.round(xp), current: Math.round(cur), next: Math.round(next),
    progress: Math.min(1, (xp - cur) / Math.max(1, next - cur)) };
}

/* ---------- рефералы ---------- */

function referralCode(userId) { return userId.replace('u_', '').slice(0, 10); }

function applyReferralRewards(userId, progress) {
  // progress: 'registered' | 'calls3'
  const u = store.users.get(userId);
  const inviterId = u?.invited_by;
  if (!inviterId) return null;
  const inviter = store.users.get(inviterId);
  if (!inviter) return null;

  if (progress === 'registered') {
    store.users.grantPremium(inviterId, DAY);          // пригласил друга — Premium на день
    store.users.addCoins(inviterId, 50);
    store.events.log('referral_registered', inviterId, { userId });
    return { type: 'premium_day', coins: 50 };
  }
  if (progress === 'calls3' && u.calls_total === 3) {
    store.users.grantPremium(inviterId, 3 * DAY);      // друг сделал 3 звонка — бонус больше
    store.users.addCoins(inviterId, 150);
    store.events.log('referral_qualified', inviterId, { userId });
    return { type: 'premium_3days', coins: 150 };
  }
  return null;
}

/* ---------- генератор вопросов (ТЗ §11) ---------- */

const QUESTIONS = {
  chat: ['Что самое странное случилось с тобой за неделю?', 'Если бы у тебя был лишний час в сутках — на что бы потратил?', 'Какой твой самый бесполезный талант?'],
  meet: ['Каким было твоё первое впечатление обо мне?', 'Что для тебя важнее в человеке: юмор или надёжность?', 'Какой самый смелый поступок ты совершал?'],
  friends: ['Во что ты играешь/чем увлекаешься чаще всего?', 'Что бы ты делал, если бы мы жили в одном городе?', 'Какая песня у тебя на репите?'],
  couple: ['Идеальное первое свидание — опиши за 30 секунд', 'Что тебя отталкивает в людях сразу?', 'Кошки или собаки? Отвечай честно.'],
  topic: ['Какая тема сейчас разделила бы нас сильнее всего?', 'Если бы ты писал книгу — о чём бы она была?', 'Какой миф ты недавно разрушил для себя?'],
  language: ['Расскажи о своём городе на этом языке', 'Какое слово в этом языке тебе нравится больше всего?', 'Какая идиома тут самая смешная?'],
  networking: ['Над каким проектом ты сейчас работаешь?', 'Какой навык ты хотел бы прокачать в этом году?', 'Кого из своей сферы мне стоит знать?'],
  support: ['Что сейчас занимает больше всего твоих мыслей?', 'Что бы ты хотел, чтобы кто-то тебе сегодня сказал?', 'Что обычно помогает тебе выдохнуть?'],
};

function randomQuestion(goal = 'chat', seed = Date.now()) {
  const pool = QUESTIONS[goal] || QUESTIONS.chat;
  return pool[seed % pool.length];
}

module.exports = {
  QUEST_POOL, QUESTIONS, todaysQuests, todaysTheme, THEME_EVENINGS,
  bumpQuest, questsState, evaluate, achievementsState, level,
  referralCode, applyReferralRewards, randomQuestion,
  DAY, HOUR,
};
