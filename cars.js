'use strict';

// cars.js — the Kate-shareable, cars-ONLY browser.
//
// Access model ("security by obscurity", like the photo album): the car key
// lives in the URL fragment  cars.html#k=<key>  which the browser NEVER sends to
// the server. That key is an independent, high-entropy token — NOT the family
// passphrase — so this page can decrypt ONLY data/cars.enc.json (the car list).
// It can never touch the itinerary, tickets, or contacts. If the link has no
// #k=, we fall back to a manual code box.
//
// Kate's 👍/👎 are saved locally (localStorage, keyed by VIN) and never leave her
// phone until she taps "Send my picks", which hands the summary to the native
// share sheet (or copies it to the clipboard) so she can send it back however
// she likes. No backend, no accounts.
//
// Crypto matches the rest of the app: PBKDF2(SHA-256, 250000) -> AES-GCM-256.
//   data/cars.enc.json   JSON payload {v,kdf,salt,iv,ct} -> the car data

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

let KEY = null;         // the car key string
let DATA = null;        // decrypted car data
let VOTES = {};         // { vin: 'up' | 'down' }
let COMMENTS = {};      // { vin: 'free-text note from Kate' }
let SORT = 'match-desc'; // match-desc | price-asc | price-desc | miles-asc | distance-asc | year-desc
const FACETS = {};      // { groupId: Set(values) } — active faceted filters (within-group OR, across-group AND)
const STORE_KEY = 'kate-cars-votes-v1';
const COMMENTS_KEY = 'kate-cars-comments-v1';

// ---------- crypto ----------
async function decryptPayload(payload) {
  const salt = b64ToU8(payload.salt);
  const iv = b64ToU8(payload.iv);
  const ct = b64ToU8(payload.ct);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: payload.kdf.iterations, hash: payload.kdf.hash },
    km, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(buf));
}

async function tryLoadData() {
  try {
    const res = await fetch('data/cars.enc.json', { cache: 'no-cache' });
    const payload = await res.json();
    DATA = await decryptPayload(payload);
    return true;
  } catch {
    return false;
  }
}

// ---------- votes (localStorage) ----------
function loadVotes() {
  try { VOTES = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; }
  catch { VOTES = {}; }
}
function saveVotes() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(VOTES)); } catch { /* private mode */ }
}

// ---------- comments (localStorage) ----------
// Kate's free-text note per car — the "why" behind a 👍/👎, or a standalone
// thought ("love the color but too far", "would you check the tires?"). Saved
// locally like votes, keyed by VIN, and folded into the "Send my picks" summary
// so we learn what she actually likes, not just which cars she tapped.
function loadComments() {
  try { COMMENTS = JSON.parse(localStorage.getItem(COMMENTS_KEY) || '{}') || {}; }
  catch { COMMENTS = {}; }
}
function saveComments() {
  try { localStorage.setItem(COMMENTS_KEY, JSON.stringify(COMMENTS)); } catch { /* private mode */ }
}
function setComment(vin, text) {
  const t = (text || '').trim();
  if (t) COMMENTS[vin] = t;
  else delete COMMENTS[vin]; // clearing the box removes the note
  saveComments();
}

// ---------- boot ----------
// Remembered car key: once a link with #k=<key> has opened the page (or Kate has
// typed the code once), stash the key in localStorage so a pull-to-refresh or a PWA
// relaunch — which reload the page WITHOUT the #k= fragment — reopen straight to the
// cars instead of dropping back to the access-code box. Same "keep me unlocked"
// tradeoff the main app makes; the car key is cars-only and can never touch the
// itinerary, tickets, or contacts. A stale key (after a rotate) just falls back to
// the gate.
const CARKEY_KEY = 'kate-cars-key-v1';
function rememberKey(k) { try { localStorage.setItem(CARKEY_KEY, k); } catch { /* private mode */ } }
function forgetKey() { try { localStorage.removeItem(CARKEY_KEY); } catch { /* ignore */ } }
function showGate() {
  $('#gate').hidden = false;
  $('#gate-form').addEventListener('submit', onGate);
}

