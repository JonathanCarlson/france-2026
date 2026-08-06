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
let FILTER = 'all';     // all | close | awd | roof | cheap | liked
const STORE_KEY = 'kate-cars-votes-v1';

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

// ---------- boot ----------
(function boot() {
  loadVotes();
  const m = /[#&]k=([^&]+)/.exec(location.hash || '');
  if (m) {
    KEY = decodeURIComponent(m[1]).trim();
    // Strip the key from the visible URL bar (it stays in memory) so a casual
    // over-the-shoulder glance / screenshot of the address doesn't reveal it.
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
    openApp();
  } else {
    $('#gate').hidden = false;
    $('#gate-form').addEventListener('submit', onGate);
  }
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

// ---------- render ----------
function render() {
  $('#cars-status').hidden = true;
  document.title = DATA.title || 'Mach-E shortlist';
  $('#app-title').textContent = DATA.title || 'Mach-E shortlist';
  $('#app-sub').textContent = (DATA.subtitle || '') + (DATA.updated ? ' · updated ' + DATA.updated : '');

  renderIntro();
  renderTrends();
  renderFilters();
  renderCars();

  $('#sendbar').hidden = false;
  $('#send-btn').addEventListener('click', sendPicks);
  updateTally();
}

function renderIntro() {
  const w = DATA.wants || {};
  const chips = [];
  (w.mustHaves || []).forEach((x) => chips.push(`<span class="want-chip must">✓ ${esc(x)}</span>`));
  (w.niceToHaves || []).forEach((x) => chips.push(`<span class="want-chip">${esc(x)}</span>`));
  (w.avoid || []).forEach((x) => chips.push(`<span class="want-chip avoid">${esc(x)}</span>`));
  $('#intro').innerHTML = `
    <div class="card">
      <p style="margin:0 0 6px">${esc(DATA.intro || '')}</p>
      ${chips.length ? `<div class="want-row">${chips.join('')}</div>` : ''}
    </div>`;
}

function renderTrends() {
  const t = DATA.trends;
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
      <ul class="trend-list">${(t.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
      ${statCells.length ? `<div class="stat-grid">${statCells.join('')}</div>` : ''}
      ${s.label ? `<p class="muted tiny" style="margin:10px 0 0">${esc(s.label)}</p>` : ''}
    </div>`;
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'close', label: '📍 Under 30 mi' },
  { id: 'awd', label: 'AWD' },
  { id: 'roof', label: '☀️ Glass roof' },
  { id: 'cheap', label: 'Under $33k' },
  { id: 'liked', label: '👍 My picks' },
];

function renderFilters() {
  const bar = $('#filterbar');
  bar.hidden = false;
  bar.innerHTML = FILTERS.map((f) =>
    `<button class="fbtn${f.id === FILTER ? ' active' : ''}" data-f="${f.id}">${esc(f.label)}</button>`).join('');
  bar.querySelectorAll('.fbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      FILTER = btn.dataset.f;
      renderFilters();
      renderCars();
    });
  });
}

function matchesFilter(c) {
  switch (FILTER) {
    case 'close': return (c.distanceMi != null && c.distanceMi <= 30);
    case 'awd': return c.drivetrain === 'AWD';
    case 'roof': return c.glassRoof === 'yes' || c.glassRoof === 'likely';
    case 'cheap': return (c.price != null && c.price < 33000);
    case 'liked': return VOTES[c.vin] === 'up';
    default: return true;
  }
}

function renderCars() {
  const grid = $('#cars-grid');
  const list = (DATA.cars || []).filter(matchesFilter);
  if (!list.length) {
    grid.innerHTML = `<p class="muted" style="text-align:center;padding:30px 10px">No cars match this filter yet.</p>`;
    return;
  }
  grid.innerHTML = list.map(carCard).join('');
  grid.querySelectorAll('.vbtn').forEach((btn) => {
    btn.addEventListener('click', () => vote(btn.dataset.vin, btn.dataset.v));
  });
}

function carCard(c) {
  const v = VOTES[c.vin] || null;
  const cls = v === 'up' ? ' v-up' : v === 'down' ? ' v-down' : '';
  const dt = c.drivetrain === 'AWD'
    ? '<span class="badge awd">AWD</span>'
    : '<span class="badge rwd">RWD</span>';
  const star = c.standout ? '<span class="badge star">⭐ Standout</span>' : '';
  const cert = /certified/i.test(c.cert || '') ? '<span class="badge">✅ Certified</span>' : '';
  const priceHtml = c.price != null
    ? `<div class="price">${money(c.price)}${c.priceNote ? `<span class="note">${esc(c.priceNote)}</span>` : ''}</div>`
    : `<div class="price"><span class="calld">Call for price</span></div>`;
  const distTxt = c.distanceMi != null ? `${c.distanceMi} mi away` : '';
  const highlights = (c.highlights || []).map((h) => `<span class="hl">${esc(h)}</span>`).join('');
  return `
    <div class="carcard${cls}">
      <div class="top">
        <h2>${esc(c.year)} Mach-E ${esc(c.trim)}</h2>
        ${priceHtml}
      </div>
      <div class="badges">
        ${dt}
        <span class="badge">🔋 ${esc(c.battery)}${c.rangeMi ? ` · ~${c.rangeMi} mi` : ''}</span>
        ${roofBadge(c.glassRoof)}
        ${cert}
        ${star}
      </div>
      <p class="carmeta">
        <b>${esc(c.color)}</b> · ${miles(c.miles)}${distTxt ? ` · 📍 ${esc(c.location)} (${esc(distTxt)})` : ` · 📍 ${esc(c.location)}`}
      </p>
      ${highlights ? `<div class="highlights">${highlights}</div>` : ''}
      ${c.note ? `<p class="carnote">${esc(c.note)}</p>` : ''}
      <div class="carfoot">
        <div class="vote">
          <button class="vbtn up${v === 'up' ? ' on' : ''}" data-vin="${esc(c.vin)}" data-v="up" aria-label="Like">👍</button>
          <button class="vbtn down${v === 'down' ? ' on' : ''}" data-vin="${esc(c.vin)}" data-v="down" aria-label="Pass">👎</button>
        </div>
        ${c.url ? `<a class="listing-link" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Listing ↗</a>` : ''}
      </div>
    </div>`;
}

function vote(vin, v) {
  if (VOTES[vin] === v) delete VOTES[vin]; // tapping the same vote again clears it
  else VOTES[vin] = v;
  saveVotes();
  // Re-render so the "My picks" filter + card styling stay in sync.
  renderCars();
  updateTally();
}

function updateTally() {
  const up = Object.values(VOTES).filter((v) => v === 'up').length;
  const down = Object.values(VOTES).filter((v) => v === 'down').length;
  $('#tally').innerHTML = `<b>${up}</b> 👍 &nbsp; <b>${down}</b> 👎`;
  $('#send-btn').disabled = (up + down === 0);
}

// ---------- send picks ----------
function buildSummary() {
  const byVin = {};
  (DATA.cars || []).forEach((c) => { byVin[c.vin] = c; });
  const label = (c) => {
    const price = c.price != null ? money(c.price) : 'call for price';
    return `${c.year} Mach-E ${c.trim} — ${c.drivetrain}, ${price}, ${c.color} (${c.location})`;
  };
  const up = [], down = [];
  Object.entries(VOTES).forEach(([vin, v]) => {
    const c = byVin[vin];
    if (!c) return;
    (v === 'up' ? up : down).push(label(c));
  });
  let out = `Kate's car picks (${DATA.updated || ''})\n`;
  out += `\n👍 Liked (${up.length}):\n` + (up.length ? up.map((x) => '  • ' + x).join('\n') : '  (none)');
  out += `\n\n👎 Passed (${down.length}):\n` + (down.length ? down.map((x) => '  • ' + x).join('\n') : '  (none)');
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
