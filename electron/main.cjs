const { app, BrowserWindow, shell, ipcMain } = require('electron');
const { spawn, execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let server = null;
let quitting = false;

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

function isAdmin() {
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    );
    return output.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

/**
 * The app must run as administrator: it needs to open the firewall ports so
 * phones on the LAN can reach it. If it was started normally, relaunch the
 * same executable elevated via UAC and exit this instance.
 */
function relaunchElevated() {
  const packaged = app.isPackaged;
  const target = packaged
    ? process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
    : process.execPath;
  const args = packaged ? [] : process.argv.slice(1);

  const argList = args.length
    ? ` -ArgumentList @(${args.map((arg) => `'${psQuote(arg)}'`).join(',')})`
    : '';
  const script =
    `Start-Process -FilePath '${psQuote(target)}'` +
    ` -WorkingDirectory '${psQuote(process.cwd())}'` +
    argList +
    ' -Verb RunAs';

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.unref();
  } catch (err) {
    console.error('Could not request administrator privileges:', err);
  }
  process.exit(0);
}

if (!isAdmin()) {
  relaunchElevated();
}

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

/**
 * Ensures the Windows Firewall rule allows the configured ports on every
 * network profile (Domain, Private and Public). Runs elevated, so no UAC.
 */
function applyFirewall(ports) {
  if (!ports) return;
  const script =
    "$name='CamNet'; " +
    "$rule=Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue; " +
    'if($rule){ ' +
    'Set-NetFirewallRule -DisplayName $name -Profile Any -Enabled True -Action Allow -ErrorAction SilentlyContinue ' +
    '} else { ' +
    `New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${ports} -Profile Any -ErrorAction SilentlyContinue | Out-Null ` +
    '}';

  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 20000 },
    (err) => {
      if (err) console.error('[firewall] could not apply rule:', err.message);
      else console.log('[firewall] CamNet is allowed on all network profiles');
    }
  );
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

  if (server) {
    const ports = [server.httpPort, server.httpsPort]
      .filter((port) => Number(port) > 0)
      .join(',');
    applyFirewall(ports);
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
