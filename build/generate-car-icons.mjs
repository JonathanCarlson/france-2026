// Generates the Mach-E PWA/favicon icons for Kate's car page (cars.html).
// Dependency-free PNG writer, same approach as build/generate-icons.mjs.
//
// ⚠️ Writes icons/car-icon-*.png ONLY. The plain icons/icon-*.png files are the
// France trip app's Eiffel Tower icons and are shared by index.html — never
// overwrite them here.
//
// Run: node build/generate-car-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'icons'), { recursive: true });

// ---------- PNG plumbing (CRC32 + chunks) ----------
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
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// ---------- palette (matches styles.css) ----------
const BG = [11, 16, 32];        // --bg
const BG_TOP = [26, 37, 76];    // lighter top of the gradient
const BODY = [238, 242, 255];   // --text, the car's paint
const CLAD = [72, 87, 126];      // black lower cladding + arch surrounds
const GLASS = [27, 36, 64];     // --card, window cutout
const TIRE = [9, 12, 24];       // near-black rubber
const RIM = [200, 212, 240];    // light alloy
const HUB = [46, 58, 96];       // rim centre
const ACCENT = [110, 168, 254]; // --accent, the road line

// ---------- Mustang Mach-E side profile, facing right ----------
// Normalized 0..1 coordinates, laid out from the real car's proportions so it
// reads as a Mach-E crossover rather than a generic hatchback or a sports coupe:
//   • wheelbase ≈ 0.62 of overall length (2.98 m / 4.71 m) — a long stance
//   • height ≈ 0.42 of length (stylized up from the true 0.34 so the crossover
//     stance still reads at favicon size; a lower body looks like a coupe)
//   • crossover ride height — a visible gap between the rocker and the road
//   • tall greenhouse (~43% of height) pushed rearward behind a long hood, with
//     a hard-raked windshield and a fastback running into a spoiler lip
// Y_SHIFT centres the finished drawing (roof → road line) in the tile.
const Y_SHIFT = -0.073;
const P = (x, y) => [x, y + Y_SHIFT];

const BODY_POLY = [
  P(0.075, 0.685), // rocker, rear
  P(0.058, 0.630), // rear fascia
  P(0.060, 0.507), // tail lamp bar — sits high, and the rear face is
  P(0.078, 0.455), //   near-vertical; a low tapering tail reads as a coupe
  P(0.150, 0.421), // roof spoiler → fastback backlight
  P(0.250, 0.388),
  P(0.330, 0.368), // roof, rear
  P(0.560, 0.361), // roof, front — a long flat roof, not a bubble
  P(0.645, 0.420), // A-pillar
  P(0.706, 0.496), // cowl / windshield base — just behind the front axle
  P(0.820, 0.503), // long, FLAT, high hood; sloping it down reads as a sports car
  P(0.900, 0.514),
  P(0.934, 0.548), // nose — blunt and tall, EV-style
  P(0.946, 0.596), // front fascia
  P(0.940, 0.648),
  P(0.918, 0.685), // front air dam, tucked under
];

// Greenhouse — one bold cutout reads better than separate panes at 180px.
// A raked C-pillar plus a flat beltline; the rear edge stops well ahead of the
// spoiler so a thick C-pillar remains, which is what makes a fastback read.
// The band is deliberately shallow (~1/3 of body height): the Mach-E has a high
// beltline with a lot of sheet metal below it.
const GLASS_POLY = [
  P(0.278, 0.494),
  P(0.352, 0.392),
  P(0.440, 0.382),
  P(0.556, 0.376),
  P(0.634, 0.430),
  P(0.688, 0.494),
];

// A dark headlight slash gives the nose direction at a glance. Kept clear of
// the front arch cladding so it reads as a lamp, not a smudge.
const LAMP_POLY = [
  P(0.878, 0.524),
  P(0.930, 0.550),
  P(0.924, 0.566),
  P(0.872, 0.541),
];

const WHEELS = [P(0.225, 0.649), P(0.780, 0.649)];
const TIRE_R = 0.086;
const ARCH_R = 0.107;  // > TIRE_R so the arches read as gaps, like a real car
const CLAD_R = 0.133;  // thick black arch surround — a Mach-E signature
const CLAD_Y = P(0, 0.638)[1]; // top of the black rocker cladding
const RIM_R = 0.049;
const HUB_R = 0.017;
const ROAD_Y = 0.649 + TIRE_R + Y_SHIFT; // exactly where the tires meet tarmac

function inPoly(pt, poly) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const dist = (x, y, c) => Math.hypot(x - c[0], y - c[1]);

/** Colour of the car artwork at (nx, ny), or null where the background shows. */
function carColorAt(nx, ny) {
  for (const w of WHEELS) {
    const d = dist(nx, ny, w);
    if (d <= TIRE_R) {
      if (d <= HUB_R) return HUB;
      if (d <= RIM_R) return RIM;
      return TIRE;
    }
  }
  if (inPoly([nx, ny], BODY_POLY)) {
    // Punch the wheel arches out of the body.
    for (const w of WHEELS) if (dist(nx, ny, w) <= ARCH_R) return null;
    if (inPoly([nx, ny], GLASS_POLY)) return GLASS;
    if (inPoly([nx, ny], LAMP_POLY)) return GLASS;
    // Black cladding: the rocker band plus a thick surround on each arch.
    if (ny >= CLAD_Y) return CLAD;
    for (const w of WHEELS) if (dist(nx, ny, w) <= CLAD_R) return CLAD;
    return BODY;
  }
  // Road line under the car.
  if (ny >= ROAD_Y + 0.026 && ny <= ROAD_Y + 0.050 && nx >= 0.10 && nx <= 0.90) return ACCENT;
  return null;
}

function bgColorAt(ny) {
  const g = Math.max(0, 1 - ny * 1.6);
  return [
    Math.round(BG[0] + (BG_TOP[0] - BG[0]) * g),
    Math.round(BG[1] + (BG_TOP[1] - BG[1]) * g),
    Math.round(BG[2] + (BG_TOP[2] - BG[2]) * g),
  ];
}

// 4x4 supersampling — without it the curved roofline and tires alias badly at 180px.
const SS = 4;

function png(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    let o = y * (size * 3 + 1);
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size;
          const ny = (y + (sy + 0.5) / SS) / size;
          const col = carColorAt(nx, ny) || bgColorAt(ny);
          r += col[0]; g += col[1]; b += col[2];
        }
      }
      const n = SS * SS;
      raw[o++] = Math.round(r / n);
      raw[o++] = Math.round(g / n);
      raw[o++] = Math.round(b / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, RGB
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of [180, 192, 512]) {
  writeFileSync(join(ROOT, 'icons', `car-icon-${s}.png`), png(s));
  console.log(`✅ icons/car-icon-${s}.png`);
}
