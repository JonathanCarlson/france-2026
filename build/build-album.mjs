// build-album.mjs — build a STANDALONE, friends-shareable photo album bundle.
//
// The main trip app encrypts everything (itinerary, tickets, photos) with the
// FAMILY passphrase. This script builds a SEPARATE, photos-only bundle encrypted
// with an independent "album key" so the link you share with friends grants
// access to ONLY the photo album — never the itinerary, tickets, or contacts,
// and never reveals the family passphrase.
//
// The album key is ALSO the obfuscation token: it lives in the URL fragment
//   https://.../album.html#k=<albumKey>
// (the #fragment is never sent to the server, so the key stays client-side).
//
// Outputs (all committed, all ciphertext):
//   data/album/index.enc         — encrypted manifest (captions/dates/people/order)
//   data/album/photos/<id>.enc   — each photo, re-encrypted with the album key
//
// The album key is persisted to build/album-key.txt (GITIGNORED) so the shared
// URL stays STABLE across republishes. Re-running only encrypts new photos.
//
// Usage (PowerShell), from the repo root:
//   node build/build-album.mjs            # reuse/create the album key, print the URL
//   node build/build-album.mjs --rotate   # generate a BRAND-NEW key (old links die)
//   $env:TRIP_ALBUM_KEY="..."; node build/build-album.mjs   # force a specific key
//
// Photo/manifest crypto matches the app: PBKDF2(SHA-256, 250000) → AES-GCM-256.
// Photo files use the raw [16-byte salt][12-byte iv][ct] layout (like
// encrypt-assets.mjs / encrypt-photos.mjs); the manifest uses the JSON payload
// layout (like encrypt.mjs) so album.js can decrypt it the same way.

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PHOTOS_SRC = join(__dirname, 'photos');
const OUT_DIR = join(ROOT, 'data', 'album');
const OUT_PHOTOS = join(OUT_DIR, 'photos');
const OUT_VIDEOS = join(OUT_DIR, 'videos');
const VIDEOS_SRC = join(__dirname, 'videos');
const KEY_FILE = join(__dirname, 'album-key.txt');
const ITINERARY = join(__dirname, 'itinerary.json');

const ITERATIONS = 250000;
const subtle = crypto.subtle;
const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const argv = process.argv.slice(2);
const ROTATE = argv.includes('--rotate');
const PUBLIC_BASE = 'https://jonathancarlson.github.io/france-2026';

