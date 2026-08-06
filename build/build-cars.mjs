// build-cars.mjs — build a STANDALONE, Kate-shareable car-browser bundle.
//
// This mirrors build-album.mjs: it encrypts build/cars.json into a single
// encrypted blob (data/cars.enc.json) with an INDEPENDENT "car key" so the link
// you text Kate grants access to ONLY the car list — never the itinerary,
// tickets, or contacts, and it never reveals the family passphrase.
//
// The car key is ALSO the obfuscation token: it lives in the URL fragment
//   https://.../cars.html#k=<carKey>
// (the #fragment is never sent to the server, so the key stays client-side).
//
// Output (committed, ciphertext only):
//   data/cars.enc.json   — encrypted { v, kdf, salt, iv, ct } payload of cars.json
//
// The car key is persisted to build/cars-key.txt (GITIGNORED) so the shared URL
// stays STABLE across republishes.
//
// Usage (PowerShell), from the repo root:
//   node build/build-cars.mjs            # reuse/create the car key, print the URL
//   node build/build-cars.mjs --rotate   # generate a BRAND-NEW key (old links die)
//   $env:TRIP_CARS_KEY="..."; node build/build-cars.mjs   # force a specific key
//
// Crypto matches the app: PBKDF2(SHA-256, 250000) -> AES-GCM-256, JSON payload
// layout (like encrypt.mjs) so cars.js decrypts it the same way.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CARS_JSON = join(__dirname, 'cars.json');
const OUT_DIR = join(ROOT, 'data');
const OUT_FILE = join(OUT_DIR, 'cars.enc.json');
const KEY_FILE = join(__dirname, 'cars-key.txt');

const ITERATIONS = 250000;
const subtle = crypto.subtle;
const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const argv = process.argv.slice(2);
const ROTATE = argv.includes('--rotate');
const PUBLIC_BASE = 'https://jonathancarlson.github.io/france-2026';

// --- Resolve the car key (env > key file > generate) ----------------------
function newKey() {
  // 24 random bytes -> URL-safe base64 (~192 bits). Unguessable, so the URL
  // itself is the access control ("security by obscurity").
  const raw = crypto.getRandomValues(new Uint8Array(24));
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let carKey;
let keySource;
if (process.env.TRIP_CARS_KEY && process.env.TRIP_CARS_KEY.trim().length >= 16) {
  carKey = process.env.TRIP_CARS_KEY.trim();
  keySource = 'env TRIP_CARS_KEY';
} else if (existsSync(KEY_FILE) && !ROTATE) {
  carKey = readFileSync(KEY_FILE, 'utf8').trim();
  keySource = 'build/cars-key.txt (existing)';
} else {
  carKey = newKey();
  writeFileSync(KEY_FILE, carKey + '\n', 'utf8');
  keySource = ROTATE ? 'build/cars-key.txt (ROTATED — old links now dead)' : 'build/cars-key.txt (new)';
}
if (carKey.length < 16) {
  console.error('❌ Car key too short. Delete build/cars-key.txt and re-run, or set TRIP_CARS_KEY.');
  process.exit(1);
}

// --- Derive AES key + encrypt the JSON payload ----------------------------
async function deriveKey(salt, usage) {
  const km = await subtle.importKey('raw', enc.encode(carKey), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, [usage],
  );
}

async function encryptJsonPayload(obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(salt, 'encrypt');
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return {
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS },
    salt: b64(salt), iv: b64(iv), ct: b64(ct),
  };
}

// --- Load + validate the plaintext car data -------------------------------
if (!existsSync(CARS_JSON)) {
  console.error('❌ build/cars.json not found — nothing to build the car page from.');
  process.exit(1);
}
const data = JSON.parse(readFileSync(CARS_JSON, 'utf8'));
if (!Array.isArray(data.cars) || !data.cars.length) {
  console.error('❌ build/cars.json has no cars[] — nothing to publish.');
  process.exit(1);
}
// Stamp the build time so the page can show an accurate "last updated".
data.built = new Date().toISOString();

// --- Write the encrypted bundle -------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const payload = await encryptJsonPayload(data);
writeFileSync(OUT_FILE, JSON.stringify(payload));

const shareUrl = `${PUBLIC_BASE}/cars.html#k=${carKey}`;

console.log('');
console.log('🚗  Kate\'s car page — bundle built');
console.log(`    key source : ${keySource}`);
console.log(`    cars       : ${data.cars.length}`);
console.log(`    bundle     : data/cars.enc.json  (${payload.ct.length} b64 chars)`);
console.log('');
console.log('    SHAREABLE LINK (text this to Kate — grants the car list only):');
console.log(`    ${shareUrl}`);
console.log('');
console.log('    The token after #k= is the access key AND the decryption key. Anyone with');
console.log('    the full link sees the cars; without it, data/cars.enc.json is unreadable.');
console.log('    It CANNOT unlock the France itinerary, tickets, or contacts.');
