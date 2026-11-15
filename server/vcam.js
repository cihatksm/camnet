import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT_DIR } from './paths.js';

/**
 * Windows virtual camera (Media Foundation, no OBS).
 *
 * The native Media Foundation source is registered once per machine and must
 * live in a location that the Windows Frame Server services can read. The
 * portable app extracts to a random %TEMP% folder, so the binaries are copied
 * to ProgramData before registration.
 */

const VCAM_DIR = path.join(ROOT_DIR, 'native', 'vcam');
const SOURCE_DLL = path.join(VCAM_DIR, 'VCamNetSampleSourceAOT.dll');
const SOURCE_EXE = path.join(VCAM_DIR, 'VCamNetSampleAOT.exe');

// Machine-wide, readable by LOCAL SERVICE / LOCAL SYSTEM (Frame Server).
const PUBLIC_DIR = path.join(process.env.ProgramData || 'C:\\ProgramData', 'CamNet', 'vcam');
const PUBLIC_DLL = path.join(PUBLIC_DIR, 'VCamNetSampleSourceAOT.dll');
const PUBLIC_EXE = path.join(PUBLIC_DIR, 'VCamNetSampleAOT.exe');
const ERROR_LOG = path.join(PUBLIC_DIR, 'vcam-error.log');
const URL_FILE = path.join(PUBLIC_DIR, 'url.txt');

// Must match Shared.CLSID_VCamNetAOT in the native AOT source.
const CLSID = '{570b1532-4fcb-472f-ae37-b5daf86abfd4}';
const CLSID_KEY = `HKCR\\CLSID\\${CLSID}\\InprocServer32`;
const CAMERA_INTERFACE_CLASS = '{e5323777-f976-4f5b-9b55-b94699c46e44}';

let driverProcess = null;
let currentCameraId = null;
let lastError = '';
let aclApplied = false;
let registrationCache = { at: 0, ok: false };
let deviceCache = { at: 0, present: false };

function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copyIfChanged(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`Native virtual camera file is missing: ${source}`);
  }
  const hash = fileHash(source);
  const marker = `${target}.sha256`;
  let current = '';
  try {
    current = fs.readFileSync(marker, 'utf8').trim();
  } catch {
    /* first run */
  }
  if (fs.existsSync(target) && current === hash) return;

  try {
    fs.copyFileSync(source, target);
    fs.writeFileSync(marker, hash, 'utf8');
  } catch (err) {
    // A stale running driver can lock the exe. Keep the existing copy.
    if (!fs.existsSync(target)) throw err;
  }
}

function grantReadAccess() {
  if (aclApplied) return;
  aclApplied = true;
  try {
    // Everyone (S-1-1-0) read + execute. SIDs are locale independent.
    execFileSync(
      'icacls.exe',
      [PUBLIC_DIR, '/grant', '*S-1-1-0:(OI)(CI)RX', '/T', '/C', '/Q'],
      { windowsHide: true, stdio: 'ignore' }
    );
  } catch {
    // ProgramData already inherits readable ACLs in practice; not fatal.
  }
}

/** Copies the driver next to a machine-readable path and returns its paths. */
export function prepareVirtualCameraFiles() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  copyIfChanged(SOURCE_DLL, PUBLIC_DLL);
  copyIfChanged(SOURCE_EXE, PUBLIC_EXE);
  grantReadAccess();
  return { dll: PUBLIC_DLL, exe: PUBLIC_EXE };
}

