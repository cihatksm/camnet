const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const { execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

let server = null;
let win = null;
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
 *
 * Blocks until the UAC prompt is answered: on "Yes" the elevated process starts
 * and we exit this instance; on "No" (or any elevation failure) we show a clear
 * error and exit instead of silently closing.
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
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 120000 }
    );
    // The elevated instance is starting; close this unprivileged one.
    process.exit(0);
  } catch {
    dialog.showErrorBox(
      'CamNet — administrator privileges required',
      'CamNet needs administrator privileges to open the firewall ports so phones on your network can reach it.\n\nPlease run the app again and choose "Yes" when Windows asks for permission.'
    );
    process.exit(1);
  }
}

if (!isAdmin()) {
  relaunchElevated();
}

function dataDir() {
  if (process.env.CAMNET_DATA_DIR) return process.env.CAMNET_DATA_DIR;
  // Always store data in the user's profile folder (~/.camnet) so that
  // the portable .exe does not create a "data" folder next to itself.
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.camnet');
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

/**
 * Checks whether the Windows Firewall rule for CamNet currently exists and is enabled.
 */
function checkFirewallRule(ports) {
  const script =
    "$name='CamNet'; " +
    "$rule=Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue; " +
    'if($rule){ @{Exists=$true; Enabled=$rule.Enabled; Profile=$rule.Profile} | ConvertTo-Json } else { @{Exists=$false} | ConvertTo-Json }';
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    );
    return JSON.parse(output.trim());
  } catch {
    return { Exists: false };
  }
}

/**
 * Removes the Windows Firewall rule for CamNet.
 */
function removeFirewallRule() {
  const script = "Remove-NetFirewallRule -DisplayName 'CamNet' -ErrorAction SilentlyContinue";
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000 },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 580,
    height: 800,
    minWidth: 480,
    minHeight: 660,
    resizable: true,
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

  // Forward publisher events to the renderer for live notifications
  if (server?.events) {
    server.events.on('publisher-online', (info) => {
      if (win && !win.isDestroyed()) win.webContents.send('publisher-online', info);
    });
    server.events.on('publisher-offline', (info) => {
      if (win && !win.isDestroyed()) win.webContents.send('publisher-offline', info);
    });
  }

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

  ipcMain.handle('get-permissions', () => {
    if (!server) return null;
    const ports = [server.httpPort, server.httpsPort].filter((port) => Number(port) > 0).join(',');
    const firewall = checkFirewallRule(ports);
    return {
      firewall,
      dataDir: dataDir(),
      httpPort: server.httpPort,
      httpsPort: server.httpsPort,
      ports
    };
  });

  ipcMain.handle('get-cameras', async () => {
    if (!server) return [];
    const { listCameras } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'store.js')).href);
    const { publicCamera } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'state.js')).href);
    return listCameras().map((c) => publicCamera(c));
  });

  ipcMain.handle('delete-camera', async (_event, cameraId) => {
    if (!server) return false;
    const { deleteCamera } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'store.js')).href);
    const { dropRuntime } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'state.js')).href);
    const ok = deleteCamera(cameraId);
    if (ok) dropRuntime(cameraId);
    return ok;
  });

  ipcMain.handle('remove-firewall-rule', async () => {
    await removeFirewallRule();
    return true;
  });

  ipcMain.handle('add-firewall-rule', () => {
    if (!server) return false;
    const ports = [server.httpPort, server.httpsPort].filter((port) => Number(port) > 0).join(',');
    applyFirewall(ports);
    return true;
  });

  ipcMain.handle('get-data-dir', () => dataDir());

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

  const mainWin = createWindow();
  mainWin.webContents.on('did-finish-load', () => {
    if (startError) {
      mainWin.webContents.send('start-error', startError.message || String(startError));
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
