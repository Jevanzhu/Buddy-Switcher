'use strict';

// 生成 build/icon.png（512×512）。无第三方依赖，便于随时重出图标。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const SS = 4;

function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function capsule(px, py, x1, y1, x2, y2, r) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy)) <= r;
}

function triangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const BONE = [244, 241, 232];
const SIGNAL = [255, 107, 53];

function sample(x, y) {
  const d = sdRoundRect(x, y, 16, 16, 480, 480, 112);
  if (d > 0) return null;

  const t = Math.min(1, Math.max(0, (x + y) / (SIZE * 2)));
  let r = 38 + (10 - 38) * t;
  let g = 38 + (10 - 38) * t;
  let b = 31 + (8 - 31) * t;

  const glow = Math.max(0, 1 - Math.hypot(x - 150, y - 118) / 340) * 0.12;
  r += (255 - r) * glow;
  g += (255 - g) * glow;
  b += (255 - b) * glow;

  if (d > -3) {
    r += (255 - r) * 0.1;
    g += (255 - g) * 0.1;
    b += (255 - b) * 0.1;
  }

  const topArrow =
    capsule(x, y, 152, 198, 306, 198, 16) ||
    triangle(x, y, 306, 166, 306, 230, 374, 198);
  if (topArrow) return BONE;

  const bottomArrow =
    capsule(x, y, 206, 314, 360, 314, 16) ||
    triangle(x, y, 206, 282, 206, 346, 138, 314);
  if (bottomArrow) return SIGNAL;

  return [r, g, b];
}

function render() {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let offset = 0;

  for (let y = 0; y < SIZE; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < SIZE; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let covered = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (!c) continue;
          sr += c[0];
          sg += c[1];
          sb += c[2];
          covered++;
        }
      }

      const total = SS * SS;
      if (!covered) {
        raw[offset++] = 0;
        raw[offset++] = 0;
        raw[offset++] = 0;
        raw[offset++] = 0;
      } else {
        raw[offset++] = Math.round(sr / covered);
        raw[offset++] = Math.round(sg / covered);
        raw[offset++] = Math.round(sb / covered);
        raw[offset++] = Math.round((covered / total) * 255);
      }
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(raw) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon.png');
fs.writeFileSync(outFile, png(render()));
console.log('icon written:', outFile);
