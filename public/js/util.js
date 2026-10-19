/* Zvonitel.ru — утилиты клиента: хранилище, i18n, DOM-хелперы, звук */

const Store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem('zv_' + k); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem('zv_' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('zv_' + k); } catch {} },
};

const I18N = {
  ru: {
    start: 'Начать звонок', setup: 'Настроить фильтры', searching: 'Ищем собеседника…',
    skip: 'Пропустить', hangup: 'Завершить', report: 'Пожалоба', block: 'Заблокировать',
    addFriend: 'В друзья', next: 'Следующий', cancel: 'Отмена', waiting: 'Ожидание',
    peerSkipped: 'Собеседник пропустил', peerLeft: 'Собеседник завершил разговор',
    connecting: 'Соединение…', connected: 'В эфире', quality: 'Связь',
    relaxTitle: 'Партнёра нет уже 30 секунд', relaxHint: 'Расширим фильтры — так матч найдётся быстрее:',
    relaxGo: 'Расширить', rateTitle: 'Как вам собеседник?', send: 'Отправить',
  },
  en: {
    start: 'Start call', setup: 'Set filters', searching: 'Looking for someone…',
    skip: 'Skip', hangup: 'End', report: 'Report', block: 'Block',
    addFriend: 'Add friend', next: 'Next', cancel: 'Cancel', waiting: 'Waiting',
    peerSkipped: 'Your peer skipped', peerLeft: 'Your peer ended the call',
    connecting: 'Connecting…', connected: 'Live', quality: 'Connection',
    relaxTitle: 'No match for 30 seconds', relaxHint: 'Let’s loosen the filters — matches come faster:',
    relaxGo: 'Loosen', rateTitle: 'How was your peer?', send: 'Send',
  },
};

const lang = () => (navigator.language || 'ru').startsWith('ru') ? 'ru' : 'ru'; // продукт русскоязычный, en — задел
const t = (key) => (I18N[lang()] && I18N[lang()][key]) || I18N.ru[key] || key;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtWait(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} с`;
  return `${Math.floor(s / 60)} мин ${s % 60} с`;
}

function plural(n, forms) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
  return forms[2];
}

/* ---------- звук интерфейса (WebAudio, без файлов) ---------- */

const Sound = (() => {
  let ctx = null;
  const ensure = () => {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  function tone(freq, dur = 0.12, type = 'sine', gain = 0.05) {
    const c = ensure(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(gain, c.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g); g.connect(c.destination);
    o.start(); o.stop(c.currentTime + dur + 0.02);
  }
  return {
    enabled: true,
    match() { if (this.enabled) { tone(660, 0.1); setTimeout(() => tone(880, 0.16), 110); } },
    click() { if (this.enabled) tone(520, 0.05, 'triangle', 0.03); },
    skip() { if (this.enabled) tone(300, 0.09, 'sawtooth', 0.03); },
    end() { if (this.enabled) { tone(400, 0.12); setTimeout(() => tone(260, 0.2), 120); } },
    notify() { if (this.enabled) { tone(760, 0.08); setTimeout(() => tone(980, 0.1), 90); } },
    /** Гудок входящего адресного звонка — двухтональный, как в телефоне. */
    ring() { if (this.enabled) { tone(880, 0.2, 'sine', 0.045); setTimeout(() => tone(1180, 0.26, 'sine', 0.045), 240); } },
    achievement() { if (this.enabled) { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.14, 'sine', 0.05), i * 110)); } },
  };
})();

/* ---------- тосты ---------- */

function toast(text, type = 'info', ms = 3600) {
  let wrap = $('#toasts');
  if (!wrap) { wrap = el('div', { id: 'toasts', class: 'toasts' }); document.body.append(wrap); }
  const node = el('div', { class: `toast toast--${type}`, text });
  wrap.append(node);
  requestAnimationFrame(() => node.classList.add('in'));
  setTimeout(() => { node.classList.remove('in'); setTimeout(() => node.remove(), 350); }, ms);
  return node;
}

/* ---------- аватар ---------- */

function avatar(nick, hue, size = 44) {
  const letter = (nick || '?').trim().charAt(0).toUpperCase();
  return `<div class="avatar" style="--hue:${hue ?? 210};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${letter}</div>`;
}

/* ---------- «демо-поток»: когда камеры нет (превью без устройств, CI, запрет доступа) ---------- */

