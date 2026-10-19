'use strict';

/**
 * Единый источник правды по продуктовым константам Zvonitel.ru.
 * Клиент получает этот объект по GET /api/config, чтобы не дублировать словари.
 */

const GOALS = [
  { id: 'chat',        ru: 'Поболтать',        en: 'Just chat',      emoji: '💬' },
  { id: 'meet',        ru: 'Познакомиться',    en: 'Meet someone',   emoji: '🌸' },
  { id: 'friends',     ru: 'Найти друзей',     en: 'Make friends',   emoji: '🤝' },
  { id: 'couple',      ru: 'Пара',             en: 'Dating',         emoji: '❤️' },
  { id: 'topic',       ru: 'Обсудить тему',    en: 'Discuss a topic',emoji: '🎯' },
  { id: 'language',    ru: 'Практика языка',   en: 'Language swap',  emoji: '🌍' },
  { id: 'networking',  ru: 'Нетворкинг',       en: 'Networking',     emoji: '💼' },
  { id: 'support',     ru: 'Поддержка',        en: 'Support',        emoji: '🫂' },
];

const TOPICS = [
  { id: 'politics',   ru: 'Политика',    en: 'Politics',   emoji: '🗳️' },
  { id: 'economy',    ru: 'Экономика',   en: 'Economy',    emoji: '📈' },
  { id: 'art',        ru: 'Искусство',   en: 'Art',        emoji: '🎨' },
  { id: 'movies',     ru: 'Кино',        en: 'Movies',     emoji: '🎬' },
  { id: 'music',      ru: 'Музыка',      en: 'Music',      emoji: '🎧' },
  { id: 'games',      ru: 'Игры',        en: 'Games',      emoji: '🎮' },
  { id: 'sport',      ru: 'Спорт',       en: 'Sport',      emoji: '⚽' },
  { id: 'tech',       ru: 'Технологии',  en: 'Tech',       emoji: '💻' },
  { id: 'science',    ru: 'Наука',       en: 'Science',    emoji: '🔬' },
  { id: 'travel',     ru: 'Путешествия', en: 'Travel',     emoji: '✈️' },
  { id: 'psychology', ru: 'Психология',  en: 'Psychology', emoji: '🧠' },
  { id: 'relations',  ru: 'Отношения',   en: 'Relations',  emoji: '💞' },
  { id: 'humor',      ru: 'Юмор',        en: 'Humor',      emoji: '😂' },
  { id: 'memes',      ru: 'Мемы',        en: 'Memes',      emoji: '🐸' },
];

const STYLES = [
  { id: 'calm',       ru: 'Спокойный',    en: 'Calm',        emoji: '🌿' },
  { id: 'fun',        ru: 'Весёлый',      en: 'Fun',         emoji: '🎉' },
  { id: 'deep',       ru: 'Глубокий',     en: 'Deep',        emoji: '🌌' },
  { id: 'nopolitics', ru: 'Без политики', en: 'No politics', emoji: '🚫' },
];

const LANGUAGES = [
  { id: 'ru', label: 'Русский',  native: 'Русский', flag: '🇷🇺' },
  { id: 'en', label: 'English',  native: 'English', flag: '🇬🇧' },
  { id: 'uk', label: 'Українська', native: 'Українська', flag: '🇺🇦' },
  { id: 'de', label: 'Deutsch',  native: 'Deutsch', flag: '🇩🇪' },
  { id: 'es', label: 'Español',  native: 'Español', flag: '🇪🇸' },
  { id: 'fr', label: 'Français', native: 'Français', flag: '🇫🇷' },
  { id: 'tr', label: 'Türkçe',   native: 'Türkçe',  flag: '🇹🇷' },
  { id: 'zh', label: '中文',      native: '中文',     flag: '🇨🇳' },
];

/**
 * Фичи V2. Ключевое продуктовое правило (ТЗ §4.4): запись звонка возможна
 * ТОЛЬКО с явного согласия обоих участников. Это обеспечено и протоколом,
 * и интерфейсом: без взаимного подтверждения MediaRecorder не стартует.
 */
const V2 = {
  captions:    { premium: false, ru: 'Субтитры',        en: 'Live captions' },
  translate:   { premium: true,  ru: 'Перевод субтитров', en: 'Caption translation' },
  recording:   { premium: true,  ru: 'Запись звонка',   en: 'Call recording' },
  maxRecordingMs: 10 * 60_000,   // 10 минут — чтобы файл оставался подъёмным
};

const AGE_RANGES = [
  { id: '18-25', label: '18–25', min: 18, max: 25 },
  { id: '26-35', label: '26–35', min: 26, max: 35 },
  { id: '36-50', label: '36–50', min: 36, max: 50 },
  { id: '50+',   label: '50+',   min: 51, max: 120 },
];

