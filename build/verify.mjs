// Verifies the encrypted blob decrypts with the same Web Crypto logic the
// browser (app.js) uses — proves the front-end will unlock successfully.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const payload = JSON.parse(readFileSync(join(ROOT, 'data', 'itinerary.enc.json'), 'utf8'));
const pass = process.env.TRIP_PASSPHRASE;
const b64ToU8 = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));
const enc = new TextEncoder();
const km = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64ToU8(payload.salt), iterations: payload.kdf.iterations, hash: payload.kdf.hash }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToU8(payload.iv) }, key, b64ToU8(payload.ct));
const data = JSON.parse(new TextDecoder().decode(buf));
console.log(`✅ Decrypt OK — "${data.trip.title}", ${data.days.length} days, ${data.flights.length} flights, ${data.trains.length} trains, ${data.contacts.length} contacts`);
// wrong-passphrase check
try {
  const km2 = await crypto.subtle.importKey('raw', enc.encode('wrong-pass'), 'PBKDF2', false, ['deriveKey']);
  const k2 = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64ToU8(payload.salt), iterations: payload.kdf.iterations, hash: payload.kdf.hash }, km2, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToU8(payload.iv) }, k2, b64ToU8(payload.ct));
  console.log('❌ wrong passphrase did NOT fail (bug)');
} catch { console.log('✅ Wrong passphrase correctly rejected'); }