(async function boot() {
  loadVotes();
  loadComments();
  const m = /[#&]k=([^&]+)/.exec(location.hash || '');
  if (m) {
    KEY = decodeURIComponent(m[1]).trim();
    rememberKey(KEY);
    // Strip the key from the visible URL bar (it stays in memory) so a casual
    // over-the-shoulder glance / screenshot of the address doesn't reveal it.
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
    openApp();
    return;
  }
  // No key in the URL — try one we remembered from a prior open so a refresh or PWA
  // relaunch doesn't re-prompt for the access code.
  let saved = null;
  try { saved = localStorage.getItem(CARKEY_KEY); } catch { /* ignore */ }
  if (saved) {
    KEY = saved;
    const ok = await tryLoadData();
    if (ok) { openApp(true); return; }
    KEY = null;
    forgetKey(); // remembered key no longer works (rotated) — fall through to the gate
  }
  showGate();
})();

async function onGate(e) {
  e.preventDefault();
  const code = $('#gate-code').value.trim();
  const err = $('#gate-error');
  err.hidden = true;
  if (!code) return;
  KEY = code;
  $('#gate-btn').textContent = 'Opening…';
  const ok = await tryLoadData();
  if (ok) {
    rememberKey(KEY); // so a later refresh / PWA relaunch reopens without re-asking
    $('#gate').hidden = true;
    openApp(true);
  } else {
    KEY = null;
    err.textContent = 'That code didn’t work. Check it and try again.';
    err.hidden = false;
    $('#gate-btn').textContent = 'View cars';
  }
}

async function openApp(alreadyLoaded) {
  $('#app').hidden = false;
  if (!alreadyLoaded) {
    const ok = await tryLoadData();
    if (!ok) {
      $('#cars-status').innerHTML = '<div class="big">🔒</div>Couldn’t open this link. Ask Jonathan to resend it.';
      return;
    }
  }
  render();
}

// ---------- formatting helpers ----------
const money = (n) => (n == null ? null : '$' + Number(n).toLocaleString('en-US'));
const miles = (n) => Number(n).toLocaleString('en-US') + ' mi';

function roofBadge(state) {
  if (state === 'yes') return '<span class="badge roof">☀️ Glass roof</span>';
  if (state === 'likely') return '<span class="badge roof q">☀️ Glass roof (likely)</span>';
  if (state === 'unconfirmed') return '<span class="badge roof q">☀️ Roof: check</span>';
  if (state === 'no') return '<span class="badge roof no">No glass roof</span>';
  return '';
}

// Ford BlueCruise (hands-free highway driving) status. Derived per-VIN from the
// car's Ford window sticker (see helpers/car-bluecruise-enrich.mjs). It is NOT a
// clean model-year cutoff — 2022 Mach-Es have it too — so it's tracked per car.
// "unknown" means Ford hasn't published that VIN's sticker yet, not "no".
function bcBadge(state) {
  if (state === 'yes') return '<span class="badge bc">🔵 BlueCruise</span>';
  return '';
}
function bcText(state) {
  if (state === 'yes') return 'Yes — hands-free capable';
  if (state === 'no') return 'No';
  return 'Need to verify';
}

// Plain-text glass-roof status for the key-specs grid (the badge above is the
// at-a-glance version; this spells it out).
function roofText(state) {
  if (state === 'yes') return 'Yes';
  if (state === 'likely') return 'Likely (confirming)';
  if (state === 'unconfirmed') return 'Need to verify';
  if (state === 'no') return 'No';
  return '—';
}

// Key specs — "a lot more info": the concrete facts we're comparing cars on,
// pulled straight from the tracked listing data. Rendered as a label/value grid.
function keySpecs(c) {
  const rows = [];
  const add = (label, val, wide) => { if (val != null && val !== '') rows.push([label, val, !!wide]); };
  add('Drivetrain', c.drivetrain === 'AWD' ? 'AWD (eAWD)' : c.drivetrain);
  add('Battery', c.battery);
  add('Range (EPA est.)', c.rangeMi ? `~${c.rangeMi} mi` : null);
  add('Mileage', c.miles != null ? miles(c.miles) : null);
  add('Glass roof', roofText(c.glassRoof));
  add('BlueCruise', bcText(c.bluecruise));
  add('Certification', c.cert);
  add('Color', c.color);
  add('Distance', c.distanceMi != null ? `${c.distanceMi} mi away` : null);
  add('Days on lot', c.daysOnLot != null ? `${c.daysOnLot} day${c.daysOnLot === 1 ? '' : 's'}` : null);
  add('Dealer', c.location, true);
  add('VIN', c.vin, true);
  if (!rows.length) return '';
  const cells = rows.map(([l, val, wide]) =>
    `<div class="spec${wide ? ' wide' : ''}"><dt>${esc(l)}</dt><dd>${esc(val)}</dd></div>`).join('');
  return `<dl class="specs">${cells}</dl>`;
}

// ---------- render ----------
function render() {
  $('#cars-status').hidden = true;
  document.title = DATA.title || 'Mach-E shortlist';
  $('#app-title').textContent = DATA.title || 'Mach-E shortlist';
  $('#app-sub').textContent = (DATA.subtitle || '') + (DATA.updated ? ' · updated ' + DATA.updated : '');

  renderIntro();
  renderTrends();
  renderAnalysis();
  renderFilters();
  renderCars();
  setupTabs();

  const sendbar = $('#sendbar');
  sendbar.dataset.ready = '1';
  sendbar.hidden = false;
  $('#send-btn').addEventListener('click', sendPicks);
  const shareBtn = $('#share-btn');
  if (shareBtn) { shareBtn.hidden = false; shareBtn.addEventListener('click', shareLink); }
  updateTally();
}

function renderIntro() {
  const w = DATA.wants || {};
  const chips = [];
  (w.mustHaves || []).forEach((x) => chips.push(`<span class="want-chip must">✓ ${esc(x)}</span>`));
  (w.niceToHaves || []).forEach((x) => chips.push(`<span class="want-chip">${esc(x)}</span>`));
  (w.avoid || []).forEach((x) => chips.push(`<span class="want-chip avoid">${esc(x)}</span>`));
  // "Standard on every car" baseline: the features that come with the
  // Premium / Extended-Range trim on ALL of these, so they're not per-car
  // differentiators. Keeps the page honest — optional extras (360° camera,
  // Nite Pony) are shown per car only where a window sticker confirms them.
  const sf = DATA.standardFeatures;
  const stdBlock = sf && Array.isArray(sf.items) && sf.items.length
    ? `<div class="std-features">
        <div class="std-head">${esc(sf.heading || 'Standard on every car')}</div>
        ${sf.note ? `<p class="std-note">${esc(sf.note)}</p>` : ''}
        <div class="std-row">${sf.items.map((x) => `<span class="std-chip">✓ ${esc(x)}</span>`).join('')}</div>
        ${sf.varies ? `<p class="std-varies">${esc(sf.varies)}</p>` : ''}
      </div>`
    : '';
  const links = (DATA.resources || [])
    .filter((r) => r && r.url && r.label)
    .map((r) => `<a class="resource-link" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">🔎 ${esc(r.label)} ↗</a>`)
    .join('');
  $('#intro').innerHTML = `
    <div class="card">
      <p style="margin:0 0 6px">${esc(DATA.intro || '')}</p>
      ${chips.length ? `<div class="want-row">${chips.join('')}</div>` : ''}
      ${stdBlock}
      ${links ? `<div class="resource-row">${links}</div>` : ''}
    </div>
    <button id="analysis-cta" class="analysis-cta" type="button" aria-label="Open the price analysis">
      <span class="ac-icon" aria-hidden="true">📊</span>
      <span class="ac-text">
        <b>See the price analysis</b>
        <span class="ac-sub">How year, mileage, AWD &amp; options move the price — recomputed from the latest listings</span>
      </span>
      <span class="ac-arrow" aria-hidden="true">→</span>
    </button>`;
}

function renderTrends() {
  const t = DATA.tradeoffs || DATA.trends;
  if (!t) { $('#trends').innerHTML = ''; return; }
  const s = t.stats || {};
  const statCells = [];
  if (s.count != null) statCells.push(`<div class="stat"><div class="n">${s.count}</div><div class="l">cars in range</div></div>`);
  if (s.min != null) statCells.push(`<div class="stat"><div class="n">${money(s.min)}</div><div class="l">lowest price</div></div>`);
  if (s.median != null) statCells.push(`<div class="stat"><div class="n">${money(s.median)}</div><div class="l">typical price</div></div>`);
  if (s.rwdAvg != null) statCells.push(`<div class="stat"><div class="n">${money(s.rwdAvg)}</div><div class="l">avg RWD</div></div>`);
  if (s.awdAvg != null) statCells.push(`<div class="stat"><div class="n">${money(s.awdAvg)}</div><div class="l">avg AWD</div></div>`);
  if (s.awdPremium != null) statCells.push(`<div class="stat"><div class="n">+${money(s.awdPremium)}</div><div class="l">AWD costs more</div></div>`);
  $('#trends').innerHTML = `
    <div class="card">
      <h2>📈 ${esc(t.headline || 'Market trends')}</h2>
      ${t.note ? `<p class="muted" style="margin:4px 0 0;line-height:1.45">${esc(t.note)}</p>` : ''}
      <ul class="trend-list">${(t.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
      ${statCells.length ? `<div class="stat-grid">${statCells.join('')}</div>` : ''}
      ${s.label ? `<p class="muted tiny" style="margin:10px 0 0">${esc(s.label)}</p>` : ''}
    </div>`;
}

// ---------- price analysis (client-side regression) ----------
// A small, dependency-free ordinary-least-squares model rebuilt from the current
// inventory on every load. The nightly refresh overwrites cars.json, so we
// recompute rather than hardcode any number. It teases apart how much each factor
// — model year, mileage, drivetrain, battery, trim, glass roof, certification,
// color, and location — independently moves the asking price, holding the rest
// equal. "Over time" is read through model year + mileage (the age/use axes); the
// page keeps no nightly price history, so this is a cross-section, not a time
// series — stated plainly in the caveat.

const REG_COLOR_BASE = 'White';
function normColor(raw) {
  const s = (raw || '').toLowerCase();
  if (/white/.test(s)) return 'White';
  if (/black/.test(s)) return 'Black';
  if (/blue/.test(s)) return 'Blue';
  if (/gray|grey|carbonized/.test(s)) return 'Gray';
  if (/red/.test(s)) return 'Red';
  return 'Other';
}
function stateOf(loc) { const m = /([A-Z]{2})\s*$/.exec((loc || '').trim()); return m ? m[1] : ''; }

// Each term: a grouped label plus a value extractor. The baseline (all dummies 0)
// is a 2023 · Select · RWD · Standard Range · White · WA · non-certified car.
// `per` scales the coefficient for display (miles shown per 10k, not per 1k).
function regTerms() {
  return [
    { key: 'yearC',    grp: 'Age & use',        label: 'Each model year newer',   per: 1,  f: (c) => c.year - 2023 },
    { key: 'milesK',   grp: 'Age & use',        label: 'Each 10,000 miles',       per: 10, f: (c) => c.miles / 1000 },
    { key: 'awd',      grp: 'Powertrain',       label: 'AWD (vs RWD)',            per: 1,  f: (c) => (c.drivetrain === 'AWD' ? 1 : 0) },
    { key: 'ext',      grp: 'Powertrain',       label: 'Extended Range (vs Std)', per: 1,  f: (c) => (/extended/i.test(c.battery || '') ? 1 : 0) },
    { key: 'premium',  grp: 'Trim (vs Select)', label: 'Premium',                 per: 1,  f: (c) => (/premium/i.test(c.trim || '') ? 1 : 0) },
    { key: 'gt',       grp: 'Trim (vs Select)', label: 'GT',                      per: 1,  f: (c) => (/\bgt\b/i.test(c.trim || '') ? 1 : 0) },
    { key: 'route1',   grp: 'Trim (vs Select)', label: 'California Route 1',      per: 1,  f: (c) => (/route\s*1/i.test(c.trim || '') ? 1 : 0) },
    { key: 'roof',     grp: 'Features',         label: 'Glass roof',              per: 1,  f: (c) => (c.glassRoof === 'yes' || c.glassRoof === 'likely' ? 1 : 0) },
    { key: 'cert',     grp: 'Features',         label: 'Ford Certified',          per: 1,  f: (c) => (/certified/i.test(c.cert || '') ? 1 : 0) },
    { key: 'Black',    grp: 'Color (vs White)', label: 'Black',                   per: 1,  f: (c) => (normColor(c.color) === 'Black' ? 1 : 0) },
    { key: 'Blue',     grp: 'Color (vs White)', label: 'Blue',                    per: 1,  f: (c) => (normColor(c.color) === 'Blue' ? 1 : 0) },
    { key: 'Gray',     grp: 'Color (vs White)', label: 'Gray',                    per: 1,  f: (c) => (normColor(c.color) === 'Gray' ? 1 : 0) },
    { key: 'Red',      grp: 'Color (vs White)', label: 'Red',                     per: 1,  f: (c) => (normColor(c.color) === 'Red' ? 1 : 0) },
    { key: 'OtherCol', grp: 'Color (vs White)', label: 'Other color',             per: 1,  f: (c) => (normColor(c.color) === 'Other' ? 1 : 0) },
    { key: 'isOR',     grp: 'Location',         label: 'Oregon (vs Washington)',  per: 1,  f: (c) => (stateOf(c.location) === 'OR' ? 1 : 0) },
  ];
}

// --- tiny matrix toolkit (no deps) ---
function mT(A) { const r = A.length, c = A[0].length, B = []; for (let j = 0; j < c; j++) { B[j] = []; for (let i = 0; i < r; i++) B[j][i] = A[i][j]; } return B; }
function mMul(A, B) { const r = A.length, k = B.length, c = B[0].length, C = []; for (let i = 0; i < r; i++) { C[i] = new Array(c).fill(0); for (let t = 0; t < k; t++) { const a = A[i][t]; if (!a) continue; const Bt = B[t]; for (let j = 0; j < c; j++) C[i][j] += a * Bt[j]; } } return C; }
function mVec(A, v) { return A.map((row) => { let s = 0; for (let j = 0; j < row.length; j++) s += row[j] * v[j]; return s; }); }
function mInv(M) {
  const n = M.length;
  const A = M.map((r, i) => { const row = r.slice(); for (let j = 0; j < n; j++) row.push(i === j ? 1 : 0); return row; });
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) throw new Error('singular');
    const tmp = A[col]; A[col] = A[piv]; A[piv] = tmp;
    const d = A[col][col];
    for (let j = 0; j < 2 * n; j++) A[col][j] /= d;
    for (let r = 0; r < n; r++) { if (r === col) continue; const fct = A[r][col]; if (!fct) continue; for (let j = 0; j < 2 * n; j++) A[r][j] -= fct * A[col][j]; }
  }
  return A.map((r) => r.slice(n));
}

