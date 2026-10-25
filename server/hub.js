import { runtimeFor } from './state.js';

const MAX_WS_BUFFER = 4 * 1024 * 1024;
const MAX_HTTP_BUFFER = 3 * 1024 * 1024;

export function send(ws, payload) {
  if (!ws || ws.readyState !== 1) return false;
  if (ws.bufferedAmount > MAX_WS_BUFFER) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function broadcastToViewers(cameraId, payload) {
  const rt = runtimeFor(cameraId);
  for (const viewer of rt.viewers.values()) send(viewer.ws, payload);
}

export function broadcastViewerCount(cameraId) {
  const rt = runtimeFor(cameraId);
  const modes = { webrtc: 0, ws: 0 };
  for (const viewer of rt.viewers.values()) modes[viewer.mode] = (modes[viewer.mode] ?? 0) + 1;
  const message = { t: 'viewers', count: rt.viewers.size, modes };
  if (rt.publisher) send(rt.publisher, message);
  return message;
}

/** Is there any consumer that needs MJPEG? If so, tell the publisher. */
export function updateMjpegDemand(cameraId) {
  const rt = runtimeFor(cameraId);
  const httpDemand = rt.httpMjpeg.size > 0;
  const wsDemand = [...rt.viewers.values()].some((v) => v.mode === 'ws');
  const on = httpDemand || wsDemand;
  if (on === rt.mjpegDemand) return;
  rt.mjpegDemand = on;
  if (rt.publisher) send(rt.publisher, { t: 'mjpeg-demand', on });
}

/** Distributes a JPEG frame from the publisher to WS viewers and MJPEG clients. */
export function relayFrame(cameraId, fullBuffer) {
  const rt = runtimeFor(cameraId);
  rt.lastFrameTs = Date.now();
  rt.framesSent += 1;

  for (const viewer of rt.viewers.values()) {
    if (viewer.mode !== 'ws') continue;
    const ws = viewer.ws;
    if (!ws || ws.readyState !== 1) continue;
    if (ws.bufferedAmount > MAX_WS_BUFFER) continue;
    try {
      ws.send(fullBuffer);
    } catch {
      /* ignore */
    }
  }

  if (rt.httpMjpeg.size === 0) return;
  const jpeg = fullBuffer.subarray(1);
  const header = Buffer.from(
    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
    'ascii'
  );
  const footer = Buffer.from('\r\n', 'ascii');
  for (const client of rt.httpMjpeg) {
    const res = client.res;
    if (!res || res.writableEnded) continue;
    if (res.writableLength > MAX_HTTP_BUFFER) continue;
    try {
      res.write(header);
      res.write(jpeg);
      res.write(footer);
    } catch {
      /* connection lost; the close event cleans up */
    }
  }
}
