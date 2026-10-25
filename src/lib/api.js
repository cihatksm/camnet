const TOKEN_KEY = 'camnet.tokens';

export async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const error = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

function readTokens() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TOKEN_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeTokens(tokens) {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  } catch {
    /* gizli mod vb. */
  }
}

export function getToken(id) {
  return readTokens()[id] ?? null;
}

export function setToken(id, token) {
  const tokens = readTokens();
  tokens[id] = token;
  writeTokens(tokens);
}

export function removeToken(id) {
  const tokens = readTokens();
  delete tokens[id];
  writeTokens(tokens);
}

export function listOwnedIds() {
  return Object.keys(readTokens());
}

export function snapshotUrl(id, ts) {
  return `/api/cameras/${encodeURIComponent(id)}/snapshot.jpg?v=${ts || 0}`;
}