function createDemoStream(label, hue = 210, audio = true) {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 480;
  const ctx2d = canvas.getContext('2d');
  const stream = canvas.captureStream(15);

  let raf = 0;
  const t0 = performance.now();
  function draw() {
    const t = (performance.now() - t0) / 1000;
    const g = ctx2d.createLinearGradient(0, 0, canvas.width, canvas.height);
    g.addColorStop(0, `hsl(${hue}, 65%, 18%)`);
    g.addColorStop(1, `hsl(${(hue + 60) % 360}, 70%, 10%)`);
    ctx2d.fillStyle = g; ctx2d.fillRect(0, 0, canvas.width, canvas.height);

    // «дыхание» — круги, чтобы поток выглядел живым
    for (let i = 0; i < 4; i++) {
      const r = 40 + i * 26 + Math.sin(t * 1.4 + i) * 12;
      ctx2d.beginPath();
      ctx2d.arc(canvas.width / 2, canvas.height / 2, r, 0, Math.PI * 2);
      ctx2d.strokeStyle = `hsla(${hue + i * 20}, 90%, 70%, ${0.28 - i * 0.05})`;
      ctx2d.lineWidth = 2; ctx2d.stroke();
    }
    ctx2d.fillStyle = 'rgba(255,255,255,.92)';
    ctx2d.font = '600 30px system-ui, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.fillText(label, canvas.width / 2, canvas.height / 2 + 10);
    ctx2d.font = '400 15px system-ui, sans-serif';
    ctx2d.fillStyle = 'rgba(255,255,255,.55)';
    ctx2d.fillText('демо-поток (камера недоступна)', canvas.width / 2, canvas.height / 2 + 38);
    raf = requestAnimationFrame(draw);
  }
  draw();

  if (audio) {
    // тихий «голосовой» шум, чтобы аудио-тракт тоже проверялся
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ac.createOscillator(); const gain = ac.createGain();
      const lfo = ac.createOscillator(); const lfoGain = ac.createGain();
      osc.type = 'sine'; osc.frequency.value = 180;
      lfo.frequency.value = 3.1; lfoGain.gain.value = 60;
      lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
      gain.gain.value = 0.0015;
      osc.connect(gain); gain.connect(ac.destination);
      const dest = ac.createMediaStreamDestination();
      gain.connect(dest);
      osc.start(); lfo.start();
      dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
      stream.__audioCleanup = () => { try { osc.stop(); lfo.stop(); ac.close(); } catch {} };
    } catch {}
  }
  stream.__cleanup = () => {
    cancelAnimationFrame(raf);
    stream.__audioCleanup?.();
    stream.getTracks().forEach(tr => tr.stop());
  };
  return stream;
}

/* ---------- NSFW-эвристика на клиенте (видео не покидает браузер) ---------- */

function createFrameAnalyzer(videoEl, onScore, intervalMs = 1500) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 24;
  const ctx2d = c.getContext('2d', { willReadFrequently: true });
  const timer = setInterval(() => {
    if (!videoEl.videoWidth || videoEl.paused) return;
    try {
      ctx2d.drawImage(videoEl, 0, 0, c.width, c.height);
      const d = ctx2d.getImageData(0, 0, c.width, c.height).data;
      let skin = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r > 95 && g > 40 && b > 20 && r > g && r > b && Math.abs(r - g) > 15) skin++;
      }
      const ratio = skin / (d.length / 4);
      onScore(Math.min(1, Math.max(0, (ratio - 0.45) * 2.2)));
    } catch {}
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

/* ---------- громкость микрофона ---------- */

function createLoudnessMeter(stream, onLoud) {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser(); an.fftSize = 512;
    src.connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    let loudCount = 0;
    const timer = setInterval(() => {
      an.getByteFrequencyData(data);
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
      const rms = sum / data.length / 255;
      if (rms > 0.55) { loudCount++; if (loudCount >= 4) { onLoud(); loudCount = 0; } } else loudCount = 0;
    }, 250);
    return { stop: () => { clearInterval(timer); try { ac.close(); } catch {} } };
  } catch { return { stop() {} }; }
}

/* ---------- шаринг ---------- */

function shareText(url) {
  return `Залетай в Zvonitel.ru — умная видеорулетка: подбор по интересам, языку и целям. Мне уже зашло 👉 ${url}`;
}

async function share(url, title = 'Zvonitel.ru') {
  const text = shareText(url);
  if (navigator.share) { try { await navigator.share({ title, text, url }); return 'native'; } catch {} }
  try { await navigator.clipboard.writeText(text + '\n' + url); toast('Ссылка скопирована — делись!', 'success'); }
  catch { toast('Скопируйте ссылку вручную: ' + url, 'info'); }
  return 'copy';
}

/** Экранирование для вставки пользовательских строк в HTML. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.ZV = { Store, el, $, $$, t, esc, fmtTime, fmtWait, plural, toast, avatar, Sound, createDemoStream,
  createFrameAnalyzer, createLoudnessMeter, share, shareText, lang };
