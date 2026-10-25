import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createApp } from './app.js';
import { attachSignaling } from './signaling.js';
import { ensureCerts } from './certs.js';
import { DIST_DIR } from './paths.js';
import { flushAll, getConfig, loadCameras } from './store.js';
import { getLanIps } from './util.js';
import { events } from './events.js';
import { registerCom } from './vcam.js';

/**
 * Starts the HTTP + HTTPS servers and returns a handle with the URLs and
 * a close() method. Used by both the CLI (`npm start`) and the desktop app.
 */
export async function startServer() {
  loadCameras();
  const config = getConfig();
  const app = createApp();

  if (!fs.existsSync(DIST_DIR)) {
    console.warn('\n[!] dist/ not found. Build the UI first: npm run build\n');
  }

  // Register native virtual camera COM component (requires admin)
  try {
    await registerCom();
    console.log('[vcam] COM component registered');
  } catch (err) {
    console.warn('[vcam] COM registration skipped:', err.message);
  }

  const listen = (server, port) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, config.bind);
    });

  const httpServer = http.createServer(app);
  attachSignaling(httpServer, config);
  await listen(httpServer, config.httpPort); // throws on EADDRINUSE

  let httpsServer = null;
  if (config.httpsPort && config.httpsPort !== config.httpPort) {
    try {
      const certs = ensureCerts();
      httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, app);
      attachSignaling(httpsServer, config);
      await listen(httpsServer, config.httpsPort);
    } catch (err) {
      console.error(`[!] Could not start HTTPS (${config.httpsPort}): ${err.message}`);
      httpsServer = null;
    }
  }

  const ips = getLanIps();
  const lan = ips[0] ?? '127.0.0.1';

  const closeServer = (server) =>
    new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      setTimeout(resolve, 1500).unref();
    });

  return {
    config,
    ips,
    lan,
    events,
    httpServer,
    httpsServer,
    httpPort: config.httpPort,
    httpsPort: config.httpsPort,
    urls: {
      local: `http://localhost:${config.httpPort}`,
      http: `http://${lan}:${config.httpPort}`,
      https: httpsServer ? `https://${lan}:${config.httpsPort}` : null
    },
    async close() {
      await Promise.all([closeServer(httpServer), closeServer(httpsServer)]);
      flushAll();
    }
  };
}
