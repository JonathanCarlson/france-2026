// Encrypts build/itinerary.json → data/itinerary.enc.json using PBKDF2 + AES-GCM.
// Uses the SAME Web Crypto primitives the browser uses, so the front-end can
// decrypt it. The passphrase is read from the TRIP_PASSPHRASE env var and is
// NEVER written to disk or committed.
//
// Usage (PowerShell):
//   $env:TRIP_PASSPHRASE="your shared family passphrase"; node build/encrypt.mjs
//
// Only the ENCRYPTED blob (data/itinerary.enc.json) is committed. The plaintext
// source (build/itinerary.json) is gitignored.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const passphrase = process.env.TRIP_PASSPHRASE;
if (!passphrase || passphrase.length < 6) {
  console.error('❌ Set TRIP_PASSPHRASE (>= 6 chars). Example (PowerShell):');
  console.error('   $env:TRIP_PASSPHRASE="your family passphrase"; node build/encrypt.mjs');
  process.exit(1);
}

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

const plaintext = readFileSync(join(__dirname, 'itinerary.json'), 'utf8');
const parsed = JSON.parse(plaintext); // validate
// Stamp the actual build time so the app can show an accurate "last updated".
parsed.trip = parsed.trip || {};
parsed.trip.updated = new Date().toISOString();
const stamped = JSON.stringify(parsed);

const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
const iterations = 250000;

const keyMaterial = await subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
const key = await subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
  keyMaterial,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt'],
);
const ctBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(stamped));

const b64 = (u8) => Buffer.from(u8).toString('base64');
const payload = {
  v: 1,
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations },
  salt: b64(salt),
  iv: b64(iv),
  ct: b64(new Uint8Array(ctBuf)),
  updated: parsed.trip.updated,
};
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'itinerary.enc.json'), JSON.stringify(payload));
console.log(`✅ Encrypted → data/itinerary.enc.json  (updated ${payload.updated}, ${payload.ct.length} b64 chars)`);
