// Generates simple French-tricolore PWA icons (no external deps) at the sizes
// iOS + Android need. Run: node build/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'icons'), { recursive: true });

// CRC32 (PNG)
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(size) {
  const W = size, H = size;
  const bg = [11, 16, 32], top2 = [26, 37, 76];
  const white = [238, 242, 255], blue = [0, 85, 164], red = [239, 65, 53];
  const raw = Buffer.alloc(H * (W * 3 + 1));
  const cx = 0.5, top = 0.12, base = 0.86, plat1 = 0.55, plat2 = 0.34;
  for (let y = 0; y < H; y++) {
    let o = y * (W * 3 + 1); raw[o++] = 0; // filter: none
    const ny = y / H;
    for (let x = 0; x < W; x++) {
      const nx = x / W;
      // vertical bg gradient (a touch lighter at the top)
      const g = Math.max(0, 1 - ny * 1.6);
      let col = [
        Math.round(bg[0] + (top2[0] - bg[0]) * g),
        Math.round(bg[1] + (top2[1] - bg[1]) * g),
        Math.round(bg[2] + (top2[2] - bg[2]) * g),
      ];
      // small tricolore ground stripe
      if (ny >= 0.885 && ny <= 0.95 && nx >= 0.16 && nx <= 0.84) {
        const w = 0.68;
        col = nx < 0.16 + w / 3 ? blue : nx < 0.16 + (2 * w) / 3 ? white : red;
      }
      // Eiffel Tower silhouette (hollow legs + platform bars + solid spire)
      if (ny >= top && ny <= base) {
        const t = (ny - top) / (base - top);
        const dx = Math.abs(nx - cx);
        const outer = 0.045 + 0.32 * Math.pow(t, 2.3);
        const band = 0.028 + 0.06 * t;
        const solidSpire = ny < 0.28;
        const nearPlat = Math.abs(ny - plat1) < 0.02 || Math.abs(ny - plat2) < 0.016;
        const archBar = Math.abs(ny - 0.60) < 0.014;
        if (dx <= outer && (solidSpire || nearPlat || archBar || dx >= outer - band)) col = white;
      }
      raw[o++] = col[0]; raw[o++] = col[1]; raw[o++] = col[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, RGB
  const idat = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [180, 192, 512]) {
  writeFileSync(join(ROOT, 'icons', `icon-${s}.png`), png(s));
  console.log(`✅ icons/icon-${s}.png`);
}
