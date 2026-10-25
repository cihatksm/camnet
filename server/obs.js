import OBSWebSocket from 'obs-websocket-js';
import { getCamera, getConfig } from './store.js';

/**
 * OBS WebSocket integration.
 *
 * The app does not ship a virtual-camera driver (that would require a native
 * DirectShow/Media Foundation component). Instead it drives OBS's own Virtual
 * Camera through its WebSocket API: create a Browser Source pointing at the
 * camera, then start or stop OBS's virtual camera output.
 */

const DEFAULT_OBS = {
  host: '127.0.0.1',
  port: 4455,
  password: '',
  width: 1280,
  height: 720
};

let client = null;
let connected = false;
let connecting = null;
let lastError = '';

function obsConfig() {
  const config = getConfig();
  const obs = config.obs ?? {};
  return {
    ...DEFAULT_OBS,
    ...obs,
    port: Number(obs.port) || DEFAULT_OBS.port,
    width: Number(obs.width) || DEFAULT_OBS.width,
    height: Number(obs.height) || DEFAULT_OBS.height
  };
}

function address(cfg) {
  return `ws://${cfg.host}:${cfg.port}`;
}

export function obsStatus() {
  const cfg = obsConfig();
  return {
    connected,
    host: cfg.host,
    port: cfg.port,
    passwordSet: Boolean(cfg.password),
    lastError
  };
}

function connectionError(cfg, detail) {
  const err = new Error(
    `Could not reach OBS at ${address(cfg)}. Is OBS open and is the WebSocket server enabled?` +
      (detail ? ` (${detail})` : '')
  );
  err.code = 'OBS_CONNECT_FAILED';
  return err;
}

async function getClient() {
  if (client && connected) return client;
  if (connecting) return connecting;

  const cfg = obsConfig();
  connecting = (async () => {
    const ws = new OBSWebSocket();
    ws.on('ConnectionClosed', () => {
      if (client === ws) {
        client = null;
        connected = false;
      }
    });
    ws.on('ConnectionError', (err) => {
      lastError = err?.message || 'Connection error';
    });

    try {
      if (cfg.password) await ws.connect(address(cfg), cfg.password);
      else await ws.connect(address(cfg));
      client = ws;
      connected = true;
      lastError = '';
      return ws;
    } catch (err) {
      client = null;
      connected = false;
      lastError = err?.message || String(err);
      throw connectionError(cfg, lastError);
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

async function currentScene(ws) {
  try {
    const { currentProgramSceneName } = await ws.call('GetCurrentProgramScene');
    if (currentProgramSceneName) return currentProgramSceneName;
  } catch {
    /* fall through to the scene list */
  }
  const { scenes } = await ws.call('GetSceneList');
  return scenes?.[0]?.sceneName ?? null;
}

/**
 * Creates (or updates) a Browser Source for the camera and starts OBS's
 * Virtual Camera. Returns details the UI can show.
 */
export async function startVirtualCamera(cameraId, baseUrl) {
  const camera = getCamera(cameraId);
  if (!camera) {
    const err = new Error('Camera not found.');
    err.code = 'CAMERA_NOT_FOUND';
    throw err;
  }

  const cfg = obsConfig();
  const ws = await getClient();

  const sceneName = await currentScene(ws);
  if (!sceneName) {
    const err = new Error('OBS has no scene to add the camera to.');
    err.code = 'OBS_NO_SCENE';
    throw err;
  }

  const url = `${baseUrl.replace(/\/$/, '')}/c/${camera.id}`;
  const inputName = `CamNet ${camera.name || camera.id}`;
  const inputSettings = {
    url,
    width: cfg.width,
    height: cfg.height,
    shutdown: false,
    reroute_audio: false
  };

  let exists = false;
  try {
    const { inputs } = await ws.call('GetInputList');
    exists = inputs.some((input) => input.inputName === inputName);
  } catch {
    /* if listing fails, try creating and fall back to updating */
  }

  if (exists) {
    await ws.call('SetInputSettings', { inputName, inputSettings, overlay: true });
  } else {
    try {
      await ws.call('CreateInput', {
        sceneName,
        inputName,
        inputKind: 'browser_source',
        inputSettings,
        sceneItemEnabled: true
      });
    } catch {
      // The input may already exist in another scene; updating is safe.
      await ws.call('SetInputSettings', { inputName, inputSettings, overlay: true });
    }
  }

  await ws.call('StartVirtualCam');
  return { started: true, sceneName, inputName, url };
}

export async function stopVirtualCamera() {
  const ws = await getClient();
  try {
    await ws.call('StopVirtualCam');
  } catch {
    /* already stopped */
  }
  return { stopped: true };
}

export async function virtualCameraStatus() {
  const cfg = obsConfig();
  try {
    const ws = await getClient();
    const { outputActive } = await ws.call('GetVirtualCamStatus');
    return { connected: true, active: Boolean(outputActive), host: cfg.host, port: cfg.port };
  } catch (err) {
    return {
      connected: false,
      active: false,
      host: cfg.host,
      port: cfg.port,
      error: err?.message || String(err)
    };
  }
}

export async function disconnectObs() {
  if (!client) return;
  try {
    await client.disconnect();
  } catch {
    /* ignore */
  }
  client = null;
  connected = false;
}
