// Encrypts trip photos → data/photos/<name>.enc so the app can decrypt + display
// them in-browser (offline, private). Two tiers are encrypted:
//   build/photos/<id>.jpg         → data/photos/<id>.enc          (full-res, opened on tap)
//   build/photos/thumbs/<id>.jpg  → data/photos/thumbs/<id>.enc   (low-res, shown in the grid)
// Same binary format as encrypt-assets.mjs: [16-byte salt][12-byte iv][AES-GCM ciphertext].
// iterations = 250000 (constant, known by app.js). Uses TRIP_PASSPHRASE.
//
// Incremental by default: a source is (re)encrypted only when its .enc is missing
// or older than the source JPEG — so re-running after adding a few photos/thumbs
// doesn't churn (and re-commit) all 184 blobs. Pass --all / --force to re-encrypt
// everything.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(__dirname, 'photos');
const OUT = join(ROOT, 'data', 'photos');

const FORCE = process.argv.includes('--all') || process.argv.includes('--force');

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

// Encrypt every *.jpg (files only) from `srcDir` into `outDir`. Skips subdirs and
// dotfiles. Returns { made, skipped }.
async function encryptDir(srcDir, outDir, label) {
  let names;
  try { names = readdirSync(srcDir); }
  catch { return { made: 0, skipped: 0 }; }
  const files = names.filter((f) => !f.startsWith('.') && statSync(join(srcDir, f)).isFile());
  if (!files.length) return { made: 0, skipped: 0 };
  mkdirSync(outDir, { recursive: true });
  let made = 0, skipped = 0;
  for (const f of files) {
    const srcPath = join(srcDir, f);
    const name = basename(f, extname(f));
    const outPath = join(outDir, name + '.enc');
    if (!FORCE && existsSync(outPath) && statSync(outPath).mtimeMs >= statSync(srcPath).mtimeMs) {
      skipped++;
      continue;
    }
    const size = await encryptOne(srcPath, outPath);
    console.log(`✅ data/photos/${label}${name}.enc (${(size / 1024).toFixed(0)} KB)`);
    made++;
  }
  return { made, skipped };
}

let anySrc = false;
try { anySrc = readdirSync(SRC).length > 0; } catch { anySrc = false; }
if (!anySrc) { console.log('ℹ️ No build/photos/ folder — no photos to encrypt.'); process.exit(0); }

const full = await encryptDir(SRC, OUT, '');
const thumbs = await encryptDir(join(SRC, 'thumbs'), join(OUT, 'thumbs'), 'thumbs/');

console.log(
  `Done — full: ${full.made} encrypted / ${full.skipped} unchanged; ` +
  `thumbs: ${thumbs.made} encrypted / ${thumbs.skipped} unchanged.`,
);
