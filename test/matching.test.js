'use strict';
/**
 * Юнит-тесты ядра матчинга (node --test).
 * Проверяют правила ТЗ §4.1/§5 на реальных функциях MatchingEngine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { MatchingEngine } = require('../server/matching');
const { COOLDOWN_MS } = require('../server/config');

const entry = (over = {}) => ({
  id: over.id || 'u_a', socketId: 's1', nick: 'A', isPremium: false, role: 'user',
  joinedAt: Date.now(), strict: false, mode: 'classic',
  profile: { nick: 'A', age: 25, gender: 'male', languages: ['ru'], goals: ['chat'], topics: ['movies'], style: 'fun' },
  filters: { language: 'ru', goal: 'any', gender: 'any', age: 'any', topics: [], style: 'any' },
  ...over,
});

test('взаимное совпадение: фильтр A подходит профилю B и наоборот', () => {
  const a = entry({ id: 'u_a', profile: { age: 27, gender: 'male', languages: ['ru'], goals: ['meet'], topics: ['movies'], style: 'calm' },
    filters: { language: 'ru', goal: 'any', gender: 'female', age: '18-25', topics: [], style: 'any' } });
  const b = entry({ id: 'u_b', profile: { age: 23, gender: 'female', languages: ['ru'], goals: ['meet'], topics: ['music'], style: 'calm' },
    filters: { language: 'ru', goal: 'any', gender: 'male', age: '26-35', topics: [], style: 'any' } });

  const m = MatchingEngine.mutual(a, b);
  assert.equal(m.ok, true, 'пара должна подходить друг другу (пример из ТЗ §4.1)');
  assert.ok(m.score >= 55, `скор ${m.score} должен быть ≥ 55 для гибкого матча`);
});

test('невзаимный интерес пары не создаёт', () => {
  const a = entry({ id: 'u_a', filters: { language: 'ru', goal: 'any', gender: 'female', age: 'any', topics: [], style: 'any' } });
  const b = entry({ id: 'u_b', profile: { age: 30, gender: 'male', languages: ['ru'], goals: ['chat'], topics: [], style: 'fun' } });
  const m = MatchingEngine.mutual(a, b);
  assert.equal(m.ok, false, 'A хочет женщину, B — мужчина: совпадения быть не должно');
});

test('язык — жёсткий критерий', () => {
  const a = entry({ id: 'u_a', filters: { language: 'en', goal: 'any', gender: 'any', age: 'any', topics: [], style: 'any' } });
  const b = entry({ id: 'u_b', profile: { age: 25, gender: 'male', languages: ['ru'], goals: ['chat'], topics: [], style: 'fun' } });
  assert.equal(MatchingEngine.mutual(a, b).ok, false);
});

test('«без политики» блокирует пару с темой «политика»', () => {
  const a = entry({ id: 'u_a', filters: { language: 'ru', goal: 'any', gender: 'any', age: 'any', topics: ['politics'], style: 'any' } });
  const b = entry({ id: 'u_b', profile: { age: 25, gender: 'female', languages: ['ru'], goals: ['chat'], topics: ['politics'], style: 'nopolitics' } });
  assert.equal(MatchingEngine.mutual(a, b).ok, false);
});

test('строгий режим требует общего интереса и высокого скора', () => {
  const a = entry({ id: 'u_a', strict: true, profile: { age: 25, gender: 'male', languages: ['ru'], goals: ['chat'], topics: ['movies'], style: 'fun' } });
  const b = entry({ id: 'u_b', strict: true, profile: { age: 24, gender: 'female', languages: ['ru'], goals: ['chat'], topics: ['games'], style: 'fun' } });
  const m = MatchingEngine.mutual(a, b);
  assert.equal(m.strictOk, false, 'без общих тем строгий матч не создаётся');

  b.profile.topics = ['movies', 'games'];
  const m2 = MatchingEngine.mutual(a, b);
  assert.equal(m2.flexibleOk, true);
});

test('очередь: premium и долго ждущие получают приоритет', () => {
  const eng = new MatchingEngine();
  const now = Date.now();
  const fresh = entry({ id: 'u_fresh', joinedAt: now });
  const waited = entry({ id: 'u_waited', joinedAt: now - 120_000 });
  const prem = entry({ id: 'u_prem', joinedAt: now, isPremium: true });
  assert.ok(eng.priority(prem) > eng.priority(waited), 'premium выше любого ожидания');
  assert.ok(eng.priority(waited) > eng.priority(fresh), 'кто ждёт дольше — выше');
});

test('tick соединяет совместимую пару и убирает её из очереди', () => {
  const eng = new MatchingEngine();
  eng.enqueue(entry({ id: 'u_1' }));
  eng.enqueue(entry({ id: 'u_2', socketId: 's2' }));
  const pairs = eng.tick();
  assert.equal(pairs.length, 1, 'должна создаться ровно одна пара');
  assert.equal(eng.size(), 0, 'очередь пуста после матча');
});

test('tick не соединяет несовместимых', () => {
  const eng = new MatchingEngine();
  eng.enqueue(entry({ id: 'u_1', filters: { language: 'ru', goal: 'any', gender: 'female', age: 'any', topics: [], style: 'any' } }));
  eng.enqueue(entry({ id: 'u_2', socketId: 's2', profile: { age: 25, gender: 'male', languages: ['ru'], goals: ['chat'], topics: [], style: 'fun' } }));
  assert.equal(eng.tick().length, 0);
  assert.equal(eng.size(), 2, 'оба остались ждать');
});

test('повторный матч запрещён на 30 минут (ТЗ §4.1)', () => {
  const eng = new MatchingEngine();
  eng.enqueue(entry({ id: 'u_1' }));
  eng.enqueue(entry({ id: 'u_2', socketId: 's2' }));
  assert.equal(eng.tick().length, 1);

  eng.enqueue(entry({ id: 'u_1' }));
  eng.enqueue(entry({ id: 'u_2', socketId: 's2' }));
  assert.equal(eng.tick().length, 0, 'тех же двоих сразу соединять нельзя');

  // сдвигаем метку времени за пределы кулдауна
  const key = eng.pairKey('u_1', 'u_2');
  eng.recentPairs.set(key, Date.now() - COOLDOWN_MS - 1000);
  assert.equal(eng.tick().length, 1, 'после 30 минут можно снова');
});

test('жалоба добавляет пару в чёрный список навсегда', () => {
  const eng = new MatchingEngine();
  eng.blacklistPair('u_1', 'u_2');
  assert.equal(eng.pairAllowed('u_1', 'u_2'), false);
  assert.equal(eng.pairAllowed('u_2', 'u_1'), false, 'ключ симметричный');
  assert.equal(eng.pairAllowed('u_1', 'u_3'), true);
});

test('теневой бан живёт в отдельной очереди', () => {
  const eng = new MatchingEngine();
  eng.enqueue(entry({ id: 'u_ok' }));
  eng.enqueue(entry({ id: 'u_shadow', socketId: 's2', shadow: true }));
  assert.equal(eng.tick().length, 0, 'обычный и теневой пользователь не встречаются');
  assert.equal(eng.size(false), 1);
  assert.equal(eng.size(true), 1);
});

test('relaxationAdvice предлагает, что ослабить', () => {
  const eng = new MatchingEngine();
  const e = entry({ id: 'u_1', filters: { language: 'ru', goal: 'any', gender: 'female', age: '18-25', topics: ['movies'], style: 'any' } });
  const advice = eng.relaxationAdvice(e);
  assert.ok(advice.length >= 2);
  assert.ok(advice.some(a => a.key === 'age'));
});