// β = (XᵀX)⁻¹Xᵀy via the normal equations, with SEs from σ²·diag((XᵀX)⁻¹).
function runRegression(cars) {
  const rows = (cars || []).filter((c) => typeof c.price === 'number' && Number.isFinite(c.price)
    && typeof c.miles === 'number' && Number.isFinite(c.miles)
    && typeof c.year === 'number' && Number.isFinite(c.year));
  if (rows.length < 15) return { ok: false, n: rows.length };
  // Drop terms with no variation in this snapshot — an all-0 or all-1 column is
  // collinear with the intercept and makes XᵀX singular.
  const terms = regTerms().filter((t) => { const v0 = t.f(rows[0]); return rows.some((c) => t.f(c) !== v0); });
  if (!terms.length) return { ok: false, n: rows.length };
  const X = rows.map((c) => [1, ...terms.map((t) => t.f(c))]);
  const y = rows.map((c) => c.price);
  const Xt = mT(X);
  const XtX = mMul(Xt, X);
  let inv;
  try {
    inv = mInv(XtX);
  } catch (e) {
    // Ridge fallback for a near-singular design on an unlucky night's data.
    const lam = 1;
    const R = XtX.map((r, i) => r.map((v, j) => (i === j && i > 0 ? v + lam : v)));
    try { inv = mInv(R); } catch (e2) { return { ok: false, n: rows.length, singular: true }; }
  }
  const beta = mVec(inv, mVec(Xt, y));
  const yhat = mVec(X, beta);
  const n = rows.length, p = beta.length;
  let rss = 0; for (let i = 0; i < n; i++) { const e = y[i] - yhat[i]; rss += e * e; }
  const ybar = y.reduce((s, v) => s + v, 0) / n;
  const tss = y.reduce((s, v) => s + (v - ybar) * (v - ybar), 0) || 1;
  const r2 = 1 - rss / tss;
  const adjR2 = n - p > 0 ? 1 - (1 - r2) * (n - 1) / (n - p) : NaN;
  const sigma2 = n - p > 0 ? rss / (n - p) : NaN;
  const coefs = terms.map((t, i) => {
    const b = beta[i + 1];
    const varc = Number.isFinite(sigma2) ? sigma2 * inv[i + 1][i + 1] : NaN;
    const se = Number.isFinite(varc) && varc >= 0 ? Math.sqrt(varc) : NaN;
    const tstat = se ? b / se : NaN;
    return { key: t.key, grp: t.grp, label: t.label, coef: b, disp: b * t.per, se, t: tstat, sig: Number.isFinite(tstat) && Math.abs(tstat) >= 1.96 };
  });
  return { ok: true, n, p, r2, adjR2, rmse: Number.isFinite(sigma2) ? Math.sqrt(sigma2) : NaN, intercept: beta[0], coefs };
}

