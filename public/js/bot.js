/* Zvonitel.ru — клиент демо-бота.
 * Живёт в headless-браузере, держит настоящую Socket.IO-сессию и настоящий PeerConnection.
 * Честно представляется ботом: ник «Демо-бот …», в чате сразу говорит, что он бот.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  // токен вида bot_<base64url(ник)> — сервер по нему понимает, что это бот
  let nick = 'Демо-бот';
  try { nick = decodeURIComponent(escape(atob(token.replace(/^bot_/, '').replace(/-/g, '+').replace(/_/g, '/')))); } catch {}
  const log = (m) => {
    const node = document.getElementById('log');
    if (node) node.textContent += m + '\n';
    console.log('[bot]', m);
  };

  const SCRIPT = [
    'Привет! Я демо-бот — со мной можно проверить камеру, микрофон и сам звонок 🙂',
    'Пока в очереди мало людей, я подменяю собеседника. Всё честно: я не человек.',
    'Расскажи, что привело тебя сюда: поболтать, практика языка или поиск друзей?',
    'Кстати, если нажать «Пропустить», тебя сразу вернёт в очередь к живым людям.',
    'А ещё тут есть приватные комнаты — можно позвать друга по ссылке.',
  ];
  const REPLIES = [
    'Понял тебя. А что тебе самому интереснее всего в таком формате?',
    'Хороший вопрос. Я, конечно, бот, но слушаю внимательно 🙂',
    'Ого! Расскажи подробнее — мне правда интересно (насколько это доступно боту).',
    'Согласен. Живой собеседник ответит лучше — попробуй «Следующий».',
  ];
  const REACTIONS = ['👍', '😂', '❤️', '🔥'];

  const state = { socket: null, call: null, stream: null, timers: [], said: 0, pending: [], callId: null };

  function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }

  function startScript() {
    clearTimers();
    state.said = 0;
    const send = (text) => {
      if (!state.call) return;
      state.socket.emit('chat:message', { callId: state.call.callId, text }, () => {});
    };
    send(SCRIPT[0]);
    state.timers.push(setInterval(() => {
      state.said++;
      if (state.said < SCRIPT.length) send(SCRIPT[state.said]);
      else send(REACTIONS[state.said % REACTIONS.length]);
    }, 11000));
  }

  async function onMatched(d) {
    log('матч: ' + d.peer.nick + ' (инициатор: ' + d.initiator + ')');
    state.callId = d.callId;
    state.pending = [];
    const call = new ZVCall({
      socket: state.socket,
      callId: d.callId,
      initiator: d.initiator,
      stream: state.stream,
      iceServers: d.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
      onEvent: (e) => {
        if (e.type === 'state' && e.state === 'connected') {
          log('P2P установлен');
          startScript();
        }
      },
    });
    state.call = call;
    await call.setup();
    // применяем сигналы, которые пришли до готовности PeerConnection
    for (const s of state.pending.splice(0)) {
      if (s.type === 'offer') await call.handleOffer(s.data);
      else if (s.type === 'answer') await call.handleAnswer(s.data);
      else if (s.type === 'ice') await call.handleIce(s.data);
    }
  }

  function reset() {
    clearTimers();
    try { state.call?.close(); } catch {}
    state.call = null;
    state.said = 0;
    state.socket?.emit('queue:leave', {}, () => {});
  }

  async function boot() {
    const socket = io({ auth: { token, nick } });
    state.socket = socket;

    socket.on('welcome', async (w) => {
      log('подключён как ' + (w.nick || '?'));
      window.__ice = w.config?.iceServers;
      log('ice=' + JSON.stringify(w.config?.iceServers));
      // синтетическое видео: бот показывает «говорящую голову» из canvas
      state.stream = ZV.createDemoStream(w.nick || 'Демо-бот', 285, true);
      socket.emit('queue:join', {
        filters: { language: 'ru', goal: 'any', gender: 'any', age: 'any', topics: [], style: 'any' },
        strict: false, mode: 'classic',
      }, (res) => log('очередь: ' + JSON.stringify(res)));
      window.ZVBot.ready = true;
    });

    socket.on('matched', (d) => {
      Promise.resolve(onMatched(d)).catch(e => log('MATCH ERROR ' + e.name + ': ' + e.message));
    });
    socket.on('rtc:signal', ({ callId, type, data }) => {
      if (!state.call || state.call.callId !== callId) {
        if (state.callId === callId) state.pending.push({ type, data }); // придёт раньше PC — отложим
        return;
      }
      if (type === 'offer') state.call.handleOffer(data).catch(e => log('offer err ' + e.message));
      if (type === 'answer') state.call.handleAnswer(data).catch(e => log('answer err ' + e.message));
      if (type === 'ice') state.call.handleIce(data);
    });
    socket.on('call:connected', () => log('звонок активен'));
    socket.on('chat:message', (m) => {
      if (!state.call) return;
      const reply = REPLIES[Math.floor(Math.random() * REPLIES.length)];
      setTimeout(() => socket.emit('chat:message', { callId: state.call.callId, text: reply }, () => {}), 1200);
      log('ответ на: ' + m.text);
    });
    socket.on('reaction', (r) => log('реакция: ' + r.emoji));
    socket.on('call:ended', (d) => { log('звонок завершён: ' + d.endReason); reset(); });
    socket.on('call:skipped', () => { log('собеседник пропустил'); reset(); });
    socket.on('call:peer-left', () => { log('собеседник вышел'); reset(); });
    socket.on('queue:joined', () => log('жду собеседника…'));
  }

  window.ZVBot = { ready: false, reset, state };
  boot();
})();
