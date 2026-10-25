import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT_DIR } from './paths.js';

/**
 * Virtual Camera integration using Windows Media Foundation.
 * Native AOT component in native/vcam/ directory.
 * COM registration requires admin (CamNet runs as admin).
 */

const VCAM_DIR = path.join(ROOT_DIR, 'native', 'vcam');
const COMTHUNK_DLL = path.join(VCAM_DIR, 'VCamNetSampleSourceAOT.comthunk.dll');
const NATIVE_DLL = path.join(VCAM_DIR, 'VCamNetSampleSourceAOT.dll');
const DRIVER_EXE = path.join(VCAM_DIR, 'VCamNetSampleAOT.exe');

let registered = false;
let driverProcess = null;
let currentCameraId = null;

export function vcamStatus() {
  return {
    registered,
    running: driverProcess !== null,
    cameraId: currentCameraId,
    comThunkExists: fs.existsSync(COMTHUNK_DLL),
    nativeDllExists: fs.existsSync(NATIVE_DLL),
    driverExeExists: fs.existsSync(DRIVER_EXE)
  };
}

export async function registerCom() {
  if (!fs.existsSync(COMTHUNK_DLL)) {
    throw new Error('COM thunk DLL not found: ' + COMTHUNK_DLL);
  }
  
  return new Promise((resolve, reject) => {
    const proc = spawn('regsvr32.exe', ['/s', COMTHUNK_DLL], { windowsHide: true });
    proc.on('error', (err) => reject(new Error('COM registration failed: ' + err.message)));
    proc.on('exit', (code) => {
      if (code !== 0) reject(new Error('COM registration failed with code: ' + code));
      else { registered = true; resolve(); }
    });
  });
}

export async function unregisterCom() {
  if (!fs.existsSync(COMTHUNK_DLL)) return;
  
  return new Promise((resolve) => {
    const proc = spawn('regsvr32.exe', ['/s', '/u', COMTHUNK_DLL], { windowsHide: true });
    proc.on('exit', () => { registered = false; resolve(); });
  });
}

export async function startVirtualCamera(cameraId, baseUrl) {
  if (!fs.existsSync(DRIVER_EXE)) {
    throw new Error('Driver executable not found: ' + DRIVER_EXE);
  }

  // Stop existing driver
  await stopVirtualCamera();

  const url = `${baseUrl}/c/${cameraId}.mjpeg`;
  const env = {
    ...process.env,
    CAMNET_VIRTUAL_CAM_URL: url
  };

  return new Promise((resolve, reject) => {
    try {
      const child = spawn(DRIVER_EXE, [], { 
        env, 
        windowsHide: true,
        stdio: 'ignore'
      });
      driverProcess = child;
      currentCameraId = cameraId;
      
      child.on('error', (err) => {
        driverProcess = null;
        currentCameraId = null;
        reject(new Error('Driver failed to start: ' + err.message));
      });
      
      child.on('exit', (code) => {
        driverProcess = null;
        currentCameraId = null;
        if (code !== 0 && code !== null) {
          reject(new Error('Driver exited with code: ' + code));
        }
      });
      
      setTimeout(() => resolve({ started: true, cameraId, url }), 1000);
    } catch (err) {
      reject(err);
    }
  });
}

export async function stopVirtualCamera() {
  if (driverProcess) {
    try { 
      driverProcess.kill(); 
    } catch {}
    driverProcess = null;
    currentCameraId = null;
  }
  return { stopped: true };
}
