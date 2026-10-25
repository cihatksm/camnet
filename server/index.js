import { startServer } from './server.js';
import { listCameras } from './store.js';

try {
  const server = await startServer();

  const ips = server.ips;
  const lan = server.lan;
  const line = '-'.repeat(60);

  console.log(`\n+${line}+`);
  console.log(`  ${server.config.siteName} ready`);
  console.log(`+${line}+`);
  console.log(`  This computer      : http://localhost:${server.config.httpPort}`);
  if (ips.length) console.log(`  Devices on your LAN: http://${lan}:${server.config.httpPort}`);
  if (server.httpsServer) {
    console.log(`  Camera sharing     : https://${lan}:${server.config.httpsPort}`);
    console.log('  (self-signed certificate: choose "Advanced > Proceed" in your browser)');
  }
  console.log('');
  console.log(`  OBS Browser Source : http://${lan}:${server.config.httpPort}/c/<camera-id>`);
  console.log(`  OBS Media / VLC    : http://${lan}:${server.config.httpPort}/c/<camera-id>.mjpeg`);
  console.log('');
  console.log(`  Registered cameras: ${listCameras().length}   |   Data: data/cameras.json`);
  console.log('  Press Ctrl+C to stop\n');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  console.error(`\n[ERROR] Could not start the server: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error('Port already in use. Change it in data/config.json.');
  }
  process.exit(1);
}
