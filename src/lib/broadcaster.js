import { wsUrl } from './util.js';

/**
 * Camera broadcaster.
 * - Creates a separate RTCPeerConnection per viewer (mesh).
 * - In MJPEG mode, encodes JPEG frames from a canvas and sends them over WS (OBS fallback).
 * - When rotation is set, the video is rotated via a canvas pipeline for both WebRTC and MJPEG.
 * - Reconnects automatically when the connection drops.
 */
export class Broadcaster {
  constructor({ id, token, onEvent = () => {}, onStats = () => {} }) {
    this.id = id;
    this.token = token;
    this.onEvent = onEvent;
    this.onStats = onStats;

    this.ws = null;
    this.stream = null;
    this.peers = new Map();
    this.iceServers = [];
    this.closed = false;
    this.replaced = false;
    this.retry = 0;
    this.retryTimer = null;

    this.pumpOn = false;
    this.fps = 24;
    this.quality = 0.72;
    this.maxWidth = 1280;
    this.maxHeight = 720;
    this.rotation = 0;
    this.snapshotInterval = 4000;
    this.batterySaver = false;

    this.video = null;
    this.canvasFull = null;
    this.canvasThumb = null;
    this.processingStream = null;
    this.processingTrack = null;
    this.loopTimer = null;
    this.encoding = false;
    this.snapshotBusy = false;
    this.lastSnapshot = 0;
    this.lastFrameAt = 0;

    this.statsTimer = null;
    this.lastBytes = 0;
    this.lastBytesAt = 0;
    this.lastBitrate = 0;
    this.lastStatusAt = 0;
    this.lastFps = 0;
    this.pumpBytes = 0;
  }

  start(stream, settings = {}) {
    this.stream = stream;
    this.closed = false;
    this.replaced = false;
    this.retry = 0;
    this.pumpOn = false;
    this.applySettings(settings);
    this.connect();
    this.startCapture();
    this.startStats();
    this.lastSnapshot = 0;
  }

  applySettings(settings = {}) {
    if (settings.fps) this.fps = Math.min(60, Math.max(5, Number(settings.fps) || 24));
    if (settings.quality) this.quality = Math.min(1, Math.max(0.25, Number(settings.quality)));
    if (settings.width) this.maxWidth = Number(settings.width) || 1280;
    if (settings.height) this.maxHeight = Number(settings.height) || 720;
    if (settings.rotation !== undefined) this.rotation = clampRotation(settings.rotation);
  }

  updateSettings(settings = {}) {
    const previous = this.rotation;
    this.applySettings(settings);
    if (this.rotation !== previous) this.setRotation(this.rotation);
    for (const peer of this.peers.values()) this.tuneVideoSender(peer.pc);
    this.reschedule();
    this.sendStatus(true);
  }

  setRotation(rotation) {
    this.rotation = clampRotation(rotation);
    if (this.rotation !== 0) this.ensureProcessing();
    else this.stopProcessing();
    this.replaceVideoTracks(this.videoTrack());
    this.reschedule();
    this.sendStatus(true);
  }

  /**
   * Battery saver mode: slow the thumbnail snapshots down and drop MJPEG
   * quality. The phone's CPU/encoder is the biggest battery drain, so this
   * trades a slightly slower thumbnail refresh for meaningful battery savings.
   */
  setBatterySaver(on) {
    this.batterySaver = Boolean(on);
    this.snapshotInterval = this.batterySaver ? 15000 : 4000;
    this.reschedule();
  }

