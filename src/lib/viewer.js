import { wsUrl } from './util.js';

const FALLBACK_MS = 8000;

/**
 * Camera viewer (OBS Browser Source).
 * Tries WebRTC first, then falls back to JPEG frames over WebSocket (MJPEG).
 */
export class ViewerClient {
  constructor({
    id,
    mode = 'auto',
    onEvent = () => {},
    onFrame = () => {},
    onStream = () => {},
    onStatus = () => {}
  }) {
    this.id = id;
    this.preferred = mode;
    this.mode = mode === 'ws' ? 'ws' : 'webrtc';
    this.onEvent = onEvent;
    this.onFrame = onFrame;
    this.onStream = onStream;
    this.onStatus = onStatus;

    this.ws = null;
    this.pc = null;
    this.peerId = null;
    this.iceServers = [];
    this.pendingIce = [];
    this.chain = Promise.resolve();
    this.online = false;
    this.live = false;
    this.closed = false;
    this.retry = 0;
    this.retryTimer = null;
    this.fallbackTimer = null;
    this.connectedOnce = false;
  }

  connect() {
    clearTimeout(this.retryTimer);
    let ws;
    try {
      ws = new WebSocket(
        wsUrl({ role: 'viewer', id: this.id, mode: this.preferred === 'ws' ? 'ws' : 'webrtc' })
      );
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.emit('socket-open');
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this.handleJson(event.data);
      } else {
        this.handleBinary(event.data);
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.closePc();
      if (this.closed) return;
      if (event.code === 4004) {
        this.emit('fatal', { message: 'Camera not found.' });
        return;
      }
      if (event.code === 4003) {
        this.emit('fatal', { message: 'Unauthorized.' });
        return;
      }
      this.emit('socket-close', { code: event.code });
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose halleder */
    };
  }

  scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(5000, 400 * 2 ** Math.min(5, this.retry));
    this.retry += 1;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  handleJson(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'hello':
        this.peerId = msg.peerId;
        this.iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
        this.online = Boolean(msg.online);
        this.emit('hello', msg);
        if (msg.status) this.onStatus(msg.status);
        if (this.online) {
          this.emit('online');
          this.armFallback();
        } else {
          this.emit('waiting');
        }
        break;

      case 'publisher-online':
        this.online = true;
        this.live = false;
        this.connectedOnce = false;
        this.closePc();
        this.emit('online');
        if (msg.status) this.onStatus(msg.status);
        this.armFallback();
        break;

      case 'publisher-offline':
        this.online = false;
        this.live = false;
        this.closePc();
        clearTimeout(this.fallbackTimer);
        this.emit('waiting');
        break;

      case 'signal':
        this.handleSignal(msg.data);
        break;

      case 'status':
        if (msg.status) this.onStatus(msg.status);
        break;

      case 'mode-set':
        this.emit('mode', msg.mode);
        break;

      case 'error':
        this.emit('error', msg.message);
        break;

      default:
        break;
    }
  }

  handleBinary(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 2) return;
    const view = new Uint8Array(data);
    if (view[0] !== 0x01) return;
    const blob = new Blob([view.subarray(1)], { type: 'image/jpeg' });
    this.emit('frame');
    this.onFrame(blob);
  }

  handleSignal(data) {
    if (!data) return;
    const pc = this.ensurePc();
    if (!pc) return;

    if (data.sdp) {
      if (data.sdp.type !== 'offer') return;
      this.chain = this.chain
        .then(async () => {
          if (this.pc !== pc) return;
          await pc.setRemoteDescription(data.sdp);
          for (const candidate of this.pendingIce.splice(0)) {
            await pc.addIceCandidate(candidate).catch(() => {});
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.signal({ sdp: pc.localDescription });
        })
        .catch(() => {
          this.emit('webrtc-error');
        });
      return;
    }

    if (data.candidate) {
      if (pc.remoteDescription) {
        pc.addIceCandidate(data.candidate).catch(() => {});
      } else {
        this.pendingIce.push(data.candidate);
      }
    }
  }

  ensurePc() {
    if (this.pc) return this.pc;
    if (this.mode !== 'webrtc') return null;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle'
    });
    this.pc = pc;
    this.pendingIce = [];

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.onStream(stream);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) this.signal({ candidate: event.candidate });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        this.connectedOnce = true;
        clearTimeout(this.fallbackTimer);
        this.emit('connected');
      } else if (state === 'failed') {
        this.emit('webrtc-error');
        if (!this.connectedOnce) this.fallbackNow('failed');
      }
    };

    return pc;
  }

  closePc() {
    const pc = this.pc;
    this.pc = null;
    this.pendingIce = [];
    if (pc) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  armFallback() {
    clearTimeout(this.fallbackTimer);
    if (this.preferred === 'ws') return;
    this.fallbackTimer = setTimeout(() => {
      if (!this.live) this.fallbackNow('timeout');
    }, FALLBACK_MS);
  }

  fallbackNow(reason) {
    if (this.mode === 'ws' || this.closed) return;
    this.emit('fallback', { reason });
    this.setMode('ws');
  }

  setMode(mode) {
    const next = mode === 'ws' ? 'ws' : 'webrtc';
    if (next === this.mode) return;
    this.mode = next;
    this.live = false;
    this.closePc();
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ t: 'mode', mode: next }));
    }
    this.emit('mode', next);
    if (next === 'webrtc') this.armFallback();
  }

  /** Video gercekten oynamaya basladiginda cagrilir. */
  markLive() {
    if (this.live) return;
    this.live = true;
    clearTimeout(this.fallbackTimer);
    this.emit('live', { mode: this.mode });
  }

  signal(data) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ t: 'signal', data }));
  }

  destroy() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.fallbackTimer);
    this.closePc();
    if (this.ws) {
      try {
        this.ws.close(1000, 'bye');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  emit(type, payload) {
    try {
      this.onEvent({ type, payload });
    } catch {
      /* ignore */
    }
  }
}
