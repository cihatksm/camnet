import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { DIST_DIR, ROOT_DIR } from './paths.js';
import {
  createCamera,
  deleteCamera,
  getCamera,
  getConfig,
  listCameras,
  updateCamera
} from './store.js';
import { dropRuntime, publicCamera, runtimeFor } from './state.js';
import { attachMjpeg } from './mjpeg.js';
import { getLanIps } from './util.js';
import { startVirtualCamera, stopVirtualCamera, virtualCameraStatus } from './obs.js';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const INDEX_FILE = path.join(DIST_DIR, 'index.html');

function authCamera(req, res, next) {
  const camera = getCamera(req.params.id);
  if (!camera) {
    res.status(404).json({ error: 'not_found', message: 'Camera not found.' });
    return;
  }
  const token = req.get('x-camera-token') || req.query.token;
  if (!token || token !== camera.token) {
    res.status(403).json({ error: 'forbidden', message: 'Invalid camera key.' });
    return;
  }
  req.camera = camera;
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));

  // ------------------------------------------------------------------ API

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
  });

  app.get('/api/info', (req, res) => {
    const config = getConfig();
    const ips = getLanIps();
    res.json({
      siteName: config.siteName,
      version: pkg.version,
      httpPort: config.httpPort,
      httpsPort: config.httpsPort,
      ips,
      primaryIp: ips[0] ?? '127.0.0.1',
      secure: req.secure,
      iceServers: config.iceServers ?? [],
      maxViewersPerCamera: config.maxViewersPerCamera
    });
  });

  app.get('/api/obs/status', async (_req, res) => {
    res.json(await virtualCameraStatus());
  });

  app.post('/api/obs/virtual-camera/start', async (req, res) => {
    const cameraId = String(req.body?.cameraId ?? '').trim();
    if (!cameraId || !getCamera(cameraId)) {
      res.status(404).json({ error: 'not_found', message: 'Camera not found.' });
      return;
    }
    const config = getConfig();
    // OBS runs on this machine; loopback is the most reliable base URL.
    const baseUrl = `http://127.0.0.1:${config.httpPort}`;
    try {
      const result = await startVirtualCamera(cameraId, baseUrl);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(502).json({ error: err.code || 'obs_error', message: err.message });
    }
  });

  app.post('/api/obs/virtual-camera/stop', async (_req, res) => {
    try {
      const result = await stopVirtualCamera();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(502).json({ error: err.code || 'obs_error', message: err.message });
    }
  });

  app.get('/api/cameras', (_req, res) => {
    const cameras = listCameras()
      .map((camera) => publicCamera(camera))
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.createdAt - b.createdAt;
      });
    res.json({ cameras });
  });

  app.post('/api/cameras', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    try {
      const camera = createCamera(name);
      res.status(201).json({ camera: publicCamera(camera), token: camera.token });
    } catch (err) {
      if (err.code === 'MAX_CAMERAS') {
        res.status(409).json({ error: 'max_cameras', message: err.message });
        return;
      }
      throw err;
    }
  });

  app.get('/api/cameras/:id', (req, res) => {
    const camera = getCamera(req.params.id);
    if (!camera) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ camera: publicCamera(camera) });
  });

  app.patch('/api/cameras/:id', authCamera, (req, res) => {
    const camera = updateCamera(req.params.id, {
      name: req.body?.name,
      settings: req.body?.settings
    });
    res.json({ camera: publicCamera(camera) });
  });

  app.delete('/api/cameras/:id', authCamera, (req, res) => {
    deleteCamera(req.params.id);
    dropRuntime(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/cameras/:id/snapshot.jpg', (req, res) => {
    if (!getCamera(req.params.id)) {
      res.status(404).end();
      return;
    }
    const rt = runtimeFor(req.params.id);
    if (!rt.snapshot?.buf?.length) {
      res.status(404).end();
      return;
    }
    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': String(rt.snapshot.buf.length),
      'Cache-Control': 'no-store, max-age=0'
    });
    res.end(rt.snapshot.buf);
  });

  app.get('/api/qr.svg', async (req, res) => {
    const text = String(req.query.text ?? '').slice(0, 800);
    if (!text) {
      res.status(400).json({ error: 'missing_text' });
      return;
    }
    try {
      const svg = await QRCode.toString(text, {
        type: 'svg',
        margin: 1,
        width: 260,
        errorCorrectionLevel: 'M',
        color: { dark: '#0b1017', light: '#ffffff' }
      });
      res
        .type('image/svg+xml')
        .set('Cache-Control', 'public, max-age=300')
        .send(svg);
    } catch {
      res.status(500).json({ error: 'qr_failed' });
    }
  });

  // --------------------------------------------------------- MJPEG (OBS/VLC)

  app.get(/^\/c\/([a-z0-9][a-z0-9-]{0,40})\.mjpeg$/i, (req, res) => {
    const camera = getCamera(req.params[0]);
    if (!camera) {
      res.status(404).type('text/plain').send('Camera not found.');
      return;
    }
    attachMjpeg(req, res, camera.id);
  });

  // ----------------------------------------------------------------- statik

  if (fs.existsSync(DIST_DIR)) {
    app.use(
      '/assets',
      express.static(path.join(DIST_DIR, 'assets'), {
        immutable: true,
        maxAge: '365d'
      })
    );
    app.use(
      express.static(DIST_DIR, {
        index: false,
        maxAge: '1h',
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        }
      })
    );
  }

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/ws') {
      next();
      return;
    }
    if (!fs.existsSync(INDEX_FILE)) {
      res
        .status(503)
        .type('html')
        .send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>CamNet</title>
           <body style="font-family:system-ui;background:#0b0f14;color:#e8eef7;padding:40px;line-height:1.6">
           <h1>CamNet UI is not built</h1>
           <p>Run <code>npm run build</code> first, then restart the server.</p>
           </body></html>`
        );
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(INDEX_FILE);
  });

  // ------------------------------------------------------------ error handling

  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    console.error('[api] unexpected error:', err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}