// --- Resolve the album key (env > key file > generate) --------------------
function newKey() {
  // 24 random bytes → URL-safe base64 (32 chars). ~192 bits of entropy:
  // unguessable, so the URL itself is the access control ("security by obscurity").
  const raw = crypto.getRandomValues(new Uint8Array(24));
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let albumKey;
let keySource;
if (process.env.TRIP_ALBUM_KEY && process.env.TRIP_ALBUM_KEY.trim().length >= 16) {
  albumKey = process.env.TRIP_ALBUM_KEY.trim();
  keySource = 'env TRIP_ALBUM_KEY';
} else if (existsSync(KEY_FILE) && !ROTATE) {
  albumKey = readFileSync(KEY_FILE, 'utf8').trim();
  keySource = 'build/album-key.txt (existing)';
} else {
  albumKey = newKey();
  writeFileSync(KEY_FILE, albumKey + '\n', 'utf8');
  keySource = ROTATE ? 'build/album-key.txt (ROTATED — old links now dead)' : 'build/album-key.txt (new)';
}
if (albumKey.length < 16) {
  console.error('❌ Album key too short. Delete build/album-key.txt and re-run, or set TRIP_ALBUM_KEY.');
  process.exit(1);
}

// --- Derive AES keys from the album key -----------------------------------
async function deriveKey(salt, usage) {
  const km = await subtle.importKey('raw', enc.encode(albumKey), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, [usage],
  );
}

// Raw-binary photo/asset format: [16 salt][12 iv][ct]
async function encryptBytes(bytes) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(salt, 'encrypt');
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(16 + 12 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  return out;
}

// JSON payload format: { v, kdf, salt, iv, ct }
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

// --- Load photo metadata from the itinerary -------------------------------
if (!existsSync(ITINERARY)) {
  console.error('❌ build/itinerary.json not found — nothing to build the album from.');
  process.exit(1);
}
const data = JSON.parse(readFileSync(ITINERARY, 'utf8'));
const photos = (data.photos || []).slice();
if (!photos.length) {
  console.error('❌ No photos[] in build/itinerary.json — run the photo sync first.');
  process.exit(1);
}

// Only include photos whose plaintext JPEG actually exists in build/photos/.
const present = new Set(
  (existsSync(PHOTOS_SRC) ? readdirSync(PHOTOS_SRC) : [])
    .filter((f) => !f.startsWith('.'))
    .map((f) => basename(f, extname(f))),
);
const usable = photos.filter((p) => present.has(p.file || p.id));
if (!usable.length) {
  console.error('❌ No source JPEGs found in build/photos/ matching itinerary photos[].');
  process.exit(1);
}

// Manifest — only the fields the album UI needs. No confirmation #s / tickets.
usable.sort((a, b) => String(a.taken || a.date).localeCompare(String(b.taken || b.date)));
const manifest = {
  title: (data.trip && data.trip.title) || 'France & Italy 2026',
  dates: (data.trip && data.trip.dates) || '',
  updated: new Date().toISOString(),
  count: usable.length,
  photos: usable.map((p) => {
    const o = {
      id: p.id,
      file: p.file || p.id,
      date: p.date,
      dow: p.dow || '',
      city: p.city || '',
      dayTitle: p.dayTitle || '',
      taken: p.taken || p.date,
      caption: p.caption || '',
      trip: p.trip || '',
      desc: p.desc || '',
      people: Array.isArray(p.people) ? p.people : [],
    };
    // Video entries carry the clip reference + type so album.js plays a <video>.
    if (p.type === 'video') {
      o.type = 'video';
      o.videoFile = p.videoFile || p.file || p.id;
      if (p.durationSec != null) o.durationSec = p.durationSec;
    }
    return o;
  }),
};

// --- Write the bundle -----------------------------------------------------
mkdirSync(OUT_PHOTOS, { recursive: true });

let encrypted = 0;
let skipped = 0;
for (const p of usable) {
  const id = p.file || p.id;
  const outPath = join(OUT_PHOTOS, id + '.enc');
  const srcPath = existsSync(join(PHOTOS_SRC, id + '.jpg'))
    ? join(PHOTOS_SRC, id + '.jpg')
    : join(PHOTOS_SRC, (readdirSync(PHOTOS_SRC).find((f) => basename(f, extname(f)) === id)) || (id + '.jpg'));
  // Incremental: skip a photo whose .enc already exists AND is newer than its source.
  if (existsSync(outPath) && existsSync(srcPath) && statSync(outPath).mtimeMs >= statSync(srcPath).mtimeMs) {
    skipped++;
    continue;
  }
  const bytes = new Uint8Array(readFileSync(srcPath));
  const outBytes = await encryptBytes(bytes);
  writeFileSync(outPath, Buffer.from(outBytes));
  encrypted++;
}

const indexPayload = await encryptJsonPayload(manifest);
writeFileSync(join(OUT_DIR, 'index.enc'), JSON.stringify(indexPayload));

// --- Video clips: encrypt build/videos/<videoFile>.mp4 -> data/album/videos/<id>.enc
let vidEncrypted = 0, vidSkipped = 0;
const videoItems = usable.filter((p) => p.type === 'video' && (p.videoFile || p.file || p.id));
if (videoItems.length) {
  mkdirSync(OUT_VIDEOS, { recursive: true });
  for (const p of videoItems) {
    const vid = p.videoFile || p.file || p.id;
    const srcPath = join(VIDEOS_SRC, vid + '.mp4');
    if (!existsSync(srcPath)) continue; // clip not transcoded yet — poster still shows
    const outPath = join(OUT_VIDEOS, vid + '.enc');
    if (existsSync(outPath) && statSync(outPath).mtimeMs >= statSync(srcPath).mtimeMs) { vidSkipped++; continue; }
    const outBytes = await encryptBytes(new Uint8Array(readFileSync(srcPath)));
    writeFileSync(outPath, Buffer.from(outBytes));
    vidEncrypted++;
  }
}

const shareUrl = `${PUBLIC_BASE}/album.html#k=${albumKey}`;

console.log('');
console.log('📷  France & Italy 2026 — friends album built');
console.log(`    key source : ${keySource}`);
console.log(`    photos     : ${usable.length} (${encrypted} encrypted, ${skipped} unchanged)`);
if (videoItems.length) console.log(`    videos     : ${videoItems.length} (${vidEncrypted} encrypted, ${vidSkipped} unchanged)`);
console.log(`    manifest   : data/album/index.enc`);
console.log('');
console.log('    SHAREABLE LINK (send this to friends — grants photos only):');
console.log(`    ${shareUrl}`);
console.log('');
console.log('    The token after #k= is the access key AND the decryption key. Anyone with');
console.log('    the full link sees the photos; without it, data/album/* is unreadable.');
console.log('    Keep it out of public posts — treat it like a password baked into a URL.');
