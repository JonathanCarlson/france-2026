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
  renderFilters();
  renderCars();

  $('#sendbar').hidden = false;
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
    </div>`;
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
