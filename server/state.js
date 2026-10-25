import { getCamera } from './store.js';

/**
 * Runtime (in-memory) state for each camera.
 * Nothing persistent is kept here; it resets when the server restarts.
 */
const runtimes = new Map();

export function runtimeFor(id) {
  let rt = runtimes.get(id);
  if (!rt) {
    rt = {
      id,
      publisher: null,
      viewers: new Map(), // peerId -> { peerId, ws, mode }
      snapshot: null, // { buf, ts }
      status: null, // { width, height, fps, bitrate, audio, at }
      httpMjpeg: new Set(), // { res }
      mjpegDemand: false,
      lastFrameTs: 0,
      framesSent: 0
    };
    runtimes.set(id, rt);
  }
  return rt;
}

export function dropRuntime(id) {
  const rt = runtimes.get(id);
  if (!rt) return;
  try {
    rt.publisher?.close(4004, 'deleted');
  } catch {
    /* ignore */
  }
  for (const viewer of rt.viewers.values()) {
    try {
      viewer.ws.close(4004, 'deleted');
    } catch {
      /* ignore */
    }
  }
  for (const client of rt.httpMjpeg) {
    try {
      client.res.end();
    } catch {
      /* ignore */
    }
  }
  runtimes.delete(id);
}

export function publicCamera(camera) {
  const rt = runtimes.get(camera.id);
  return {
    id: camera.id,
    name: camera.name,
    online: Boolean(rt?.publisher),
    viewers: rt ? rt.viewers.size : 0,
    createdAt: camera.createdAt,
    lastSeen: camera.lastSeen,
    settings: camera.settings,
    status: rt?.status ?? null,
    snapshotTs: rt?.snapshot?.ts ?? 0
  };
}

export function getCameraOrNull(id) {
  return getCamera(id);
}