// --- charts (inline SVG, theme colors) ---
function priceByYear(cars) {
  const g = {};
  cars.forEach((c) => { if (typeof c.price === 'number' && typeof c.year === 'number') { (g[c.year] || (g[c.year] = [])).push(c.price); } });
  return Object.keys(g).map(Number).sort((a, b) => a - b).map((yr) => {
    const arr = g[yr].slice().sort((a, b) => a - b);
    return { year: yr, median: arr[Math.floor(arr.length / 2)], count: arr.length };
  });
}

function yearBarSvg(series) {
  if (!series.length) return '';
  const W = 320, H = 190, padL = 8, padR = 8, padT = 22, padB = 34;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxV = Math.max(...series.map((d) => d.median)) * 1.08 || 1;
  const n = series.length, gap = iw / n, bw = gap * 0.6;
  const yOf = (v) => padT + ih - (v / maxV) * ih;
  const short = (v) => '$' + (v / 1000).toFixed(v >= 10000 ? 1 : 0) + 'k';
  let bars = '';
  series.forEach((d, i) => {
    const cx = padL + gap * i + gap / 2, x = cx - bw / 2, yy = yOf(d.median), bh = padT + ih - yy;
    bars += `<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="4" fill="#3b6fd6"></rect>`;
    bars += `<text x="${cx.toFixed(1)}" y="${(yy - 6).toFixed(1)}" text-anchor="middle" font-size="11" fill="#eef2ff" font-weight="600">${short(d.median)}</text>`;
    bars += `<text x="${cx.toFixed(1)}" y="${(padT + ih + 15).toFixed(1)}" text-anchor="middle" font-size="11" fill="#9aa6c7">${d.year}</text>`;
    bars += `<text x="${cx.toFixed(1)}" y="${(padT + ih + 28).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="#9aa6c7">n=${d.count}</text>`;
  });
  const baseY = (padT + ih).toFixed(1);
  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Median asking price by model year">`
    + `<line x1="${padL}" y1="${baseY}" x2="${W - padR}" y2="${baseY}" stroke="#2a355c"></line>${bars}</svg></div>`;
}

function mileageScatterSvg(cars) {
  const pts = cars.filter((c) => typeof c.price === 'number' && typeof c.miles === 'number')
    .map((c) => ({ x: c.miles, y: c.price, awd: c.drivetrain === 'AWD' }));
  if (pts.length < 4) return '';
  const W = 320, H = 200, padL = 40, padR = 10, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const xmax = Math.max(...xs) * 1.05 || 1;
  const ymin = Math.min(...ys) * 0.97, ymax = Math.max(...ys) * 1.03;
  const yspan = (ymax - ymin) || 1;
  const sx = (v) => padL + (v / xmax) * iw;
  const sy = (v) => padT + ih - (v - ymin) / yspan * ih;
  let mx = 0, my = 0; pts.forEach((p) => { mx += p.x; my += p.y; }); mx /= pts.length; my /= pts.length;
  let sxy = 0, sxx = 0; pts.forEach((p) => { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) * (p.x - mx); });
  const slope = sxx ? sxy / sxx : 0, intc = my - slope * mx;
  const clamp = (v) => Math.max(ymin, Math.min(ymax, v));
  const y1 = clamp(intc), y2 = clamp(intc + slope * xmax);
  const grid = [ymin, (ymin + ymax) / 2, ymax].map((v) =>
    `<line x1="${padL}" y1="${sy(v).toFixed(1)}" x2="${W - padR}" y2="${sy(v).toFixed(1)}" stroke="#2a355c" stroke-dasharray="2 3"></line>`
    + `<text x="${padL - 5}" y="${(sy(v) + 3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#9aa6c7">$${Math.round(v / 1000)}k</text>`).join('');
  const xt = [0, xmax / 2, xmax].map((v) =>
    `<text x="${sx(v).toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="9.5" fill="#9aa6c7">${Math.round(v / 1000)}k mi</text>`).join('');
  const fit = `<line x1="${sx(0).toFixed(1)}" y1="${sy(y1).toFixed(1)}" x2="${sx(xmax).toFixed(1)}" y2="${sy(y2).toFixed(1)}" stroke="#34d399" stroke-width="2"></line>`;
  const dots = pts.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="${p.awd ? '#6ea8fe' : '#9aa6c7'}" fill-opacity="0.85"></circle>`).join('');
  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Asking price versus mileage">${grid}${xt}${fit}${dots}</svg></div>`;
}

