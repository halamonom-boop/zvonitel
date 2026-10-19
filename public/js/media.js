/* Zvonitel.ru — доступ к камере/микрофону, выбор устройств, blur/виртуальный фон */

const Media = (() => {
  let stream = null;
  let demoMode = false;
  let processedCanvas = null;
  let processedStream = null;
  let raf = 0;
  const constraintsCache = { video: true, audio: true };

  const PRESETS = {
    low:    { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15 } },
    medium: { width: { ideal: 960 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
    high:   { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  };

  async function start({ video = true, audio = true, quality = 'medium', deviceId } = {}) {
    constraintsCache.video = video; constraintsCache.audio = audio;
    const trackConstraints = video === false ? false : {
      ...PRESETS[quality],
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      facingMode: deviceId ? undefined : 'user',
    };
    const audioConstraints = audio === false ? false : {
      echoCancellation: true,   // шумоподавление/эхо (ТЗ §11)
      noiseSuppression: true,
      autoGainControl: true,
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: trackConstraints, audio: audioConstraints });
      demoMode = false;
      return { stream, demo: false };
    } catch (err) {
      // без камеры продукт не должен ломаться: демо-поток сохраняет весь сценарий рабочим
      console.warn('[media] getUserMedia failed:', err.name, err.message);
      demoMode = true;
      stream = ZV.createDemoStream('Вы', 265, audio);
      return { stream, demo: true, error: err.name };
    }
  }

  async function listDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return {
        video: list.filter(d => d.kind === 'videoinput'),
        audio: list.filter(d => d.kind === 'audioinput'),
        output: list.filter(d => d.kind === 'audiooutput'),
      };
    } catch { return { video: [], audio: [], output: [] }; }
  }

  async function switchDevice(kind, deviceId) {
    if (!stream) return stream;
    const isVideo = kind === 'video';
    try {
      const next = await navigator.mediaDevices.getUserMedia(
        isVideo ? { video: { deviceId: { exact: deviceId }, ...PRESETS.medium } }
                : { audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } });
      const oldTracks = stream.getTracks().filter(t => t.kind === (isVideo ? 'video' : 'audio'));
      oldTracks.forEach(t => { stream.removeTrack(t); t.stop(); });
      next.getTracks().forEach(t => stream.addTrack(t));
      return stream;
    } catch (err) {
      ZV.toast('Не удалось переключить устройство', 'error');
      return stream;
    }
  }

  /* ---------- размытие фона (canvas, без внешних моделей) ---------- */

  async function enableBlur(videoEl, on = true) {
    if (!stream) return stream;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return stream;

    if (!on) {
      if (processedStream) { stopProcessing(); }
      return stream;
    }
    if (processedCanvas) return processedStream;

    processedCanvas = document.createElement('canvas');
    processedCanvas.width = 480; processedCanvas.height = 360;
    const ctx = processedCanvas.getContext('2d');
    processedStream = processedCanvas.captureStream(15);
    stream.getAudioTracks().forEach(t => processedStream.addTrack(t));

    const tmp = document.createElement('canvas');
    tmp.width = 60; tmp.height = 45;
    const tctx = tmp.getContext('2d');

    function frame() {
      if (!videoEl.videoWidth) { raf = requestAnimationFrame(frame); return; }
      // «портрет» — центр кадра остаётся резким, края размываются
      ctx.filter = 'blur(9px)';
      ctx.drawImage(videoEl, 0, 0, processedCanvas.width, processedCanvas.height);
      ctx.filter = 'none';
      const w = processedCanvas.width * 0.56, h = processedCanvas.height * 0.78;
      const x = (processedCanvas.width - w) / 2, y = (processedCanvas.height - h) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(processedCanvas.width / 2, processedCanvas.height / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(videoEl, x - w * 0.2, y - h * 0.2, w * 1.4, h * 1.4, 0, 0, processedCanvas.width, processedCanvas.height);
      ctx.restore();
      raf = requestAnimationFrame(frame);
    }
    frame();
    return processedStream;
  }

  function stopProcessing() {
    cancelAnimationFrame(raf); raf = 0;
    processedStream?.getVideoTracks().forEach(t => t.stop());
    processedStream = null; processedCanvas = null;
  }

  function stop() {
    stopProcessing();
    stream?.getTracks().forEach(t => t.stop());
    stream?.__cleanup?.();
    stream = null; demoMode = false;
  }

  return {
    get stream() { return stream; },
    get isDemo() { return demoMode; },
    start, listDevices, switchDevice, enableBlur, stop,
  };
})();

window.ZVMedia = Media;
