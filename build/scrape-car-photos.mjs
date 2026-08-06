// scrape-car-photos.mjs — enrich build/cars.json with a primary listing PHOTO per car.
//
// For each car, fetch its Autotrader VDP (or atcm.co shortlink) using the same
// PowerShell/Invoke-WebRequest path that autotrader-vin.mjs relies on (Akamai lets
// .NET's HttpClient through on this Windows devbox where raw Node/curl get 403), then
// pull the listing's PRIMARY photo. Autotrader serves the gallery from its image CDN
// as  https://images.autotrader.com/hn/c/<contentHash>.jpg  — the FIRST such URL in the
// server-delivered HTML is the hero image (it also matches the og:image tag). We verify
// the page's embedded VIN equals the car's VIN before trusting the photo, so a
// redirect/relist to a different vehicle can't attach the wrong picture.
//
// We store the CDN URL (NOT a rehosted copy) as car.photo, so the page hotlinks the
// image — no manufacturer/dealer photos are copied into the repo, and cars.js hides the
// <img> gracefully if a sold listing's photo 404s later.
//
// Usage (from repo root):
//   node build/scrape-car-photos.mjs           # fill missing photos only
//   node build/scrape-car-photos.mjs --force   # re-scrape every car
//
// After running, rebuild the encrypted bundle:  node build/build-cars.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARS_JSON = join(__dirname, 'cars.json');
const FORCE = process.argv.includes('--force');

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

// Fetch a URL's HTML via .NET HttpClient (from PowerShell). HttpClient's TLS/HTTP stack
// gets past Akamai on this Windows devbox where raw Node/curl get a 403, AND — unlike
// Windows PowerShell 5.1's Invoke-WebRequest — it auto-follows 308/301 redirects, so the
// atcm.co mobile shortlinks resolve to their final Autotrader VDP. URL/UA are passed via
// env to avoid command injection.
function fetchHtml(url) {
  const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Net.Http
$h = New-Object System.Net.Http.HttpClientHandler
$h.AllowAutoRedirect = $true
try { $h.MaxAutomaticRedirections = 10 } catch {}
$c = New-Object System.Net.Http.HttpClient($h)
$c.Timeout = [TimeSpan]::FromSeconds(45)
$c.DefaultRequestHeaders.Add('User-Agent', $env:ATV_UA)
try {
  $resp = $c.GetAsync($env:ATV_URL).Result
  $html = $resp.Content.ReadAsStringAsync().Result
  [Console]::Out.Write($html)
} catch { [Console]::Error.Write($_.Exception.Message); exit 3 }
`;
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, ATV_URL: url, ATV_UA: UA },
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (res.status !== 0) return { ok: false, err: (res.stderr || '').trim() || `exit ${res.status}` };
  return { ok: true, html: res.stdout || '' };
}

function extractVin(html) {
  const m = /"vin"\s*:\s*"([A-HJ-NPR-Z0-9]{17})"/.exec(html);
  return m ? m[1] : null;
}

function extractPrimaryPhoto(html) {
  // Only accept a real GALLERY photo: images.autotrader.com/hn/<hash>.jpg (this is the
  // hero image and also what og:image points at). We deliberately do NOT fall back to
  // og:image, because a brand-new listing with no uploaded photos serves the Autotrader
  // LOGO as og:image — better to show no image than a logo.
  const m = /https:\/\/images\.autotrader\.com\/hn\/[^"'\\ ]+?\.jpg/i.exec(html);
  return m ? m[0] : null;
}

const data = JSON.parse(readFileSync(CARS_JSON, 'utf8'));
let filled = 0, skipped = 0, failed = 0;
const report = [];

for (const c of data.cars) {
  if (c.photo && !FORCE) { skipped++; report.push(`#${c.id} ${c.color}: kept existing`); continue; }
  if (!c.url) { failed++; report.push(`#${c.id} ${c.color}: no url`); continue; }
  const r = fetchHtml(c.url);
  if (!r.ok) { failed++; report.push(`#${c.id} ${c.color}: fetch failed (${r.err})`); continue; }
  const pageVin = extractVin(r.html);
  const photo = extractPrimaryPhoto(r.html);
  if (!photo) { failed++; report.push(`#${c.id} ${c.color}: no photo found`); continue; }
  if (pageVin && c.vin && pageVin.toUpperCase() !== c.vin.toUpperCase()) {
    failed++;
    report.push(`#${c.id} ${c.color}: VIN mismatch (page ${pageVin} != ${c.vin}) — skipped`);
    continue;
  }
  c.photo = photo;
  filled++;
  report.push(`#${c.id} ${c.color}: ${photo}${pageVin ? '  (VIN ok)' : '  (VIN not found on page — kept anyway)'}`);
}

writeFileSync(CARS_JSON, JSON.stringify(data, null, 2) + '\n', 'utf8');

console.log('\n📷  Car photo scrape complete');
console.log(`    filled: ${filled} · kept: ${skipped} · failed: ${failed}\n`);
report.forEach((l) => console.log('    ' + l));
