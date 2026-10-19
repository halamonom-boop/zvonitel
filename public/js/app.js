/* Zvonitel.ru — клиентская логика: экраны, очередь, звонок, геймификация, модерация */
(function () {
  const { el, $, $$, Store, toast, Sound, avatar, fmtTime, fmtWait, plural } = window.ZV;

  const State = {
    socket: null, cfg: null, user: null, token: Store.get('token'), guestId: Store.get('guestId'),
    role: 'guest', nick: '', stats: { online: 0, queue: 0, calls: 0, totalCalls: 0 },
    filters: { language: 'ru', goal: 'any', gender: 'any', age: 'any', topics: [], style: 'any' },
    strict: false, mode: 'classic', queue: null, call: null, room: null,
    micOn: true, camOn: true, blur: false, quality: 'auto', lastPeer: null,
    captcha: null, referral: null, quests: [], achievements: [], level: null, friends: [],
  };

  /** Язык фильтра → тег для SpeechRecognition (Web Speech API). */
  const LANG_SPEECH = {
    ru: 'ru-RU', en: 'en-US', uk: 'uk-UA', de: 'de-DE',
    es: 'es-ES', fr: 'fr-FR', tr: 'tr-TR', zh: 'zh-CN',
  };

  /* ============================================================
     РОУТЕР
     ============================================================ */
  const screens = {};
  function show(name, params = {}) {
    const current = $('.screen.is-active');
    if (current) { current.classList.remove('is-active'); setTimeout(() => current.classList.add('is-hidden'), 220); }
    const next = screens[name] ? screens[name](params) : screens.landing();
    next.classList.add('is-active');
    if (window.innerWidth < 760) window.scrollTo({ top: 0 });
    State.screen = name;
    updateNav();
    return next;
  }

  function routeFromHash() {
    const path = location.pathname + location.hash.replace('#', '');
    if (/^\/admin/.test(path)) return show('admin');
    const roomMatch = path.match(/^\/r\/([a-z0-9]{4,8})/i);
    if (roomMatch) return show('room', { code: roomMatch[1] });
    if (/^\/profile/.test(path)) return show('profile');
    if (/^\/premium/.test(path)) return show('premium');
    return show('landing');
  }

  function updateNav() {
    $$('.nav__link').forEach(a => a.classList.toggle('is-active', a.dataset.screen === State.screen));
    const authArea = $('#navAuth');
    if (authArea) authArea.innerHTML = State.user
      ? `${avatar(State.user.nick, State.user.avatarHue, 30)}<span class="nav__nick">${esc(State.user.nick)}</span>`
      : `<button class="btn btn--ghost btn--sm" data-act="auth">Войти</button>`;
    const badge = $('#navCoins');
    if (badge) badge.textContent = State.user ? `🪙 ${State.user.coins}` : '';
    ZVDirect.renderQuotaChip();
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ============================================================
     API + SOCKET
     ============================================================ */
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (State.token) headers.Authorization = 'Bearer ' + State.token;
    const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'error'), { data, status: res.status });
    return data;
  }

  const emit = (event, payload) => new Promise(resolve => {
    if (!State.socket) return resolve(null);
    State.socket.emit(event, payload || {}, resolve);
  });

  /** Контекст для модуля адресных звонков и квот. */
  ZVDirect.mount({
    State, api, emit, show,
    openAuth: (mode) => openAuth(mode || 'register'),
  });

  function connect() {
    const socket = io({ auth: { token: State.token || null, nick: State.nick, guestId: State.guestId } });
    State.socket = socket;

    socket.on('connect', () => console.info('[socket] connected'));
    socket.on('welcome', onWelcome);
    socket.on('stats', s => { State.stats = s; renderLiveCounters(); });
    socket.on('metrics:public', m => { State.publicMetrics = m; renderLiveCounters(); });
    socket.on('matched', onMatched);
    socket.on('call:connected', d => { onCallConnected(); if (d?.quota) ZVDirect.setQuota(d.quota); });
    socket.on('call:skipped', d => onPeerGone('skip', d));
    socket.on('call:peer-left', d => onPeerGone('hangup', d));
    socket.on('call:peer-dropped', d => onPeerDropped(d));
    socket.on('call:ended', d => onCallEnded(d));
    socket.on('call:end', d => { if (d.forced) endCallUi(d.reason, true); });
    socket.on('queue:joined', d => { State.queue = { startedAt: Date.now() - (d.waitMs || 0), relaxOffered: false }; });
    socket.on('queue:relax', onRelaxOffer);
    socket.on('queue:relaxed', () => toast('Фильтры расширены — ищем снова', 'success'));
    socket.on('captcha:required', () => openCaptcha());
    socket.on('rtc:signal', onSignal);
    socket.on('rtc:peer-quality', d => setQualityBadge(d));
    socket.on('rtc:peer-failed', () => endCallUi('failed', true));
    socket.on('chat:message', onIncomingChat);
    socket.on('reaction', d => spawnReaction(d.emoji, true));

    /* ---------- звонок по логину ---------- */
    socket.on('direct:incoming', d => ZVDirect.onIncoming(d));
    socket.on('direct:cancelled', d => ZVDirect.onCancelled(d));
    socket.on('direct:declined', d => ZVDirect.onDeclined(d));
    socket.on('direct:timeout', d => ZVDirect.onTimeout(d));

    /* ---------- квоты ---------- */
    socket.on('quota:exceeded', d => ZVDirect.showQuotaGate(d.quota));

    /* ---------- V2: субтитры и запись ---------- */
    socket.on('caption', d => onRemoteCaption(d));
    socket.on('rec:request', d => askRecordingConsent(d));
    socket.on('rec:start', d => onRecordingStart(d));
    socket.on('rec:declined', d => {
      if (State.recorder) State.recorder.state = 'idle';
      toast(`${d.by} отклонил запись звонка`, 'info');
      setRecordingUi('idle');
    });
    socket.on('rec:stop', d => onRecordingStop(d));
    socket.on('rating:received', d => toast(`Вам поставили ${d.stars}★`, 'success'));
    socket.on('friend:requested', d => onFriendRequest(d));
    socket.on('friend:accepted', d => { toast(`${d.user.nick} теперь у вас в друзьях 🎉`, 'success'); Sound.notify(); loadMe(); });
    socket.on('friend:declined', d => toast(`${d.user.nick} отклонил запрос`, 'info'));
    socket.on('achievements:unlocked', d => d.items.forEach(a => showAchievement(a)));
    socket.on('moderation:warning', d => toast(d.text, 'warn', 6000));
    socket.on('moderation:peer', d => toast(d.text, 'warn', 6000));
    socket.on('moderation:action', d => {
      toast(d.text, 'error', 8000);
      if (d.action !== 'warn') { State.user = null; Store.del('token'); show('landing'); }
    });
    socket.on('banned', d => {
      showBan(d);
    });
    socket.on('toast', d => toast(d.text, d.type || 'info'));
    socket.on('disconnect', () => toast('Связь с сервером потеряна, переподключаемся…', 'warn'));
    socket.on('connect', () => { if (State.queue) emit('queue:join', { filters: State.filters, strict: State.strict, mode: State.mode }); });
    return socket;
  }

  function onWelcome(data) {
    State.cfg = data.config;
    State.user = data.user;
    State.role = data.role;
    State.nick = data.nick;
    State.limits = data.limits;
    State.stats = data.stats;
    State.bots = data.bots || { available: false };
    State.quests = data.quests || [];
    State.achievements = data.achievements || [];
    State.level = data.level;
    State.referral = data.referral;
    State.todayTheme = data.todayTheme;
    if (data.quota) { State.quota = data.quota; ZVDirect.renderQuotaChip(); }
    if (data.guestId) { State.guestId = data.guestId; Store.set('guestId', data.guestId); }
    if (State.user && State.user.languages?.length) State.filters.language = State.user.languages[0];
    if (State.user && State.user.mode) State.mode = State.user.mode;
    renderLiveCounters();
    if (State.refCode && !State.user) openAuth('register');
    document.dispatchEvent(new CustomEvent('zv:welcome', { detail: data }));
  }

  /* ============================================================
     18+ ГЕЙТ
     ============================================================ */
  function ageGate() {
    if (Store.get('age18')) return;
    const overlay = el('div', { class: 'gate' }, [
      el('div', { class: 'gate__card' }, [
        el('div', { class: 'gate__badge', text: '18+' }),
        el('h2', { text: 'Только для взрослых' }),
        el('p', { text: 'Zvonitel.ru — сервис случайных видеозвонков. Продолжая, вы подтверждаете, что вам исполнилось 18 лет, и принимаете правила сообщества.' }),
        el('div', { class: 'gate__actions' }, [
          el('button', {
            class: 'btn btn--primary btn--lg', text: 'Мне есть 18 лет',
            onclick: () => { Store.set('age18', Date.now()); Sound.click(); overlay.remove(); },
          }),
          el('a', { class: 'btn btn--ghost', href: 'https://google.com', text: 'Мне нет 18' }),
        ]),
        el('a', { class: 'gate__rules', href: '/rules', text: 'Правила сообщества и политика приватности' }),
      ]),
    ]);
    document.body.append(overlay);
  }

  function showBan(d) {
    const until = d.until ? new Date(d.until).toLocaleString('ru-RU') : 'навсегда';
    const overlay = el('div', { class: 'gate' }, [
      el('div', { class: 'gate__card' }, [
        el('div', { class: 'gate__badge gate__badge--red', text: '⛔' }),
        el('h2', { text: 'Доступ ограничен' }),
        el('p', { text: `${d.reason || 'Нарушение правил сообщества'}. До: ${until}` }),
        el('p', { class: 'muted', text: 'Не согласны? Напишите апелляцию на support@zvonitel.ru — модераторы отвечают в течение 24 часов.' }),
      ]),
    ]);
    document.body.append(overlay);
  }

  /* ============================================================
     ЛЕНДИНГ
     ============================================================ */
  screens.landing = () => {
    const total = State.stats.totalCalls || 0;
    const scr = screenShell('landing', `
      <section class="hero">
        <div class="hero__glow"></div>
        <div class="hero__inner">
          <div class="chip chip--live"><span class="dot"></span> <b id="liveOnline">0</b> человек онлайн · <b id="liveQueue">0</b> в очереди</div>
          <h1>Умная рулетка общения.<br><span class="grad">Один клик — и вы уже говорите.</span></h1>
          <p class="lead">Zvonitel.ru — это видеозвонки 1-на-1 с людьми, которые вам действительно подходят.
            Найдём собеседника по интересам, целям и языку. Знаете, кому хотите позвонить? Наберите его логин —
            и вы на связи сразу, в обход очереди.</p>
          <div class="hero__cta">
            <button class="btn btn--primary btn--xl" data-act="start">🎥 ${ZV.t('start')}</button>
            <button class="btn btn--ghost btn--xl" data-act="filters">⚙️ ${ZV.t('setup')}</button>
          </div>
          <div class="hero__trust">
            <span>✅ Уже <b id="heroCalls">0</b> звонков</span>
            <span>🔒 Видео не записывается и не хранится</span>
            <span>🛡️ Модерация и жалобы в 1 клик</span>
            <span>🎁 1 звонок бесплатно, без регистрации</span>
          </div>
          <div class="hero__modes" id="modeStrip"></div>
        </div>
        <div class="hero__preview">
          <div class="mock">
            <div class="mock__remote"><div class="mock__avatar">${avatar('М', 300, 72)}</div><span>Мария, 24 · 🎬 🎧 ✈️</span></div>
            <div class="mock__local">${avatar('Вы', 210, 40)}<span class="mock__timer">04:12</span></div>
            <div class="mock__bar">
              <span class="mock__btn mock__btn--skip">⟳</span>
              <span class="mock__btn mock__btn--end">✕</span>
              <span class="mock__btn">👍</span><span class="mock__btn">😂</span><span class="mock__btn">💬</span>
            </div>
          </div>
        </div>
      </section>

      <section class="band">
        <div class="band__inner">
          <h2 class="section-title">Зачем это нужно</h2>
          <p class="section-lead">Обычная видеорулетка — это лотерея: три секунды, скучно или неприятно — скип.
            Zvonitel.ru заменяет лотерею подбором. Вы говорите, с кем хотите поговорить и зачем, — а мы находим
            человека, который хочет того же.</p>
          <div class="why">
            ${[['🎯', 'Не «кто попало», а «кто вам подходит»',
                'Цель, язык, возраст, темы и стиль общения. Алгоритм соединяет тех, кому действительно есть что сказать друг другу.'],
               ['🌍', 'Языковая практика без репетиторов',
                'Выберите «практика языка» — и окажетесь с носителем или таким же учеником. Половина времени на одном языке, половина на другом.'],
               ['🫂', 'Когда просто нужно, чтобы выслушали',
                'Режим «Поддержка» подбирает спокойного собеседника, который не будет давать советы, которых вы не просили.'],
               ['🔗', 'И не только случайные',
                'Знаете, кому хотите позвонить? Наберите логин — и вы на связи сразу, без ожидания. Или создайте приватную комнату и отправьте другу ссылку.'],
               ['🛡️', 'Безопасность как настройка по умолчанию',
                'Жалоба в один клик, автомодерация, страйки и теневые баны. Видео идёт напрямую между собеседниками и не сохраняется.'],
               ['🏆', 'Разговоры, которые что-то значат',
                'Рейтинг, достижения, монеты и серии дней — чтобы возвращаться было приятно, а вести себя хорошо — выгодно.']]
              .map(([e, t2, d]) => `<div class="why__item"><span class="why__emoji">${e}</span><h3>${t2}</h3><p>${d}</p></div>`).join('')}
          </div>
        </div>
      </section>

      <section class="band band--alt">
        <div class="band__inner">
          <h2 class="section-title">Как это работает</h2>
          <div class="steps">
            ${[['1', 'Проверьте камеру', 'Предпросмотр за 5 секунд — вы видите себя таким, каким увидит собеседник.'],
               ['2', 'Скажите, кого ищете', 'Язык, возраст, цель, темы. Или просто жмите «Начать» и доверьтесь подбору.'],
               ['3', 'Умный матч', 'Соединяем только при взаимном совпадении фильтров. Скор совпадения виден прямо в звонке.'],
               ['4', 'Оценка и друзья', 'Звёзды и теги формируют репутацию. Понравился человек — добавьте в друзья или позвоните ему по логину.']]
              .map(([n, t2, d]) => `<div class="step"><span class="step__n">${n}</span><h3>${t2}</h3><p>${d}</p></div>`).join('')}
          </div>
        </div>
      </section>

      <section class="band band--alt">
        <div class="band__inner">
          <h2 class="section-title">Тема сегодняшнего вечера</h2>
          <div class="theme-card" id="themeCard"></div>
          <div class="modes-grid" id="modesGrid"></div>
        </div>
      </section>

      <section class="band">
        <div class="band__inner band__inner--split">
          <div>
            <h2 class="section-title">Пригласи друга — получи Premium</h2>
            <p class="lead">Друг зарегистрировался — Premium на день вам обоим. Сделал 3 звонка — ещё 3 дня и 150 монет.</p>
            <div class="ref-box" id="refBox"></div>
          </div>
          <div>
            <h2 class="section-title">Топ недели</h2>
            <div class="lb" id="leaderboard"></div>
          </div>
        </div>
      </section>

      <section class="band band--alt" id="plans">
        <div class="band__inner">
          <h2 class="section-title">Сколько это стоит</h2>
          <p class="section-lead">Попробовать можно вообще без регистрации. Дальше — бесплатный аккаунт со щедрым
            лимитом, а если хочется без ограничений — Premium.</p>
          <div class="plans" id="plansGrid"></div>
        </div>
      </section>

      <section class="band">
        <div class="band__inner band__inner--split">
          <div>
            <h2 class="section-title">Безопасность</h2>
            <ul class="ticks">
              <li>Видео идёт напрямую между участниками и не сохраняется на сервере</li>
              <li>Жалоба в 1 клик: 18+, насилие, оскорбления, спам, мошенничество</li>
              <li>Автомодерация: фильтр чата, детекция рекламы, подозрительный кадр</li>
              <li>Страйки: предупреждение → бан 1 час → 24 часа → перманентный</li>
              <li>Кнопка SOS мгновенно разрывает звонок и отправляет жалобу</li>
            </ul>
          </div>
          <div>
            <h2 class="section-title">Отзывы</h2>
            ${[['Аня, 26', 'Нашла подругу для практики английского. Третья неделя подряд созваниваемся!'],
               ['Игорь, 34', 'Наконец-то рулетка, где не показывают всякое. Жалоба срабатывает за секунду.'],
               ['Лена, 21', 'Режим «свидание вслепую» — сначала голос. Меньше стеснения, больше разговоров.']]
              .map(([n, txt]) => `<blockquote class="quote"><p>«${txt}»</p><footer>${n}</footer></blockquote>`).join('')}
          </div>
        </div>
      </section>

      <section class="band band--alt">
        <div class="band__inner">
          <h2 class="section-title">Частые вопросы</h2>
          <div class="faq">
            ${[['Это правда бесплатно?',
                'Да. Один звонок доступен без регистрации — просто чтобы попробовать. Зарегистрированный аккаунт бесплатен и даёт 100 звонков в месяц. Premium снимает лимит и добавляет запись, перевод субтитров и приоритет в очереди.'],
               ['Сколько ждать собеседника?',
                'Обычно несколько секунд. Если за 30 секунд пары нет, мы сами предложим немного расширить фильтры — это экономит время и почти всегда помогает.'],
               ['Можно ли позвонить конкретному человеку?',
                'Да, двумя способами. Наберите его логин — и звонок пойдёт напрямую, если он в сети и примет вызов. Или создайте приватную комнату и отправьте ссылку.'],
               ['Вы записываете видео?',
                'Нет. Видео идёт напрямую между браузерами собеседников, сервер передаёт только технические сигналы. Запись звонка — локальная функция браузера, она возможна только в Premium и только если оба участника явно согласились; файл остаётся у вас на устройстве.'],
               ['Что делать, если собеседник нарушает правила?',
                'Жалоба в один клик или кнопка SOS — она мгновенно разрывает звонок и отправляет жалобу. Нарушения дают страйки: предупреждение, бан на час, на сутки, затем навсегда.'],
               ['С кем я буду говорить?',
                'С тем, кто подходит под ваши фильтры и чьи фильтры подходите вы. Случайных «кого попало» мы не подбираем: совпадение должно быть взаимным.']]
              .map(([q, a]) => `<details class="faq__item"><summary>${q}</summary><p>${a}</p></details>`).join('')}
          </div>
        </div>
      </section>

      <footer class="footer">
        <div>Zvonitel.ru © 2026 · 18+ · <a href="/rules">Правила</a> · <a href="/admin">Модерация</a></div>
        <div class="muted">Видеопоток P2P (WebRTC), сервер хранит только метаданные. 152-ФЗ / GDPR.</div>
      </footer>
    `);

    // живые счётчики
    setTimeout(() => {
      animateNumber($('#heroCalls'), total, 1200);
      renderModeStrip(); renderTheme(); renderModes(); renderRef(); loadLeaderboard(); renderPlans();
    }, 30);
    return scr;
  };

  /** Тарифы: гость / зарегистрированный / премиум. */
  function renderPlans() {
    const node = $('#plansGrid');
    if (!node || !State.cfg?.plans) return;

    const role = State.user ? (State.user.isPremium ? 'premium' : 'user') : 'guest';
    node.innerHTML = State.cfg.plans.map(p => {
      const current = p.id === role;
      const disabled = p.disabled || [];
      return `
        <div class="plan ${p.id === 'premium' ? 'plan--hot' : ''} ${current ? 'plan--current' : ''}">
          ${current ? '<span class="plan__now">Вы здесь</span>' : ''}
          <h3>${p.ru} ${p.badge ? `<span>${p.badge}</span>` : ''}</h3>
          <div class="plan__price">${p.price}</div>
          <div class="plan__calls">🎥 ${p.calls}</div>
          <p class="plan__tag">${p.tagline}</p>
          <ul class="plan__list">
            ${p.features.map(f => `<li class="yes">${f}</li>`).join('')}
            ${disabled.map(f => `<li class="no">${f}</li>`).join('')}
          </ul>
          <button class="btn ${p.id === 'premium' ? 'btn--primary' : 'btn--ghost'}"
            data-plan="${p.id}" ${current ? 'disabled' : ''}>${p.cta}</button>
        </div>`;
    }).join('');

    $$('[data-plan]', node).forEach(b => b.onclick = () => {
      const id = b.dataset.plan;
      Sound.click();
      if (id === 'user') openAuth('register');
      else if (id === 'premium') show('premium');
    });
  }

  function renderLiveCounters() {
    const o = $('#liveOnline'), q = $('#liveQueue'), c = $('#heroCalls');
    if (o) o.textContent = State.stats.online || 0;
    if (q) q.textContent = State.stats.queue || 0;
    if (c && !c.dataset.done) animateNumber(c, State.stats.totalCalls || 0, 1000);
  }

  function animateNumber(node, target, ms = 900) {
    if (!node) return;
    node.dataset.done = '1';
    const from = 0, t0 = performance.now();
    function step(t) {
      const p = Math.min(1, (t - t0) / ms);
      node.textContent = Math.round(from + (target - from) * (1 - Math.pow(1 - p, 3))).toLocaleString('ru-RU');
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function renderModeStrip() {
    const strip = $('#modeStrip'); if (!strip || !State.cfg) return;
    strip.innerHTML = Object.entries(State.cfg.modes).map(([id, m]) =>
      `<button class="mode-chip" data-mode="${id}">${m.emoji} ${m.ru}</button>`).join('');
    $$('#modeStrip .mode-chip', strip).forEach(b => b.onclick = () => {
      State.mode = b.dataset.mode; Sound.click();
      toast(`${State.cfg.modes[b.dataset.mode].emoji} ${State.cfg.modes[b.dataset.mode].ru}: ${State.cfg.modes[b.dataset.mode].desc}`, 'info', 4200);
      startFlow();
    });
  }

  function renderTheme() {
    const node = $('#themeCard'); if (!node || !State.todayTheme) return;
    const th = State.todayTheme;
    node.innerHTML = `
      <div class="theme-card__emoji">${th.emoji}</div>
      <div><h3>${th.ru}</h3><p>Сегодня весь сервис подталкивает к этой теме. Фильтр уже подставлен — заходите в очередь и ловите единомышленников.</p>
      <button class="btn btn--primary btn--sm" data-act="theme-join">В очередь с темой «${th.ru}»</button></div>`;
    $('[data-act="theme-join"]', node).onclick = () => {
      State.filters.topics = [th.id]; State.mode = 'topic'; startFlow();
    };
  }

  function renderModes() {
    const grid = $('#modesGrid'); if (!grid || !State.cfg) return;
    grid.innerHTML = Object.entries(State.cfg.modes).map(([id, m]) => `
      <article class="mode-card" data-mode="${id}">
        <div class="mode-card__emoji">${m.emoji}</div>
        <h3>${m.ru}</h3><p>${m.desc}</p>
      </article>`).join('');
    $$('.mode-card', grid).forEach(c => c.onclick = () => { State.mode = c.dataset.mode; Sound.click(); startFlow(); });
  }

  function renderRef() {
    const box = $('#refBox'); if (!box) return;
    if (!State.user) {
      box.innerHTML = `<p class="muted">Войдите или зарегистрируйтесь, чтобы получить свою ссылку.</p>
        <button class="btn btn--ghost btn--sm" data-act="auth">Создать аккаунт</button>`;
      $('[data-act="auth"]', box).onclick = () => openAuth('register');
      return;
    }
    const link = State.referral?.link || location.origin;
    box.innerHTML = `
      <div class="ref-box__row">
        <input readonly value="${esc(link)}" class="input" id="refInput">
        <button class="btn btn--primary btn--sm" id="refCopy">Копировать</button>
      </div>
      <div class="share-row">
        <button class="btn btn--ghost btn--sm" data-net="tg">Telegram</button>
        <button class="btn btn--ghost btn--sm" data-net="vk">VK</button>
        <button class="btn btn--ghost btn--sm" data-net="wa">WhatsApp</button>
        <span class="muted">Приглашено: ${State.user.invitedCount || 0}</span>
      </div>`;
    $('#refCopy').onclick = async () => { await navigator.clipboard.writeText(link); toast('Ссылка скопирована', 'success'); };
    $$('[data-net]', box).forEach(b => b.onclick = () => {
      const url = encodeURIComponent(link), text = encodeURIComponent(ZV.shareText(link));
      const map = { tg: `https://t.me/share/url?url=${url}&text=${text}`, vk: `https://vk.com/share.php?url=${url}&title=${text}`, wa: `https://wa.me/?text=${text}%20${url}` };
      window.open(map[b.dataset.net], '_blank', 'noopener');
    });
  }

  async function loadLeaderboard() {
    const node = $('#leaderboard'); if (!node) return;
    try {
      const { items } = await api('/api/leaderboard?metric=calls_total');
      node.innerHTML = items.length ? items.map((u, i) => `
        <div class="lb__row"><span class="lb__pos">${i + 1}</span>${avatar(u.nick, u.avatar_hue, 30)}
        <span class="lb__nick">${esc(u.nick)}</span><span class="lb__val">${u.value} ${plural(u.value, ['звонок', 'звонка', 'звонков'])}</span></div>`).join('')
        : `<p class="muted">Пока пусто — станьте первым.</p>`;
    } catch { node.innerHTML = '<p class="muted">Нет данных</p>'; }
  }

  /* ============================================================
     ОНБОРДИНГ + ФИЛЬТРЫ
     ============================================================ */
  screens.onboarding = () => {
    const scr = screenShell('onboarding', `
      <div class="onb">
        <div class="onb__preview">
          <video id="previewVideo" autoplay playsinline muted class="video video--preview"></video>
          <div class="onb__preview-ui">
            <div class="onb__badge" id="deviceBadge">Проверяем устройства…</div>
            <div class="onb__meters">
              <div class="meter"><span>Микрофон</span><div class="meter__bar"><i id="micLevel"></i></div></div>
            </div>
            <div class="onb__devices">
              <select id="videoDevices" class="input input--sm"></select>
              <select id="audioDevices" class="input input--sm"></select>
            </div>
            <div class="onb__toggles">
              <button class="btn btn--ghost btn--sm" data-t="mic">🎤 Микрофон</button>
              <button class="btn btn--ghost btn--sm" data-t="cam">📷 Камера</button>
              <button class="btn btn--ghost btn--sm" data-t="blur">🌫️ Размытие фона <span class="pill">Premium</span></button>
            </div>
          </div>
        </div>
        <div class="onb__side">
          <h2>Проверьте камеру и микрофон</h2>
          <p class="muted">Вы видите себя таким, каким вас увидит собеседник. Видео не записывается.</p>
          <div id="quotaNudge" class="quota-nudge"></div>
          <div class="mode-picker" id="modePicker"></div>
          <div class="onb__actions">
            <button class="btn btn--primary btn--lg" id="goRandom">🎲 Случайный звонок</button>
            <button class="btn btn--ghost btn--lg" id="goFilters">⚙️ Настроить фильтры</button>
          </div>
          <div class="onb__direct" id="directBlock"></div>
          <div id="registerNudge"></div>
        </div>
      </div>
    `);

    initPreview();
    renderModePicker($('#modePicker'));
    renderQuotaNudge();
    $('#directBlock').append(ZVDirect.directBlock());

    $('#goRandom').onclick = async () => {
      Sound.click();
      State.filters = { language: State.user ? (State.user.languages?.[0] || 'ru') : 'ru', goal: 'any', gender: 'any', age: 'any', topics: [], style: 'any' };
      State.strict = false;
      await joinQueue();
    };
    $('#goFilters').onclick = () => { Sound.click(); show('filters'); };

    if (!State.user) {
      $('#registerNudge').innerHTML = `<div class="nudge">
        <b>Гостю доступен 1 пробный звонок.</b> Регистрация бесплатна и открывает 100 звонков в месяц,
        фильтры, историю и друзей.
        <button class="btn btn--primary btn--sm" id="nudgeReg">Регистрация за 10 секунд</button>
        <span class="muted">Не обязательно — можно звонить и так.</span></div>`;
      $('#nudgeReg').onclick = () => openAuth('register');
    }
    return scr;
  };

  /** Строка «осталось звонков» над кнопками старта. */
  function renderQuotaNudge() {
    const node = $('#quotaNudge');
    if (!node) return;
    const q = State.quota;
    if (!q) { node.innerHTML = ''; return; }
    if (q.unlimited) {
      node.innerHTML = `<span class="qchip qchip--inf">∞ Безлимитные звонки · Premium</span>`;
      return;
    }
    const period = q.period === 'month' ? 'в этом месяце' : 'доступно';
    const low = q.left <= 1;
    node.innerHTML = `<span class="qchip ${low ? 'qchip--low' : ''}">
      🎥 Осталось <b>${q.left}</b> из ${q.calls} звонков ${period}</span>`;
  }

  function renderModePicker(node) {
    if (!node || !State.cfg) return;
    node.innerHTML = `<label class="field__label">Режим звонка</label>` + Object.entries(State.cfg.modes).map(([id, m]) =>
      `<button class="pick ${State.mode === id ? 'is-on' : ''}" data-mode="${id}" title="${esc(m.desc)}">${m.emoji} ${m.ru}</button>`).join('');
    $$('.pick', node).forEach(b => b.onclick = () => {
      State.mode = b.dataset.mode;
      $$('.pick', node).forEach(x => x.classList.toggle('is-on', x === b));
      Sound.click();
    });
  }

  let previewCleanup = null;
  async function initPreview() {
    const video = $('#previewVideo');
    const res = await ZVMedia.start({ video: true, audio: true, quality: State.quality === 'auto' ? 'medium' : State.quality });
    if (video) { video.srcObject = res.stream; }
    const badge = $('#deviceBadge');
    if (badge) badge.innerHTML = res.demo
      ? '⚠️ Камера недоступна — включён демо-поток (звонок всё равно работает)'
      : '✅ Камера и микрофон готовы';

    // индикатор микрофона
    try {
      const ac = new AudioContext();
      const src = ac.createMediaStreamSource(res.stream);
      const an = ac.createAnalyser(); an.fftSize = 256; src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      previewCleanup = setInterval(() => {
        an.getByteFrequencyData(data);
        let sum = 0; for (const v of data) sum += v;
        const lvl = Math.min(100, (sum / data.length / 128) * 100);
        const bar = $('#micLevel'); if (bar) bar.style.width = lvl + '%';
      }, 100);
    } catch {}

    const devices = await ZVMedia.listDevices();
    const fill = (selId, list, label) => {
      const s = $(selId); if (!s) return;
      s.innerHTML = list.length
        ? list.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `${label} ${i + 1}`)}</option>`).join('')
        : `<option>Устройства не найдены</option>`;
    };
    fill('#videoDevices', devices.video, 'Камера');
    fill('#audioDevices', devices.audio, 'Микрофон');
    $('#videoDevices')?.addEventListener('change', e => ZVMedia.switchDevice('video', e.target.value).then(s => { const v = $('#previewVideo'); if (v) v.srcObject = s; }));
    $('#audioDevices')?.addEventListener('change', e => ZVMedia.switchDevice('audio', e.target.value).then(s => { const v = $('#previewVideo'); if (v) v.srcObject = s; }));

    $$('[data-t]').forEach(btn => btn.onclick = async () => {
      const t = btn.dataset.t;
      if (t === 'mic') { State.micOn = !State.micOn; ZVMedia.stream?.getAudioTracks().forEach(tr => tr.enabled = State.micOn); }
      if (t === 'cam') { State.camOn = !State.camOn; ZVMedia.stream?.getVideoTracks().forEach(tr => tr.enabled = State.camOn); }
      if (t === 'blur') {
        if (!State.user?.isPremium) { toast('Размытие фона — функция Premium', 'warn'); openPremiumUpsell(); return; }
        State.blur = !State.blur;
        await ZVMedia.enableBlur(video, State.blur);
      }
      btn.classList.toggle('is-off', (t === 'mic' && !State.micOn) || (t === 'cam' && !State.camOn) || (t === 'blur' && !State.blur));
      Sound.click();
    });
  }

  screens.filters = () => {
    const c = State.cfg || {};
    const chips = (name, items, keyLabel = 'ru') => items.map(i =>
      `<button class="chip-btn ${isOn(State.filters[name], i.id, name) ? 'is-on' : ''}" data-f="${name}" data-v="${i.id}">${i.emoji || ''} ${i[keyLabel]}</button>`).join('');

    const scr = screenShell('filters', `
      <div class="filters">
        <div class="filters__head">
          <h2>Фильтры подбора</h2>
          <p class="muted">Строгий режим соединяет только при полном совпадении. Гибкий — допускает частичное.</p>
        </div>
        <div class="filters__body">
          <section class="fgroup">
            <h3>Язык</h3>
            <div class="chips">${chips('language', [{ id: 'any', ru: 'Не важно', emoji: '🌐' }, ...c.languages.map(l => ({ id: l.id, ru: l.native, emoji: l.flag }))])}</div>
          </section>
          <section class="fgroup">
            <h3>Цель общения</h3>
            <div class="chips">${chips('goal', [{ id: 'any', ru: 'Любая', emoji: '✨' }, ...c.goals])}</div>
          </section>
          <section class="fgroup">
            <h3>Пол собеседника</h3>
            <div class="chips">${chips('gender', [{ id: 'any', ru: 'Не важно' }, ...c.genders])}</div>
          </section>
          <section class="fgroup">
            <h3>Возраст</h3>
            <div class="chips">${chips('age', [{ id: 'any', label: 'Не важно' }, ...c.ageRanges].map(a => ({ id: a.id, ru: a.label })))}</div>
          </section>
          <section class="fgroup">
            <h3>Темы <span class="muted">— хотя бы одна общая</span></h3>
            <div class="chips">${chips('topics', c.topics)}</div>
          </section>
          <section class="fgroup">
            <h3>Стиль общения</h3>
            <div class="chips">${chips('style', [{ id: 'any', ru: 'Любой', emoji: '✨' }, ...c.styles])}</div>
          </section>
          <section class="fgroup">
            <h3>Режим звонка</h3>
            <div class="chips" id="modeChips">${Object.entries(c.modes).map(([id, m]) =>
              `<button class="chip-btn ${State.mode === id ? 'is-on' : ''}" data-mode2="${id}">${m.emoji} ${m.ru}</button>`).join('')}</div>
          </section>
          <section class="fgroup fgroup--row">
            <label class="switch"><input type="checkbox" id="strictToggle" ${State.strict ? 'checked' : ''}><span></span> Строгий матч</label>
            <span class="muted" id="strictHint"></span>
          </section>
        </div>
        <div class="filters__foot">
          <button class="btn btn--primary btn--xl" id="toQueue">В очередь →</button>
          <span class="muted" id="filtersSummary"></span>
        </div>
      </div>
    `);

    $$('.chip-btn[data-f]', scr).forEach(btn => btn.onclick = () => {
      const f = btn.dataset.f, v = btn.dataset.v;
      if (f === 'topics') {
        const set = new Set(State.filters.topics);
        set.has(v) ? set.delete(v) : set.add(v);
        State.filters.topics = [...set];
      } else {
        State.filters[f] = v;
        if (f === 'language' && State.user) State.filters.language = v;
      }
      Sound.click();
      $$('.chip-btn', scr).forEach(b => {
        const bf = b.dataset.f; if (!bf) return;
        const on = bf === 'topics' ? State.filters.topics.includes(b.dataset.v) : State.filters[bf] === b.dataset.v;
        b.classList.toggle('is-on', on);
      });
      updateSummary();
    });

    $$('[data-mode2]', scr).forEach(btn => btn.onclick = () => {
      State.mode = btn.dataset.mode2;
      $$('[data-mode2]', scr).forEach(b => b.classList.toggle('is-on', b === btn));
      Sound.click(); updateSummary();
    });

    $('#strictToggle').onchange = e => { State.strict = e.target.checked; updateSummary(); };

    $('#toQueue').onclick = () => { Sound.click(); joinQueue(); };

    function isOn(current, id, field) {
      if (field === 'topics') return State.filters.topics.includes(id);
      return current === id;
    }
    function updateSummary() {
      const f = State.filters;
      const parts = [];
      if (f.language !== 'any') parts.push(`язык: ${c.languages.find(l => l.id === f.language)?.native || f.language}`);
      if (f.goal !== 'any') parts.push(`цель: ${c.goals.find(g => g.id === f.goal)?.ru}`);
      if (f.gender !== 'any') parts.push(`пол: ${c.genders.find(g => g.id === f.gender)?.ru}`);
      if (f.age !== 'any') parts.push(`возраст: ${f.age}`);
      if (f.topics.length) parts.push(`темы: ${f.topics.length}`);
      if (f.style !== 'any') parts.push(`стиль: ${c.styles.find(s => s.id === f.style)?.ru}`);
      const sum = $('#filtersSummary');
      if (sum) sum.textContent = parts.length ? parts.join(' · ') : 'Без фильтров — чистый рандом';
      const hint = $('#strictHint');
      if (hint) hint.textContent = State.strict
        ? 'Только полное взаимное совпадение (скор ≥ 85 и общая тема). Ожидание может быть дольше.'
        : 'Допускаем частичное совпадение (скор ≥ 55) — матч найдётся быстрее.';
    }
    updateSummary();
    return scr;
  };

  /* ============================================================
     ОЧЕРЕДЬ
     ============================================================ */
  const QUEUE_FACTS = [
    '💡 Первый вопрос часто решает всё: «Что самое странное случилось с тобой за неделю?»',
    '🌍 Больше половины пользователей приходят практиковать язык.',
    '🎧 Режим «Свидание вслепую» включает видео только через 3 минуты.',
    '🛡️ Жалоба работает мгновенно: звонок рвётся, модератор получает сигнал.',
    '🔥 Серия дней (streak) даёт приоритет в очереди.',
    '🤝 Если собеседник понравился — жмите «В друзья»: он увидит запрос.',
    '📵 Видео не записывается и не хранится на сервере. Никогда.',
    '🎯 Общие темы видны прямо в звонке — начните с них.',
  ];

  screens.queue = () => {
    const scr = screenShell('queue', `
      <div class="queue">
        <div class="radar"><div class="radar__ring"></div><div class="radar__ring radar__ring--2"></div><div class="radar__ring radar__ring--3"></div>
          ${avatar(State.nick, State.user?.avatarHue ?? 210, 84)}</div>
        <h2>Ищем вашего собеседника…</h2>
        <div class="queue__timer" id="queueTimer">0:00</div>
        <div class="queue__meta" id="queueMeta"></div>
        <div class="queue__fact" id="queueFact"></div>
        <div class="queue__actions">
          <button class="btn btn--ghost btn--lg" id="queueCancel">Отмена</button>
          <button class="btn btn--primary btn--lg" id="queueRelaxNow">Расширить фильтры</button>
        </div>
        <div class="queue__relax" id="queueRelax"></div>
        <div class="queue__bot" id="queueBot"></div>
      </div>
    `);

    State.queue = State.queue || { startedAt: Date.now() };
    let i = 0;
    const fact = $('#queueFact');
    const tick = () => {
      const waited = Date.now() - State.queue.startedAt;
      $('#queueTimer')?.replaceChildren(document.createTextNode(fmtTime(waited / 1000)));
      const meta = $('#queueMeta');
      if (meta) meta.innerHTML = `Онлайн: <b>${State.stats.online || 0}</b> · В очереди: <b>${State.stats.queue || 0}</b> · Режим: <b>${State.cfg?.modes?.[State.mode]?.ru || 'Классика'}</b>`;
    };
    tick();
    State.queueTimers = [setInterval(tick, 500), setInterval(() => {
      i = (i + 1) % QUEUE_FACTS.length;
      if (fact) fact.textContent = QUEUE_FACTS[i];
    }, 5000)];
    if (fact) fact.textContent = QUEUE_FACTS[0];

    // Если живых собеседников нет — предлагаем демо-бота (честно подписанного)
    const botBox = $('#queueBot');
    State.queueTimers.push(setInterval(() => {
      if (!botBox || botBox.dataset.shown) return;
      const waited = Date.now() - State.queue.startedAt;
      if (waited < 12000) return;
      if (!(State.stats.online <= 2) && !State.bots?.available) return;
      botBox.dataset.shown = '1';
      botBox.innerHTML = `<div class="relax">
        <b>Пока никого нет в очереди</b>
        <p class="muted">Можно поговорить с демо-ботом: он честно представляется ботом, зато камера, микрофон и связь проверяются по-настоящему.</p>
        <button class="btn btn--primary btn--sm" id="callBot">🤖 Позвать демо-бота</button>
      </div>`;
      $('#callBot').onclick = async () => {
        const res = await emit('bot:request');
        if (!res?.ok) {
          const map = { busy: 'Бот сейчас занят — попробуйте через минуту', disabled: 'Демо-боты отключены', unavailable: 'Бот недоступен, перезапустите сервер' };
          toast(map[res?.error] || 'Не получилось', 'warn');
          return;
        }
        toast(`Подключаем: ${res.nick}`, 'info');
      };
    }, 2000));

    $('#queueCancel').onclick = async () => {
      clearInterval(State.queueTimers[0]); clearInterval(State.queueTimers[1]);
      State.queue = null;
      await emit('queue:leave');
      show('onboarding');
    };
    $('#queueRelaxNow').onclick = () => onRelaxOffer({ waitedMs: Date.now() - State.queue.startedAt, advice: suggestAdvice() });
    return scr;
  };

  function suggestAdvice() {
    const a = [];
    if (State.filters.age !== 'any') a.push({ key: 'age', value: 'any' });
    if (State.filters.gender !== 'any') a.push({ key: 'gender', value: 'any' });
    if (State.filters.topics.length) a.push({ key: 'topics', value: [] });
    return a;
  }

  function onRelaxOffer(d) {
    const box = $('#queueRelax'); if (!box) return;
    const advice = d.advice?.length ? d.advice : suggestAdvice();
    if (!advice.length) {
      box.innerHTML = `<div class="relax"><b>Сейчас в очереди мало людей.</b><p class="muted">Попробуйте позже или позовите друга — за приглашение дают Premium.</p></div>`;
      return;
    }
    const labels = { age: 'любой возраст', gender: 'любой пол', topics: 'без тем', language: 'любой язык' };
    box.innerHTML = `<div class="relax">
      <b>${ZV.t('relaxTitle')}</b>
      <p class="muted">${ZV.t('relaxHint')} ${advice.map(a => labels[a.key]).join(', ')}</p>
      <button class="btn btn--primary btn--sm" id="relaxApply">${ZV.t('relaxGo')}</button>
    </div>`;
    $('#relaxApply').onclick = async () => {
      const patch = {};
      advice.forEach(a => { patch[a.key] = a.value; });
      Object.assign(State.filters, patch);
      State.strict = false;
      await emit('queue:relax', { patch });
      box.innerHTML = '';
      if (State.queue) State.queue.startedAt = Date.now();
      toast('Фильтры расширены', 'success');
    };
  }

  async function joinQueue() {
    if (!ZVMedia.stream) {
      const res = await ZVMedia.start({ video: State.mode !== 'voiceonly', audio: true });
      if (res.demo) toast('Камера недоступна — включён демо-поток', 'warn', 5000);
    }
    if (State.mode === 'voiceonly') ZVMedia.stream?.getVideoTracks().forEach(t => t.enabled = false);

    const res = await emit('queue:join', {
      filters: State.filters, strict: State.strict, mode: State.mode,
      captchaSolved: State.captchaOk || State.role !== 'guest',
    });
    if (res && res.ok === false) {
      if (res.error === 'captcha') return openCaptcha();
      if (res.error === 'ratelimit') { toast('Слишком много попыток. Подождите немного или зарегистрируйтесь.', 'error'); return; }
      if (res.error === 'banned') { toast('Аккаунт заблокирован', 'error'); return; }
      if (res.error === 'quota') { ZVDirect.showQuotaGate(res.quota); return; }
    }
    State.queue = { startedAt: Date.now() };
    show('queue');
  }

  function openCaptcha() {
    if (!$('#captchaModal')) {
      const overlay = el('div', { class: 'modal', id: 'captchaModal' }, [
        el('div', { class: 'modal__card' }, [
          el('h3', { text: 'Вы человек?' }),
          el('p', { class: 'muted', text: 'Гостям нужна быстрая проверка — это защита от ботов.' }),
          el('div', { class: 'captcha', text: '…' }),
          el('input', { class: 'input', id: 'captchaInput', inputmode: 'numeric', placeholder: 'Ответ' }),
          el('div', { class: 'modal__actions' }, [el('button', { class: 'btn btn--primary', id: 'captchaSend', text: 'Проверить' })]),
        ]),
      ]);
      document.body.append(overlay);
      State.socket?.emit('captcha:get', {}, (cap) => {
        State.captcha = cap;
        overlay.querySelector('.captcha').textContent = cap.question + ' = ?';
      });
      $('#captchaSend').onclick = () => {
        State.socket?.emit('captcha:solve', { id: State.captcha?.id, answer: Number($('#captchaInput').value) }, (r) => {
          if (r?.ok) { State.captchaOk = true; overlay.remove(); toast('Спасибо! Продолжаем', 'success'); joinQueue(); }
          else toast('Неверно, попробуйте ещё раз', 'error');
        });
      };
    }
  }

  /* ============================================================
     ЗВОНОК
     ============================================================ */
  screens.call = (params) => {
    const d = params.data;
    const scr = screenShell('call', `
      <div class="call" data-mode="${d.mode}">
        <div class="call__stage">
          <video id="remoteVideo" autoplay playsinline class="video video--remote"></video>
          <div class="call__placeholder" id="remotePlaceholder">${avatar(d.peer.nick, d.peer.avatarHue, 96)}</div>
          <video id="localVideo" autoplay playsinline muted class="video video--local"></video>

          <div class="call__top">
            <div class="call__peer">
              <span class="call__nick">${esc(d.peer.nick)}</span>
              <span class="call__match" title="Скор взаимного совпадения">⚡ ${d.score ?? '—'}</span>
              ${(d.mutualTopics || []).map(t => `<span class="tag">${esc(State.cfg?.topics?.find(x => x.id === t)?.ru || t)}</span>`).join('')}
            </div>
            <div class="call__status">
              <span class="status" id="callStatus">Соединение…</span>
              <span class="timer" id="callTimer">0:00</span>
              <span class="qbadge" id="qBadge" title="Качество связи">●</span>
            </div>
          </div>

          <div class="call__question" id="callQuestion">${esc(d.question || '')}</div>
          <div class="call__blind" id="blindNotice" style="display:none">🙈 Свидание вслепую: видео включится через <b id="blindTimer">3:00</b></div>

          <div class="call__reactions" id="reactionsLayer"></div>

          <div class="call__recbadge" id="recBadge"><span class="rec-dot"></span> REC</div>

          <div class="call__captions" id="captionsBox">
            <div class="cap cap--peer">
              <span class="cap__who">${esc(d.peer.nick)}</span>
              <div class="cap__text" id="capPeer"></div>
              <div class="cap__tr" id="capPeerTr"></div>
            </div>
            <div class="cap cap--self">
              <span class="cap__who">Вы</span>
              <div class="cap__text" id="capSelf"></div>
              <div class="cap__tr" id="capSelfTr"></div>
            </div>
          </div>

          <div class="call__controls">
            <button class="cbtn cbtn--skip" data-act="skip" title="Пропустить">⟳<span>Пропустить</span></button>
            <button class="cbtn" data-act="mic" title="Микрофон">🎤<span>Микрофон</span></button>
            <button class="cbtn" data-act="cam" title="Камера">📷<span>Камера</span></button>
            <button class="cbtn" data-act="react" title="Реакции">😂<span>Реакции</span></button>
            <button class="cbtn" data-act="chat" title="Чат">💬<span>Чат</span></button>
            <button class="cbtn" data-act="more" title="Ещё">⋯<span>Ещё</span></button>
            <button class="cbtn cbtn--end" data-act="hangup" title="Завершить">✕<span>Завершить</span></button>
          </div>

          <div class="call__side" id="chatPanel">
            <div class="chat__head"><b>Чат звонка</b><button class="icon-btn" data-act="chat-close">✕</button></div>
            <div class="chat__log" id="chatLog"></div>
            <form class="chat__form" id="chatForm"><input class="input" id="chatInput" placeholder="Сообщение…" maxlength="300" autocomplete="off"><button class="btn btn--primary btn--sm">➤</button></form>
            <div class="chat__reactions">${['👍', '❤️', '😂', '😮', '🔥', '👏'].map(e => `<button class="emoji-btn" data-emoji="${e}">${e}</button>`).join('')}</div>
          </div>

          <div class="call__more" id="morePanel">
            <button data-act="friend">🤝 Добавить в друзья</button>
            <button data-act="captions">💬 Субтитры <span class="pill pill--v2">V2</span></button>
            <button data-act="translate">🌐 Перевод субтитров</button>
            <button data-act="record"><span id="recLabel">⏺️ Записать звонок</span> <span class="pill pill--v2">V2</span></button>
            <button data-act="report">🚩 Пожаловаться</button>
            <button data-act="block">⛔ Заблокировать</button>
            <button data-act="sos">🆘 SOS — разорвать немедленно</button>
            <button data-act="quality">🎚️ Качество: <span id="qualityLabel">авто</span></button>
            <button data-act="pip">🖼️ Картинка-в-картинке</button>
            <button data-act="fs">⛶ Полный экран</button>
            <button data-act="question">💡 Другой вопрос</button>
          </div>
        </div>
      </div>
    `);

    const localVideo = $('#localVideo'), remoteVideo = $('#remoteVideo');
    localVideo.srcObject = ZVMedia.stream;
    localVideo.muted = true;

    // локальные кнопки
    const timers = [];
    State.callStartedAt = Date.now();
    timers.push(setInterval(() => {
      if (!State.call) return;
      $('#callTimer')?.replaceChildren(document.createTextNode(fmtTime((Date.now() - (State.callConnectedAt || Date.now())) / 1000)));
    }, 500));

    // слепое свидание
    if (d.mode === 'blind' && d.blindRevealMs) {
      $('#blindNotice').style.display = '';
      remoteVideo.classList.add('is-hidden-media');
      const t0 = Date.now();
      timers.push(setInterval(() => {
        const left = d.blindRevealMs - (Date.now() - t0);
        if (left <= 0) {
          $('#blindNotice')?.remove();
          remoteVideo.classList.remove('is-hidden-media');
          toast('Видео включено 👀', 'info');
          return;
        }
        const b = $('#blindTimer'); if (b) b.textContent = fmtTime(left / 1000);
      }, 500));
    }

    $$('.cbtn', scr).forEach(btn => btn.onclick = () => handleControl(btn.dataset.act));
    $$('#morePanel button', scr).forEach(btn => btn.onclick = () => handleMore(btn.dataset.act));
    $$('.emoji-btn', scr).forEach(btn => btn.onclick = () => sendReaction(btn.dataset.emoji));

    $('#chatForm').onsubmit = async (e) => {
      e.preventDefault();
      const input = $('#chatInput');
      const text = input.value.trim(); if (!text) return;
      input.value = '';
      const res = await emit('chat:message', { callId: d.callId, text });
      if (res?.ok) appendChat(res.message, true);
    };
    $('[data-act="chat-close"]').onclick = () => $('#chatPanel').classList.remove('is-open');

    State.callTimers = timers;
    startCallSession(d);
    return scr;
  };

  function handleControl(act) {
    Sound.click();
    if (act === 'skip') return doSkip();
    if (act === 'hangup') return doHangup();
    if (act === 'mic') {
      State.micOn = !State.micOn;
      ZVMedia.setMicOn?.(State.micOn);
      ZVMedia.stream?.getAudioTracks().forEach(t => t.enabled = State.micOn);
      State.call?.setMic(State.micOn);
      markBtn('mic', State.micOn);
    }
    if (act === 'cam') {
      State.camOn = !State.camOn;
      ZVMedia.stream?.getVideoTracks().forEach(t => t.enabled = State.camOn);
      State.call?.setCamera(State.camOn);
      markBtn('cam', State.camOn);
    }
    if (act === 'react') {
      const panel = $('#morePanel');
      panel.classList.remove('is-open');
      const strip = el('div', { class: 'quick-reactions' }, ['👍', '❤️', '😂', '😮', '🔥', '👏', '🤝'].map(e =>
        el('button', { class: 'emoji-btn', text: e, onclick: () => { sendReaction(e); strip.remove(); } })));
      $('.call__controls').before(strip);
      setTimeout(() => strip.remove(), 6000);
    }
    if (act === 'chat') $('#chatPanel').classList.toggle('is-open');
    if (act === 'more') $('#morePanel').classList.toggle('is-open');
  }

  function markBtn(act, on) {
    const btn = $(`.cbtn[data-act="${act}"]`);
    if (btn) btn.classList.toggle('is-off', !on);
  }

  /** Перевод субтитров: включаем только если на сервере настроен переводчик. */
  async function toggleTranslate() {
    const v2 = State.cfg?.v2 || {};
    if (v2.translate?.premium && !State.user?.isPremium) { toast('Перевод субтитров — функция Premium', 'warn'); openPremiumUpsell(); return; }
    const ok = await ZVV2.Translate.check();
    if (!ok) {
      toast('Перевод не настроен на сервере. Задайте TRANSLATE_URL (LibreTranslate) — см. README.', 'warn', 7000);
      return;
    }
    State.translateOn = !State.translateOn;
    $$('[data-act="translate"]').forEach(b => b.classList.toggle('is-on', State.translateOn));
    toast(State.translateOn ? 'Перевод субтитров включён' : 'Перевод субтитров выключен', 'info');
  }

  function handleMore(act) {
    $('#morePanel').classList.remove('is-open');
    const callId = State.callData?.callId;
    if (act === 'friend') return doAddFriend();
    if (act === 'captions') return toggleCaptions();
    if (act === 'translate') return toggleTranslate();
    if (act === 'record') return requestRecording();
    if (act === 'report') return openReport();
    if (act === 'block') return doBlock();
    if (act === 'sos') return doSos();
    if (act === 'quality') return cycleQuality();
    if (act === 'pip') return togglePip();
    if (act === 'fs') return toggleFullscreen();
    if (act === 'question') {
      const q = randomQuestionFor(State.mode);
      $('#callQuestion').textContent = q;
      Sound.notify();
    }
  }

  function randomQuestionFor(mode) {
    const pool = {
      chat: ['Что самое странное случилось с тобой за неделю?', 'Если бы дали лишний час в сутках — на что бы потратил?'],
      meet: ['Каким было первое впечатление обо мне?', 'Что важнее: юмор или надёжность?'],
      topic: ['Какая тема разделила бы нас сильнее всего?', 'Какой миф ты недавно разрушил для себя?'],
      language: ['Опиши свой город на этом языке', 'Какое слово здесь тебе нравится больше всего?'],
      support: ['Что сейчас занимает больше всего твоих мыслей?', 'Что бы ты хотел, чтобы тебе сегодня сказали?'],
      networking: ['Над каким проектом работаешь?', 'Какой навык хочешь прокачать в этом году?'],
      blind: ['Опиши свой голос тремя словами', 'Что бы ты спросил, если бы остался один вопрос?'],
      voiceonly: ['Расскажи историю, которую ты редко рассказываешь', 'Что тебя сегодня порадовало?'],
    };
    const list = pool[mode] || pool.chat;
    return list[Math.floor(Math.random() * list.length)];
  }

  const QUALITY_CYCLE = ['auto', 'low', 'medium', 'high'];
  const QUALITY_LABEL = { auto: 'авто', low: 'низкое', medium: 'среднее', high: 'высокое (Premium)' };
  function cycleQuality() {
    let i = QUALITY_CYCLE.indexOf(State.quality);
    i = (i + 1) % QUALITY_CYCLE.length;
    const next = QUALITY_CYCLE[i];
    if (next === 'high' && !State.user?.isPremium) { toast('HD-видео — функция Premium', 'warn'); openPremiumUpsell(); return; }
    State.quality = next;
    State.call?.setQuality(next);
    const l = $('#qualityLabel'); if (l) l.textContent = QUALITY_LABEL[next];
    toast(`Качество: ${QUALITY_LABEL[next]}`, 'info', 2000);
  }

  async function togglePip() {
    const v = $('#remoteVideo');
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled) await v.requestPictureInPicture();
    } catch { toast('PiP недоступен в этом браузере', 'warn'); }
  }
  function toggleFullscreen() {
    const stage = $('.call__stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else stage?.requestFullscreen?.().catch(() => toast('Полный экран недоступен', 'warn'));
  }

  /* ---------- старт P2P ---------- */

  async function startCallSession(d) {
    State.callData = d;
    State.lastPeer = d.peer;
    State.callError = null;
    setCallStatus('connecting');

    const call = new ZVCall({
      socket: State.socket, callId: d.callId, initiator: d.initiator,
      stream: ZVMedia.stream, iceServers: State.cfg?.iceServers,
      onEvent: onCallEvent,
    });
    State.call = call;
    State.pendingSignals = [];
    try {
      await call.setup();
      // применяем сигналы, пришедшие за время инициализации
      const early = State.pendingSignals.splice(0);
      for (const s of early) {
        if (s.type === 'offer') await call.handleOffer(s.data).catch(console.warn);
        else if (s.type === 'answer') await call.handleAnswer(s.data).catch(console.warn);
        else if (s.type === 'ice') await call.handleIce(s.data);
      }
    } catch (err) {
      State.callError = `${err?.name}: ${err?.message}`;
      console.error('[call] setup failed', err);
      toast('Не удалось поднять видеосвязь: ' + err.message, 'error', 6000);
      return;
    }

    // автомодерация: локальный кадр + громкость
    State.analyzer = ZV.createFrameAnalyzer($('#localVideo'), score => {
      State.socket?.emit('rtc:quality', { callId: d.callId, nsfwScore: score });
    }, 2000);
    if (ZVMedia.stream && !ZVMedia.isDemo) {
      State.loudMeter = ZV.createLoudnessMeter(ZVMedia.stream, () => {
        State.socket?.emit('rtc:quality', { callId: d.callId, loud: true });
      });
    }
  }

  function onCallEvent(e) {
    if (e.type === 'remote-stream') {
      const v = $('#remoteVideo');
      if (v) { v.srcObject = e.stream; v.play?.().catch(() => {}); }
      $('#remotePlaceholder')?.classList.add('is-hidden');
    }
    if (e.type === 'stats') {
      State.lastStats = e.stats;
      State.socket?.emit('rtc:quality', { callId: State.callData?.callId, rtt: e.stats.rtt, quality: e.stats.quality });
      setQualityBadge({ rtt: e.stats.rtt, quality: e.stats.quality });
    }
    if (e.type === 'pc-state' && e.state === 'failed') endCallUi('failed', true);
  }

  function setQualityBadge(d) {
    const b = $('#qBadge'); if (!b) return;
    b.className = 'qbadge qbadge--' + (d.quality || 'good');
    b.title = d.rtt ? `Задержка ${d.rtt} мс` : 'Качество связи';
  }

  function setCallStatus(state) {
    const s = $('#callStatus'); if (!s) return;
    s.textContent = { connecting: 'Соединение…', connected: '● В эфире', reconnecting: 'Переподключение…', failed: 'Связь потеряна', ended: 'Завершено' }[state] || state;
    s.dataset.state = state;
  }

  function onMatched(d) {
    Sound.match();
    State.queue = null;
    (State.queueTimers || []).forEach(clearInterval);
    show('call', { data: d });
  }

  function onSignal({ callId, type, data }) {
    // Сигнал может прийти раньше, чем у нас создан PeerConnection (инициатор шлёт offer
    // сразу после matched). Буферизуем и применим, когда сессия звонка будет готова.
    if (!State.call || State.call.callId !== callId) {
      if (State.callData?.callId === callId) (State.pendingSignals ||= []).push({ type, data });
      return;
    }
    if (type === 'offer') State.call.handleOffer(data).catch(console.warn);
    if (type === 'answer') State.call.handleAnswer(data).catch(console.warn);
    if (type === 'ice') State.call.handleIce(data);
  }

  function onCallConnected() {
    State.callConnectedAt = Date.now();
    setCallStatus('connected');
    Sound.notify();
    navigator.vibrate?.(30);
  }

  function onPeerDropped(d) {
    setCallStatus('reconnecting');
    toast(`Собеседник потерял связь — ждём ${Math.round(d.graceMs / 1000)} с`, 'warn');
  }

  function onPeerGone(kind, d) {
    toast(kind === 'skip' ? ZV.t('peerSkipped') : ZV.t('peerLeft'), 'info');
    Sound.skip();
  }

  function onCallEnded(d) {
    cleanupCall();
    if (d.quota) ZVDirect.setQuota(d.quota);
    if (d.tooShort) {
      // Звонок короче 5 секунд не засчитывается: сервер уже вернул нас в очередь.
      toast('Звонок слишком короткий — ищем следующего', 'info');
      show('queue');
      return;
    }
    State.callResult = d;
    if (d.unlocked?.length) d.unlocked.forEach(a => showAchievement(a));
    if (d.referralReward) toast('Реферальный бонус начислен: Premium + монеты', 'success', 6000);
    if (d.quests) State.quests = d.quests;
    if (d.level) State.level = d.level;
    if (State.user && typeof d.coins === 'number') State.user.coins = d.coins;
    show('rate', { data: d });
  }

  function cleanupCall() {
    State.analyzer?.stop(); State.loudMeter?.stop();
    State.captions?.stop();
    State.recorder?.destroy();
    State.captions = null; State.recorder = null;
    State.capTimer?.forEach?.(clearTimeout);
    State.capTimer = [];
    State.call?.close();
    (State.callTimers || []).forEach(clearInterval);
    State.call = null;
    setCallStatus('ended');
  }

  /* ============================================================
     V2: СУБТИТРЫ
     ============================================================ */

  async function toggleCaptions() {
    const v2 = State.cfg?.v2 || {};
    if (v2.captions?.premium && !State.user?.isPremium) { toast('Субтитры входят в Premium', 'warn'); openPremiumUpsell(); return; }
    if (!$('.call__captions')) return;

    if (State.captions?.running) {
      State.captions.stop();
      $('.call__captions')?.classList.remove('is-on');
      $$('.cbtn[data-act="captions"]').forEach(b => b.classList.remove('is-on'));
      toast('Субтитры выключены', 'info', 2000);
      return;
    }

    const c = new ZVV2.LiveCaptions({
      socket: State.socket,
      callId: State.callData?.callId,
      lang: LANG_SPEECH[State.filters?.language] || 'ru-RU',
      onLocal: (d) => showCaption('self', d.text, d.final),
      onRemote: (d) => showCaption('peer', d.text, d.final),
    });

    if (!c.supported) {
      toast('Ваш браузер не поддерживает распознавание речи — попробуйте Chrome или Edge', 'warn', 6000);
      return;
    }
    if (!c.start()) { toast('Не удалось включить распознавание речи', 'error'); return; }

    State.captions = c;
    $('.call__captions')?.classList.add('is-on');
    $$('.cbtn[data-act="captions"]').forEach(b => b.classList.add('is-on'));
    toast('Субтитры включены. Наружу уходит только текст — аудио остаётся у вас.', 'success', 5000);

    // проверяем доступность перевода один раз
    ZVV2.Translate.check();
  }

  /** Показывает строку субтитра; при включённом переводе — двуязычную. */
  async function showCaption(who, text, final) {
    const box = who === 'self' ? $('#capSelf') : $('#capPeer');
    if (!box) return;
    box.textContent = text;
    box.classList.toggle('is-interim', !final);

    clearTimeout(box._hide);
    box._hide = setTimeout(() => { box.textContent = ''; }, final ? 6000 : 2500);

    if (!final || !State.translateOn) return;
    const ok = await ZVV2.Translate.check();
    if (!ok) return;
    const from = who === 'self' ? (State.myLang || 'ru') : (State.peerLang || 'ru');
    const to = State.translateTarget || 'ru';
    if (from === to) return;
    const tr = await ZVV2.Translate.text(text, from, to);
    if (tr && tr !== text) {
      const sub = who === 'self' ? $('#capSelfTr') : $('#capPeerTr');
      if (sub) { sub.textContent = tr; clearTimeout(sub._hide); sub._hide = setTimeout(() => { sub.textContent = ''; }, 6000); }
    }
  }

  function onRemoteCaption(d) {
    State.captions?.incoming(d.text, d.final);
    if (!State.captions) showCaption('peer', d.text, d.final);
  }

  /* ============================================================
     V2: ЗАПИСЬ (только по взаимному согласию)
     ============================================================ */

  function ensureRecorder() {
    const callId = State.callData?.callId;
    // переиспользуем только «живой» рекордер; в idle пересобираем, чтобы взять
    // актуальные потоки (P2P мог подняться уже после создания)
    if (State.recorder && State.recorder.callId === callId && State.recorder.state !== 'idle') return State.recorder;
    State.recorder?.destroy();
    State.recorder = new ZVV2.CallRecorder({
      socket: State.socket,
      callId: State.callData?.callId,
      localStream: ZVMedia.stream,
      remoteStream: State.call?.remoteStream,
      remoteVideo: $('#remoteVideo'),
      localVideo: $('#localVideo'),
      onState: (s) => setRecordingUi(s.state, s),
    });
    return State.recorder;
  }

  function requestRecording() {
    const v2 = State.cfg?.v2 || {};
    if (v2.recording?.premium && !State.user?.isPremium) { toast('Запись звонка — функция Premium', 'warn'); openPremiumUpsell(); return; }
    const rec = ensureRecorder();
    // повторное нажатие во время записи — остановить и сохранить файл
    if (rec.state === 'recording') { rec.stop(); return; }
    if (rec.state === 'pending') { toast('Запрос на запись уже отправлен', 'info'); return; }
    rec.request();
  }

  /** Входящий запрос: нужен явный ответ собеседника. */
  function askRecordingConsent(d) {
    if ($('#recConsent')) return;
    Sound.notify();
    const overlay = el('div', { class: 'modal', id: 'recConsent' }, [
      el('div', { class: 'modal__card' }, [
        el('h3', { text: 'Вас просят разрешить запись' }),
        el('p', { html: `<b>${esc(d.by)}</b> хочет записать этот разговор.` }),
        el('p', { class: 'muted', text: 'Запись делается на устройстве каждого участника и не отправляется на сервер. Без вашего согласия запись не начнётся.' }),
        el('div', { class: 'modal__actions' }, [
          el('button', { class: 'btn btn--ghost', text: 'Отклонить', onclick: () => { ensureRecorder().respond(false); overlay.remove(); } }),
          el('button', { class: 'btn btn--primary', text: 'Разрешить', onclick: () => { ensureRecorder().respond(true); overlay.remove(); } }),
        ]),
      ]),
    ]);
    document.body.append(overlay);
  }

  function onRecordingStart(d) {
    const rec = ensureRecorder();
    // на момент старта (а не запроса) потоки и элементы уже точно есть
    rec.remoteStream = State.call?.remoteStream || rec.remoteStream;
    rec.localStream = ZVMedia.stream || rec.localStream;
    rec.remoteVideo = $('#remoteVideo') || rec.remoteVideo;
    rec.localVideo = $('#localVideo') || rec.localVideo;
    rec.maxMs = d?.maxMs || State.cfg?.v2?.maxRecordingMs || 10 * 60_000;
    rec.start();
  }

  function onRecordingStop(d) {
    const rec = State.recorder;
    if (rec) {
      if (rec.state === 'recording') { rec.chunks.length ? rec.stop() : rec.finish(); }
      rec.state = 'idle';
    }
    setRecordingUi('idle');
    if (d?.auto) toast('Запись остановлена — звонок завершён', 'info', 4000);
  }

  function setRecordingUi(state, extra = {}) {
    const badge = $('#recBadge');
    if (badge) {
      badge.classList.toggle('is-on', state === 'recording' || state === 'pending');
      badge.classList.toggle('is-pending', state === 'pending');
      if (state === 'recording' && extra.durationMs) {
        const t = fmtTime(extra.durationMs / 1000);
        badge.innerHTML = `<span class="rec-dot"></span> REC ${t}`;
      } else if (state === 'pending') {
        badge.innerHTML = `<span class="rec-dot"></span> Запрос записи…`;
      }
    }
    $$('.cbtn[data-act="record"]').forEach(b => b.classList.toggle('is-on', state === 'recording'));
    const label = $('#recLabel');
    if (label) label.textContent = state === 'recording' ? '⏹️ Остановить запись' : '⏺️ Записать звонок';
  }

  function endCallUi(reason, forced = false) {
    if (forced) toast('Звонок прерван: ' + reason, 'error');
    cleanupCall();
  }

  async function doSkip() {
    const res = await emit('call:skip', { callId: State.callData?.callId });
    Sound.skip();
    if (res?.ok === false && res.error === 'limit') return;
    // Сервер сам возвращает обоих в очередь (ТЗ §3.6) — экран оценки покажет «Следующий».
  }

  async function doHangup() {
    await emit('call:hangup', { callId: State.callData?.callId });
    Sound.end();
  }

  async function doBlock() {
    await emit('block', { callId: State.callData?.callId });
    toast('Собеседник заблокирован — вы больше не встретитесь', 'success');
  }

  async function doSos() {
    await emit('call:sos', { callId: State.callData?.callId });
    toast('SOS отправлен. Звонок разорван, жалоба у модераторов.', 'error', 6000);
    show('landing');
  }

  async function doAddFriend() {
    const peer = State.lastPeer;
    if (!peer?.id?.startsWith('u_')) { toast('Гостей нельзя добавить в друзья — позовите его зарегистрироваться', 'warn'); return; }
    const res = await emit('friend:request', { target: peer.id });
    if (res?.status === 'accepted') toast('Вы уже друзья 🎉', 'success');
    else toast('Запрос отправлен — ждём согласия', 'success');
  }

  function openReport() {
    const reasons = State.cfg.reportReasons;
    const overlay = el('div', { class: 'modal' }, [
      el('div', { class: 'modal__card' }, [
        el('h3', { text: 'Пожалоба на собеседника' }),
        el('p', { class: 'muted', text: 'Анонимно. Звонок прервётся сразу после отправки.' }),
        el('div', { class: 'chips', id: 'reasonChips' }, reasons.map(r =>
          el('button', { class: 'chip-btn', 'data-r': r.id, text: `${r.ru}` }))),
        el('textarea', { class: 'input', id: 'reportComment', rows: 3, placeholder: 'Комментарий (необязательно)' }),
        el('div', { class: 'modal__actions' }, [
          el('button', { class: 'btn btn--ghost', text: 'Отмена', onclick: () => overlay.remove() }),
          el('button', { class: 'btn btn--danger', id: 'reportSend', text: 'Отправить жалобу' }),
        ]),
      ]),
    ]);
    document.body.append(overlay);
    let reason = 'other';
    $$('#reasonChips .chip-btn', overlay).forEach(b => b.onclick = () => {
      reason = b.dataset.r;
      $$('#reasonChips .chip-btn', overlay).forEach(x => x.classList.toggle('is-on', x === b));
    });
    $('#reportSend', overlay).onclick = async () => {
      await emit('report', { callId: State.callData?.callId, reason, comment: $('#reportComment', overlay).value });
      overlay.remove();
      toast('Жалоба отправлена. Спасибо, что делаете сервис безопаснее.', 'success', 6000);
      show('landing');
    };
  }

  /* ---------- чат и реакции ---------- */

  function appendChat(msg, mine) {
    const log = $('#chatLog'); if (!log) return;
    log.append(el('div', { class: 'msg' + (mine ? ' msg--mine' : '') }, [
      el('span', { class: 'msg__nick', text: mine ? 'Вы' : msg.nick }),
      el('span', { class: 'msg__text', text: msg.text }),
    ]));
    log.scrollTop = log.scrollHeight;
  }

  function onIncomingChat(msg) { appendChat(msg, false); Sound.notify(); $('#chatPanel')?.classList.add('is-open'); }

  function sendReaction(emoji) {
    State.socket?.emit('reaction', { callId: State.callData?.callId, emoji });
    spawnReaction(emoji, false);
  }

  function spawnReaction(emoji, incoming) {
    const layer = $('#reactionsLayer'); if (!layer) return;
    const node = el('div', { class: 'float-emoji' + (incoming ? ' is-incoming' : ''), text: emoji });
    node.style.left = (10 + Math.random() * 70) + '%';
    layer.append(node);
    setTimeout(() => node.remove(), 2400);
  }

  /* ============================================================
     ОЦЕНКА
     ============================================================ */
  screens.rate = (params) => {
    const d = params.data || {};
    const peer = d.peer || State.lastPeer || { nick: 'Собеседник' };
    const scr = screenShell('rate', `
      <div class="rate">
        <div class="rate__card">
          ${avatar(peer.nick, 260, 84)}
          <h2>${ZV.t('rateTitle')}</h2>
          <p class="muted">Разговор длился ${fmtTime((d.durationMs || 0) / 1000)} · ${esc(peer.nick || '')}</p>
          <div class="stars" id="stars">${[1, 2, 3, 4, 5].map(i => `<button data-s="${i}">★</button>`).join('')}</div>
          <div class="chips" id="rateTags">${(State.cfg?.ratingTags || []).map(t =>
            `<button class="chip-btn" data-tag="${t.id}">${t.ru}</button>`).join('')}</div>
          <div class="rate__actions">
            <button class="btn btn--ghost btn--lg" id="rateFriend">🤝 В друзья</button>
            <button class="btn btn--primary btn--lg" id="rateNext">Следующий →</button>
          </div>
          <div class="rate__extra">
            <button class="btn btn--ghost btn--sm" id="rateShare">📤 Поделиться результатом</button>
            <button class="btn btn--ghost btn--sm" id="rateReport">🚩 Пожаловаться</button>
          </div>
          <div class="rate__stats" id="rateStats"></div>
        </div>
      </div>
    `);

    let stars = 0; const tags = new Set();
    $$('#stars button', scr).forEach(b => b.onclick = () => {
      stars = +b.dataset.s;
      $$('#stars button', scr).forEach(x => x.classList.toggle('is-on', +x.dataset.s <= stars));
      Sound.click();
    });
    $$('#rateTags .chip-btn', scr).forEach(b => b.onclick = () => {
      const id = b.dataset.tag;
      tags.has(id) ? tags.delete(id) : tags.add(id);
      b.classList.toggle('is-on');
      Sound.click();
    });

    $('#rateNext').onclick = async () => {
      if (stars) await emit('rate', { callId: d.callId, stars, tags: [...tags] });
      Sound.click();
      await joinQueue();   // сервер мог уже вернуть нас в очередь — join идемпотентен
    };
    $('#rateFriend').onclick = doAddFriend;
    $('#rateReport').onclick = openReport;
    $('#rateShare').onclick = () => shareResult(d);

    if (State.level) {
      $('#rateStats').innerHTML = `
        <div class="lvl"><b>Уровень ${State.level.level}</b><div class="lvl__bar"><i style="width:${Math.round(State.level.progress * 100)}%"></i></div>
        <span class="muted">${State.level.xp} / ${State.level.next} XP</span></div>`;
    }
    return scr;
  };

  async function shareResult(d) {
    const seconds = Math.round((d.durationMs || 0) / 1000);
    const url = State.referral?.link || location.origin;
    // карточка результата — виральный артефакт
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1080; canvas.height = 620;
      const ctx = canvas.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 1080, 620);
      g.addColorStop(0, '#150b2e'); g.addColorStop(1, '#071228');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 1080, 620);
      ctx.fillStyle = 'rgba(140,90,255,.16)';
      ctx.beginPath(); ctx.arc(880, 90, 240, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '700 64px system-ui';
      ctx.fillText('Zvonitel.ru', 70, 130);
      ctx.font = '400 34px system-ui'; ctx.fillStyle = 'rgba(255,255,255,.7)';
      ctx.fillText('умная видеорулетка', 70, 180);
      ctx.font = '700 92px system-ui'; ctx.fillStyle = '#fff';
      ctx.fillText(`${fmtTime(seconds)}`, 70, 340);
      ctx.font = '400 36px system-ui'; ctx.fillStyle = 'rgba(255,255,255,.6)';
      ctx.fillText('разговор с новым человеком', 70, 400);
      ctx.font = '600 30px system-ui'; ctx.fillStyle = '#a78bfa';
      ctx.fillText(url, 70, 540);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const file = new File([blob], 'zvonitel.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], text: ZV.shareText(url) }); return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'zvonitel-result.png'; a.click();
      toast('Карточка сохранена — выкладывайте в сторис!', 'success');
    } catch {
      ZV.share(url);
    }
  }

  /* ============================================================
     КОМНАТА
     ============================================================ */
  screens.room = (params) => {
    const scr = screenShell('room', `
      <div class="room">
        <h2>Приватная комната</h2>
        <p class="muted">Создайте комнату и отправьте ссылку другу — звонок начнётся автоматически, когда он зайдёт.</p>
        <div class="room__grid">
          <div class="room__card">
            <button class="btn btn--primary btn--lg" id="roomCreate">Создать комнату</button>
            <div id="roomInfo"></div>
          </div>
          <div class="room__card">
            <label class="field__label">Присоединиться по коду</label>
            <div class="room__join"><input class="input" id="roomCode" placeholder="например, k7m2qa" maxlength="6">
            <button class="btn btn--ghost" id="roomJoin">Войти</button></div>
          </div>
        </div>
        <div class="room__stage" id="roomStage"></div>
      </div>
    `);

    $('#roomCreate').onclick = async () => {
      if (!ZVMedia.stream) await ZVMedia.start({ video: true, audio: true });
      const res = await emit('room:create', { mode: State.mode });
      if (!res?.ok) return;
      State.room = res.room;
      renderRoomInfo(res);
    };

    $('#roomJoin').onclick = async () => {
      const code = $('#roomCode').value.trim().toLowerCase();
      if (!code) return;
      if (!ZVMedia.stream) await ZVMedia.start({ video: true, audio: true });
      const res = await emit('room:join', { code });
      if (!res?.ok) { toast(res?.error === 'full' ? 'В комнате уже два человека' : 'Комната не найдена', 'error'); return; }
      State.room = res.room;
      renderRoomInfo(res);
    };

    function renderRoomInfo(res) {
      const link = `${location.origin}/r/${res.room.code}`;
      $('#roomInfo').innerHTML = `
        <div class="room__link"><input readonly class="input" value="${esc(link)}" id="roomLink">
        <button class="btn btn--primary btn--sm" id="roomCopy">Копировать</button></div>
        <div class="share-row">
          <button class="btn btn--ghost btn--sm" id="roomTg">Telegram</button>
          <button class="btn btn--ghost btn--sm" id="roomVk">VK</button>
          <button class="btn btn--ghost btn--sm" id="roomShare">Поделиться</button>
        </div>
        <p class="muted">Комната ${esc(res.room.code)} · участников: ${res.room.size}/2</p>`;
      $('#roomCopy').onclick = async () => { await navigator.clipboard.writeText(link); toast('Ссылка скопирована', 'success'); };
      $('#roomTg').onclick = () => window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Звоним?')}`, '_blank');
      $('#roomVk').onclick = () => window.open(`https://vk.com/share.php?url=${encodeURIComponent(link)}`, '_blank');
      $('#roomShare').onclick = () => ZV.share(link, 'Звоним в Zvonitel.ru');
    }

    if (params.code) {
      $('#roomCode').value = params.code;
      setTimeout(() => $('#roomJoin').click(), 400);
    }
    return scr;
  };

  /* ============================================================
     ПРОФИЛЬ
     ============================================================ */
  screens.profile = () => {
    if (!State.user) return show('auth');
    const u = State.user;
    const scr = screenShell('profile', `
      <div class="profile">
        <div class="profile__head">
          ${avatar(u.nick, u.avatarHue, 88)}
          <div>
            <h2>${esc(u.nick)} ${u.isPremium ? '<span class="pill pill--gold">Premium</span>' : ''}</h2>
            <p class="muted">${u.rating ? `★ ${u.rating} (${u.ratingCount})` : 'Рейтинга пока нет'} · ${u.calls} ${plural(u.calls, ['звонок', 'звонка', 'звонков'])} · 🪙 ${u.coins}</p>
            <p class="muted">Серия: 🔥 ${u.streak} ${plural(u.streak, ['день', 'дня', 'дней'])} (рекорд ${u.bestStreak})</p>
          </div>
          <div class="profile__actions">
            <button class="btn btn--ghost btn--sm" id="editProfile">Редактировать</button>
            <button class="btn btn--primary btn--sm" id="buyPremium">Premium за 500 🪙</button>
          </div>
        </div>
        <div class="profile__grid">
          <section class="card"><h3>Уровень</h3><div id="profileLevel"></div></section>
          <section class="card"><h3>Задания на сегодня</h3><div id="profileQuests"></div></section>
          <section class="card"><h3>Достижения</h3><div class="ach" id="profileAch"></div></section>
          <section class="card"><h3>Друзья</h3><div id="profileFriends"></div></section>
          <section class="card"><h3>История звонков</h3><div id="profileHistory"></div></section>
          <section class="card"><h3>Рефералы</h3><div id="profileRef"></div></section>
        </div>
      </div>
    `);

    loadMe().then(data => {
      if (!data) return;
      State.user = data.user; State.quests = data.quests; State.achievements = data.achievements;
      State.level = data.level; State.friends = data.friends; State.referral = data.referral;
      renderProfile(data);
    });

    $('#editProfile').onclick = () => openEditProfile();
    $('#buyPremium').onclick = async () => {
      try {
        const { user } = await api('/api/me/coins-to-premium', { method: 'POST' });
        State.user = user; toast('Premium активирован на 24 часа 🎉', 'success');
        show('profile');
      } catch (e) { toast(e.data?.error === 'not_enough_coins' ? `Не хватает ${e.data.need} монет` : 'Ошибка', 'error'); }
    };
    return scr;
  };

  async function loadMe() {
    if (!State.token) return null;
    try {
      const data = await api('/api/me');
      State.user = data.user; State.token = data.token;
      Store.set('token', data.token);
      updateNav();
      return data;
    } catch { Store.del('token'); State.token = null; State.user = null; return null; }
  }

  function renderProfile(data) {
    const lv = State.level;
    $('#profileLevel').innerHTML = lv ? `
      <div class="lvl lvl--big"><b>Уровень ${lv.level}</b>
      <div class="lvl__bar"><i style="width:${Math.round(lv.progress * 100)}%"></i></div>
      <span class="muted">${lv.xp} / ${lv.next} XP</span></div>` : '';

    $('#profileQuests').innerHTML = (State.quests || []).map(q => `
      <div class="quest ${q.done ? 'is-done' : ''}">
        <div class="quest__row"><span>${q.ru}</span><span>${q.progress}/${q.target}</span></div>
        <div class="quest__bar"><i style="width:${Math.min(100, q.progress / q.target * 100)}%"></i></div>
        <span class="quest__reward">+${q.reward} 🪙</span>
      </div>`).join('') || '<p class="muted">Нет заданий</p>';

    $('#profileAch').innerHTML = (State.achievements || []).map(a => `
      <div class="ach__item ${a.unlocked ? 'is-on' : ''}" title="${esc(a.reward || '')}">
        <span>${a.emoji}</span><b>${a.ru}</b></div>`).join('');

    $('#profileFriends').innerHTML = (State.friends || []).length
      ? State.friends.map(f => `<div class="friend"><span class="dot ${f.status === 'accepted' ? 'dot--on' : ''}"></span>${avatar(f.nick, f.avatar_hue, 28)} ${esc(f.nick)} <span class="muted">${f.status === 'accepted' ? 'друг' : 'ожидает'}</span></div>`).join('')
      : '<p class="muted">Пока нет друзей. Добавляйте собеседников после звонка.</p>';

    $('#profileHistory').innerHTML = (data.history || []).length
      ? data.history.map(c => `<div class="hist"><span>${new Date(c.started_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
        <b>${fmtTime((c.duration_ms || 0) / 1000)}</b><span class="muted">${esc(c.end_reason || '')}</span></div>`).join('')
      : '<p class="muted">Истории пока нет.</p>';

    $('#profileRef').innerHTML = `
      <div class="ref-box__row"><input readonly class="input" value="${esc(State.referral?.link || '')}" id="pRefInput">
      <button class="btn btn--primary btn--sm" id="pRefCopy">Копировать</button></div>
      <p class="muted">Приглашено: ${State.user.invitedCount || 0}. Друг зарегистрировался — Premium на день, 3 звонка — ещё 3 дня и 150 🪙.</p>`;
    $('#pRefCopy').onclick = async () => { await navigator.clipboard.writeText(State.referral.link); toast('Скопировано', 'success'); };
  }

  function openEditProfile() {
    const u = State.user;
    const c = State.cfg;
    const overlay = el('div', { class: 'modal' }, [
      el('div', { class: 'modal__card modal__card--wide' }, [
        el('h3', { text: 'Профиль' }),
        el('label', { class: 'field' }, [el('span', { text: 'Ник' }), el('input', { class: 'input', id: 'edNick', value: u.nick })]),
        el('div', { class: 'field field--row' }, [
          el('label', {}, [el('span', { text: 'Возраст' }), el('input', { class: 'input', id: 'edAge', type: 'number', min: 18, max: 99, value: u.age || '' })]),
          el('label', {}, [el('span', { text: 'Пол' }), el('select', { class: 'input', id: 'edGender' },
            [['', '—'], ...c.genders.map(g => [g.id, g.ru])].map(([v, l]) => el('option', { value: v, ...(u.gender === v ? { selected: true } : {}), text: l })))])]),
        el('label', { class: 'field__label', text: 'Языки' }),
        el('div', { class: 'chips', id: 'edLangs' }, c.languages.map(l =>
          el('button', { class: 'chip-btn' + (u.languages?.includes(l.id) ? ' is-on' : ''), 'data-v': l.id, text: `${l.flag} ${l.native}` }))),
        el('label', { class: 'field__label', text: 'Цели' }),
        el('div', { class: 'chips', id: 'edGoals' }, c.goals.map(g =>
          el('button', { class: 'chip-btn' + (u.goals?.includes(g.id) ? ' is-on' : ''), 'data-v': g.id, text: `${g.emoji} ${g.ru}` }))),
        el('label', { class: 'field__label', text: 'Темы' }),
        el('div', { class: 'chips', id: 'edTopics' }, c.topics.map(tp =>
          el('button', { class: 'chip-btn' + (u.topics?.includes(tp.id) ? ' is-on' : ''), 'data-v': tp.id, text: `${tp.emoji} ${tp.ru}` }))),
        el('div', { class: 'modal__actions' }, [
          el('button', { class: 'btn btn--ghost', text: 'Отмена', onclick: () => overlay.remove() }),
          el('button', { class: 'btn btn--primary', id: 'edSave', text: 'Сохранить' }),
        ]),
      ]),
    ]);
    document.body.append(overlay);
    const toggle = (rootId) => $$('#' + rootId + ' .chip-btn', overlay).forEach(b => b.onclick = () => b.classList.toggle('is-on'));
    ['edLangs', 'edGoals', 'edTopics'].forEach(toggle);
    $('#edSave', overlay).onclick = async () => {
      const pick = id => $$('#' + id + ' .is-on', overlay).map(b => b.dataset.v);
      const body = {
        nick: $('#edNick', overlay).value.trim(),
        age: +$('#edAge', overlay).value || null,
        gender: $('#edGender', overlay).value || null,
        languages: pick('edLangs'), goals: pick('edGoals'), topics: pick('edTopics'),
      };
      await api('/api/me', { method: 'PATCH', body });
      emit('profile:set', body);
      overlay.remove();
      toast('Профиль сохранён', 'success');
      const data = await loadMe(); if (data) renderProfile(data);
    };
  }

  /* ============================================================
     АВТОРИЗАЦИЯ
     ============================================================ */
  screens.auth = () => {
    const scr = screenShell('auth', `
      <div class="auth">
        <div class="auth__card">
          <h2 id="authTitle">Регистрация</h2>
          <p class="muted">10 секунд — и у вас фильтры, история, друзья и достижения.</p>
          <form id="authForm">
            <label class="field"><span>Ник</span><input class="input" id="authNick" required minlength="2" maxlength="24" autocomplete="nickname"></label>
            <label class="field"><span>Пароль</span><input class="input" id="authPass" type="password" required minlength="4" autocomplete="current-password"></label>
            <label class="field"><span>Возраст</span><input class="input" id="authAge" type="number" min="18" max="99" value="25"></label>
            <div class="field"><span class="field__label">Пол</span>
              <div class="chips" id="authGender">${(State.cfg?.genders || []).map(g => `<button type="button" class="chip-btn" data-v="${g.id}">${g.ru}</button>`).join('')}</div></div>
            <label class="field"><span>Реферальный код (если есть)</span><input class="input" id="authRef" value="${esc(State.refCode || '')}"></label>
            <button class="btn btn--primary btn--lg" id="authSubmit" type="submit">Создать аккаунт</button>
          </form>
          <p class="auth__switch" id="authSwitch"></p>
        </div>
      </div>
    `);
    let mode = 'register';
    const render = () => {
      $('#authTitle').textContent = mode === 'register' ? 'Регистрация' : 'Вход';
      $('#authSubmit').textContent = mode === 'register' ? 'Создать аккаунт' : 'Войти';
      $('#authSwitch').innerHTML = mode === 'register'
        ? 'Уже есть аккаунт? <a href="#" id="authToLogin">Войти</a>'
        : 'Нет аккаунта? <a href="#" id="authToReg">Создать</a>';
      $('#authToLogin')?.addEventListener('click', e => { e.preventDefault(); mode = 'login'; render(); });
      $('#authToReg')?.addEventListener('click', e => { e.preventDefault(); mode = 'register'; render(); });
    };
    render();

    let gender = null;
    $$('#authGender .chip-btn', scr).forEach(b => b.onclick = () => {
      gender = b.dataset.v;
      $$('#authGender .chip-btn', scr).forEach(x => x.classList.toggle('is-on', x === b));
    });

    $('#authForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        nick: $('#authNick').value.trim(), password: $('#authPass').value,
        age: +$('#authAge').value || null, gender, ref: $('#authRef').value.trim() || undefined,
      };
      try {
        const res = await api(mode === 'register' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body });
        State.token = res.token; Store.set('token', res.token); State.user = res.user;
        toast(`Добро пожаловать, ${res.user.nick}!`, 'success');
        // переподключаем сокет уже с токеном
        State.socket?.disconnect();
        connect();
        updateNav();
        show('landing');
      } catch (err) {
        const map = { nick_taken: 'Такой ник уже занят', not_found: 'Пользователь не найден', bad_password: 'Неверный пароль', nick_short: 'Ник слишком короткий', password_short: 'Пароль от 4 символов' };
        toast(map[err.data?.error] || 'Ошибка: ' + (err.data?.error || err.message), 'error');
      }
    };
    return scr;
  };

  function openAuth(mode) {
    show('auth');
    if (mode === 'register') $('#authToReg')?.click();
  }

  /* ============================================================
     PREMIUM
     ============================================================ */
  screens.premium = () => {
    const scr = screenShell('premium', `
      <div class="premium">
        <h2>Premium</h2>
        <p class="lead">Больше контроля над подбором и качеством.</p>
        <ul class="ticks ticks--big">
          <li>Расширенные фильтры: город, точный возраст, «только с рейтингом 4.5+»</li>
          <li>Приоритет в очереди — матч в 3 раза быстрее</li>
          <li>HD-видео, маски, размытие и виртуальный фон</li>
          <li>Без рекламы, запись звонка с согласия обоих</li>
          <li>Расширенная статистика: темы, страны, длительность</li>
        </ul>
        <div class="premium__actions">
          <button class="btn btn--primary btn--xl" id="premCoins">Купить за 500 🪙</button>
          <button class="btn btn--ghost btn--xl" id="premInvite">Получить бесплатно — пригласить друга</button>
        </div>
        <p class="muted">Монеты капают за задания, серии дней и оценки собеседников.</p>
      </div>
    `);
    $('#premCoins').onclick = async () => {
      if (!State.user) return openAuth('register');
      try {
        const { user } = await api('/api/me/coins-to-premium', { method: 'POST' });
        State.user = user; toast('Premium активирован 🎉', 'success');
      } catch (e) { toast(e.data?.need ? `Не хватает ${e.data.need} монет` : 'Ошибка', 'error'); }
    };
    $('#premInvite').onclick = () => { if (State.user) show('profile'); else openAuth('register'); };
    return scr;
  };

  function openPremiumUpsell() {
    const overlay = el('div', { class: 'modal' }, [
      el('div', { class: 'modal__card' }, [
        el('h3', { text: 'Функция Premium' }),
        el('p', { text: 'Размытие фона, HD-видео, приоритет в очереди и расширенные фильтры.' }),
        el('div', { class: 'modal__actions' }, [
          el('button', { class: 'btn btn--ghost', text: 'Позже', onclick: () => overlay.remove() }),
          el('button', { class: 'btn btn--primary', text: 'Открыть Premium', onclick: () => { overlay.remove(); show('premium'); } }),
        ]),
      ]),
    ]);
    document.body.append(overlay);
  }

  /* ============================================================
     АДМИНКА
     ============================================================ */
  screens.admin = () => {
    const scr = screenShell('admin', `
      <div class="admin">
        <div class="admin__head">
          <h2>Панель модерации</h2>
          <div id="adminUser"></div>
        </div>
        <div class="admin__login" id="adminLogin">
          <div class="auth__card">
            <h3>Вход для модераторов</h3>
            <p class="muted">Демо-доступ: <code>admin</code> / <code>zvonitel</code> (задаётся через ADMIN_PASS)</p>
            <form id="adminForm">
              <label class="field"><span>Логин</span><input class="input" id="admNick" value="admin"></label>
              <label class="field"><span>Пароль</span><input class="input" id="admPass" type="password" value="zvonitel"></label>
              <button class="btn btn--primary">Войти</button>
            </form>
          </div>
        </div>
        <div class="admin__body" id="adminBody" style="display:none">
          <div class="metrics" id="adminMetrics"></div>
          <section class="card"><h3>Демо-боты <span class="muted">— чтобы новичку было с кем говорить, пока нет аудитории</span></h3>
            <div class="report__actions">
              <button class="btn btn--primary btn--sm" id="botsOn">Запустить 1 бота</button>
              <button class="btn btn--ghost btn--sm" id="botsTwo">Запустить 2 ботов</button>
              <button class="btn btn--ghost btn--sm" id="botsOff">Остановить</button>
              <span class="muted" id="botsStatus"></span>
            </div>
          </section>
          <section class="card"><h3>Жалобы <span class="pill" id="repCount"></span></h3>
            <div class="tabs" id="repTabs">
              <button class="is-on" data-s="all">Все</button><button data-s="new">Новые</button>
              <button data-s="resolved">Решённые</button><button data-s="rejected">Отклонённые</button>
            </div>
            <div id="reportsList"></div>
          </section>
          <section class="card"><h3>Очередь и звонки</h3><div id="adminQueue"></div></section>
          <section class="card"><h3>Пользователи</h3>
            <input class="input" id="admSearch" placeholder="Поиск по нику">
            <div id="adminUsers"></div>
          </section>
        </div>
      </div>
    `);

    const isStaff = State.user && ['admin', 'moderator'].includes(State.user.role);
    if (isStaff) enterAdmin();
    $('#adminForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const res = await api('/api/auth/login', { method: 'POST', body: { nick: $('#admNick').value, password: $('#admPass').value } });
        if (!['admin', 'moderator'].includes(res.user.role)) { toast('Недостаточно прав', 'error'); return; }
        State.token = res.token; Store.set('token', res.token); State.user = res.user;
        State.socket?.disconnect(); connect();
        setTimeout(enterAdmin, 500);
      } catch { toast('Неверный логин или пароль', 'error'); }
    };

    async function enterAdmin() {
      $('#adminLogin').style.display = 'none';
      $('#adminBody').style.display = '';
      $('#adminUser').innerHTML = `${avatar(State.user.nick, State.user.avatarHue, 30)} <b>${esc(State.user.nick)}</b> · ${State.user.role}`;
      await refresh();
      await refreshBots();
      State.adminTimer = setInterval(refresh, 5000);
    }

    async function refreshBots() {
      try {
        const st = await api('/api/admin/bots');
        $('#botsStatus').textContent = st.total
          ? `запущено ${st.total}, свободно ${st.idle}: ${st.names.join(', ')}`
          : 'боты не запущены';
      } catch { $('#botsStatus').textContent = 'нет связи с сервером'; }
    }

    const botsCtl = async (on, count) => {
      $('#botsStatus').textContent = on ? 'запускаем браузер…' : 'останавливаем…';
      try {
        await api('/api/admin/bots', { method: 'POST', body: { on, count } });
        await refreshBots();
        toast(on ? 'Демо-боты запущены' : 'Демо-боты остановлены', 'success');
      } catch (e) { toast('Ошибка: ' + (e.data?.error || e.message), 'error'); }
    };
    $('#botsOn').onclick = () => botsCtl(true, 1);
    $('#botsTwo').onclick = () => botsCtl(true, 2);
    $('#botsOff').onclick = () => botsCtl(false, 0);

    async function refresh() {
      try {
        const [metrics, reports, queue, users] = await Promise.all([
          api('/api/admin/metrics'), api('/api/admin/reports'), api('/api/admin/queue'), api('/api/admin/users'),
        ]);
        renderMetrics(metrics); renderReports(reports); renderQueue(queue); renderUsers(users.items);
      } catch (e) { console.warn(e); }
    }

    function renderMetrics(m) {
      $('#adminMetrics').innerHTML = [
        ['Онлайн', m.online], ['В очереди', m.inQueue], ['Активных звонков', m.activeCalls],
        ['Всего звонков', m.totalCalls.toLocaleString('ru-RU')], ['DAU', m.dau],
        ['Средняя длительность', m.avgCallSeconds + ' с'], ['Среднее ожидание', m.avgWaitSeconds + ' с'],
        ['Скипов сегодня', m.skipsToday], ['Skip-rate', m.skipRate],
        ['Матчей сегодня', m.matchesToday], ['Жалоб на 1000 звонков', m.reportsPer1000],
        ['Регистраций сегодня', m.registrationsToday], ['Виральный K', m.viralCoefficient],
      ].map(([k, v]) => `<div class="metric"><span>${k}</span><b>${v}</b></div>`).join('');
    }

    function renderReports(data) {
      $('#repCount').textContent = (data.counts.new || 0) + ' новых';
      $('#reportsList').innerHTML = data.items.length ? data.items.map(r => `
        <div class="report">
          <div class="report__main">
            <span class="report__reason">${esc(State.cfg?.reportReasons?.find(x => x.id === r.reason)?.ru || r.reason)}</span>
            <span class="muted">${new Date(r.created_at).toLocaleString('ru-RU')}</span>
            <span class="pill pill--${r.status}">${r.status}</span>
          </div>
          <div class="muted">от ${esc(r.reporter_id)} → ${esc(r.target_id)}</div>
          ${r.comment ? `<div class="report__comment">${esc(r.comment)}</div>` : ''}
          ${r.status === 'new' ? `<div class="report__actions">
            <button class="btn btn--ghost btn--sm" data-a="warn" data-id="${r.id}">Варн</button>
            <button class="btn btn--ghost btn--sm" data-a="ban" data-id="${r.id}">Бан 24ч</button>
            <button class="btn btn--ghost btn--sm" data-a="shadow" data-id="${r.id}">Теневой бан</button>
            <button class="btn btn--ghost btn--sm" data-a="dismiss" data-id="${r.id}">Отклонить</button>
          </div>` : `<div class="muted">Решение: ${esc(r.action || '—')} · ${esc(r.moderator || '')}</div>`}
        </div>`).join('') : '<p class="muted">Жалоб нет.</p>';
      $$('#reportsList [data-a]').forEach(b => b.onclick = async () => {
        await api('/api/admin/reports/' + b.dataset.id, { method: 'POST', body: { action: b.dataset.a } });
        refresh();
      });
    }

    function renderQueue(q) {
      $('#adminQueue').innerHTML = `
        <h4>В очереди (${q.queue.length})</h4>
        ${q.queue.length ? q.queue.map(e => `<div class="admin-row"><b>${esc(e.nick)}</b> <span class="muted">${fmtWait(e.waitMs)}</span>
          <span class="pill">${e.mode}</span>${e.strict ? '<span class="pill pill--gold">strict</span>' : ''}${e.shadow ? '<span class="pill pill--red">shadow</span>' : ''}</div>`).join('') : '<p class="muted">Пусто</p>'}
        <h4>Активные звонки (${q.calls.length})</h4>
        ${q.calls.length ? q.calls.map(c => `<div class="admin-row"><b>${esc(c.aNick)} ↔ ${esc(c.bNick)}</b>
          <span class="muted">${fmtTime((Date.now() - c.startedAt) / 1000)}</span><span class="pill">${c.state}</span></div>`).join('') : '<p class="muted">Нет</p>'}`;
    }

    function renderUsers(items) {
      $('#adminUsers').innerHTML = items.map(u => `
        <div class="admin-row">
          ${avatar(u.nick, u.avatar_hue, 26)} <b>${esc(u.nick)}</b>
          <span class="muted">${u.role}${u.isPremium ? ' · Premium' : ''} · ${u.calls_total} зв. · ${u.rating_count ? '★' + (u.rating_sum / u.rating_count).toFixed(1) : 'нет рейтинга'} · страйков ${u.strikes}</span>
          <span class="admin-row__actions">
            <button class="btn btn--ghost btn--sm" data-b="1h" data-id="${u.id}">Бан 1ч</button>
            <button class="btn btn--ghost btn--sm" data-b="86400000" data-id="${u.id}">Бан 24ч</button>
            <button class="btn btn--ghost btn--sm" data-p="1" data-id="${u.id}">Premium</button>
          </span>
        </div>`).join('');
      $$('#adminUsers [data-b]').forEach(b => b.onclick = async () => {
        await api(`/api/admin/users/${b.dataset.id}/ban`, { method: 'POST', body: { ms: +b.dataset.b } });
        toast('Бан выдан', 'success'); refresh();
      });
      $$('#adminUsers [data-p]').forEach(b => b.onclick = async () => {
        await api(`/api/admin/users/${b.dataset.id}/premium`, { method: 'POST', body: { ms: 86400000 } });
        toast('Premium выдан', 'success'); refresh();
      });
    }

    $$('#repTabs button').forEach(b => b.onclick = async () => {
      $$('#repTabs button').forEach(x => x.classList.toggle('is-on', x === b));
      const data = await api('/api/admin/reports?status=' + b.dataset.s);
      renderReports(data);
    });
    $('#admSearch').oninput = async (e) => {
      const { items } = await api('/api/admin/users?q=' + encodeURIComponent(e.target.value));
      renderUsers(items);
    };
    return scr;
  };

  /* ============================================================
     ОБЩИЙ КАРКАС ЭКРАНА
     ============================================================ */
  function screenShell(name, html) {
    const old = $$('.screen');
    old.forEach(n => n.remove());
    const scr = el('section', { class: 'screen is-hidden', id: 'screen-' + name, html });
    $('#app').append(scr);
    return scr;
  }

  function showAchievement(a) {
    Sound.achievement();
    const node = el('div', { class: 'ach-toast' }, [
      el('span', { class: 'ach-toast__emoji', text: a.emoji }),
      el('div', {}, [el('b', { text: 'Достижение: ' + a.ru }), el('div', { class: 'muted', text: a.reward || '' })]),
    ]);
    document.body.append(node);
    requestAnimationFrame(() => node.classList.add('in'));
    setTimeout(() => { node.classList.remove('in'); setTimeout(() => node.remove(), 400); }, 5200);
  }

  /* ============================================================
     ГЛОБАЛЬНЫЕ ДЕЙСТВИЯ
     ============================================================ */
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'start') { Sound.click(); startFlow(); }
    if (act === 'filters') { Sound.click(); show('filters'); }
    if (act === 'auth') { Sound.click(); openAuth('register'); }
    if (act === 'premium') { Sound.click(); show('premium'); }
    if (act === 'logout') { Store.del('token'); State.token = null; State.user = null; State.socket?.disconnect(); connect(); show('landing'); }
  });

  let flowRetries = 0;
  async function startFlow() {
    if (!State.cfg) {
      if (flowRetries++ < 40) { setTimeout(startFlow, 250); return; }
      toast('Нет связи с сервером — обновите страницу', 'error');
      return;
    }
    flowRetries = 0;
    show('onboarding');
  }

  /* ============================================================
     СТАРТ
     ============================================================ */
  async function boot() {
    // каркас
    document.body.innerHTML = `
      <header class="nav">
        <a class="nav__logo" href="/" data-screen="landing">
          <span class="nav__mark">📞</span> Zvonitel<span class="nav__dot">.ru</span>
        </a>
        <nav class="nav__links">
          <a href="/" data-screen="landing">Главная</a>
          <a href="/room" data-screen="room">Комната</a>
          <a href="/profile" data-screen="profile">Профиль</a>
          <a href="/premium" data-screen="premium">Premium</a>
        </nav>
        <div class="nav__right">
          <span id="navQuota" class="nav__quota" hidden></span>
          <span id="navCoins" class="nav__coins"></span>
          <span id="navAuth"></span>
          <button class="btn btn--primary btn--sm" data-act="start">Начать</button>
        </div>
      </header>
      <main id="app"></main>`;

    $$('.nav__links a').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      const target = a.getAttribute('href');
      history.pushState({}, '', target);
      routeFromHash();
    }));
    $('.nav__logo').addEventListener('click', e => { e.preventDefault(); history.pushState({}, '', '/'); routeFromHash(); });

    connect();

    // ждём конфиг
    await new Promise(resolve => {
      if (State.cfg) return resolve();
      const h = setInterval(() => { if (State.cfg) { clearInterval(h); resolve(); } }, 60);
      setTimeout(() => { clearInterval(h); resolve(); }, 6000);
    });

    if (State.token) await loadMe();
    ageGate();

    const params = new URLSearchParams(location.search);
    State.refCode = params.get('ref');

    routeFromHash();
    // конфиг может прийти позже первого рендера — перерисовываем текущий экран
    document.addEventListener('zv:welcome', () => {
      if (State.screen === 'landing' || State.screen === 'filters') routeFromHash();
    });
    window.addEventListener('popstate', routeFromHash);

    // горячие клавиши: S — скип, H — завершить, M — микрофон
    document.addEventListener('keydown', (e) => {
      if (State.screen !== 'call') return;
      if (e.target.matches('input, textarea')) return;
      if (e.key.toLowerCase() === 's') handleControl('skip');
      if (e.key.toLowerCase() === 'h') handleControl('hangup');
      if (e.key.toLowerCase() === 'm') handleControl('mic');
      if (e.key === ' ') { e.preventDefault(); sendReaction('👍'); }
    });
  }

  // экспорт для тестов
  window.ZVApp = {
    State, show, screens, startFlow, joinQueue, api,
    /** диагностика для E2E: состояние PeerConnection и треков */
    debug() {
      const c = State.call;
      const rv = document.querySelector('#remoteVideo');
      const lv = document.querySelector('#localVideo');
      return {
        screen: State.screen,
        hasCall: !!c,
        callError: State.callError,
        callId: c?.callId,
        initiator: c?.initiator,
        pcState: c?.pc?.connectionState,
        iceState: c?.pc?.iceConnectionState,
        signalingState: c?.pc?.signalingState,
        senders: c?.pc ? c.pc.getSenders().map(s => ({ kind: s.track?.kind, ready: s.track?.readyState, enabled: s.track?.enabled })) : null,
        receivers: c?.pc ? c.pc.getReceivers().map(r => ({ kind: r.track?.kind, muted: r.track?.muted })) : null,
        remoteTracks: c?.remoteStream ? c.remoteStream.getTracks().map(t => ({ kind: t.kind, muted: t.muted, ready: t.readyState })) : null,
        remoteVideo: rv ? { w: rv.videoWidth, h: rv.videoHeight, ready: rv.readyState, paused: rv.paused, hasSrc: !!rv.srcObject } : null,
        localVideo: lv ? { w: lv.videoWidth, h: lv.videoHeight, hasSrc: !!lv.srcObject } : null,
        mediaDemo: ZVMedia.isDemo,
        lastStats: State.lastStats,
      };
    },
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