  connect() {
    clearTimeout(this.retryTimer);
    let ws;
    try {
      ws = new WebSocket(wsUrl({ role: 'publisher', id: this.id, token: this.token }));
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.emit('open');
      this.sendStatus(true);
    };

    ws.onmessage = (event) => this.onMessage(event);

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.closeAllPeers();
      this.emit('close', { code: event.code, reason: event.reason, replaced: this.replaced });
      if (!this.closed && !this.replaced) this.scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose handles it */
    };
  }

  scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(8000, 500 * 2 ** Math.min(5, this.retry));
    this.retry += 1;
    this.emit('reconnecting', { delay });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  onMessage(event) {
    if (typeof event.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'hello':
        this.iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
        this.emit('hello', { camera: msg.camera, viewerCount: msg.viewerCount ?? 0 });
        break;
      case 'viewer-join':
        this.emit('viewers', { delta: 1 });
        if (msg.mode === 'webrtc') this.ensurePeer(msg.peerId);
        break;
      case 'viewer-mode':
        if (msg.mode === 'webrtc') this.ensurePeer(msg.peerId);
        else this.closePeer(msg.peerId);
        break;
      case 'viewer-leave':
        this.closePeer(msg.peerId);
        this.emit('viewers', { delta: -1 });
        break;
      case 'viewers':
        this.emit('viewers', { count: msg.count, modes: msg.modes });
        break;
      case 'mjpeg-demand':
        this.pumpOn = Boolean(msg.on);
        this.reschedule();
        this.emit('pump', this.pumpOn);
        break;
      case 'signal':
        this.onSignal(msg.peerId, msg.data);
        break;
      case 'replaced':
        this.replaced = true;
        this.emit('replaced', msg.message);
        break;
      case 'error':
        this.emit('error', msg.message);
        if (msg.code === 4003 || msg.code === 4004) {
          this.closed = true;
          this.emit('fatal', { code: msg.code, message: msg.message });
        }
        break;
      default:
        break;
    }
  }

  // --------------------------------------------------------------- WebRTC

  /** The video track that should be sent (raw, or rotated via canvas capture). */
  videoTrack() {
    if (this.processingTrack) return this.processingTrack;
    return this.stream?.getVideoTracks?.()[0] ?? null;
  }

  audioTrack() {
    return this.stream?.getAudioTracks?.()[0] ?? null;
  }

  ensurePeer(peerId) {
    if (!peerId || !this.stream) return null;
    let peer = this.peers.get(peerId);
    if (peer) return peer;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle'
    });
    peer = {
      peerId,
      pc,
      pendingIce: [],
      makingOffer: false,
      retries: 0,
      senders: new Map()
    };
    this.peers.set(peerId, peer);

    const video = this.videoTrack();
    if (video) peer.senders.set('video', pc.addTrack(video, this.stream));
    const audio = this.audioTrack();
    if (audio) peer.senders.set('audio', pc.addTrack(audio, this.stream));

    this.tuneVideoSender(pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) this.signal(peerId, { candidate: event.candidate });
    };

    pc.onnegotiationneeded = async () => {
      if (peer.makingOffer) return;
      peer.makingOffer = true;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signal(peerId, { sdp: pc.localDescription });
      } catch {
        /* the connection may already be closed */
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        if (peer.retries >= 2) {
          this.closePeer(peerId);
          return;
        }
        peer.retries += 1;
        try {
          pc.restartIce();
        } catch {
          /* ignore */
        }
      }
    };

    return peer;
  }

  tuneVideoSender(pc) {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = this.bitrateForQuality();
      params.encodings[0].maxFramerate = this.fps;
      params.degradationPreference = 'maintain-resolution';
      sender.setParameters(params).catch(() => {});
    } catch {
      /* ignore if unsupported */
    }
  }

  bitrateForQuality() {
    if (this.maxWidth >= 1900) return 6_000_000;
    if (this.maxWidth >= 1200) return 3_500_000;
    return 1_800_000;
  }

  closePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    try {
      peer.pc.close();
    } catch {
      /* ignore */
    }
  }

  closeAllPeers() {
    for (const peerId of [...this.peers.keys()]) this.closePeer(peerId);
  }

  async onSignal(peerId, data) {
    if (!data) return;
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const pc = peer.pc;

    try {
      if (data.sdp) {
        if (data.sdp.type === 'answer') {
          await pc.setRemoteDescription(data.sdp);
          for (const candidate of peer.pendingIce.splice(0)) {
            await pc.addIceCandidate(candidate).catch(() => {});
          }
        }
        return;
      }
      if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pendingIce.push(data.candidate);
      }
    } catch {
      /* SDP/ICE error: the connection will be re-established */
    }
  }

  signal(peerId, data) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ t: 'signal', peerId, data }));
  }

  // ---------------------------------------------------------------- stream

  setStream(stream) {
    const old = this.stream;
    this.stream = stream;
    this.lastSnapshot = 0;
    this.startCapture();

    for (const peer of this.peers.values()) {
      for (const kind of ['video', 'audio']) {
        const track = kind === 'video' ? this.videoTrack() : this.audioTrack();
        const sender = peer.senders?.get(kind);
        if (sender) {
          sender.replaceTrack(track).catch(() => {});
        } else if (track) {
          const added = peer.pc.addTrack(track, stream);
          peer.senders?.set(kind, added);
        }
      }
      this.tuneVideoSender(peer.pc);
    }

    if (old && old !== stream) {
      const keep = new Set(stream.getTracks().map((t) => t.id));
      for (const track of old.getTracks()) {
        if (!keep.has(track.id)) track.stop();
      }
    }

    this.sendStatus(true);
  }

  replaceVideoTracks(track) {
    for (const peer of this.peers.values()) {
      peer.senders?.get('video')?.replaceTrack(track).catch(() => {});
    }
  }

  ensureProcessing() {
    if (this.processingTrack || !this.canvasFull) return;
    try {
      this.processingStream = this.canvasFull.captureStream(this.fps);
      this.processingTrack = this.processingStream.getVideoTracks()[0] ?? null;
    } catch {
      this.processingTrack = null;
      this.processingStream = null;
    }
  }

  stopProcessing() {
    try {
      this.processingTrack?.stop();
    } catch {
      /* ignore */
    }
    this.processingTrack = null;
    this.processingStream = null;
  }

  startCapture() {
    this.stopCapture();
    if (!this.stream) return;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    // iOS/Safari only produces frames when the element is in the DOM.
    video.style.cssText =
      'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(video);
    video.srcObject = this.stream;
    video.play().catch(() => {});
    this.video = video;
    this.canvasFull = document.createElement('canvas');
    this.canvasThumb = document.createElement('canvas');
    if (this.rotation !== 0) this.ensureProcessing();
    this.reschedule();
  }

  stopCapture() {
    clearTimeout(this.loopTimer);
    this.loopTimer = null;
    this.stopProcessing();
    if (this.video) {
      try {
        this.video.pause();
      } catch {
        /* ignore */
      }
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
  }

  reschedule() {
    clearTimeout(this.loopTimer);
    if (!this.video) return;
    const processing = this.processingTrack != null;
    const delay = this.pumpOn || processing
      ? Math.max(1000 / 30, 1000 / Math.max(5, this.fps))
      : 800;
    this.loopTimer = setTimeout(() => {
      try {
        this.tick();
      } catch {
        /* a single frame error must not stop the loop */
      }
      this.reschedule();
    }, delay);
  }

  tick() {
    if (this.closed) return;
    const video = this.video;
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    const now = Date.now();

    // When the tab is hidden (screen locked / app backgrounded), skip the
    // thumbnail work entirely. WebRTC is peer-to-peer and unaffected; only
    // the home-page preview cards lose freshness, which is fine.
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (!hidden && now - this.lastSnapshot >= this.snapshotInterval) {
      this.captureSnapshot(video);
    }

    const processing = this.processingTrack != null;
    if (!this.pumpOn && !processing) return;

    if (now - this.lastFrameAt < (1000 / this.fps) * 0.8) return;
    this.lastFrameAt = now;

    this.renderInto(video, this.canvasFull, this.maxWidth, this.maxHeight);

    if (this.pumpOn && !this.encoding && this.ws?.readyState === 1 && !largeBuffered(this.ws)) {
      this.encoding = true;
      this.canvasFull.toBlob(
        (blob) => {
          this.encoding = false;
          if (!blob || !this.pumpOn) return;
          blob
            .arrayBuffer()
            .then((buffer) => this.sendBinary(0x01, buffer))
            .catch(() => {});
        },
        'image/jpeg',
        this.batterySaver ? Math.min(this.quality, 0.5) : this.quality
      );
    }
  }

  /** Draws a video frame into the canvas, applying the configured rotation. */
  renderInto(video, canvas, maxW, maxH) {
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const rotated = this.rotation % 180 !== 0;
    const rw = rotated ? vh : vw;
    const rh = rotated ? vw : vh;
    const scale = Math.min(maxW / rw, maxH / rh, 1);
    let outW = Math.max(2, Math.round(rw * scale));
    outW -= outW % 2;
    const s = outW / rw;
    let outH = Math.max(2, Math.round(rh * s));
    outH -= outH % 2;

    if (canvas.width !== outW || canvas.height !== outH) {
      canvas.width = outW;
      canvas.height = outH;
    }
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, outW, outH);

    const dw = vw * s;
    const dh = vh * s;
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    if (this.rotation) ctx.rotate((this.rotation * Math.PI) / 180);
    ctx.drawImage(video, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();

    return { width: outW, height: outH };
  }

  captureSnapshot(video) {
    if (this.snapshotBusy) return;
    this.lastSnapshot = Date.now();
    this.snapshotBusy = true;
    this.renderInto(video, this.canvasThumb, 480, 480);
    this.canvasThumb.toBlob(
      (blob) => {
        if (!blob) {
          this.snapshotBusy = false;
          return;
        }
        blob
          .arrayBuffer()
          .then((buffer) => {
            this.sendBinary(0x02, buffer);
            this.snapshotBusy = false;
          })
          .catch(() => {
            this.snapshotBusy = false;
          });
      },
      'image/jpeg',
      0.62
    );
  }

  sendBinary(type, arrayBuffer) {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (largeBuffered(this.ws)) return;
    const payload = new Uint8Array(arrayBuffer);
    const out = new Uint8Array(payload.length + 1);
    out[0] = type;
    out.set(payload, 1);
    if (type === 0x01) this.pumpBytes += out.length;
    try {
      this.ws.send(out);
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- statistics

  startStats() {
    clearInterval(this.statsTimer);
    this.lastBytes = 0;
    this.lastBytesAt = Date.now();
    this.statsTimer = setInterval(() => {
      this.collectStats().catch(() => {});
    }, 3000);
  }

  async collectStats() {
    let bytes = 0;
    let fps = 0;
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState === 'closed') continue;
      try {
        const stats = await peer.pc.getStats();
        stats.forEach((report) => {
          if (report.type === 'outbound-rtp' && report.kind === 'video' && !report.isRemote) {
            bytes += report.bytesSent || 0;
            fps = Math.max(fps, report.framesPerSecond || 0);
          }
        });
      } catch {
        /* ignore */
      }
    }
    const now = Date.now();
    const dt = (now - this.lastBytesAt) / 1000;
    const pumped = this.pumpBytes;
    this.pumpBytes = 0;
    const webrtcBitrate = dt > 0 ? Math.max(0, ((bytes - this.lastBytes) * 8) / dt) : 0;
    const pumpBitrate = dt > 0 ? (pumped * 8) / dt : 0;
    this.lastBytes = bytes;
    this.lastBytesAt = now;
    this.lastBitrate = webrtcBitrate + pumpBitrate;
    this.lastFps = fps;
    try {
      this.onStats({ bitrate: this.lastBitrate, fps, peers: this.peers.size, pump: this.pumpOn });
    } catch {
      /* a UI error must not stop the stream */
    }
    if (now - this.lastStatusAt > 4000) this.sendStatus();
  }

  sendStatus(force = false) {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (!force && Date.now() - this.lastStatusAt < 2000) return;
    this.lastStatusAt = Date.now();

    const processing = this.processingTrack != null && this.canvasFull;
    const raw = this.stream?.getVideoTracks?.()[0]?.getSettings?.() ?? {};
    const width = processing ? this.canvasFull.width : (raw.width ?? 0);
    const height = processing ? this.canvasFull.height : (raw.height ?? 0);
    const audio = Boolean(this.stream?.getAudioTracks?.().length);

    this.ws.send(
      JSON.stringify({
        t: 'status',
        width,
        height,
        fps: raw.frameRate ? Math.round(raw.frameRate) : this.fps,
        bitrate: Math.round(this.lastBitrate),
        audio
      })
    );
  }

  // ------------------------------------------------------------- lifecycle

  stop() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.statsTimer);
    this.stopCapture();
    this.closeAllPeers();
    if (this.ws) {
      try {
        this.ws.close(1000, 'bye');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.emit('close', { code: 1000, reason: 'stopped', replaced: false });
  }

  emit(type, payload) {
    try {
      this.onEvent({ type, payload });
    } catch {
      /* a UI error must not stop the stream */
    }
  }
}

function clampRotation(value) {
  const normalized = ((Number(value) || 0) % 360 + 360) % 360;
  return [0, 90, 180, 270].includes(normalized) ? normalized : 0;
}

function largeBuffered(ws) {
  return ws.bufferedAmount > 3 * 1024 * 1024;
}
