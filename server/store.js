import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { clampNumber, randomHex, safeParse } from './util.js';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CAMERAS_FILE = path.join(DATA_DIR, 'cameras.json');

export const DEFAULT_CONFIG = {
  httpPort: 3000,
  httpsPort: 3443,
  bind: '0.0.0.0',
  siteName: 'CamNet',
  maxCameras: 100,
  maxViewersPerCamera: 12,
  // Extra STUN/TURN servers for WebRTC. Usually not needed on a local network.
  iceServers: [],
  // OBS WebSocket connection, used to drive OBS's Virtual Camera.
  obs: {
    host: '127.0.0.1',
    port: 4455,
    password: '',
    width: 1280,
    height: 720
  },
  defaultWidth: 1280,
  defaultHeight: 720,
  defaultFps: 24,
  defaultQuality: 0.72
};

export const DEFAULT_SETTINGS = {
  width: 1280,
  height: 720,
  fps: 24,
  quality: 0.72,
  audio: false,
  mirror: false,
  rotation: 0,
  preview: false,
  facing: 'user'
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let configCache = null;

export function getConfig() {
  if (configCache) return configCache;
  ensureDataDir();
  let fileConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    fileConfig = safeParse(fs.readFileSync(CONFIG_FILE, 'utf8'), {}) ?? {};
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
  }
  configCache = { ...DEFAULT_CONFIG, ...fileConfig };
  return configCache;
}

// ---------------------------------------------------------------- cameras

let store = { version: 1, cameras: [] };
let saveTimer = null;

function normalizeCamera(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return null;
  return {
    id,
    name: String(raw.name ?? 'Camera').slice(0, 40),
    token: typeof raw.token === 'string' && raw.token.length >= 16 ? raw.token : randomHex(24),
    createdAt: Number(raw.createdAt) || Date.now(),
    lastSeen: Number(raw.lastSeen) || 0,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) }
  };
}

export function loadCameras() {
  ensureDataDir();
  if (!fs.existsSync(CAMERAS_FILE)) {
    store = { version: 1, cameras: [] };
    return store;
  }
  const parsed = safeParse(fs.readFileSync(CAMERAS_FILE, 'utf8'), null);
  const list = Array.isArray(parsed?.cameras) ? parsed.cameras : [];
  store = {
    version: 1,
    cameras: list.map(normalizeCamera).filter(Boolean)
  };
  return store;
}

export function listCameras() {
  return store.cameras;
}

export function getCamera(id) {
  return store.cameras.find((c) => c.id === id) ?? null;
}

export function createCamera(name) {
  const config = getConfig();
  if (store.cameras.length >= config.maxCameras) {
    const err = new Error('Maximum number of cameras reached.');
    err.code = 'MAX_CAMERAS';
    throw err;
  }
  const cleanName = String(name ?? '').trim().slice(0, 40) || 'Camera';

  // Generate a unique 4-digit numeric ID (1000–9999)
  let id;
  let attempts = 0;
  do {
    id = String(1000 + Math.floor(Math.random() * 9000));
    attempts++;
  } while (getCamera(id) && attempts < 200);
  if (getCamera(id)) {
    const err = new Error('Could not generate a unique camera ID. Please try again.');
    err.code = 'ID_GENERATION_FAILED';
    throw err;
  }

  const camera = {
    id,
    name: cleanName,
    token: randomHex(24),
    createdAt: Date.now(),
    lastSeen: 0,
    settings: { ...DEFAULT_SETTINGS }
  };
  store.cameras.push(camera);
  saveCameras();
  return camera;
}

export function updateCamera(id, patch) {
  const camera = getCamera(id);
  if (!camera) return null;
  if (typeof patch?.name === 'string') {
    const name = patch.name.trim().slice(0, 40);
    if (name) camera.name = name;
  }
  if (patch?.settings && typeof patch.settings === 'object') {
    const s = patch.settings;
    if (s.width !== undefined) camera.settings.width = clampNumber(s.width, 160, 3840, camera.settings.width);
    if (s.height !== undefined) camera.settings.height = clampNumber(s.height, 120, 2160, camera.settings.height);
    if (s.fps !== undefined) camera.settings.fps = clampNumber(s.fps, 5, 60, camera.settings.fps);
    if (s.quality !== undefined) camera.settings.quality = Math.min(1, Math.max(0.2, Number(s.quality) || camera.settings.quality));
    if (s.audio !== undefined) camera.settings.audio = Boolean(s.audio);
    if (s.mirror !== undefined) camera.settings.mirror = Boolean(s.mirror);
    if (s.preview !== undefined) camera.settings.preview = Boolean(s.preview);
    if (s.rotation !== undefined) {
      const rotation = Number(s.rotation);
      camera.settings.rotation = [0, 90, 180, 270].includes(rotation) ? rotation : 0;
    }
    if (s.facing === 'user' || s.facing === 'environment') camera.settings.facing = s.facing;
    if (typeof s.deviceId === 'string') camera.settings.deviceId = s.deviceId.slice(0, 200);
  }
  saveCameras();
  return camera;
}

export function deleteCamera(id) {
  const index = store.cameras.findIndex((c) => c.id === id);
  if (index === -1) return false;
  store.cameras.splice(index, 1);
  saveCameras();
  return true;
}

export function touchCamera(id) {
  const camera = getCamera(id);
  if (!camera) return;
  camera.lastSeen = Date.now();
  saveCameras();
}

export function saveCameras() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushCameras, 120);
}

export function flushCameras() {
  clearTimeout(saveTimer);
  saveTimer = null;
  ensureDataDir();
  const payload = JSON.stringify(store, null, 2) + '\n';
  const tmp = `${CAMERAS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, CAMERAS_FILE);
  } catch (err) {
    console.error('[store] cameras.json yazilamadi:', err.message);
  }
}

/** Everything that needs to be persisted has been written. */
export function flushAll() {
  flushCameras();
}