/** True when HKCR points at the ProgramData copy (and not at an old temp path). */
export function isComRegistered(force = false) {
  if (!force && Date.now() - registrationCache.at < 10000) {
    return registrationCache.ok;
  }
  let ok = false;
  try {
    const output = execFileSync('reg.exe', ['query', CLSID_KEY, '/ve'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    ok = output.toLowerCase().includes(PUBLIC_DLL.toLowerCase());
  } catch {
    ok = false;
  }
  registrationCache = { at: Date.now(), ok };
  return ok;
}

function readStartError() {
  try {
    return fs.readFileSync(ERROR_LOG, 'utf8').trim().slice(0, 800);
  } catch {
    return '';
  }
}

/** Removes a driver left behind by a crashed/previous app instance. */
function killOrphanDrivers() {
  try {
    execFileSync('taskkill.exe', ['/IM', 'VCamNetSampleAOT.exe', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
  } catch {
    /* nothing to kill */
  }
}

function isDevicePresent(force = false) {
  const maxAge = driverProcess ? 4000 : 15000;
  if (!force && Date.now() - deviceCache.at < maxAge) return deviceCache.present;

  let present = false;
  try {
    const output = execFileSync(
      'reg.exe',
      ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceClasses\\${CAMERA_INTERFACE_CLASS}`, '/s'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }
    );
    present = output.toLowerCase().includes(CLSID.toLowerCase());
  } catch {
    present = false;
  }
  deviceCache = { at: Date.now(), present };
  return present;
}

async function waitForDevice(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDevicePresent(true)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return isDevicePresent(true);
}

export function vcamStatus() {
  return {
    registered: isComRegistered(),
    running: Boolean(driverProcess),
    cameraId: currentCameraId,
    filesReady: fs.existsSync(PUBLIC_DLL) && fs.existsSync(PUBLIC_EXE),
    devicePresent: driverProcess ? isDevicePresent() : false,
    deviceName: 'CamNet Virtual Camera',
    publicDir: PUBLIC_DIR,
    error: lastError
  };
}

/**
 * Registers the Media Foundation source for all users. Must run elevated;
 * CamNet already requests administrator privileges on launch.
 */
export async function registerCom() {
  killOrphanDrivers();
  const { dll } = prepareVirtualCameraFiles();
  if (isComRegistered(true)) return vcamStatus();

  const result = spawnSync('regsvr32.exe', ['/s', dll], {
    cwd: PUBLIC_DIR,
    windowsHide: true,
    encoding: 'utf8'
  });

  if (result.error) {
    throw new Error(`COM registration failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `Windows camera registration failed (regsvr32 exit ${result.status})` +
        (detail ? `: ${detail}` : '') +
        '. Run CamNet as administrator.'
    );
  }
  if (!isComRegistered(true)) {
    throw new Error(
      'Windows did not register the camera source. Run CamNet as administrator and try again.'
    );
  }
  lastError = '';
  return vcamStatus();
}

export async function unregisterCom() {
  if (!fs.existsSync(PUBLIC_DLL)) {
    registrationCache = { at: 0, ok: false };
    return vcamStatus();
  }
  spawnSync('regsvr32.exe', ['/s', '/u', PUBLIC_DLL], {
    cwd: PUBLIC_DIR,
    windowsHide: true
  });
  registrationCache = { at: 0, ok: false };
  return vcamStatus();
}

export async function startVirtualCamera(cameraId, baseUrl) {
  if (!cameraId) throw new Error('Select a camera first.');

  prepareVirtualCameraFiles();
  if (!isComRegistered(true)) {
    try {
      await registerCom();
    } catch (err) {
      throw new Error(`Windows camera is not registered. ${err.message}`);
    }
  }

  await stopVirtualCamera();
  lastError = '';
  try {
    fs.unlinkSync(ERROR_LOG);
  } catch {
    /* no previous error */
  }

  const url = `${baseUrl}/c/${cameraId}.mjpeg`;
  try {
    // The media source runs inside Frame Server, so pass the URL through a
    // file it can read (environment variables of this process are not inherited).
    fs.writeFileSync(URL_FILE, url, 'utf8');
  } catch (err) {
    throw new Error(`Could not write the virtual camera URL: ${err.message}`);
  }

  const child = spawn(PUBLIC_EXE, [], {
    cwd: PUBLIC_DIR,
    env: { ...process.env, CAMNET_VIRTUAL_CAM_URL: url },
    windowsHide: true,
    stdio: 'ignore'
  });

  driverProcess = child;
  currentCameraId = cameraId;

  child.on('error', (err) => {
    lastError = `Could not start the Windows camera driver: ${err.message}`;
    if (driverProcess === child) {
      driverProcess = null;
      currentCameraId = null;
    }
  });

  child.on('exit', (code) => {
    if (driverProcess === child) {
      driverProcess = null;
      currentCameraId = null;
    }
    if (code && code !== 0) {
      lastError = readStartError() || `Windows camera driver stopped with code ${code}.`;
    }
  });

  // Give the driver a moment to call MFCreateVirtualCamera + Start.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (!driverProcess) {
    throw new Error(
      readStartError() || 'The Windows camera driver exited before the camera was ready.'
    );
  }

  const present = await waitForDevice(6000);
  if (!present) {
    lastError =
      'The driver is running, but Windows has not listed the camera yet. Check Settings → Bluetooth & devices → Cameras.';
  } else {
    lastError = '';
  }

  return {
    started: true,
    cameraId,
    url,
    registered: isComRegistered(),
    devicePresent: present
  };
}

export async function stopVirtualCamera() {
  const child = driverProcess;
  driverProcess = null;
  currentCameraId = null;
  lastError = '';
  deviceCache = { at: 0, present: false };

  if (child && child.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  try {
    fs.unlinkSync(URL_FILE);
  } catch {
    /* no URL file */
  }

  return { stopped: true };
}

// Never leave an orphaned virtual camera driver behind.
process.on('exit', () => {
  try {
    driverProcess?.kill();
  } catch {
    /* ignore */
  }
});
