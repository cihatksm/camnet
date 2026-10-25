import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { DATA_DIR } from './paths.js';
import { getLanIps } from './util.js';

const CERT_DIR = path.join(DATA_DIR, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');

/**
 * getUserMedia on phones only works in a secure context (HTTPS).
 * On first run, generates a self-signed certificate covering the local IPs.
 */
export function ensureCerts() {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
    return {
      key: fs.readFileSync(KEY_FILE),
      cert: fs.readFileSync(CERT_FILE),
      created: false
    };
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });

  const ips = getLanIps();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip }))
  ];

  const pems = selfsigned.generate([{ name: 'commonName', value: 'CamNet Local' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames }
    ]
  });

  fs.writeFileSync(KEY_FILE, pems.private, 'utf8');
  fs.writeFileSync(CERT_FILE, pems.cert, 'utf8');

  return { key: pems.private, cert: pems.cert, created: true };
}
