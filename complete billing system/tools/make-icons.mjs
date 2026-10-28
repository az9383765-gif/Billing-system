// Generates the PWA icons (no image libraries — a tiny PNG encoder + pixel
// drawing of the MartBill receipt mark on the brand gradient).
// Run: node tools/make-icons.mjs   → writes public/icon-*.png etc.
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');

// ---------- minimal PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- drawing ----------
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
// rounded-rect signed distance (negative inside)
const rrect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

const BLUE = [0x3b, 0x82, 0xf6];
const VIOLET = [0x8b, 0x5c, 0xf6];

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size;
  const put = (i, r, g, b, a) => {
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const mix = t => [
    Math.round(BLUE[0] + (VIOLET[0] - BLUE[0]) * t),
    Math.round(BLUE[1] + (VIOLET[1] - BLUE[1]) * t),
    Math.round(BLUE[2] + (VIOLET[2] - BLUE[2]) * t)
  ];

  // geometry (in px units)
  const margin = s * 0.045;
  const hw = s / 2 - margin;
  const rr = hw * 0.44;                     // squircle-ish corners
  const recHW = s * 0.20;                   // receipt half width
  const recHH = s * 0.265;                  // receipt half height
  const recCY = s * 0.475;                  // receipt centre y
  const teeth = 7;                          // zigzag bottom edge
  const toothH = s * 0.022;
  const lineH = Math.max(1.5, s * 0.026);   // printed lines
  const lineW = recHW * 0.62;
  const lineYs = [0.34, 0.47, 0.60].map(f => recCY - recHH + recHH * 2 * f);

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const d = rrect(x + 0.5, y + 0.5, s / 2, s / 2, hw, hw, rr);
      const cover = 1 - smooth(-1, 1, d);   // anti-aliased edge
      if (cover <= 0) { put(i, 0, 0, 0, 0); continue; }

      const grad = mix((x + y) / (2 * s));
      let r = grad[0], g = grad[1], b = grad[2];

      // receipt body
      const rx = x + 0.5, ry = y + 0.5;
      const insideX = Math.abs(rx - s / 2) <= recHW;
      const top = recCY - recHH;
      const zig = ((rx - (s / 2 - recHW)) / (2 * recHW)) * teeth;   // 0..teeth
      const tri = Math.abs((zig % 1) - 0.5) * 2;                     // 0..1..0
      const bottom = recCY + recHH - toothH * (1 - tri);
      const inReceipt = insideX && ry >= top && ry <= bottom;
      if (inReceipt) {
        // printed lines stay gradient-coloured
        const isLine = lineYs.some(ly => Math.abs(ry - ly) <= lineH / 2 && Math.abs(rx - s / 2) <= lineW);
        if (!isLine) { r = 255; g = 255; b = 255; }
      }
      put(i, r, g, b, Math.round(cover * 255));
    }
  }
  return encodePNG(s, s, px);
}

fs.mkdirSync(OUT, { recursive: true });
const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
  ['favicon.png', 32]
];
for (const [name, size] of targets) {
  fs.writeFileSync(path.join(OUT, name), drawIcon(size));
  console.log('wrote public/' + name, size + 'px');
}
