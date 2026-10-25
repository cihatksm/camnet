import { runtimeFor } from './state.js';
import { updateMjpegDemand } from './hub.js';

/**
 * Multipart MJPEG stream for OBS "Media Source" / VLC.
 * boundary=frame, each frame is sent with Content-Length (ffmpeg mpjpeg compatible).
 */
export function attachMjpeg(req, res, cameraId) {
  const rt = runtimeFor(cameraId);

  if (!rt.publisher) {
    res.status(503).type('text/plain').send('Camera is offline.');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });
  // Some clients wait for the first boundary marker.
  res.write('--frame\r\n');

  const client = { res };
  rt.httpMjpeg.add(client);
  updateMjpegDemand(cameraId);

  if (rt.snapshot?.buf?.length) {
    writeJpeg(res, rt.snapshot.buf);
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rt.httpMjpeg.delete(client);
    updateMjpegDemand(cameraId);
  };

  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

export function writeJpeg(res, jpeg) {
  if (!res || res.writableEnded) return;
  if (res.writableLength > 3 * 1024 * 1024) return;
  try {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg);
    res.write('\r\n');
  } catch {
    /* the close event cleans up */
  }
}
