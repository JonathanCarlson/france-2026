// Encrypts trip videos → data/videos/<id>.enc so the app can decrypt + play them
// in-browser (offline, private), the same way encrypt-photos.mjs handles stills.
//   build/videos/<id>.mp4  →  data/videos/<id>.enc   (H.264, played on tap)
// Same binary format as encrypt-photos.mjs: [16-byte salt][12-byte iv][AES-GCM ct].
// iterations = 250000 (constant, known by app.js). Uses TRIP_PASSPHRASE.
//
// Incremental by default: a clip is (re)encrypted only when its .enc is missing or
// older than the source .mp4 — so re-running after adding one video doesn't churn
// every blob. Pass --all / --force to re-encrypt everything.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(__dirname, 'videos');
const OUT = join(ROOT, 'data', 'videos');

const FORCE = process.argv.includes('--all') || process.argv.includes('--force');
const VID_EXT = new Set(['.mp4', '.webm', '.m4v', '.mov']);

const pass = process.env.TRIP_PASSPHRASE;
if (!pass || pass.length < 6) {
  console.error('❌ Set TRIP_PASSPHRASE (>= 6 chars) — same passphrase as encrypt.mjs.');
  process.exit(1);
}

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

async function encryptOne(srcPath, outPath) {
  const bytes = new Uint8Array(readFileSync(srcPath));
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const km = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(16 + 12 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  writeFileSync(outPath, Buffer.from(out));
  return out.length;
}

let names;
try { names = readdirSync(SRC); } catch { console.log('ℹ️ No build/videos/ folder — no videos to encrypt.'); process.exit(0); }
const files = names.filter((f) => !f.startsWith('.') && VID_EXT.has(extname(f).toLowerCase()) && statSync(join(SRC, f)).isFile());
if (!files.length) { console.log('ℹ️ No videos in build/videos/ — nothing to encrypt.'); process.exit(0); }

mkdirSync(OUT, { recursive: true });
let made = 0, skipped = 0;
for (const f of files) {
  const srcPath = join(SRC, f);
  const name = basename(f, extname(f));
  const outPath = join(OUT, name + '.enc');
  if (!FORCE && existsSync(outPath) && statSync(outPath).mtimeMs >= statSync(srcPath).mtimeMs) { skipped++; continue; }
  const size = await encryptOne(srcPath, outPath);
  console.log(`✅ data/videos/${name}.enc (${(size / 1024 / 1024).toFixed(1)} MB)`);
  made++;
}
console.log(`Done — videos: ${made} encrypted / ${skipped} unchanged.`);