function fmtSigned(v) {
  const r = Math.round(v / 10) * 10;
  return (r < 0 ? '−$' : '+$') + Math.abs(r).toLocaleString('en-US');
}

function takeawaysHtml(reg) {
  const by = {}; reg.coefs.forEach((c) => { by[c.key] = c; });
  const d = (v) => '$' + Math.abs(Math.round(v / 10) * 10).toLocaleString('en-US');
  const bul = [];
  if (by.yearC && by.yearC.sig) bul.push(`Every <b>model year newer</b> adds about <b>${d(by.yearC.disp)}</b>, all else equal.`);
  if (by.milesK && by.milesK.sig) bul.push(`Every <b>10,000 miles</b> ${by.milesK.disp < 0 ? 'knocks off' : 'adds'} about <b>${d(by.milesK.disp)}</b>.`);
  if (by.awd && by.awd.sig) bul.push(`<b>AWD</b> commands about <b>${d(by.awd.disp)}</b> over RWD.`);
  const trims = ['premium', 'gt', 'route1'].map((k) => by[k]).filter((c) => c && c.sig);
  if (trims.length) bul.push('Trim is the biggest lever — ' + trims.map((c) => `<b>${esc(c.label)}</b> ${c.disp >= 0 ? '+' : '−'}${d(c.disp)}`).join(', ') + ' versus the base Select.');
  if (by.cert && by.cert.sig) bul.push(`<b>Ford Certified</b> ${by.cert.disp >= 0 ? 'adds' : 'costs'} about <b>${d(by.cert.disp)}</b>.`);
  if (by.ext && !by.ext.sig) bul.push(`<b>Extended Range</b> shows little independent effect once trim is accounted for — the pricier trims almost always include it, so its value is baked into them.`);
  if (by.isOR) bul.push(by.isOR.sig
    ? `<b>Oregon</b> listings run about <b>${d(by.isOR.disp)}</b> ${by.isOR.disp < 0 ? 'less' : 'more'} than Washington.`
    : `Location (Oregon vs Washington) doesn't clearly move the price.`);
  const colorSig = ['Black', 'Blue', 'Gray', 'Red', 'OtherCol'].some((k) => by[k] && by[k].sig);
  if (!colorSig) bul.push(`<b>Color</b> barely matters — no color shows a statistically clear premium or discount.`);
  if (!bul.length) return '';
  return `<div class="section-title" style="margin:16px 0 4px">In plain English</div><ul class="takeaways">${bul.map((b) => `<li>${b}</li>`).join('')}</ul>`;
}

function regCard(reg) {
  if (!reg || !reg.ok) {
    const why = reg && reg.singular ? `today's listings are too similar to separate the factors`
      : `only ${reg && reg.n != null ? reg.n : 0} priced listings so far`;
    return `<div class="card"><h2>📊 What drives the price</h2>`
      + `<p class="muted" style="line-height:1.5">Not enough to fit a reliable model yet — ${why}. This fills in automatically after a few more nightly scans.</p></div>`;
  }
  let rowsHtml = '', lastGrp = null;
  reg.coefs.forEach((c) => {
    if (c.grp !== lastGrp) { rowsHtml += `<tr class="grp"><td colspan="2">${esc(c.grp)}</td></tr>`; lastGrp = c.grp; }
    const cls = c.disp >= 0 ? 'reg-pos' : 'reg-neg';
    const sig = c.sig ? '<span class="sig on">clear effect</span>' : '<span class="sig">not statistically clear</span>';
    rowsHtml += `<tr><td class="lbl">${esc(c.label)}${sig}</td><td class="num ${cls}">${fmtSigned(c.disp)}</td></tr>`;
  });
  const baseRow = `<tr class="base"><td class="lbl">Baseline: 2023 · Select · RWD · Std Range · White · WA</td><td class="num">$${Math.round(reg.intercept).toLocaleString('en-US')}</td></tr>`;
  const stats = `<div class="stat-grid reg-stats">`
    + `<div class="stat"><div class="n">${reg.n}</div><div class="l">cars modeled</div></div>`
    + `<div class="stat"><div class="n">${(reg.r2 * 100).toFixed(0)}%</div><div class="l">of price variation explained</div></div>`
    + `<div class="stat"><div class="n">±$${Math.round(reg.rmse).toLocaleString('en-US')}</div><div class="l">typical error</div></div></div>`;
  return `<div class="card">`
    + `<h2>📊 What drives the price</h2>`
    + `<p class="chart-cap">A multi-factor regression across the current ${reg.n} priced listings. Each figure is that factor's <b>independent</b> effect on asking price — holding everything else equal, not just its raw average.</p>`
    + `<table class="reg-table"><tbody>${baseRow}${rowsHtml}</tbody></table>`
    + stats
    + takeawaysHtml(reg)
    + `</div>`;
}

function caveatCard(reg) {
  return `<div class="card"><p class="muted tiny" style="line-height:1.6;margin:0">`
    + `<b>How to read this.</b> Figures are modeled estimates from a single day's listings`
    + `${DATA.updated ? ' (' + esc(DATA.updated) + ')' : ''}, not a guarantee on any one car. "Over time" here means model year and mileage — the page keeps no nightly price history, so this is a snapshot, not a historical trend line. "Clear effect" means the pattern is strong enough it's unlikely to be noise; "not statistically clear" means the current sample can't separate it from zero. These are <b>asking</b> prices — real sale prices run lower.`
    + `</p></div>`;
}

function renderAnalysis() {
  const host = $('#analysis');
  if (!host) return;
  const cars = DATA.cars || [];
  const reg = runRegression(cars);
  const byYear = priceByYear(cars);
  const yearCard = `<div class="card"><h2>📅 Price by model year</h2>`
    + `<p class="chart-cap">Median asking price for each model year in the current ${cars.length}-car snapshot. Newer years sit higher — the model below turns that into an all-else-equal dollar figure.</p>`
    + yearBarSvg(byYear) + `</div>`;
  const mileCard = `<div class="card"><h2>📉 Price vs mileage</h2>`
    + mileageScatterSvg(cars)
    + `<div class="chart-legend"><span class="k"><span class="dot" style="background:#6ea8fe"></span>AWD</span>`
    + `<span class="k"><span class="dot" style="background:#9aa6c7"></span>RWD</span>`
    + `<span class="k"><span class="dot" style="width:16px;height:0;border-radius:0;border-top:2px solid #34d399"></span>trend</span></div>`
    + `<p class="chart-cap">Each dot is one listing; the green line is the fitted price-vs-mileage trend.</p></div>`;
  host.innerHTML = yearCard + mileCard + regCard(reg) + caveatCard(reg);
}

