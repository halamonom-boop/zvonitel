'use strict';
/**
 * Интеграционные тесты новых продуктовых правил:
 *   • квоты на звонки: гость 1, зарегистрированный 100/мес, премиум — безлимит
 *   • звонок по логину: адресный вызов с явным согласием вызываемого
 *
 * Запуск: node --test --test-concurrency=1 test/quota-direct.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const path = require('node:path');

const PORT = 3112;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '/tmp/zv-quota-' + process.pid;

let serverProc;
const clients = [];
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
    this.welcome = await this.waitFor('welcome', 10000);
    return this.welcome;
  }
  waitFor(event, timeout = 10000) {
    const hit = [...this.events].reverse().find(e => e.event === event);
    if (hit) return Promise.resolve(hit.payload);
    return this.waitForNext(event, timeout);
  }
  waitForNext(event, timeout = 10000) {
    const after = this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${this.name}] timeout waiting "${event}"`)), timeout);
      this.waiters.push({ event, after, resolve: (p) => { clearTimeout(timer); resolve(p); } });
    });
  }
  last(event) { return [...this.events].reverse().find(e => e.event === event)?.payload; }
  count(event) { return this.events.filter(e => e.event === event).length; }
  /** Для событий, которые отвечают ack (queue:join, direct:call, block, captcha:*). */
  emit(event, payload = {}) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 6000); // страховка от «повисшего» ack
      this.socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
    });
  }
  /** Для событий-уведомлений без ответа (rtc:state, call:hangup) — не ждём ack. */
  send(event, payload = {}) { this.socket.emit(event, payload); return Promise.resolve(); }
  close() { this.socket?.close(); }

  /** Гостю нужна капча, иначе в очередь не пустят (антибот). */
  async solveCaptcha() {
    const cap = await this.emit('captcha:get');
    const [a, b] = cap.question.split('+').map(s => parseInt(s, 10));
    return this.emit('captcha:solve', { id: cap.id, answer: a + b });
  }
  async joinQueue(extra = {}) {
    return this.emit('queue:join', {
      filters: { language: 'ru', goal: 'any', gender: 'any', age: 'any', topics: [], style: 'any' },
      strict: false, mode: 'classic', ...extra,
    });
  }
}

/* ---------- lifecycle ---------- */

test.before(async () => {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASS: 'zvonitel', PUBLIC_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', d => process.stdout.write(`[srv:err] ${d}`));
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('server did not start');
});

// Клиенты закрываем после каждого теста: иначе упавший тест оставляет
// «висящие» записи в очереди, и они ломают следующие сценарии.
test.afterEach(() => { clients.splice(0).forEach(c => c.close()); });

test.after(() => { clients.forEach(c => c.close()); serverProc?.kill('SIGKILL'); });

/** Сводит двоих через очередь и доводит P2P до состояния connected (квота списывается). */
async function connectPair(a, b) {
  await a.joinQueue();
  await b.joinQueue();
  const [ma, mb] = await Promise.all([a.waitFor('matched', 15000), b.waitFor('matched', 15000)]);
  const callId = ma.callId;
  const connectedP = Promise.all([a.waitForNext('call:connected', 8000), b.waitForNext('call:connected', 8000)]);
  await a.send('rtc:state', { callId, state: 'connected' });
  const [ca, cb] = await connectedP;
  return { callId, quotaA: ca.quota, quotaB: cb.quota, ma, mb };
}

