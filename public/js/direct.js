'use strict';
/**
 * ZVDirect — звонок по логину + квоты на звонки.
 *
 * Две продуктовые вещи живут здесь:
 *  1. Адресный вызов: набрали логин зарегистрированного пользователя — звоним
 *     напрямую, минуя очередь. Соединение возможно только по обоюдному желанию:
 *     вызываемый видит, кто звонит, и может отклонить.
 *  2. Квоты: гость — 1 звонок, зарегистрированный — 100 в месяц, премиум —
 *     безлимит. Когда квота кончилась, показываем понятный апселл, а не молча
 *     ломаем кнопку.
 *
 * Монтируется из app.js: ZVDirect.mount({ State, api, show, openAuth, openPremium, emit })
 */
window.ZVDirect = (function () {
  const { el, $, $$, toast, Sound, avatar, esc } = window.ZV;

  let App = null;
  let ringTimer = null;      // повтор гудка
  let incomingBox = null;    // оверлей входящего вызова
  let outgoingBox = null;    // оверлей «звоним…»
  let searchTimer = null;
  let lastCall = null;       // { nick } — чтобы «ещё раз» работало в один клик

  function mount(app) { App = app; }
  const S = () => App.State;

  /* ============================================================
     КВОТЫ
     ============================================================ */

  function quotaShort(q) {
    if (!q) return '';
    if (q.unlimited) return 'безлимит';
    return `${q.left} из ${q.calls}`;
  }

  function resetDateText(q) {
    if (!q || !q.resetAt) return '';
    try {
      return new Date(q.resetAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    } catch { return ''; }
  }

  function setQuota(q) {
    if (!App || !q) return;
    S().quota = q;
    renderQuotaChip();
  }

  /** «Осталось N звонков» в навигации. */
  function renderQuotaChip() {
    const node = $('#navQuota');
    if (!node) return;
    const q = S().quota;
    if (!q) { node.hidden = true; return; }
    node.hidden = false;
    node.textContent = q.unlimited ? '∞' : `🎥 ${q.left}`;
    const period = q.period === 'month' ? 'в этом месяце' : 'всего';
    node.title = q.unlimited
      ? 'Безлимитные звонки — Premium активен'
      : `Осталось звонков ${period}: ${q.left} из ${q.calls}`;
    node.classList.toggle('is-low', !q.unlimited && q.left <= 1);
  }

  /**
   * Квота исчерпана. Говорим честно, что произошло и что делать,
   * а не просто «недоступно».
   */
  function showQuotaGate(q) {
    if (!App || !q) return;
    if ($('#quotaGate')) return;
    S().quota = q;
    renderQuotaChip();

    const isGuest = !S().user;
    const title = isGuest ? 'Пробный звонок использован' : 'Лимит звонков на месяц исчерпан';
    const when = resetDateText(q);
    const body = isGuest
      ? 'Как гость вы можете сделать один пробный звонок — чтобы сервис было не страшно попробовать. ' +
        'Регистрация занимает 10 секунд и открывает 100 звонков в месяц бесплатно: фильтры, история, друзья и звонок по логину.'
      : `Вы сделали ${q.calls} звонков в этом месяце — это бесплатный лимит. ` +
        (when ? `Он обновится ${when}. ` : '') +
        'Premium снимает ограничение полностью и добавляет запись звонка, перевод субтитров и приоритет в очереди.';

    const actions = [el('button', { class: 'btn btn--ghost', text: 'Позже', onclick: () => overlay.remove() })];
    if (isGuest) {
      actions.push(el('button', {
        class: 'btn btn--primary', text: 'Зарегистрироваться',
        onclick: () => { overlay.remove(); App.openAuth('register'); },
      }));
    } else {
      actions.push(el('button', {
        class: 'btn btn--primary', text: 'Подключить Premium',
        onclick: () => { overlay.remove(); App.show('premium'); },
      }));
    }

    const overlay = el('div', { class: 'modal', id: 'quotaGate' }, [
      el('div', { class: 'modal__card modal__card--quota' }, [
        el('div', { class: 'quota__ring' }, [el('span', { text: '0' }), el('small', { text: `/ ${q.calls}` })]),
        el('h3', { text: title }),
        el('p', { text: body }),
        el('div', { class: 'modal__actions', style: 'justify-content:center' }, actions),
      ]),
    ]);
    document.body.append(overlay);
  }

  /* ============================================================
     ПОИСК И ВЫЗОВ ПО ЛОГИНУ
     ============================================================ */

  async function searchUsers(q) {
    const s = String(q || '').trim();
    if (s.length < 2) return [];
    try {
      const { items } = await App.api(`/api/users/search?q=${encodeURIComponent(s)}`);
      return items || [];
    } catch { return []; }
  }

  /** Блок «позвонить по логину» — встраивается в экран подготовки к звонку. */
  function directBlock() {
    const wrap = el('div', { class: 'dir' });
    const user = S().user;

    if (!user) {
      wrap.innerHTML = `
        <div class="dir__locked">
          <b>Знаете, кому хотите позвонить?</b>
          <p class="muted">Звонок по логину доступен зарегистрированным: набрали ник друга — и вы сразу на связи, без ожидания в очереди.</p>
          <button class="btn btn--ghost btn--sm" id="dirReg">Зарегистрироваться</button>
        </div>`;
      wrap.querySelector('#dirReg').onclick = () => App.openAuth('register');
      return wrap;
    }

    wrap.innerHTML = `
      <label class="field__label">Или позвоните напрямую</label>
      <div class="dir__row">
        <input class="input" id="dirNick" placeholder="Логин друга" autocomplete="off" spellcheck="false">
        <button class="btn btn--primary" id="dirCall">📞 Позвонить</button>
      </div>
      <div class="dir__results" id="dirResults"></div>
      <p class="muted dir__hint" id="dirHint">Собеседник увидит, что это вы, и сможет отклонить вызов.</p>`;

    const input = wrap.querySelector('#dirNick');
    const results = wrap.querySelector('#dirResults');
    const callBtn = wrap.querySelector('#dirCall');

    const render = (items) => {
      if (!items.length) { results.innerHTML = ''; results.classList.remove('is-open'); return; }
      results.classList.add('is-open');
      results.innerHTML = items.map(u => `
        <button class="dir__item" data-nick="${esc(u.nick)}">
          ${avatar(u.nick, u.avatarHue, 28)}
          <span class="dir__nick">${esc(u.nick)}</span>
          ${u.isPremium ? '<span class="pill pill--tiny">PRO</span>' : ''}
        </button>`).join('');
      $$('.dir__item', results).forEach(b => {
        b.onclick = () => { input.value = b.dataset.nick; results.classList.remove('is-open'); callBtn.focus(); };
      });
    };

    input.oninput = () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (q.length < 2) { render([]); return; }
      searchTimer = setTimeout(async () => render(await searchUsers(q)), 220);
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); callBtn.click(); } };

    callBtn.onclick = async () => {
      const nick = input.value.trim();
      if (!nick) { input.focus(); toast('Введите логин собеседника', 'warn'); return; }
      await callUser(nick);
    };
    return wrap;
  }

  /** Инициирует адресный звонок: сам показывает «звоним…» и обрабатывает отказы. */
  async function callUser(nick) {
    if (!App) return false;
    const s = S();
    lastCall = { nick };

    if (!s.user) { App.openAuth('register'); return false; }

    const res = await App.emit('direct:call', { nick });
    if (!res?.ok) {
      const err = res?.error;
      if (err === 'quota') { showQuotaGate(res.quota); return false; }
      if (err === 'login_required') { App.openAuth('register'); return false; }
      const map = {
        not_found: 'Пользователь с таким логином не найден',
        offline: `${nick} сейчас не в сети — можно позвонить, когда он зайдёт`,
        busy: `${nick} сейчас занят — попробуйте через минуту`,
        self: 'Нельзя позвонить самому себе',
        blocked: 'Звонок невозможен: есть блокировка',
        unavailable: 'Этот пользователь временно недоступен',
        banned: 'Ваш аккаунт ограничен',
        ringing: `Вы уже звоните ${nick}`,
      };
      toast(map[err] || 'Не удалось позвонить. Попробуйте ещё раз.', 'error');
      return false;
    }
    showOutgoing(nick);
    return true;
  }

  function showOutgoing(nick) {
    closeOutgoing();
    outgoingBox = el('div', { class: 'ring', id: 'ringOut' }, [
      el('div', { class: 'ring__card' }, [
        el('div', { class: 'ring__avatar ring__avatar--pulse', html: avatar(nick, 260, 84) }),
        el('h3', { text: `Звоним ${nick}…` }),
        el('p', { class: 'muted', text: 'Ждём ответа. Собеседник видит, что это вы.' }),
        el('div', { class: 'ring__actions' }, [
          el('button', {
            class: 'btn btn--ghost btn--lg', text: 'Отменить',
            onclick: async () => { await App.emit('direct:cancel'); closeOutgoing(); },
          }),
        ]),
      ]),
    ]);
    document.body.append(outgoingBox);
  }

  function closeOutgoing() { outgoingBox?.remove(); outgoingBox = null; }

  /* ---------- входящий вызов ---------- */

  function onIncoming(d) {
    if (!App) return;
    const s = S();
    const from = d.from || {};

    // если уже говорим — вежливо отклоняем, не мешая текущему разговору
    if (s.call || s.screen === 'call') {
      App.emit('direct:decline', { fromId: from.id });
      return;
    }

    closeIncoming();
    incomingBox = el('div', { class: 'ring ring--in', id: 'ringIn' }, [
      el('div', { class: 'ring__card' }, [
        el('div', { class: 'ring__avatar ring__avatar--pulse', html: avatar(from.nick, from.avatarHue ?? 260, 84) }),
        el('div', { class: 'ring__label', text: 'Входящий звонок' }),
        el('h3', { text: from.nick || 'Пользователь' }),
        el('p', { class: 'muted', text: 'Звонит вам напрямую по логину' }),
        el('div', { class: 'ring__actions' }, [
          el('button', { class: 'btn btn--danger btn--lg', text: 'Отклонить', onclick: () => decline(from.id) }),
          el('button', { class: 'btn btn--primary btn--lg', text: 'Принять', onclick: () => accept(from.id) }),
        ]),
      ]),
    ]);
    document.body.append(incomingBox);

    ringTimer = setInterval(() => Sound.ring(), 2200);
    Sound.ring();
    navigator.vibrate?.([300, 200, 300]);
  }

  function closeIncoming() {
    clearInterval(ringTimer); ringTimer = null;
    incomingBox?.remove(); incomingBox = null;
  }

  /** Звонок отменён вызывающим (или истёк таймаут, или он вышел). */
  function onCancelled(d) {
    if (!incomingBox) return;
    closeIncoming();
    toast(d?.timeout ? 'Звонок отменён — вы не ответили' : 'Входящий звонок отменён', 'info');
  }

  async function decline(fromId) {
    closeIncoming();
    await App.emit('direct:decline', { fromId });
  }

  async function accept(fromId) {
    closeIncoming();
    // медиа должно быть поднято ДО принятия: иначе сессия звонка стартует без треков
    try {
      if (!window.ZVMedia?.stream) await window.ZVMedia.start({ video: true, audio: true });
    } catch (e) {
      toast('Не удалось включить камеру и микрофон', 'error');
      await App.emit('direct:decline', { fromId });
      return;
    }
    const res = await App.emit('direct:accept', { fromId });
    if (!res?.ok) {
      if (res?.error === 'quota') { showQuotaGate(res.quota); return; }
      toast(res?.error === 'no_ring' ? 'Звонок уже отменён' : 'Не удалось принять звонок', 'warn');
    }
  }

  /** Вызываемый отклонил. */
  function onDeclined(d) {
    closeOutgoing();
    toast(`${d?.nick || 'Собеседник'} отклонил звонок`, 'info');
  }

  function onTimeout(d) {
    closeOutgoing();
    toast(`${d?.nick || 'Собеседник'} не ответил — попробуйте позже`, 'info');
  }

  return {
    mount, setQuota, renderQuotaChip, quotaShort, resetDateText,
    showQuotaGate, directBlock, callUser, searchUsers,
    onIncoming, onCancelled, onDeclined, onTimeout,
    closeAll() { closeIncoming(); closeOutgoing(); },
    get lastCall() { return lastCall; },
    // для E2E
    _state: () => ({ incoming: !!incomingBox, outgoing: !!outgoingBox }),
  };
})();