// ---------- tabs ----------
function switchTab(name) {
  const cars = $('#panel-cars'), analysis = $('#panel-analysis');
  if (!cars || !analysis) return;
  const showAnalysis = name === 'analysis';
  cars.hidden = showAnalysis;
  analysis.hidden = !showAnalysis;
  document.querySelectorAll('#tabbar .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  // The picks bar only makes sense on the car list.
  const sb = $('#sendbar'); if (sb) sb.hidden = showAnalysis || !sb.dataset.ready;
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function setupTabs() {
  const bar = $('#tabbar');
  if (!bar) return;
  bar.hidden = false;
  bar.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  // Front-page shortcut: the prominent banner at the top of the car list jumps
  // straight to the analysis tab (rendered by renderIntro, so it exists here).
  const cta = $('#analysis-cta');
  if (cta) cta.addEventListener('click', () => switchTab('analysis'));
}

// ---------- sort ----------
const SORTS = [
  { id: 'match-desc', label: '⭐ Best match for Kate' },
  { id: 'price-asc', label: 'Price: low to high' },
  { id: 'price-desc', label: 'Price: high to low' },
  { id: 'miles-asc', label: 'Mileage: low to high' },
  { id: 'distance-asc', label: 'Distance: closest' },
  { id: 'year-desc', label: 'Year: newest first' },
];
function sortCars(list) {
  const cmp = {
    'match-desc': (a, b) => (b.matchScore ?? -Infinity) - (a.matchScore ?? -Infinity) || (a.price ?? Infinity) - (b.price ?? Infinity),
    'price-asc': (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
    'price-desc': (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
    'miles-asc': (a, b) => (a.miles ?? Infinity) - (b.miles ?? Infinity),
    'distance-asc': (a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity),
    'year-desc': (a, b) => (b.year ?? 0) - (a.year ?? 0) || (a.price ?? Infinity) - (b.price ?? Infinity),
  }[SORT] || (() => 0);
  return [...list].sort(cmp);
}

// ---------- faceted filters ----------
// The wishlist features that used to sit at the top of the page are now live
// filters. Within a group the tests OR together (AWD *or* RWD); across groups
// they AND (AWD *and* glass roof *and* under $31k). An option only renders when
// at least one car in the data matches it, so the bar always reflects the actual
// inventory — no dead buttons.
const FACET_GROUPS = [
  { id: 'drivetrain', cat: 'Drivetrain', opts: [
    { v: 'AWD', label: 'AWD', test: (c) => c.drivetrain === 'AWD' },
    { v: 'RWD', label: 'RWD', test: (c) => c.drivetrain === 'RWD' },
  ] },
  { id: 'battery', cat: 'Battery', opts: [
    { v: 'ext', label: '🔋 Extended Range', test: (c) => /extended/i.test(c.battery || '') },
    { v: 'std', label: 'Standard Range', test: (c) => /standard/i.test(c.battery || '') },
  ] },
  { id: 'trim', cat: 'Trim', opts: [
    { v: 'Premium', label: 'Premium', test: (c) => /premium/i.test(c.trim || '') },
    { v: 'Select', label: 'Select', test: (c) => /select/i.test(c.trim || '') },
    { v: 'GT', label: 'GT', test: (c) => /\bgt\b/i.test(c.trim || '') },
    { v: 'Route1', label: 'CA Route 1', test: (c) => /route\s*1/i.test(c.trim || '') },
  ] },
  { id: 'roof', cat: 'Features', opts: [
    { v: 'roof', label: '☀️ Glass roof', test: (c) => c.glassRoof === 'yes' || c.glassRoof === 'likely' },
  ] },
  { id: 'bluecruise', cat: 'Features', opts: [
    { v: 'bc', label: '🔵 BlueCruise', test: (c) => c.bluecruise === 'yes' },
  ] },
  { id: 'cert', cat: 'Features', opts: [
    { v: 'cert', label: '✅ Certified', test: (c) => /certified/i.test(c.cert || '') },
  ] },
  { id: 'close', cat: 'Features', opts: [
    { v: 'close', label: '📍 Under 30 mi', test: (c) => c.distanceMi != null && c.distanceMi <= 30 },
  ] },
  { id: 'lowmiles', cat: 'Features', opts: [
    { v: 'lowmiles', label: 'Under 40k miles', test: (c) => c.miles != null && c.miles <= 40000 },
  ] },
  { id: 'price', cat: 'Price', opts: [
    { v: 'u28', label: 'Under $28k', test: (c) => c.price != null && c.price < 28000 },
    { v: 'u31', label: 'Under $31k', test: (c) => c.price != null && c.price < 31000 },
  ] },
  { id: 'show', cat: 'Show', opts: [
    { v: 'new', label: '🆕 Just added', test: (c) => !!c.new },
    { v: 'liked', label: '👍 My picks', test: (c) => VOTES[c.vin] === 'up' },
  ] },
];

function availableOpts(g) {
  const cars = DATA.cars || [];
  return g.opts.filter((o) => cars.some((c) => o.test(c)));
}
function activeFacetCount() {
  return Object.values(FACETS).reduce((n, s) => n + (s ? s.size : 0), 0);
}
function matchesFacets(c) {
  for (const g of FACET_GROUPS) {
    const sel = FACETS[g.id];
    if (!sel || sel.size === 0) continue;              // group inactive — skip
    const chosen = g.opts.filter((o) => sel.has(o.v));
    if (!chosen.some((o) => o.test(c))) return false;  // within-group OR, across-group AND
  }
  return true;
}
function toggleFacet(gid, v) {
  const set = FACETS[gid] || (FACETS[gid] = new Set());
  if (set.has(v)) set.delete(v);
  else set.add(v);
  renderFilters();
  renderCars();
}
function clearFacets() {
  for (const k of Object.keys(FACETS)) delete FACETS[k];
  renderFilters();
  renderCars();
}

function renderFilters() {
  const bar = $('#filterbar');
  bar.hidden = false;
  const sortOpts = SORTS.map((s) =>
    `<option value="${s.id}"${s.id === SORT ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
  let html = `<div class="ctl-block sort-block">
      <label class="ctl-label" for="sortsel">Sort</label>
      <select id="sortsel" class="sortsel" aria-label="Sort cars">${sortOpts}</select>
    </div>`;
  // Facet chips, clustered under their category label.
  let lastCat = null;
  for (const g of FACET_GROUPS) {
    // The "My picks" toggle is a persistent control — always show it (even with
    // zero likes yet) rather than hiding it via availableOpts, so it's reachable
    // and can always be toggled back off.
    const opts = g.id === 'show' ? g.opts : availableOpts(g);
    if (!opts.length) continue;
    if (g.cat !== lastCat) {
      if (lastCat !== null) html += `</div></div>`;
      html += `<div class="ctl-block"><div class="ctl-label">${esc(g.cat)}</div><div class="chiprow">`;
      lastCat = g.cat;
    }
    const sel = FACETS[g.id];
    html += opts.map((o) =>
      `<button class="fbtn${sel && sel.has(o.v) ? ' active' : ''}" data-g="${esc(g.id)}" data-v="${esc(o.v)}">${esc(o.label)}</button>`).join('');
  }
  if (lastCat !== null) html += `</div></div>`;
  const n = activeFacetCount();
  html += `<div class="filtermeta">
      <span id="result-count"></span>
      <button class="clear-btn" id="clear-filters"${n ? '' : ' hidden'}>Clear filters (${n})</button>
    </div>`;
  bar.innerHTML = html;
  const ss = $('#sortsel');
  if (ss) ss.addEventListener('change', () => { SORT = ss.value; renderCars(); });
  bar.querySelectorAll('.fbtn').forEach((btn) => {
    btn.addEventListener('click', () => toggleFacet(btn.dataset.g, btn.dataset.v));
  });
  const clr = $('#clear-filters');
  if (clr) clr.addEventListener('click', clearFacets);
}

function renderCars() {
  const grid = $('#cars-grid');
  const list = sortCars((DATA.cars || []).filter(matchesFacets));
  const countEl = $('#result-count');
  if (countEl) {
    const total = (DATA.cars || []).length;
    countEl.textContent = list.length === total ? `${total} cars` : `${list.length} of ${total} cars`;
  }
  if (!list.length) {
    grid.innerHTML = `<p class="muted" style="text-align:center;padding:30px 10px">No cars match these filters. <button class="clear-btn" id="clear-empty">Clear filters</button></p>`;
    const ce = $('#clear-empty');
    if (ce) ce.addEventListener('click', clearFacets);
    return;
  }
  grid.innerHTML = list.map(carCard).join('');
  grid.querySelectorAll('.vbtn').forEach((btn) => {
    btn.addEventListener('click', () => vote(btn.dataset.vin, btn.dataset.v));
  });
  // Kate's per-car note — save on every keystroke (so a half-typed note isn't
  // lost if she then taps a vote and the grid re-renders) and keep the send bar
  // live so a comment alone is enough to send, even without a 👍/👎.
  grid.querySelectorAll('.comment').forEach((ta) => {
    ta.addEventListener('input', () => {
      setComment(ta.dataset.vin, ta.value);
      updateTally();
    });
  });
  // Tap a car thumbnail → opens the full Autotrader listing (the thumb is an
  // <a>). No in-app zoom viewer — the thumbnail is enough here.
  // If a listing thumbnail fails to load (e.g. the car sold and its image 404'd),
  // drop just the thumbnail so the card degrades cleanly instead of showing a broken image.
  grid.querySelectorAll('.thumb img').forEach((img) => {
    img.addEventListener('error', () => {
      const wrap = img.closest('.thumb');
      if (wrap) wrap.remove();
    });
  });
}

function carCard(c) {
  const v = VOTES[c.vin] || null;
  const cls = v === 'up' ? ' v-up' : v === 'down' ? ' v-down' : '';
  const dt = c.drivetrain === 'AWD'
    ? '<span class="badge awd">AWD</span>'
    : '<span class="badge rwd">RWD</span>';
  const star = c.standout ? '<span class="badge star">⭐ Standout</span>' : '';
  const isNew = c.new ? '<span class="badge new">🆕 Just added</span>' : '';
  const cert = /certified/i.test(c.cert || '') ? '<span class="badge">✅ Certified</span>' : '';
  const priceHtml = c.price != null
    ? `<div class="price">${money(c.price)}${c.priceNote ? `<span class="note">${esc(c.priceNote)}</span>` : ''}</div>`
    : `<div class="price"><span class="calld">Call for price</span></div>`;
  const highlights = (c.highlights || []).map((h) => `<span class="hl">${esc(h)}</span>`).join('');
  // Battery is a must-have (Extended Range) — call it out positively; a
  // Standard Range car (on the avoid list) would get a warning treatment.
  const battClass = /standard\s*range/i.test(c.battery || '') ? 'batt-std' : 'batt-ext';
  const battIcon = battClass === 'batt-std' ? '⚠️' : '🔋';
  const battOk = battClass === 'batt-ext' ? ' ✓' : '';
  const battHtml = c.battery
    ? `<span class="badge ${battClass}">${battIcon} ${esc(c.battery)}${battOk}${c.rangeMi ? ` · ~${c.rangeMi} mi` : ''}</span>`
    : '';
  // Confirmed optional extras — verified per-car from the window sticker
  // (e.g. 360° camera, Nite Pony). Shown ONLY where confirmed, so not every
  // car has these — that's the point.
  const extras = (c.confirmedExtras || []).map((x) => `<span class="hl ok">✓ ${esc(x)}</span>`).join('');
  const alt = `${esc(c.year)} Mach-E ${esc(c.trim)} in ${esc(c.color)}`;
  // Compact thumbnail, hotlinked from Autotrader's image CDN. "A thumbnail is
  // sufficient here" — shown small next to the title; tapping it opens the full
  // listing (no in-app zoom viewer). lazy/async keeps it cheap. If it 404s later
  // (e.g. the car sells), renderCars() drops just the thumb so the card stays clean.
  const thumbInner = c.photo
    ? `<img src="${esc(c.photo)}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : '';
  const thumbHtml = c.photo
    ? (c.url
        ? `<a class="thumb" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open listing — ${alt}">${thumbInner}</a>`
        : `<span class="thumb">${thumbInner}</span>`)
    : '';
  return `
    <div class="carcard${cls}">
      <div class="cardhead">
        ${thumbHtml}
        <div class="headinfo">
          <div class="top">
            <h2>${esc(c.year)} Mach-E ${esc(c.trim)}</h2>
            ${priceHtml}
          </div>
          <div class="badges">
            ${isNew}
            ${dt}
            ${battHtml}
            ${roofBadge(c.glassRoof)}
            ${bcBadge(c.bluecruise)}
            ${cert}
            ${star}
          </div>
        </div>
      </div>
      ${keySpecs(c)}
      ${highlights ? `<div class="highlights">${highlights}</div>` : ''}
      ${extras ? `<div class="extras"><span class="extras-label">✓ Confirmed on this car's window sticker</span><div class="extras-row">${extras}</div></div>` : ''}
      ${c.note ? `<p class="carnote"><b>📝 Notable:</b> ${esc(c.note)}</p>` : ''}
      <div class="carfoot">
        <div class="vote">
          <button class="vbtn up${v === 'up' ? ' on' : ''}" data-vin="${esc(c.vin)}" data-v="up" aria-label="Like">👍</button>
          <button class="vbtn down${v === 'down' ? ' on' : ''}" data-vin="${esc(c.vin)}" data-v="down" aria-label="Pass">👎</button>
        </div>
        ${c.url ? `<a class="listing-link" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">More info ↗</a>` : ''}
      </div>
      <div class="comment-row">
        <textarea class="comment" data-vin="${esc(c.vin)}" rows="2"
          placeholder="Add a note for Jonathan — what do you think? (optional)"
          aria-label="Your note on this car">${esc(COMMENTS[c.vin] || '')}</textarea>
      </div>
    </div>`;
}

function vote(vin, v) {
  if (VOTES[vin] === v) delete VOTES[vin]; // tapping the same vote again clears it
  else VOTES[vin] = v;
  saveVotes();
  // Re-render so the "My picks" filter + card styling stay in sync. renderFilters
  // refreshes the active-filter count and keeps the "My picks" result live when
  // that facet is engaged.
  renderFilters();
  renderCars();
  updateTally();
}

function updateTally() {
  const up = Object.values(VOTES).filter((v) => v === 'up').length;
  const down = Object.values(VOTES).filter((v) => v === 'down').length;
  const notes = Object.values(COMMENTS).filter((t) => t && t.trim()).length;
  $('#tally').innerHTML = `<b>${up}</b> 👍 &nbsp; <b>${down}</b> 👎 &nbsp; <b>${notes}</b> 💬`;
  // A comment on its own is worth sending — enable the button for votes OR notes.
  $('#send-btn').disabled = (up + down + notes === 0);
}

// ---------- send picks ----------
function buildSummary() {
  const byVin = {};
  (DATA.cars || []).forEach((c) => { byVin[c.vin] = c; });
  const label = (c) => {
    const price = c.price != null ? money(c.price) : 'call for price';
    return `${c.year} Mach-E ${c.trim} — ${c.drivetrain}, ${price}, ${c.color} (${c.location})`;
  };
  const noteOf = (vin) => {
    const t = (COMMENTS[vin] || '').trim();
    return t ? `\n    💬 "${t}"` : '';
  };
  const up = [], down = [], notesOnly = [];
  const voted = new Set();
  Object.entries(VOTES).forEach(([vin, v]) => {
    const c = byVin[vin];
    if (!c) return;
    voted.add(vin);
    (v === 'up' ? up : down).push(label(c) + noteOf(vin));
  });
  // Cars Kate commented on but didn't 👍/👎 — surface the note so her
  // feedback ("would this fit in the garage?") is never dropped.
  Object.keys(COMMENTS).forEach((vin) => {
    const c = byVin[vin];
    if (!c || voted.has(vin)) return;
    const t = (COMMENTS[vin] || '').trim();
    if (t) notesOnly.push(`${label(c)}\n    💬 "${t}"`);
  });
  let out = `Kate's car picks (${DATA.updated || ''})\n`;
  out += `\n👍 Liked (${up.length}):\n` + (up.length ? up.map((x) => '  • ' + x).join('\n') : '  (none)');
  out += `\n\n👎 Passed (${down.length}):\n` + (down.length ? down.map((x) => '  • ' + x).join('\n') : '  (none)');
  if (notesOnly.length) {
    out += `\n\n💬 Notes (${notesOnly.length}):\n` + notesOnly.map((x) => '  • ' + x).join('\n');
  }
  out += `\n\n(Sent from the car page)`;
  return out;
}

async function sendPicks() {
  const summary = buildSummary();
  const shareData = { title: "Kate's car picks", text: summary };
  // Native share sheet (iOS/Android) — lets Kate pick Messages, Mail, whatever.
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch (err) { if (err && err.name === 'AbortError') return; /* fall through to clipboard */ }
  }
  // Fallback: copy to clipboard.
  try {
    await navigator.clipboard.writeText(summary);
    toast('Picks copied — paste them to Jonathan 👍');
    return;
  } catch { /* fall through */ }
  // Last resort: show the text so she can copy manually.
  toast('Copy your picks below and send them to Jonathan');
  const pre = document.createElement('textarea');
  pre.value = summary;
  pre.style.cssText = 'position:fixed;left:5%;top:15%;width:90%;height:60%;z-index:99;padding:12px;border-radius:12px;background:#141b30;color:#eef2ff;border:1px solid #2a355c;font-size:13px';
  pre.readOnly = true;
  document.body.appendChild(pre);
  pre.select();
  pre.addEventListener('blur', () => pre.remove());
}

// ---------- share the car page link ----------
// Rebuilds the keyed access URL (cars.html#k=<key>) from the in-memory key — or the
// one we remembered in localStorage — and hands it to the native share sheet, so the
// link can be re-sent (or re-opened) without digging up the original invite. boot()
// strips #k= from the address bar for privacy, so we reconstruct the URL here rather
// than reading location.hash. Clipboard + manual-copy fallbacks mirror sendPicks().
const CARS_PUBLIC_URL = 'https://jonathancarlson.github.io/france-2026/cars.html';
function currentCarKey() {
  if (KEY) return KEY;
  try { return localStorage.getItem(CARKEY_KEY) || ''; } catch { return ''; }
}
async function shareLink() {
  const k = currentCarKey();
  if (!k) { toast('No link to share yet — open the car page from your invite first'); return; }
  const url = `${CARS_PUBLIC_URL}#k=${k}`;
  const shareData = { title: "Kate's Mach-E shortlist", text: 'The cars we\u2019re tracking — 👍/👎 the ones you like:', url };
  // Native share sheet (iOS/Android) — Messages, Mail, whatever.
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch (err) { if (err && err.name === 'AbortError') return; /* fall through to clipboard */ }
  }
  // Fallback: copy the link to the clipboard.
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied — paste it to share the car page 🔗');
    return;
  } catch { /* fall through */ }
  // Last resort: show the link so it can be copied manually.
  toast('Copy the link below to share the car page');
  const box = document.createElement('textarea');
  box.value = url;
  box.style.cssText = 'position:fixed;left:5%;top:30%;width:90%;height:80px;z-index:99;padding:12px;border-radius:12px;background:#141b30;color:#eef2ff;border:1px solid #2a355c;font-size:13px';
  box.readOnly = true;
  document.body.appendChild(box);
  box.select();
  box.addEventListener('blur', () => box.remove());
}

let toastTimer = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}
