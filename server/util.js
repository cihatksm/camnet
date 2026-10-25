import crypto from 'node:crypto';
import os from 'node:os';

const TR_MAP = {
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u',
  â: 'a', Â: 'a', î: 'i', Î: 'i', û: 'u', Û: 'u'
};

/** Produces a safe, URL-friendly identifier fragment. */
export function slugify(value, max = 26) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[çÇğĞıİöÖşŞüÜâÂîÎûÛ]/g, (ch) => TR_MAP[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

export function randomHex(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function isPrivateIp(ip) {
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/** All IPv4 addresses on this machine, with real LAN addresses first. */
export function getLanIps() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      found.push({ ip: entry.address, name });
    }
  }
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    if (ip.startsWith('100.')) return 5; // tailscale etc.
    return 3;
  };
  return [...new Set(found)]
    .sort((a, b) => score(a.ip) - score(b.ip))
    .map((x) => x.ip);
}

export function primaryIp() {
  return getLanIps()[0] || '127.0.0.1';
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function safeParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
