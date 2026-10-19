/* Zvonitel.ru — WebRTC 1-на-1 (PeerConnection + сигналинг через Socket.IO) */

class Call {
  /** Защита от некорректного конфига: 'stun:host' -> {urls:'stun:host'}. */
  static normalizeIce(list) {
    const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (!Array.isArray(list) || !list.length) return fallback;
    const out = list.map(item => {
      if (typeof item === 'string' && /^(stun|turn|turns):/i.test(item)) return { urls: item };
      if (item && typeof item === 'object' && item.urls) {
        const o = { urls: item.urls };
        if (item.username) o.username = item.username;
        if (item.credential) o.credential = item.credential;
        return o;
      }
      return null;
    }).filter(Boolean);
    return out.length ? out : fallback;
  }


  /**
   * @param {object} opts
   * @param {import('socket.io-client').Socket} opts.socket
   * @param {string} opts.callId
   * @param {boolean} opts.initiator — кто создаёт offer
   * @param {MediaStream} opts.stream — локальный поток
   * @param {Array} opts.iceServers
   * @param {(evt:any)=>void} opts.onEvent
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.pc = null;
    this.pendingCandidates = [];
    this.remoteSet = false;
    this.statsTimer = 0;
    this.lastStats = null;
    this.reconnects = 0;
    this.state = 'idle';
    this.onEvent = opts.onEvent || (() => {});
  }

  emit(type, data) {
    this.socket.emit('rtc:signal', { callId: this.callId, type, data });
  }

  async setup() {
    const pc = new RTCPeerConnection({
      iceServers: Call.normalizeIce(this.iceServers),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    this.pc = pc;

    // локальные треки
    (this.stream?.getTracks() || []).forEach(tr => pc.addTrack(tr, this.stream));

    pc.ontrack = (e) => {
      const [remote] = e.streams;
      this.remoteStream = remote;
      this.onEvent({ type: 'remote-stream', stream: remote });
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) this.emit('ice', e.candidate.toJSON());
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.onEvent({ type: 'pc-state', state: s });
      if (s === 'connected') {
        this.setState('connected');
        this.socket.emit('rtc:state', { callId: this.callId, state: 'connected' });
        this.startStats();
      } else if (s === 'disconnected') {
        this.setState('reconnecting');
        this.onEvent({ type: 'reconnecting' });
        // браузер сам пытается восстановить; жёсткий фейл придёт как failed
      } else if (s === 'failed') {
        this.setState('failed');
        this.socket.emit('rtc:state', { callId: this.callId, state: 'failed' });
      } else if (s === 'closed') {
        this.setState('ended');
      }
    };

    pc.oniceconnectionstatechange = () => {
      this.onEvent({ type: 'ice-state', state: pc.iceConnectionState });
      if (pc.iceConnectionState === 'failed' && this.reconnects < 2) {
        this.reconnects++;
        try { pc.restartIce(); } catch {}
        this.onEvent({ type: 'reconnecting' });
      }
    };

    if (this.initiator) await this.createOffer();
    return this;
  }

  setState(s) { this.state = s; this.onEvent({ type: 'state', state: s }); }

  async createOffer() {
    const offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await this.pc.setLocalDescription(offer);
    this.emit('offer', { sdp: this.pc.localDescription.sdp, type: this.pc.localDescription.type });
  }

  async handleOffer(payload) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(payload));
    this.remoteSet = true;
    await this.flushCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.emit('answer', { sdp: this.pc.localDescription.sdp, type: this.pc.localDescription.type });
  }

  async handleAnswer(payload) {
    if (this.pc.signalingState === 'stable') return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(payload));
    this.remoteSet = true;
    await this.flushCandidates();
  }

  async handleIce(candidate) {
    if (!candidate) return;
    if (!this.remoteSet) { this.pendingCandidates.push(candidate); return; }
    try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  }

  async flushCandidates() {
    const list = this.pendingCandidates.splice(0);
    for (const c of list) { try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
  }

  /* ---------- управление медиа ---------- */

  setMic(on) {
    this.stream?.getAudioTracks().forEach(t => { t.enabled = on; });
  }
  setCamera(on) {
    this.stream?.getVideoTracks().forEach(t => { t.enabled = on; });
  }
  /** качество: auto|low|medium|high — меняем битрейт видео (ТЗ §4.3). */
  async setQuality(level) {
    const sender = this.pc?.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    const max = { low: 200_000, medium: 600_000, high: 1_600_000, auto: 1_200_000 }[level] ?? 1_200_000;
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    params.encodings[0].maxBitrate = max;
    if (level === 'low') params.encodings[0].scaleResolutionDownBy = 2;
    try { await sender.setParameters(params); } catch {}
  }

  /** замена потока (смена устройства / blur / маска) без пересоздания PeerConnection. */
  async replaceTrack(kind, newTrack) {
    const sender = this.pc?.getSenders().find(s => s.track?.kind === kind);
    if (!sender || !newTrack) return false;
    await sender.replaceTrack(newTrack);
    return true;
  }

  /* ---------- метрики ---------- */

  startStats() {
    clearInterval(this.statsTimer);
    this.statsTimer = setInterval(async () => {
      if (!this.pc || this.pc.connectionState === 'closed') { clearInterval(this.statsTimer); return; }
      try {
        const stats = await this.pc.getStats();
        let rtt = null, lost = 0, total = 0, bytesIn = 0, framesDropped = 0;
        stats.forEach(r => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
            rtt = Math.round(r.currentRoundTripTime * 1000);
          }
          if (r.type === 'inbound-rtp') {
            total += r.packetsReceived || 0; lost += r.packetsLost || 0;
            bytesIn += r.bytesReceived || 0;
            framesDropped += r.framesDropped || 0;
          }
        });
        const lossRate = total ? lost / (total + lost) : 0;
        let quality = 'good';
        if ((rtt != null && rtt > 260) || lossRate > 0.06) quality = 'bad';
        else if ((rtt != null && rtt > 140) || lossRate > 0.02) quality = 'medium';
        this.lastStats = { rtt, lossRate: +lossRate.toFixed(3), quality, kbps: Math.round(bytesIn / 1024), framesDropped };
        this.onEvent({ type: 'stats', stats: this.lastStats });
      } catch {}
    }, 2000);
  }

  close() {
    clearInterval(this.statsTimer);
    try { this.pc?.getSenders().forEach(s => s.track && null); } catch {}
    try { this.pc?.close(); } catch {}
    this.pc = null;
  }
}

window.ZVCall = Call;
