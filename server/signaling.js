import { WebSocketServer } from 'ws';
import { getCamera, saveCameras } from './store.js';
import { runtimeFor } from './state.js';
import { broadcastViewerCount, relayFrame, send, updateMjpegDemand } from './hub.js';
import { randomHex } from './util.js';

const HEARTBEAT_MS = 25000;

function normalizeMode(value) {
  return value === 'ws' || value === 'mjpeg' ? 'ws' : 'webrtc';
}

function closeWith(ws, code, message) {
  try {
    ws.send(JSON.stringify({ t: 'error', code, message }));
  } catch {
    /* ignore */
  }
  try {
    ws.close(code, code === 4003 ? 'unauthorized' : code === 4004 ? 'not-found' : 'closed');
  } catch {
    ws.destroy();
  }
}

export function attachSignaling(server, config) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', () => {
      /* connection errors are handled by close */
    });

    let params;
    try {
      params = new URL(req.url, 'http://localhost').searchParams;
    } catch {
      closeWith(ws, 4000, 'Invalid request.');
      return;
    }

    const role = params.get('role');
    const id = params.get('id');
    const token = params.get('token');
    const camera = id ? getCamera(id) : null;

    if (!camera) {
      closeWith(ws, 4004, 'Camera not found. Create a camera first.');
      return;
    }

    if (role === 'publisher') {
      if (!token || token !== camera.token) {
        closeWith(ws, 4003, 'You are not allowed to publish this camera.');
        return;
      }
      attachPublisher(ws, camera, config);
      return;
    }

    if (role === 'viewer') {
      attachViewer(ws, camera, normalizeMode(params.get('mode')), config);
      return;
    }

    closeWith(ws, 4000, 'Invalid role.');
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

// ----------------------------------------------------------------- publisher

function attachPublisher(ws, camera, config) {
  const rt = runtimeFor(camera.id);

  if (rt.publisher && rt.publisher !== ws) {
    send(rt.publisher, { t: 'replaced', message: 'Another device took over this camera.' });
    try {
      rt.publisher.close(4001, 'replaced');
    } catch {
      rt.publisher.terminate();
    }
  }

  rt.publisher = ws;
  rt.status = null;
  rt.mjpegDemand = false;
  camera.lastSeen = Date.now();
  saveCameras();

  ws.meta = { role: 'publisher', cameraId: camera.id };

  send(ws, {
    t: 'hello',
    camera: { id: camera.id, name: camera.name, settings: camera.settings },
    viewerCount: rt.viewers.size,
    iceServers: config.iceServers ?? []
  });

  // Notify the new publisher about viewers that are already connected.
  for (const [peerId, viewer] of rt.viewers) {
    send(ws, { t: 'viewer-join', peerId, mode: viewer.mode });
    send(viewer.ws, { t: 'publisher-online', status: rt.status });
  }
  updateMjpegDemand(camera.id);
  broadcastViewerCount(camera.id);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      onPublisherFrame(camera.id, Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'signal') {
      const viewer = rt.viewers.get(msg.peerId);
      if (viewer) send(viewer.ws, { t: 'signal', data: msg.data });
      return;
    }

    if (msg.t === 'status') {
      rt.status = {
        width: Number(msg.width) || 0,
        height: Number(msg.height) || 0,
        fps: Number(msg.fps) || 0,
        bitrate: Number(msg.bitrate) || 0,
        audio: Boolean(msg.audio),
        at: Date.now()
      };
      for (const viewer of rt.viewers.values()) {
        send(viewer.ws, { t: 'status', status: rt.status });
      }
      return;
    }

    if (msg.t === 'ping') send(ws, { t: 'pong', at: Date.now() });
  });

  ws.on('close', () => {
    if (rt.publisher !== ws) return;
    rt.publisher = null;
    rt.status = null;
    rt.mjpegDemand = false;
    camera.lastSeen = Date.now();
    saveCameras();

    // MJPEG HTTP connections are not closed: they resume when the publisher returns.
    for (const viewer of rt.viewers.values()) {
      send(viewer.ws, { t: 'publisher-offline' });
    }
    broadcastViewerCount(camera.id);
  });
}

function onPublisherFrame(cameraId, buf) {
  if (buf.length < 2) return;
  const type = buf[0];

  if (type === 0x01) {
    relayFrame(cameraId, buf);
    return;
  }

  if (type === 0x02) {
    // Small preview frame: stored for the home page cards.
    const rt = runtimeFor(cameraId);
    rt.snapshot = { buf: Buffer.from(buf.subarray(1)), ts: Date.now() };
  }
}

// ------------------------------------------------------------------ viewer

function attachViewer(ws, camera, mode, config) {
  const rt = runtimeFor(camera.id);
  const maxViewers = config.maxViewersPerCamera ?? 12;

  if (rt.viewers.size >= maxViewers) {
    closeWith(ws, 4029, `Viewer limit (${maxViewers}) reached for this camera.`);
    return;
  }

  const peerId = randomHex(4);
  const viewer = { peerId, ws, mode };
  rt.viewers.set(peerId, viewer);
  ws.meta = { role: 'viewer', cameraId: camera.id, peerId };

  send(ws, {
    t: 'hello',
    peerId,
    mode,
    online: Boolean(rt.publisher),
    camera: { id: camera.id, name: camera.name },
    status: rt.status,
    snapshotTs: rt.snapshot?.ts ?? 0,
    iceServers: config.iceServers ?? [],
    viewerCount: rt.viewers.size
  });

  if (rt.publisher) send(rt.publisher, { t: 'viewer-join', peerId, mode });
  updateMjpegDemand(camera.id);
  broadcastViewerCount(camera.id);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'signal' && rt.publisher) {
      send(rt.publisher, { t: 'signal', peerId, data: msg.data });
      return;
    }

    if (msg.t === 'mode') {
      const next = normalizeMode(msg.mode);
      if (next === viewer.mode) return;
      viewer.mode = next;
      if (rt.publisher) send(rt.publisher, { t: 'viewer-mode', peerId, mode: next });
      updateMjpegDemand(camera.id);
      broadcastViewerCount(camera.id);
      send(ws, { t: 'mode-set', mode: next });
    }
  });

  ws.on('close', () => {
    rt.viewers.delete(peerId);
    if (rt.publisher) send(rt.publisher, { t: 'viewer-leave', peerId });
    updateMjpegDemand(camera.id);
    broadcastViewerCount(camera.id);
  });
}
