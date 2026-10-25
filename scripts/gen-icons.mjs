// Generates the PNG app icons used by the PWA manifest and iOS.
// No external dependencies; uses the built-in zlib for PNG encoding.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(here, '..', 'public', 'icons');

const BG = [13, 18, 25, 255]; // #0d1219
const GREEN = [61, 220, 151, 255]; // #3ddc97
const CYAN = [56, 189, 248, 255]; // #38bdf8
const LENS = [11, 16, 23, 255]; // #0b1017

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function inRoundedRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.max(x0 + r, Math.min(px, x1 - r));
  const cy = Math.max(y0 + r, Math.min(py, y1 - r));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(px, py, cx, cy, r) {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// Draws the icon into an RGBA buffer. `maskable` produces a full-bleed
// background with the artwork inside the safe zone.
function draw(size, maskable) {
  const S = size;
  const buf = Buffer.alloc(size * size * 4);

  const scale = maskable ? 0.72 : 1.0;
  const ox = (S * (1 - scale)) / 2; // centering offset
  const oy = ox;

  const s = (v) => ox + v * scale * S;

  const body = {
    x0: s(0.16),
    y0: s(0.30),
    x1: s(0.58),
    y1: s(0.70),
    r: s(0.08)
  };
  const housing = {
    x0: s(0.56),
    y0: s(0.36),
    x1: s(0.86),
    y1: s(0.64),
    r: s(0.08)
  };
  const lens = { cx: s(0.37), cy: s(0.50), r: s(0.10) };

  const bgRadius = maskable ? 0 : s(0.22);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let color = null;

      if (maskable) {
        color = BG;
      } else if (inRoundedRect(px, py, 0, 0, S, S, bgRadius)) {
        color = BG;
      }

      if (color) {
        if (inCircle(px, py, lens.cx, lens.cy, lens.r)) {
          color = LENS;
        } else if (inRoundedRect(px, py, housing.x0, housing.y0, housing.x1, housing.y1, housing.r)) {
          color = CYAN;
        } else if (inRoundedRect(px, py, body.x0, body.y0, body.x1, body.y1, body.r)) {
          color = GREEN;
        }
        const idx = (y * S + x) * 4;
        buf[idx] = color[0];
        buf[idx + 1] = color[1];
        buf[idx + 2] = color[2];
        buf[idx + 3] = color[3];
      }
      // otherwise leave transparent (alpha 0)
    }
  }
  return encodePNG(size, size, buf);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-180.png', 180, false],
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true]
];

for (const [name, size, maskable] of targets) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, draw(size, maskable));
  console.log(`wrote ${file}`);
}
