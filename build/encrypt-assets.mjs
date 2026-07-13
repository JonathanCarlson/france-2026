// Encrypts every file in build/tickets/ → data/tickets/<name>.enc so the app can
// decrypt + display real ticket PDFs/images in-browser (offline, private).
// Binary format per file: [16-byte salt][12-byte iv][AES-GCM ciphertext].
// iterations = 250000 (constant, known by app.js). Uses TRIP_PASSPHRASE.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(__dirname, 'tickets');
const OUT = join(ROOT, 'data', 'tickets');

const pass = process.env.TRIP_PASSPHRASE;
if (!pass || pass.length < 6) {
  console.error('❌ Set TRIP_PASSPHRASE (>= 6 chars) — same passphrase as encrypt.mjs.');
  process.exit(1);
}

let files;
try { files = readdirSync(SRC).filter((f) => !f.startsWith('.')); }
catch { console.log('ℹ️ No build/tickets/ folder — no ticket assets to encrypt.'); process.exit(0); }

mkdirSync(OUT, { recursive: true });
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

for (const f of files) {
  const bytes = new Uint8Array(readFileSync(join(SRC, f)));
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const km = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(16 + 12 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  const name = basename(f, extname(f));
  writeFileSync(join(OUT, name + '.enc'), Buffer.from(out));
  console.log(`✅ data/tickets/${name}.enc (${(out.length / 1024).toFixed(0)} KB)`);
}
console.log(`Done — ${files.length} asset(s) encrypted.`);
