const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

let server = null;
let quitting = false;

function dataDir() {
  if (process.env.CAMNET_DATA_DIR) return process.env.CAMNET_DATA_DIR;
  // electron-builder's portable target extracts to a temp folder; this env var
  // points at the folder containing the original portable .exe.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
  }
  return path.join(app.getPath('userData'), 'data');
}

async function startBackend() {
  process.env.CAMNET_DATA_DIR = dataDir();
  const serverModule = await import(
    pathToFileURL(path.join(__dirname, '..', 'server', 'server.js')).href
  );
  server = await serverModule.startServer();
  return server;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 660,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'CamNet',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

ipcMain.handle('get-info', () => {
  if (!server) return null;
  return {
    siteName: server.config.siteName,
    localUrl: server.urls.local,
    httpUrl: server.urls.http,
    httpsUrl: server.urls.https,
    lan: server.lan,
    httpPort: server.httpPort,
    httpsPort: server.httpsPort
  };
});

ipcMain.on('open-browser', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.on('quit', () => app.quit());

app.whenReady().then(async () => {
  let startError = null;
  try {
    await startBackend();
  } catch (err) {
    startError = err;
    console.error('Failed to start the server:', err);
  }

  const win = createWindow();
  win.webContents.on('did-finish-load', () => {
    if (startError) {
      win.webContents.send('start-error', startError.message || String(startError));
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  if (!server) return;
  event.preventDefault();
  quitting = true;
  server
    .close()
    .catch(() => {})
    .finally(() => app.exit(0));
});
