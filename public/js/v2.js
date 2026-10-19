/* Zvonitel.ru — фичи V2: живые субтитры, перевод и запись по взаимному согласию.
 *
 * Приватность (ТЗ §4.4 / §7):
 *  - наружу уходит только РАСПОЗНАННЫЙ ТЕКСТ субтитров, никогда аудио или видео;
 *  - запись собирается локально в браузере (MediaRecorder) и не покидает устройство:
 *    файл остаётся у пользователя, сервер не получает ни кадра;
 *  - запись стартует только после явного согласия ОБОИХ участников.
 */
(function () {
  const { toast, Sound } = window.ZV;

  /* ============================================================
     ЖИВЫЕ СУБТИТРЫ
     ============================================================ */
  class LiveCaptions {
    constructor({ socket, callId, lang = 'ru-RU', onLocal, onRemote }) {
      this.socket = socket;
      this.callId = callId;
      this.lang = lang;
      this.onLocal = onLocal || (() => {});
      this.onRemote = onRemote || (() => {});
      this.recognition = null;
      this.running = false;
      this.supported = typeof (window.SpeechRecognition || window.webkitSpeechRecognition) === 'function';
    }

    start() {
      if (!this.supported) return false;
      if (this.running) return true;
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new SR();
      rec.lang = this.lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onresult = (event) => {
        let interim = '', final = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const chunk = event.results[i][0].transcript;
          if (event.results[i].isFinal) final += chunk; else interim += chunk;
        }
        if (final) {
          this.onLocal({ text: final.trim(), final: true });
          // наружу — только текст
          this.socket?.emit('caption', { callId: this.callId, text: final.trim(), final: true });
        } else if (interim) {
          this.onLocal({ text: interim.trim(), final: false });
          this.socket?.emit('caption', { callId: this.callId, text: interim.trim(), final: false });
        }
      };

      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        console.warn('[captions]', e.error);
        if (e.error === 'not-allowed') { this.running = false; toast('Доступ к микрофону для субтитров не дан', 'warn'); }
      };
      rec.onend = () => {
        // Chrome сам обрывает continuous-сессию — аккуратно перезапускаем, пока включены
        if (this.running) { try { rec.start(); } catch { this.running = false; } }
      };

      try { rec.start(); this.recognition = rec; this.running = true; return true; }
      catch { return false; }
    }

    stop() {
      this.running = false;
      try { this.recognition?.stop(); } catch {}
      this.recognition = null;
    }

    /** Показывает субтитр собеседника. */
    incoming(text, final) { this.onRemote({ text, final }); }
  }

  /* ============================================================
     ПЕРЕВОД СУБТИТРОВ (через свой сервер, если он настроен)
     ============================================================ */
  const Translate = {
    cache: new Map(),
    available: null, // null = ещё не проверяли

    async check() {
      if (this.available !== null) return this.available;
      try {
        const res = await fetch('/api/translate/status');
        const data = await res.json();
        this.available = !!data.available;
      } catch { this.available = false; }
      return this.available;
    },

    async text(str, from, to) {
      if (!str || from === to) return str;
      const key = `${from}:${to}:${str}`;
      if (this.cache.has(key)) return this.cache.get(key);
      try {
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: str, source: from, target: to }),
        });
        if (!res.ok) return str;
        const data = await res.json();
        const out = data.translatedText || str;
        this.cache.set(key, out);
        return out;
      } catch { return str; }
    },
  };

  /* ============================================================
     ЗАПИСЬ ЗВОНКА — только по взаимному согласию
     ============================================================ */
  class CallRecorder {
    constructor({ socket, callId, localStream, remoteStream, remoteVideo, localVideo, onState }) {
      this.socket = socket;
      this.callId = callId;
      this.localStream = localStream;
      this.remoteStream = remoteStream;
      this.remoteVideo = remoteVideo;
      this.localVideo = localVideo;
      this.onState = onState || (() => {});

      this.recorder = null;
      this.chunks = [];
      this.canvas = null;
      this.raf = 0;
      this.audioCtx = null;
      this.state = 'idle';   // idle | pending | recording
      this.startedAt = 0;
      this.timer = 0;
      this.maxMs = 10 * 60_000;
      this.durationMs = 0;
    }

    /** Первый шаг: просим согласия собеседника. Файл не создаётся до его ответа. */
    request() {
      if (this.state !== 'idle') return;
      this.state = 'pending';
      this.onState({ state: 'pending' });
      this.socket.emit('rec:request', { callId: this.callId }, (res) => {
        if (!res?.ok) {
          this.state = 'idle';
          const reasons = { premium: 'Запись доступна в Premium', in_progress: 'Запись уже идёт', no_peer: 'Собеседник недоступен' };
          toast(reasons[res?.error] || 'Не удалось запросить запись', 'warn');
          this.onState({ state: 'idle' });
        }
      });
    }

    /** Собеседник ответил. */
    onRequest() { this.state = 'pending'; this.onState({ state: 'asked' }); }
    respond(accept) {
      this.socket.emit('rec:response', { callId: this.callId, accept }, (res) => {
        if (res?.ok === false) toast('Не удалось ответить на запрос', 'warn');
      });
      if (!accept) { this.state = 'idle'; this.onState({ state: 'idle' }); toast('Вы отклонили запись', 'info'); }
    }

    /** Второй шаг: оба согласны — можно стартовать. */
    start() {
      if (this.state === 'recording') return;
      this.state = 'recording';
      this.startedAt = Date.now();
      this.chunks = [];

      try {
        const composed = this.compose();
        const mime = CallRecorder.pickMime();
        this.recorder = new MediaRecorder(composed, mime ? { mimeType: mime } : undefined);
        this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
        this.recorder.onstop = () => this.finish();
        this.recorder.start(1000);
        this.onState({ state: 'recording', startedAt: this.startedAt });

        this.timer = setInterval(() => {
          this.durationMs = Date.now() - this.startedAt;
          this.onState({ state: 'recording', startedAt: this.startedAt, durationMs: this.durationMs });
          if (this.durationMs >= this.maxMs) { this.stop(); toast('Достигнут лимит записи — файл сохранён', 'info'); }
        }, 1000);
      } catch (err) {
        console.error('[recorder]', err);
        this.state = 'idle';
        toast('Запись не запустилась: ' + err.message, 'error');
        this.onState({ state: 'idle' });
      }
    }

    /** Собираем единый поток: картинка «собеседник + вы в углу» и микс двух микрофонов. */
    compose() {
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      this.canvas = canvas;

      const fitContain = (video, x, y, w, h) => {
        if (!video || !video.videoWidth) return;
        const vr = video.videoWidth / video.videoHeight, tr = w / h;
        let dw = w, dh = h;
        if (vr > tr) dh = w / vr; else dw = h * vr;
        ctx.drawImage(video, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      };

      const draw = () => {
        ctx.fillStyle = '#0a0812';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        fitContain(this.remoteVideo, 0, 0, canvas.width, canvas.height);
        // своё видео — в правом нижнем углу, как в интерфейсе
        const lw = 300, lh = 400, pad = 24;
        ctx.save();
        ctx.beginPath();
        const rx = canvas.width - lw - pad, ry = canvas.height - lh - pad;
        ctx.roundRect ? ctx.roundRect(rx, ry, lw, lh, 18) : ctx.rect(rx, ry, lw, lh);
        ctx.clip();
        ctx.fillStyle = '#141024';
        ctx.fillRect(rx, ry, lw, lh);
        fitContain(this.localVideo, rx, ry, lw, lh);
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 2;
        ctx.strokeRect(rx, ry, lw, lh);

        // водяной знак
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        ctx.font = '600 22px system-ui, sans-serif';
        ctx.fillText('Zvonitel.ru', pad + 4, canvas.height - pad);

        this.raf = requestAnimationFrame(draw);
      };
      draw();

      const videoStream = canvas.captureStream(24);

      // микс двух микрофонов в одну дорожку
      let audioTracks = [];
      try {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const dest = this.audioCtx.createMediaStreamDestination();
        for (const s of [this.localStream, this.remoteStream]) {
          if (!s) continue;
          const tracks = s.getAudioTracks();
          if (tracks.length) {
            const src = this.audioCtx.createMediaStreamSource(new MediaStream(tracks));
            const gain = this.audioCtx.createGain();
            gain.gain.value = 0.9;
            src.connect(gain); gain.connect(dest);
          }
        }
        audioTracks = dest.stream.getAudioTracks();
      } catch {}

      return new MediaStream([...videoStream.getVideoTracks(), ...audioTracks]);
    }

    static pickMime() {
      const candidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4',
      ];
      if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
      return candidates.find(m => MediaRecorder.isTypeSupported(m)) || null;
    }

    stop() {
      if (this.state !== 'recording') { this.socket.emit('rec:stop', { callId: this.callId }); return; }
      try { this.recorder?.stop(); } catch { this.finish(); }
      this.socket.emit('rec:stop', { callId: this.callId });
    }

    finish() {
      clearInterval(this.timer);
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      try { this.audioCtx?.close(); } catch {}
      this.canvas = null;

      const wasRecording = this.state === 'recording';
      this.state = 'idle';
      this.onState({ state: 'idle' });
      if (!wasRecording || !this.chunks.length) return;

      const mime = this.chunks[0]?.type || 'video/webm';
      const blob = new Blob(this.chunks, { type: mime });
      this.chunks = [];
      this.save(blob, mime);
    }

    /** Файл остаётся у пользователя — на сервер он не отправляется. */
    save(blob, mime) {
      const ext = (mime.includes('mp4') ? 'mp4' : 'webm');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zvonitel-${stamp}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);

      Sound.achievement();
      window.ZVLastRecording = { url, name: a.download, size: blob.size, mime };
      toast(`Запись сохранена: ${a.download} (${(blob.size / 1048576).toFixed(1)} МБ). Файл остался у вас и не уходил на сервер.`, 'success', 8000);
      document.dispatchEvent(new CustomEvent('zv:recording-saved', { detail: window.ZVLastRecording }));
    }

    destroy() {
      clearInterval(this.timer);
      cancelAnimationFrame(this.raf);
      try { this.audioCtx?.close(); } catch {}
      try { if (this.recorder?.state === 'recording') this.recorder.stop(); } catch {}
      this.state = 'idle';
    }
  }

  window.ZVV2 = { LiveCaptions, CallRecorder, Translate };
})();
