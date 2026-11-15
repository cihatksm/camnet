/**
 * The camera this device owns.
 *
 * Kept in localStorage for the normal case, mirrored to a cookie because
 * cookies ignore the port: a phone that opens the app once over HTTPS and
 * once over HTTP still finds the same camera. The token is validated before
 * it is accepted, so stale or malformed records are ignored.
 */

import { getToken, removeToken, setToken } from './api.js';

const OWNER_KEY = 'camnet.camera';
const COOKIE_NAME = 'camnet_camera';
// One year; the camera itself also lives on the server until deleted.
const COOKIE_AGE = 60 * 60 * 24 * 365;

function readCookie() {
  try {
    const match = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`).exec(document.cookie);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function writeCookie(raw) {
  try {
    // No Secure flag on purpose: the same camera must survive switching
    // between the HTTP and HTTPS ports of the LAN address.
    document.cookie =
      `${COOKIE_NAME}=${encodeURIComponent(raw)}; Path=/; Max-Age=${COOKIE_AGE}; SameSite=Lax`;
  } catch {
    /* cookies blocked */
  }
}

function clearCookie() {
  try {
    document.cookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    /* cookies blocked */
  }
}

function parseOwner(raw) {
  if (!raw) return null;
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id ?? '').trim();
  const token = String(value.token ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/i.test(id) || token.length < 16) return null;
  return { id, token, name: String(value.name ?? '').slice(0, 40) };
}

function persist(owner) {
  const raw = JSON.stringify(owner);
  try {
    localStorage.setItem(OWNER_KEY, raw);
  } catch {
    /* storage unavailable */
  }
  writeCookie(raw);
}

export function getOwnedCamera() {
  let storedRaw = '';
  try {
    storedRaw = localStorage.getItem(OWNER_KEY) || '';
  } catch {
    /* storage unavailable */
  }
  let owner = parseOwner(storedRaw);
  if (!owner) owner = parseOwner(readCookie());
  if (!owner) return null;

  // The token map is what the rest of the app reads; rebuild it when the
  // record came from the cookie after localStorage was cleared.
  if (getToken(owner.id) !== owner.token) setToken(owner.id, owner.token);

  // Avoid rewriting storage/cookie on every poll when nothing changed.
  const raw = JSON.stringify(owner);
  if (storedRaw !== raw || readCookie() !== raw) persist(owner);
  return owner;
}

export function rememberOwnedCamera(camera) {
  const owner = parseOwner(camera);
  if (!owner) return null;
  setToken(owner.id, owner.token);
  persist(owner);
  return owner;
}

export function forgetOwnedCamera(id) {
  if (id) removeToken(id);

  let stored = null;
  try {
    stored = parseOwner(localStorage.getItem(OWNER_KEY));
  } catch {
    /* storage unavailable */
  }
  if (!id || stored?.id === id) {
    try {
      localStorage.removeItem(OWNER_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  const cookie = parseOwner(readCookie());
  if (!id || cookie?.id === id) clearCookie();
}
