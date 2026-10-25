import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Runs both the backend (API + WebSocket) and the Vite dev server together,
// so `npm run dev` works as a complete app with a single command.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(here, '..', 'server', 'index.js');
const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

const server = spawn(process.execPath, [serverFile], { stdio: 'inherit' });
const web = spawn(process.execPath, [viteBin], { stdio: 'inherit' });

const children = [server, web];
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

server.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[server] exited with code ${code}. Stopping...`);
    shutdown();
  }
});

web.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[web] exited with code ${code}. Stopping...`);
    shutdown();
  }
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