const GENDERS = [
  { id: 'male',   ru: 'Мужской',  en: 'Male' },
  { id: 'female', ru: 'Женский',  en: 'Female' },
  { id: 'other',  ru: 'Другое',   en: 'Other' },
];

/**
 * Веса критериев матчинга.
 * HARD-критерии нарушать нельзя даже в «гибком» режиме, SOFT можно расслабить.
 */
const MATCH_WEIGHTS = {
  language: 26,   // HARD (если не any)
  goal:     22,   // HARD
  gender:   18,   // HARD (если не any)
  age:      14,   // HARD (если не any)
  topics:   12,   // SOFT
  style:     8,   // SOFT
};

/** Минимальный скор, ниже которого в «гибком» режиме пара не создаётся (0..100). */
const FLEXIBLE_MIN_SCORE = 55;

const REPORT_REASONS = [
  { id: 'nsfw',      ru: '18+ контент',        en: 'NSFW',        severity: 'high' },
  { id: 'violence',  ru: 'Насилие / угрозы',   en: 'Violence',    severity: 'high' },
  { id: 'insults',   ru: 'Оскорбления',        en: 'Insults',     severity: 'medium' },
  { id: 'spam',      ru: 'Спам',               en: 'Spam',        severity: 'medium' },
  { id: 'ads',       ru: 'Реклама',            en: 'Advertising', severity: 'medium' },
  { id: 'drugs',     ru: 'Наркотики',          en: 'Drugs',       severity: 'high' },
  { id: 'fraud',     ru: 'Мошенничество',      en: 'Fraud',       severity: 'high' },
  { id: 'minor',     ru: 'Несовершеннолетний', en: 'Minor',       severity: 'critical' },
  { id: 'other',     ru: 'Другое',             en: 'Other',       severity: 'low' },
];

const RATING_TAGS = [
  { id: 'interesting', ru: 'Интересный', en: 'Interesting', mood: 'good' },
  { id: 'polite',      ru: 'Вежливый',   en: 'Polite',      mood: 'good' },
  { id: 'funny',       ru: 'С юмором',   en: 'Funny',       mood: 'good' },
  { id: 'smart',       ru: 'Умный',      en: 'Smart',       mood: 'good' },
  { id: 'toxic',       ru: 'Токсичный',  en: 'Toxic',       mood: 'bad' },
  { id: 'spammer',     ru: 'Спамер',     en: 'Spammer',     mood: 'bad' },
  { id: 'silent',      ru: 'Молчун',     en: 'Silent',      mood: 'bad' },
  { id: 'rude',        ru: 'Грубый',     en: 'Rude',        mood: 'bad' },
];

const ACHIEVEMENTS = [
  { id: 'first_call',  ru: 'Первый звонок',  en: 'First call',   emoji: '📞', condition: 'calls>=1',   reward: 'Скидка 20% на Premium' },
  { id: 'calls_10',    ru: 'Десятка',        en: 'Ten calls',    emoji: '🔟', condition: 'calls>=10',  reward: '+50 монет' },
  { id: 'calls_100',   ru: 'Сотня',          en: '100 calls',    emoji: '💯', condition: 'calls>=100', reward: 'Premium на день' },
  { id: 'polyglot',    ru: 'Полиглот',       en: 'Polyglot',     emoji: '🌍', condition: 'langs>=2',   reward: 'Значок в профиле' },
  { id: 'night_owl',   ru: 'Ночной житель',  en: 'Night owl',    emoji: '🦉', condition: 'night>=3',   reward: 'Маска «Сова»' },
  { id: 'philosopher', ru: 'Философ',        en: 'Philosopher',  emoji: '🤔', condition: 'deep>=1800', reward: 'Тема «Глубокий разговор»' },
  { id: 'cinephile',   ru: 'Киноман',        en: 'Cinephile',    emoji: '🎬', condition: 'topic:movies>=3', reward: 'Значок «Киноман»' },
  { id: 'streak_7',    ru: 'Неделя подряд',  en: '7-day streak', emoji: '🔥', condition: 'streak>=7',  reward: 'Приоритет в очереди' },
  { id: 'social',      ru: 'Душа компании',  en: 'Social star',  emoji: '⭐', condition: 'friends>=5', reward: 'Premium на 3 дня' },
  { id: 'referral_3',  ru: 'Амбассадор',     en: 'Ambassador',   emoji: '🚀', condition: 'invited>=3', reward: 'Premium навсегда*' },
];

