'use strict';
/**
 * Интеграционный тест: поднимает реальный сервер и прогоняет продуктовые сценарии
 * через Socket.IO-клиентов (очередь → матч → звонок → скип → оценка → жалобы → комната).
 * Запуск: PORT=3111 DATA_DIR=/tmp/... node --test test/integration.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/zv-integration-' + process.pid;

let serverProc;
const clients = [];

/* ---------- helpers ---------- */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(url, opts = {}) {
  const res = await fetch(BASE + url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: 'Bearer ' + opts.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

class Client {
  constructor(name) { this.name = name; this.events = []; this.waiters = []; this.seq = 0; }
  async connect(auth = {}) {
    this.socket = io(BASE, { transports: ['websocket'], auth, reconnection: false, forceNew: true });
    clients.push(this);
    this.socket.onAny((event, payload) => {
      this.events.push({ event, payload, seq: ++this.seq });
      this.waiters = this.waiters.filter(w => {
        if (w.event !== event || w.after >= this.seq) return true;
        w.resolve(payload); return false;
      });
    });
    const welcome = this.waitFor('welcome', 8000);
    this.welcome = await welcome;
    return this.welcome;
  }
  /**
   * Ждать событие. По умолчанию учитывает и уже полученные (события в тестах часто
   * приходят быстрее, чем регистрируется ожидание). Для «не считать старое» — waitForNext.
   */
  waitFor(event, timeout = 8000) {
    const hit = [...this.events].reverse().find(e => e.event === event);
    if (hit) return Promise.resolve(hit.payload);
    return this.waitForNext(event, timeout);
  }
  /** Ждать только то, что придёт ПОСЛЕ вызова. */
  waitForNext(event, timeout = 8000) {
    const after = this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${this.name}] timeout waiting "${event}"`)), timeout);
      this.waiters.push({ event, after, resolve: (p) => { clearTimeout(timer); resolve(p); } });
    });
  }
  last(event) { return [...this.events].reverse().find(e => e.event === event)?.payload; }
  count(event) { return this.events.filter(e => e.event === event).length; }
  emit(event, payload = {}) {
    return new Promise((resolve) => this.socket.emit(event, payload, resolve));
  }
  close() { this.socket?.close(); }
}

/* ---------- lifecycle ---------- */

test.before(async () => {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASS: 'zvonitel', PUBLIC_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write(`[srv] ${d}`));
  serverProc.stderr.on('data', d => process.stdout.write(`[srv:err] ${d}`));

  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('server did not start');
});

test.after(() => {
  clients.forEach(c => c.close());
  serverProc?.kill('SIGKILL');
});

/* ---------- 1. публичные эндпоинты ---------- */

test('GET /api/health и /api/config отдают продукт-конфиг', async () => {
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);

  const cfg = await api('/api/config');
  assert.ok(cfg.data.goals.length >= 8, 'цели общения из ТЗ §1.2');
  assert.ok(cfg.data.topics.length >= 14, 'темы из ТЗ §1.2');
  assert.ok(cfg.data.modes.blind, 'режим «свидание вслепую» из ТЗ §4.7');
  assert.ok(cfg.data.reportReasons.some(r => r.id === 'nsfw'), 'причины жалоб из ТЗ §1.8');
});

/* ---------- 2. регистрация + реферальная механика ---------- */

let inviter, invitee, third;
test('регистрация: приветственные монеты, реферальный бонус пригласившему', async () => {
  const a = await api('/api/auth/register', { method: 'POST', body: { nick: 'Inviter', password: 'test1234', age: 30, gender: 'male', languages: ['ru'], goals: ['chat'], topics: ['movies'] } });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  inviter = { ...a.data.user, token: a.data.token };
  assert.equal(inviter.coins, 20, 'приветственный бонус 20 монет');
  assert.equal(inviter.isPremium, false);

  const refCode = inviter.id.replace('u_', '').slice(0, 10);
  const b = await api('/api/auth/register', { method: 'POST', body: { nick: 'Invitee', password: 'test1234', age: 24, gender: 'female', languages: ['ru'], goals: ['chat'], topics: ['movies'], ref: refCode } });
  assert.equal(b.status, 200);
  invitee = { ...b.data.user, token: b.data.token };

  const after = await api('/api/me', { token: inviter.token });
  assert.equal(after.data.user.isPremium, true, 'ТЗ §4.7: пригласил друга — Premium на день');
  assert.equal(after.data.user.invitedCount, 1);
  assert.ok(after.data.user.coins >= 70, `монеты за реферала: ${after.data.user.coins}`);
  assert.ok(after.data.referral.link.includes(refCode));
});

test('дубль ника и короткий пароль отклоняются', async () => {
  assert.equal((await api('/api/auth/register', { method: 'POST', body: { nick: 'Inviter', password: 'test1234' } })).status, 409);
  assert.equal((await api('/api/auth/register', { method: 'POST', body: { nick: 'Shorty', password: '12' } })).status, 400);
});

/* ---------- 3. очередь и матч ---------- */

let alice, bob;
test('два пользователя в очереди получают матч с взаимным скором', async () => {
  alice = new Client('alice'); await alice.connect({ token: inviter.token });
  bob = new Client('bob'); await bob.connect({ token: invitee.token });

  assert.equal(alice.welcome.user.nick, 'Inviter');
  assert.equal(bob.welcome.role, 'user');

  const qa = await alice.emit('queue:join', { filters: { language: 'ru', goal: 'any', gender: 'any', age: 'any', topics: [], style: 'any' }, strict: false, mode: 'classic' });
  assert.equal(qa.ok, true);
  const qb = await bob.emit('queue:join', { filters: { language: 'ru', goal: 'any', gender: 'any', age: 'any', topics: [], style: 'any' }, strict: false, mode: 'classic' });
  assert.equal(qb.ok, true);

  const [ma, mb] = await Promise.all([alice.waitFor('matched', 12000), bob.waitFor('matched', 12000)]);
  assert.equal(ma.callId, mb.callId, 'пара получила один и тот же звонок');
  assert.equal(ma.initiator, true, 'ровно один инициатор');
  assert.equal(mb.initiator, false);
  assert.equal(ma.peer.nick, 'Invitee');
  assert.equal(mb.peer.nick, 'Inviter');
  assert.ok(ma.score >= 55, `скор взаимного совпадения ${ma.score}`);
  assert.ok(ma.question, 'генератор вопросов выдал тему для разговора');
  assert.ok(Array.isArray(ma.mutualTopics), 'общие темы видны в звонке');
});

test('гость без капчи в очередь не попадает (антибот, ТЗ §4.4)', async () => {
  const guest = new Client('guest'); await guest.connect({});
  const res = await guest.emit('queue:join', { filters: { language: 'ru' } });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'captcha');
  const cap = await new Promise(r => guest.socket.emit('captcha:get', {}, r));
  const [n1, n2] = cap.question.split('+').map(s => parseInt(s, 10));
  const solved = await new Promise(r => guest.socket.emit('captcha:solve', { id: cap.id, answer: n1 + n2 }, r));
  assert.equal(solved.ok, true);
  const res2 = await guest.emit('queue:join', { filters: { language: 'ru' } });
  assert.equal(res2.ok, true, 'после капчи гость может звонить');
  await guest.emit('queue:leave');
  guest.close();
});

/* ---------- 4. чат и автомодерация ---------- */

test('чат: обычное сообщение доходит, реклама и оскорбления блокируются', async () => {
  const callId = alice.last('matched').callId;

  const receivedP = bob.waitFor('chat:message', 5000);
  const ok = await alice.emit('chat:message', { callId, text: 'Привет! Как настроение?' });
  assert.equal(ok.ok, true);
  assert.equal((await receivedP).text, 'Привет! Как настроение?');

  const spam = await alice.emit('chat:message', { callId, text: 'Переходи по ссылке http://casino.ru и заработай' });
  assert.equal(spam.ok, false, 'спам/реклама не проходят');
  assert.equal(spam.reason, 'ads');

  const insult = await alice.emit('chat:message', { callId, text: 'ты идиот' });
  assert.equal(insult.ok, false);
  assert.equal(insult.reason, 'insults');
});

test('реакция долетает до собеседника', async () => {
  const callId = alice.last('matched').callId;
  const p = bob.waitFor('reaction', 5000);
  alice.socket.emit('reaction', { callId, emoji: '😂' });
  assert.equal((await p).emoji, '😂');
});

/* ---------- 5. скип и повторная очередь ---------- */

test('скип: оба возвращаются в очередь и не рематчатся (ТЗ §3.6)', async () => {
  const callId = alice.last('matched').callId;
  const skippedP = bob.waitForNext('call:skipped', 6000);
  const requeueP = Promise.all([alice.waitForNext('queue:joined', 6000), bob.waitForNext('queue:joined', 6000)]);

  const res = await alice.emit('call:skip', { callId });
  assert.equal(res.ok, true);
  assert.equal((await skippedP).by, 'Inviter');
  await requeueP;

  await sleep(3200);
  assert.equal(alice.count('matched'), 1, 'после скипа пара не соединяется повторно');

  const adminLogin = await api('/api/auth/login', { method: 'POST', body: { nick: 'admin', password: 'zvonitel' } });
  const q = await api('/api/admin/queue', { token: adminLogin.data.token });
  assert.equal(q.data.queue.length, 2, `в очереди должно быть 2 человека, а ${q.data.queue.length}`);

  await alice.emit('queue:leave'); await bob.emit('queue:leave');
});

/* ---------- 6. оценка и репутация ---------- */

test('оценка меняет рейтинг собеседника', async () => {
  const callId = alice.last('matched').callId;
  const res = await alice.emit('rate', { callId, stars: 5, tags: ['interesting', 'polite'] });
  assert.equal(res.ok, true);
  const fresh = await api('/api/public/users/' + invitee.id);
  assert.equal(fresh.data.user.rating, 5, 'рейтинг пересчитан');
  assert.equal(fresh.data.user.ratingCount, 1);
});

/* ---------- 7. блокировка ---------- */

test('блокировка: пара больше не соединяется (ТЗ §1.9)', async () => {
  const bl = await alice.emit('block', { target: invitee.id });
  assert.equal(bl.ok, true);

  await alice.emit('queue:join', { filters: { language: 'ru' } });
  await bob.emit('queue:join', { filters: { language: 'ru' } });
  await sleep(3500);
  const matchesAlice = alice.events.filter(e => e.event === 'matched').length;
  assert.equal(matchesAlice, 1, 'заблокированные не встречаются снова');

  await alice.emit('queue:leave'); await bob.emit('queue:leave');
  await alice.emit('block:remove', { target: invitee.id });
});

/* ---------- 8. жалоба и страйки ---------- */

test('жалоба создаёт репорт и выдаёт нарушителю страйк', async () => {
  const res = await alice.emit('report', { target: invitee.id, reason: 'insults', comment: 'оскорблял в чате' });
  assert.equal(res.ok, true);
  assert.ok(res.id);

  const u = await api('/api/public/users/' + invitee.id);
  assert.equal(u.data.user.reports, 1, 'жалоба учтена в профиле');
  assert.equal(u.data.user.strikes, 1, 'выдан страйк');
});

test('жалоба 18+ приводит к немедленному бану', async () => {
  third = new Client('third');
  const reg = await api('/api/auth/register', { method: 'POST', body: { nick: 'BadGuy', password: 'test1234', age: 28 } });
  await third.connect({ token: reg.data.token });

  const res = await alice.emit('report', { target: reg.data.user.id, reason: 'nsfw' });
  assert.equal(res.ok, true);
  const action = await third.waitFor('moderation:action', 6000);
  assert.equal(action.action, 'ban');

  const u = await api('/api/public/users/' + reg.data.user.id);
  assert.equal(u.data.user.isBanned, true);
  third.close();
});

/* ---------- 9. приватная комната ---------- */

test('приватная комната по коду соединяет двоих (ТЗ §3.8)', async () => {
  const carol = new Client('carol');
  const dave = new Client('dave');
  const rc = await api('/api/auth/register', { method: 'POST', body: { nick: 'Carol', password: 'test1234', age: 26, gender: 'female' } });
  const rd = await api('/api/auth/register', { method: 'POST', body: { nick: 'Dave', password: 'test1234', age: 29, gender: 'male' } });
  await carol.connect({ token: rc.data.token });
  await dave.connect({ token: rd.data.token });

  const created = await carol.emit('room:create', { mode: 'classic' });
  assert.equal(created.ok, true);
  assert.match(created.room.code, /^[a-z0-9]{6}$/);
  assert.ok(created.link.endsWith('/r/' + created.room.code));

  const joined = await dave.emit('room:join', { code: created.room.code });
  assert.equal(joined.ok, true);

  const [m1, m2] = await Promise.all([carol.waitFor('matched', 8000), dave.waitFor('matched', 8000)]);
  assert.equal(m1.room, created.room.code);
  assert.equal(m1.callId, m2.callId);

  const wrong = await dave.emit('room:join', { code: 'zzzzzz' });
  assert.equal(wrong.ok, false);
  carol.close(); dave.close();
});

/* ---------- 9b. завершение звонка и учёт ---------- */

test('hangup: звонок засчитывается, метрики и геймификация обновляются (ТЗ §5.7)', async () => {
  // отдельная пара, чтобы предыдущие тесты (скипы, блокировки) не влияли на результат
  const h1 = new Client('h1'), h2 = new Client('h2');
  const r1 = await api('/api/auth/register', { method: 'POST', body: { nick: 'Hang1', password: 'test1234', age: 31, gender: 'male' } });
  const r2 = await api('/api/auth/register', { method: 'POST', body: { nick: 'Hang2', password: 'test1234', age: 28, gender: 'female' } });
  await h1.connect({ token: r1.data.token });
  await h2.connect({ token: r2.data.token });

  const before = await api('/api/metrics');
  const filters = { language: 'ru', goal: 'any', gender: 'any', age: 'any', topics: [], style: 'any' };
  await Promise.all([
    h1.emit('queue:join', { filters, mode: 'classic' }),
    h2.emit('queue:join', { filters, mode: 'classic' }),
  ]);
  const matched = await Promise.all([h1.waitForNext('matched', 15000), h2.waitForNext('matched', 15000)]);
  assert.equal(matched[0].callId, matched[1].callId, 'пара получила общий звонок');
  assert.equal(h1.count('matched'), 1);

  await sleep(5200); // дольше порога «звонок состоялся» (5 секунд)

  const peerLeft = h2.waitForNext('call:peer-left', 6000);
  const ended1 = h1.waitForNext('call:ended', 8000);
  const ended2 = h2.waitForNext('call:ended', 8000);
  const res = await h1.emit('call:hangup', { callId: matched[0].callId });
  assert.equal(res.ok, true);
  assert.equal((await peerLeft).callId, matched[0].callId, 'второй увидел, что собеседник завершил');

  const e1 = await ended1;
  const e2 = await ended2;
  assert.equal(e1.endReason, 'hangup');
  assert.equal(e1.tooShort, undefined, 'звонок длиннее 5 секунд засчитывается');
  assert.ok(e1.durationMs >= 5000, `длительность ${e1.durationMs} мс`);
  assert.ok(Array.isArray(e1.quests), 'в ответе пришёл прогресс заданий');
  assert.ok(e1.level && e1.level.level >= 1, 'пришёл уровень');
  assert.ok(Array.isArray(e1.achievements), 'пришли достижения');
  assert.ok(e2.durationMs >= 5000);

  const u1 = await api('/api/public/users/' + r1.data.user.id);
  const u2 = await api('/api/public/users/' + r2.data.user.id);
  assert.equal(u1.data.user.calls, 1, 'звонок записан первому участнику');
  assert.equal(u2.data.user.calls, 1, 'и второму');
  assert.ok(u1.data.user.talkSeconds >= 5, 'секунды разговора учтены');
  assert.equal(u1.data.user.streak, 1, 'серия дней началась');

  const after = await api('/api/metrics');
  assert.equal(after.data.totalCalls, before.data.totalCalls + 1, 'счётчик звонков на лендинге вырос');

  // после «Завершить» в очередь автоматически не возвращаем — человек оценивает собеседника
  await sleep(2500);
  const adminLogin = await api('/api/auth/login', { method: 'POST', body: { nick: 'admin', password: 'zvonitel' } });
  const q = await api('/api/admin/queue', { token: adminLogin.data.token });
  const stillQueued = q.data.queue.filter(e => [r1.data.user.id, r2.data.user.id].includes(e.id));
  assert.equal(stillQueued.length, 0, 'после hangup пользователь не висит в очереди');

  h1.close(); h2.close();
});

test('запрос в друзья: двустороннее согласие (ТЗ §4.5)', async () => {
  const erin = new Client('erin');
  const reg = await api('/api/auth/register', { method: 'POST', body: { nick: 'Erin', password: 'test1234', age: 27, gender: 'female' } });
  await erin.connect({ token: reg.data.token });

  const requestedP = erin.waitFor('friend:requested', 6000);
  const r1 = await alice.emit('friend:request', { target: reg.data.user.id });
  assert.equal(r1.status, 'pending', 'пока вторая сторона не согласилась');
  assert.equal((await requestedP).from.nick, 'Inviter');

  const acceptedP = alice.waitFor('friend:accepted', 6000);
  await erin.emit('friend:accept', { target: inviter.id });
  const acc = await acceptedP;
  assert.equal(acc.user.nick, 'Erin');

  const me = await api('/api/me', { token: inviter.token });
  const friend = me.data.friends.find(f => f.nick === 'Erin');
  assert.equal(friend.status, 'accepted');
  erin.close();
});

/* ---------- 10. геймификация ---------- */

test('задания дня, уровни и достижения считаются', async () => {
  const me = await api('/api/me', { token: inviter.token });
  assert.ok(Array.isArray(me.data.quests) && me.data.quests.length === 3, 'три ежедневных задания');
  assert.ok(me.data.quests.every(q => q.target > 0 && q.reward > 0));
  assert.ok(me.data.level.level >= 1);
  assert.ok(me.data.level.next > me.data.level.xp, 'прогресс уровня осмысленный');

  // «Полиглот» должен открыться после добавления второго языка
  await api('/api/me', { method: 'PATCH', token: inviter.token, body: { languages: ['ru', 'en'] } });
  const after = await api('/api/me', { token: inviter.token });
  const unlocked = after.data.achievements.filter(a => a.unlocked).map(a => a.id);
  assert.ok(unlocked.includes('polyglot'), `ожидали «Полиглот», открыты: ${unlocked.join(', ')}`);
  assert.ok(after.data.achievements.some(a => a.id === 'first_call'));
});

/* ---------- 11. админка ---------- */

test('админ видит метрики, жалобы и очередь; обычный пользователь — нет', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: { nick: 'admin', password: 'zvonitel' } });
  assert.equal(login.status, 200);
  const token = login.data.token;

  const forbidden = await api('/api/admin/metrics', { token: inviter.token });
  assert.equal(forbidden.status, 403);

  const m = await api('/api/admin/metrics', { token });
  assert.equal(m.status, 200);
  for (const key of ['online', 'inQueue', 'totalCalls', 'avgCallSeconds', 'reportsPer1000', 'viralCoefficient', 'skipRate']) {
    assert.ok(key in m.data, `метрика ${key} из ТЗ §9 отсутствует`);
  }

  const reports = await api('/api/admin/reports', { token });
  assert.ok(reports.data.items.length >= 2, 'жалобы видны модератору');

  const resolve = await api('/api/admin/reports/' + reports.data.items[0].id, { method: 'POST', token, body: { action: 'warn' } });
  assert.equal(resolve.status, 200);
  assert.equal(resolve.data.report.status, 'resolved');

  const users = await api('/api/admin/users', { token });
  assert.ok(users.data.items.length >= 3);
});

test('лидерборд отдаёт топ по звонкам', async () => {
  const lb = await api('/api/leaderboard?metric=calls_total');
  assert.equal(lb.status, 200);
  assert.ok(Array.isArray(lb.data.items));
});