async function register(nick) {
  const r = await api('/api/auth/register', {
    method: 'POST', body: { nick, password: 'test1234', age: 26, gender: 'other', languages: ['ru'], goals: ['chat'], topics: ['movies'] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

/* ============================================================
   1. Тарифы
   ============================================================ */

test('тарифы описывают три уровня: гость 1, пользователь 100/мес, премиум — безлимит', async () => {
  const cfg = await api('/api/config');
  assert.equal(cfg.status, 200);
  const plans = cfg.data.plans;
  assert.equal(plans.length, 3, 'ровно три тарифа');
  assert.match(plans[0].calls, /1 звонок/, 'гость — 1 звонок');
  assert.match(plans[1].calls, /100/, 'зарегистрированный — 100 в месяц');
  assert.match(plans[2].calls, /[Бб]езлимит/, 'премиум — безлимит');
});

/* ============================================================
   2. Квоты
   ============================================================ */

test('гость: ровно один звонок, вторая попытка блокируется с понятной причиной', async () => {
  const g1 = new Client('guest1');
  const w1 = await g1.connect({});
  assert.equal(w1.role, 'guest');
  assert.equal(w1.quota.calls, 1, 'гостю доступен 1 звонок');
  assert.equal(w1.quota.left, 1);
  assert.equal(w1.quota.period, 'total');
  assert.equal(w1.quota.unlimited, false);

  const g2 = new Client('guest2');
  await g2.connect({});
  assert.equal(g2.welcome.quota.left, 1);

  await g1.solveCaptcha();
  await g2.solveCaptcha();

  const { callId, quotaA, quotaB } = await connectPair(g1, g2);
  assert.equal(quotaA.left, 0, 'после состоявшегося звонка у гостя не осталось квоты');
  assert.equal(quotaB.left, 0, 'и у собеседника-гостя тоже');

  await g1.send('call:hangup', { callId });
  await sleep(300);

  // вторая попытка — честный отказ с объяснением, а не молчаливое «ничего не происходит»
  const again = await g1.joinQueue({ captchaSolved: true });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'quota', 'исчерпавшему квоту гостю отказано в постановке в очередь');
  assert.ok(again.quota, 'вместе с отказом пришло состояние квоты — чтобы показать апселл');
  assert.equal(again.quota.left, 0);

  g1.close(); g2.close();
});

test('зарегистрированный: 100 звонков в месяц, после одного остаётся 99', async () => {
  const a = await register('QuotaA');
  const b = await register('QuotaB');
  const ca = new Client('qa'); const w = await ca.connect({ token: a.token });
  const cb = new Client('qb'); await cb.connect({ token: b.token });

  assert.equal(w.quota.role, 'user');
  assert.equal(w.quota.calls, 100, 'лимит зарегистрированного — 100');
  assert.equal(w.quota.left, 100);
  assert.equal(w.quota.period, 'month');
  assert.ok(w.quota.resetAt > Date.now(), 'известна дата сброса квоты');

  const { callId, quotaA } = await connectPair(ca, cb);
  assert.equal(quotaA.left, 99, 'один состоявшийся звонок = минус один из ста');

  await ca.send('call:hangup', { callId });
  ca.close(); cb.close();
});

test('неудачное подключение не сжигает квоту — платим только за состоявшийся разговор', async () => {
  const a = await register('NoConnA');
  const b = await register('NoConnB');
  const ca = new Client('nca'); await ca.connect({ token: a.token });
  const cb = new Client('ncb'); await cb.connect({ token: b.token });

  await ca.joinQueue();
  await cb.joinQueue();
  const [ma] = await Promise.all([ca.waitFor('matched', 15000), cb.waitFor('matched', 15000)]);

  // P2P не поднялся — звонок завершается по таймауту, rtc:state 'connected' не было
  await ca.send('call:hangup', { callId: ma.callId });
  await sleep(300);

  const q = (await ca.emit('queue:join', {
    filters: { language: 'ru', goal: 'any', gender: 'any', age: 'any', topics: [], style: 'any' },
  }));
  assert.equal(q.ok, true, 'квота не списана — можно звонить снова');
  await ca.emit('queue:leave');
  ca.close(); cb.close();
});

test('премиум: безлимит, квота не расходуется', async () => {
  const admin = await api('/api/auth/login', { method: 'POST', body: { nick: 'admin', password: 'zvonitel' } });
  assert.equal(admin.status, 200, 'админ может войти');

  const a = await register('PremA');
  const b = await register('PremB');
  await api(`/api/admin/users/${a.user.id}/premium`, { method: 'POST', token: admin.data.token, body: { ms: 86400000 } });
  await api(`/api/admin/users/${b.user.id}/premium`, { method: 'POST', token: admin.data.token, body: { ms: 86400000 } });

  const ca = new Client('pa'); const w = await ca.connect({ token: a.token });
  const cb = new Client('pb'); await cb.connect({ token: b.token });
  assert.equal(w.quota.unlimited, true, 'у премиум-пользователя безлимит');
  assert.equal(w.quota.left, null);

  const { callId, quotaA } = await connectPair(ca, cb);
  assert.equal(quotaA.unlimited, true, 'после звонка лимит по-прежнему не ограничен');

  await ca.send('call:hangup', { callId });
  await sleep(200);
  const again = await ca.joinQueue();
  assert.equal(again.ok, true, 'премиум может звонить снова без ограничений');
  await ca.emit('queue:leave');
  ca.close(); cb.close();
});

test('матчинг не соединяет того, у кого квота кончилась, и возвращает второго в очередь', async () => {
  // гость, исчерпавший квоту, не должен «повисать» в паре
  const spent = new Client('spent'); await spent.connect({});
  await spent.solveCaptcha();
  const fresh = new Client('fresh'); await fresh.connect({});
  await fresh.solveCaptcha();

  // вручную «тратим» единственный звонок гостя через настоящий звонок с другим гостем
  const helper = new Client('helper'); await helper.connect({});
  await helper.solveCaptcha();
  const { callId } = await connectPair(spent, helper);
  await spent.send('call:hangup', { callId });
  await sleep(300);

  assert.equal((await spent.joinQueue({ captchaSolved: true })).error, 'quota', 'у spent квота кончилась');
  const okFresh = await fresh.joinQueue({ captchaSolved: true });
  assert.equal(okFresh.ok, true, 'у fresh квота есть');
  await sleep(1500);
  assert.equal(fresh.count('matched'), 0, 'fresh не получил в пару того, у кого квоты нет');

  spent.close(); fresh.close(); helper.close();
});

/* ============================================================
   3. Поиск по логину
   ============================================================ */

test('поиск по логину: префиксный, ограниченный, скрывает короткие запросы', async () => {
  const u = await register('Findme');

  const hit = await api('/api/users/search?q=find');
  assert.equal(hit.status, 200);
  assert.ok(hit.data.items.some(i => i.nick === 'Findme'), 'пользователь находится по префиксу');

  const short = await api('/api/users/search?q=f');
  assert.deepEqual(short.data.items, [], 'запрос короче двух символов ничего не выдаёт');

  const none = await api('/api/users/search?q=zzzzzz');
  assert.deepEqual(none.data.items, [], 'несуществующий логин — пусто');
});

/* ============================================================
   4. Звонок по логину
   ============================================================ */

test('гость не может звонить по логину — это привилегия зарегистрированных', async () => {
  const u = await register('Target1');
  const guest = new Client('g-direct'); await guest.connect({});
  const res = await guest.emit('direct:call', { nick: u.user.nick });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'login_required');
  guest.close();
});

test('нельзя позвонить несуществующему, себе или тому, кто не в сети', async () => {
  const a = await register('Caller1');
  const offline = await register('OfflineGuy');
  const ca = new Client('c1'); await ca.connect({ token: a.token });

  assert.equal((await ca.emit('direct:call', { nick: 'NoSuchUser' })).error, 'not_found');
  assert.equal((await ca.emit('direct:call', { nick: a.user.nick })).error, 'self');
  assert.equal((await ca.emit('direct:call', { nick: offline.user.nick })).error, 'offline');
  ca.close();
});

test('адресный звонок: вызываемый видит, кто звонит, и может принять', async () => {
  const a = await register('DirA');
  const b = await register('DirB');
  const ca = new Client('da'); await ca.connect({ token: a.token });
  const cb = new Client('db'); await cb.connect({ token: b.token });

  const incomingP = cb.waitForNext('direct:incoming', 8000);
  const res = await ca.emit('direct:call', { nick: b.user.nick });
  assert.equal(res.ok, true, 'звонок инициирован');
  assert.equal(res.ringing, true);

  const incoming = await incomingP;
  assert.equal(incoming.from.nick, 'DirA', 'вызываемый видит, кто именно звонит');
  assert.ok(incoming.timeoutMs > 0);

  // принимаем
  const matchedP = Promise.all([ca.waitForNext('matched', 8000), cb.waitForNext('matched', 8000)]);
  const acc = await cb.emit('direct:accept', { fromId: incoming.from.id });
  assert.equal(acc.ok, true);

  const [ma, mb] = await matchedP;
  assert.equal(ma.callId, mb.callId);
  assert.equal(ma.direct, true, 'звонок помечен как адресный');
  assert.equal(mb.direct, true);
  assert.equal(ma.peer.nick, 'DirB');
  assert.equal(mb.peer.nick, 'DirA');

  await ca.send('call:hangup', { callId: ma.callId });
  ca.close(); cb.close();
});

test('адресный звонок: отказ прекращает сценарий, звонок не начинается', async () => {
  const a = await register('DecA');
  const b = await register('DecB');
  const ca = new Client('deca'); await ca.connect({ token: a.token });
  const cb = new Client('decb'); await cb.connect({ token: b.token });

  const incomingP = cb.waitForNext('direct:incoming', 8000);
  await ca.emit('direct:call', { nick: b.user.nick });
  const incoming = await incomingP;

  const declinedP = ca.waitForNext('direct:declined', 8000);
  const dec = await cb.emit('direct:decline', { fromId: incoming.from.id });
  assert.equal(dec.ok, true);

  const declined = await declinedP;
  assert.equal(declined.nick, 'DecB', 'инициатор видит, кто отклонил');
  await sleep(400);
  assert.equal(ca.count('matched'), 0, 'после отказа звонок не начался');
  assert.equal(cb.count('matched'), 0);
  ca.close(); cb.close();
});

test('адресный звонок: можно отменить, не дожидаясь ответа', async () => {
  const a = await register('CancA');
  const b = await register('CancB');
  const ca = new Client('cana'); await ca.connect({ token: a.token });
  const cb = new Client('canb'); await cb.connect({ token: b.token });

  const incomingP = cb.waitForNext('direct:incoming', 8000);
  await ca.emit('direct:call', { nick: b.user.nick });
  await incomingP;

  const cancelledP = cb.waitForNext('direct:cancelled', 8000);
  const res = await ca.emit('direct:cancel');
  assert.equal(res.ok, true);
  await cancelledP;
  assert.equal(cb.count('matched'), 0);
  ca.close(); cb.close();
});

test('адресный звонок: занятому собеседнику не дозвониться', async () => {
  const a = await register('BusyA');
  const b = await register('BusyB');
  const c = await register('BusyC');
  const ca = new Client('busya'); await ca.connect({ token: a.token });
  const cb = new Client('busyb'); await cb.connect({ token: b.token });
  const cc = new Client('busyc'); await cc.connect({ token: c.token });

  // b и c уже говорят
  await connectPair(cb, cc);

  const res = await ca.emit('direct:call', { nick: b.user.nick });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'busy', 'занятому пользователю звонок не проходит');

  ca.close(); cb.close(); cc.close();
});

test('адресный звонок уважает блокировку в обе стороны', async () => {
  const a = await register('BlkA');
  const b = await register('BlkB');
  const ca = new Client('blka'); await ca.connect({ token: a.token });
  const cb = new Client('blkb'); await cb.connect({ token: b.token });

  // b блокирует a
  const blocked = await cb.emit('block', { target: a.user.id });
  assert.equal(blocked.ok, true);

  const res = await ca.emit('direct:call', { nick: b.user.nick });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'blocked');
  ca.close(); cb.close();
});

test('адресный звонок тратит квоту вызываемого — согласие должно быть осознанным', async () => {
  const a = await register('QCallsA');
  const b = await register('QCallsB');
  const ca = new Client('qca'); await ca.connect({ token: a.token });
  const cb = new Client('qcb'); await cb.connect({ token: b.token });

  const incomingP = cb.waitForNext('direct:incoming', 8000);
  await ca.emit('direct:call', { nick: b.user.nick });
  const incoming = await incomingP;

  const matchedP = Promise.all([ca.waitForNext('matched', 8000), cb.waitForNext('matched', 8000)]);
  await cb.emit('direct:accept', { fromId: incoming.from.id });
  const [ma] = await matchedP;

  const connectedP = Promise.all([ca.waitForNext('call:connected', 8000), cb.waitForNext('call:connected', 8000)]);
  await ca.send('rtc:state', { callId: ma.callId, state: 'connected' });
  const [qa, qb] = await connectedP;
  assert.equal(qa.quota.left, 99, 'инициатор потратил один звонок');
  assert.equal(qb.quota.left, 99, 'принявший тоже — согласие должно быть осознанным');

  await ca.send('call:hangup', { callId: ma.callId });
  ca.close(); cb.close();
});