/** Лимиты по ролям (ТЗ §2). */
const LIMITS = {
  guest:    { skipsPerHour: 20, filters: false,  history: false,  premiumFeatures: false, friends: false },
  user:     { skipsPerHour: 60, filters: true,   history: true,   premiumFeatures: false, friends: true },
  premium:  { skipsPerHour: 1000, filters: true, history: true,  premiumFeatures: true,  friends: true },
};

/**
 * Квоты на звонки — основа монетизации.
 *   гость           — 1 звонок total (дальше просим регистрацию)
 *   зарегистрированный — 100 звонков в календарный месяц
 *   премиум         — безлимит + премиум-функции
 *
 * Считаем только СОСТОЯВШИЕСЯ звонки (P2P реально соединился): неудачное
 * подключение не должно сжигать квоту пользователя.
 */
const QUOTAS = {
  guest:   { calls: 1,        period: 'total', ru: '1 звонок',           en: '1 call' },
  user:    { calls: 100,      period: 'month', ru: '100 звонков в месяц', en: '100 calls / month' },
  premium: { calls: Infinity, period: 'month', ru: 'безлимит',            en: 'unlimited' },
  bot:     { calls: Infinity, period: 'month', ru: 'безлимит',            en: 'unlimited' },
};

/** Тарифы для лендинга и экрана Premium. */
const PLANS = [
  {
    id: 'guest', ru: 'Гость', en: 'Guest', price: '0 ₽', badge: null,
    tagline: 'Попробовать одним глазком',
    calls: '1 звонок',
    features: [
      'Случайный звонок без регистрации',
      'Базовые фильтры не нужны — сразу в эфир',
      'Жалобы и кнопка SOS',
    ],
    disabled: ['История звонков', 'Друзья и приватные комнаты', 'Звонок по логину', 'Запись и субтитры'],
    cta: 'Текущий', action: null,
  },
  {
    id: 'user', ru: 'Зарегистрированный', en: 'Registered', price: '0 ₽', badge: null,
    tagline: 'Полноценное общение',
    calls: '100 звонков в месяц',
    features: [
      'Умный подбор по интересам, целям и языку',
      'Все фильтры и режимы общения',
      'Звонок по логину другу',
      'История, друзья, приватные комнаты',
      'Достижения, рейтинг и монеты',
    ],
    disabled: ['Запись звонка', 'Перевод субтитров', 'Приоритет в очереди'],
    cta: 'Зарегистрироваться', action: 'register',
  },
  {
    id: 'premium', ru: 'Premium', en: 'Premium', price: '299 ₽/мес', badge: '🔥',
    tagline: 'Безлимит и всё включено',
    calls: 'Безлимитно',
    features: [
      'Безлимитные звонки',
      'Запись звонка — с согласия обоих',
      'Перевод субтитров в реальном времени',
      'Приоритет в очереди и гео-фильтры',
      'HD-видео, маски и без рекламы',
    ],
    disabled: [],
    cta: 'Подключить Premium', action: 'premium',
  },
];

/** Режимы звонка (виральные механики ТЗ §4.7). */
const MODES = {
  classic:     { ru: 'Классика',            en: 'Classic',         emoji: '🎥', desc: 'Обычный видеозвонок 1-на-1' },
  blind:       { ru: 'Свидание вслепую',    en: 'Blind date',      emoji: '🙈', desc: 'Первые 3 минуты — только голос, потом видео' },
  language:    { ru: 'Языковой обмен',      en: 'Language swap',   emoji: '🌍', desc: 'Половина времени на одном языке, половина — на другом' },
  voiceonly:   { ru: 'Только голос',        en: 'Voice only',      emoji: '🎙️', desc: 'Без камеры — меньше стеснения' },
  networking:  { ru: 'Нетворкинг',          en: 'Networking',      emoji: '💼', desc: 'Профессиональный разговор по интересам' },
  support:     { ru: 'Поддержка',           en: 'Support',         emoji: '🫂', desc: 'Собеседник, который выслушает' },
};

module.exports = {
  MATCH_WEIGHTS,
  FLEXIBLE_MIN_SCORE,
  GOALS, TOPICS, STYLES, LANGUAGES, AGE_RANGES, GENDERS,
  REPORT_REASONS, RATING_TAGS, ACHIEVEMENTS, LIMITS, MODES, V2, QUOTAS, PLANS,
  // тайминги матчинга
  RELAX_PROMPT_AFTER_MS: 30_000,   // ТЗ §4.1: 30 секунд без пары — предложить расширить фильтры
  COOLDOWN_MS: 30 * 60_000,        // ТЗ §4.1: не соединять повторно 30 минут
  RECONNECT_GRACE_MS: 10_000,      // ТЗ §5.10: 10 секунд на переподключение
  BLIND_REVEAL_MS: 180_000,        // слепое свидание: раскрытие видео
  TICK_MS: 1_500,                  // период цикла матчинга
};
