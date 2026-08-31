'use strict';

// jordyn.js — the shareable, cars-ONLY browser for Jordyn's first-car search.
//
// A sibling of cars.js (Kate's Mach-E page). Same access model and crypto, but
// its OWN key + data bundle so the two family car pages never share access:
// the key lives in the URL fragment  jordyn.html#k=<key>  (never sent to the
// server) and decrypts ONLY data/jordyn.enc.json. If the link has no #k=, we
// fall back to a manual code box. Nothing here can touch the itinerary,
// tickets, contacts, or Kate's car list.
//
// How this page differs from Kate's: it's a BUYER'S search, ranked the way a
// first car for a teen should be — safety first (automatic emergency braking +
// blind-spot monitoring are the two that matter most), then cost-to-own, then
// EV range/fit. The match score is SAFETY-weighted and recomputed from the data
// at load, never baked into HTML.
//
// Crypto matches the rest of the app: PBKDF2(SHA-256, 250000) -> AES-GCM-256.
//   data/jordyn.enc.json   JSON payload {v,kdf,salt,iv,ct} -> the car data

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

let KEY = null;         // the car key string
let DATA = null;        // decrypted car data
let VOTES = {};         // { id: 'up' | 'down' }
let COMMENTS = {};      // { id: 'free-text note from Jordyn/Jonathan' }
let SORT = 'safety-desc'; // safety-desc | price-asc | price-desc | range-desc | year-desc
const FACETS = {};      // { groupId: Set(values) } — active faceted filters (within-group OR, across-group AND)
const STORE_KEY = 'jordyn-cars-votes-v1';
const COMMENTS_KEY = 'jordyn-cars-comments-v1';

// Stable per-car key. Kate's page keys votes by VIN, but Jordyn's benchmark
// cars aren't all VIN'd (the Leaf is a spec benchmark), so we key by the
// data's own id, which is always present and unique.
const keyOf = (c) => c.id || c.vin || '';

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
    const res = await fetch('data/jordyn.enc.json', { cache: 'no-cache' });
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
function loadComments() {
  try { COMMENTS = JSON.parse(localStorage.getItem(COMMENTS_KEY) || '{}') || {}; }
  catch { COMMENTS = {}; }
}
function saveComments() {
  try { localStorage.setItem(COMMENTS_KEY, JSON.stringify(COMMENTS)); } catch { /* private mode */ }
}
function setComment(id, text) {
  const t = (text || '').trim();
  if (t) COMMENTS[id] = t;
  else delete COMMENTS[id];
  saveComments();
}

// ---------- boot ----------
const CARKEY_KEY = 'jordyn-cars-key-v1';
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
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
    openApp();
    return;
  }
  let saved = null;
  try { saved = localStorage.getItem(CARKEY_KEY); } catch { /* ignore */ }
  if (saved) {
    KEY = saved;
    const ok = await tryLoadData();
    if (ok) { openApp(true); return; }
    KEY = null;
    forgetKey();
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
    rememberKey(KEY);
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
const milesFmt = (n) => Number(n).toLocaleString('en-US') + ' mi';
const carName = (c) => [c.year, c.make, c.model, c.trim].filter(Boolean).join(' ');

// ---------- safety-first scoring ----------
// Recomputed from the data at load — never baked into the JSON — so the ranking
// stays honest as cars are added. Safety dominates (a teen's first car), then
// budget fit, then powertrain/EV-range preference, with a real penalty for a
// branded/salvage title.
function scoreCar(c) {
  let s = 0;
  // Automatic emergency braking — the single most important teen-safety feature.
  s += ({ 'yes': 30, 'yes-city': 22, 'unknown': 8, 'no': 0 })[c.aeb] ?? 8;
  // Blind-spot monitoring — the second.
  s += ({ 'yes': 25, 'unknown': 6, 'no': 0 })[c.bsm] ?? 6;
  // Credit for other confirmed active-safety kit, capped so it can't outweigh the two must-haves.
  s += Math.min((Array.isArray(c.safety) ? c.safety.length : 0) * 4, 15);
  // Budget fit ($10–15k sweet spot; cheaper is fine; over-budget is penalized).
  const b = DATA.budget || { min: 10000, max: 15000 };
  if (c.price != null) {
    if (c.price >= b.min && c.price <= b.max) s += 10;
    else if (c.price < b.min) s += 8;
    else s -= Math.min(Math.round((c.price - b.max) / 1000) * 2, 20);
  }
  // Powertrain preference: EV first, then PHEV, then Hybrid.
  s += ({ 'EV': 6, 'PHEV': 4, 'Hybrid': 2, 'ICE': 0 })[c.powertrain] ?? 0;
  // EV range bonus (real electric range only).
  if (c.powertrain === 'EV' && c.rangeMi) s += Math.min(c.rangeMi / 40, 8);
  // Title penalty — a branded/salvage title caps resale and can mask damage.
  if (c.titleStatus === 'branded') s -= 18;
  else if (c.titleStatus === 'salvage') s -= 30;
  return s;
}

// ---------- render ----------
function render() {
  $('#cars-status').hidden = true;
  document.title = DATA.title || "Jordyn's first car";
  $('#app-title').textContent = DATA.title || "Jordyn's first car";
  $('#app-sub').textContent = (DATA.subtitle || '') + (DATA.updated ? ' · updated ' + DATA.updated : '');

  // Precompute + attach the safety score so sort/filter and the card can reuse it.
  (DATA.cars || []).forEach((c) => { c._score = scoreCar(c); });

  renderIntro();
  renderGuide();
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
  const b = DATA.budget || {};
  const budgetStat = (b.min != null && b.max != null)
    ? `<div class="stat-grid">
        <div class="stat"><div class="n">${money(b.min)}–${money(b.max).replace('$', '')}</div><div class="l">target budget</div></div>
        <div class="stat"><div class="n">🛡️ Safety</div><div class="l">ranked first</div></div>
        <div class="stat"><div class="n">⚡ EV-first</div><div class="l">then TCO</div></div>
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
      ${budgetStat}
      ${links ? `<div class="resource-row">${links}</div>` : ''}
    </div>
    <button id="guide-cta" class="analysis-cta" type="button" aria-label="Open the buyer's guide">
      <span class="ac-icon" aria-hidden="true">📋</span>
      <span class="ac-text">
        <b>Read the buyer's guide</b>
        <span class="ac-sub">What to look for by model — Bolt, Leaf, Volt, Ioniq, Prius &amp; more, with AEB/blind-spot availability</span>
      </span>
      <span class="ac-arrow" aria-hidden="true">→</span>
    </button>`;
}

// ---------- buyer's guide (replaces Kate's price-regression tab) ----------
// These cars' safety kit varies a lot by year/trim/package, so the guide is a
// model-by-model explainer of range + AEB/blind-spot availability + TCO notes,
// straight from the data. It's the teaching companion to the ranked list.
function renderGuide() {
  const g = DATA.guide;
  if (!g) { $('#guide').innerHTML = ''; return; }
  const fitTag = (fit) => {
    const map = { top: ['🏆 Best safety-per-$', 'tag-top'], strong: ['✅ Strong fit', ''], good: ['👍 Worth a look', ''], watch: ['👀 Situational', ''] };
    const [label, cls] = map[fit] || ['', ''];
    return label ? `<span class="gpt ${cls}">${esc(label)}</span>` : '';
  };
  const row = (dt, dd, topClass) => dd ? `<dt>${esc(dt)}</dt><dd${topClass ? ' class="tag-top"' : ''}>${esc(dd)}</dd>` : '';
  const cards = (g.models || []).map((m) => `
    <div class="gcard${m.fit === 'top' ? ' fit-top' : ''}">
      <div class="ghead">
        <h3>${esc(m.model)}</h3>
        <span class="gyears">${esc(m.years || '')}</span>
      </div>
      ${fitTag(m.fit)}
      <dl class="grow">
        ${row('Power', m.powertrain)}
        ${row('Range', m.range)}
        ${row('Price', m.priceBand)}
        ${row('AEB', m.aeb)}
        ${row('Blind-spot', m.bsm)}
        ${row('TCO', m.tco)}
      </dl>
    </div>`).join('');
  $('#guide').innerHTML = `
    <div class="card">
      <h2 style="margin:0">📋 ${esc(g.headline || "Buyer's guide")}</h2>
      ${g.note ? `<p class="guide-note">${esc(g.note)}</p>` : ''}
    </div>
    ${cards}`;
}

// ---------- tabs ----------
function switchTab(name) {
  const cars = $('#panel-cars'), guide = $('#panel-guide');
  if (!cars || !guide) return;
  const showGuide = name === 'guide';
  cars.hidden = showGuide;
  guide.hidden = !showGuide;
  document.querySelectorAll('#tabbar .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  const sb = $('#sendbar'); if (sb) sb.hidden = showGuide || !sb.dataset.ready;
  window.scrollTo({ top: 0, behavior: 'auto' });
}
function setupTabs() {
  const bar = $('#tabbar');
  if (!bar) return;
  bar.hidden = false;
  bar.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  const cta = $('#guide-cta');
  if (cta) cta.addEventListener('click', () => switchTab('guide'));
}

// ---------- sort ----------
const SORTS = [
  { id: 'safety-desc', label: '🛡️ Safest first (recommended)' },
  { id: 'price-asc', label: 'Price: low to high' },
  { id: 'price-desc', label: 'Price: high to low' },
  { id: 'range-desc', label: 'EV range: high to low' },
  { id: 'year-desc', label: 'Year: newest first' },
];
function sortCars(list) {
  const cmp = {
    'safety-desc': (a, b) => (b._score ?? -Infinity) - (a._score ?? -Infinity) || (a.price ?? Infinity) - (b.price ?? Infinity),
    'price-asc': (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
    'price-desc': (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
    'range-desc': (a, b) => (b.rangeMi ?? -Infinity) - (a.rangeMi ?? -Infinity),
    'year-desc': (a, b) => (b.year ?? 0) - (a.year ?? 0) || (a.price ?? Infinity) - (b.price ?? Infinity),
  }[SORT] || (() => 0);
  return [...list].sort(cmp);
}

// ---------- faceted filters ----------
const FACET_GROUPS = [
  { id: 'powertrain', cat: 'Powertrain', opts: [
    { v: 'EV', label: '⚡ EV', test: (c) => c.powertrain === 'EV' },
    { v: 'PHEV', label: '🔌 Plug-in hybrid', test: (c) => c.powertrain === 'PHEV' },
    { v: 'Hybrid', label: '🍃 Hybrid', test: (c) => c.powertrain === 'Hybrid' },
    { v: 'ICE', label: '⛽ Gas', test: (c) => c.powertrain === 'ICE' },
  ] },
  { id: 'safety', cat: 'Safety must-haves', opts: [
    { v: 'aeb', label: '🛡️ Has AEB', test: (c) => c.aeb === 'yes' || c.aeb === 'yes-city' },
    { v: 'bsm', label: '👁️ Has blind-spot', test: (c) => c.bsm === 'yes' },
  ] },
  { id: 'price', cat: 'Budget', opts: [
    { v: 'u12', label: 'Under $12k', test: (c) => c.price != null && c.price < 12000 },
    { v: 'u15', label: 'Under $15k', test: (c) => c.price != null && c.price < 15000 },
  ] },
  { id: 'title', cat: 'Title', opts: [
    { v: 'clean', label: '✅ Clean title only', test: (c) => c.titleStatus === 'clean' || c.titleStatus == null },
  ] },
  { id: 'show', cat: 'Show', opts: [
    { v: 'liked', label: '👍 My picks', test: (c) => VOTES[keyOf(c)] === 'up' },
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
    if (!sel || sel.size === 0) continue;
    const chosen = g.opts.filter((o) => sel.has(o.v));
    if (!chosen.some((o) => o.test(c))) return false;
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
  let lastCat = null;
  for (const g of FACET_GROUPS) {
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
    btn.addEventListener('click', () => vote(btn.dataset.id, btn.dataset.v));
  });
  grid.querySelectorAll('.comment').forEach((ta) => {
    ta.addEventListener('input', () => {
      setComment(ta.dataset.id, ta.value);
      updateTally();
    });
  });
  grid.querySelectorAll('.thumb img').forEach((img) => {
    img.addEventListener('error', () => {
      const wrap = img.closest('.thumb');
      if (wrap) wrap.remove();
    });
  });
}

// ---------- per-car badges ----------
function ptBadge(pt) {
  if (pt === 'EV') return '<span class="badge pt-ev">⚡ EV</span>';
  if (pt === 'PHEV') return '<span class="badge pt-phev">🔌 Plug-in hybrid</span>';
  if (pt === 'Hybrid') return '<span class="badge pt-hybrid">🍃 Hybrid</span>';
  if (pt === 'ICE') return '<span class="badge pt-ice">⛽ Gas</span>';
  return '';
}
function aebBadge(state) {
  if (state === 'yes') return '<span class="badge safe-yes">🛡️ AEB</span>';
  if (state === 'yes-city') return '<span class="badge safe-part">🛡️ AEB (city)</span>';
  if (state === 'no') return '<span class="badge safe-no">No AEB</span>';
  return '<span class="badge safe-unk">AEB: verify</span>';
}
function bsmBadge(state) {
  if (state === 'yes') return '<span class="badge safe-yes">👁️ Blind-spot</span>';
  if (state === 'no') return '<span class="badge safe-no">No blind-spot</span>';
  return '<span class="badge safe-unk">Blind-spot: verify</span>';
}
function benchBadge(c) {
  if (!c.benchmark) return '';
  const label = c.benchmarkKind === 'cheap-tco' ? '📊 Cheap-TCO benchmark'
    : c.benchmarkKind === 'better-ev' ? '📊 Better-EV benchmark'
    : '📊 Benchmark';
  return `<span class="badge bench-badge">${label}</span>`;
}
function titleBadge(c) {
  if (c.titleStatus === 'branded') return '<span class="badge title-warn">⚠️ Branded title</span>';
  if (c.titleStatus === 'salvage') return '<span class="badge title-warn">⚠️ Salvage title</span>';
  return '';
}

// Key specs — the concrete facts we're comparing on, as a label/value grid.
function keySpecs(c) {
  const rows = [];
  const add = (label, val, wide) => { if (val != null && val !== '') rows.push([label, val, !!wide]); };
  add('Powertrain', c.powertrain === 'EV' ? 'All-electric'
    : c.powertrain === 'PHEV' ? 'Plug-in hybrid'
    : c.powertrain === 'Hybrid' ? 'Hybrid' : c.powertrain === 'ICE' ? 'Gas' : c.powertrain);
  add('Range (EPA est.)', c.rangeMi ? `~${c.rangeMi} mi electric` : null);
  add('Mileage', c.miles != null ? milesFmt(c.miles) : null);
  add('Color', c.color);
  add('Title', c.titleStatus ? (c.titleStatus[0].toUpperCase() + c.titleStatus.slice(1)) : null);
  add('VIN', c.vin, true);
  if (!rows.length) return '';
  const cells = rows.map(([l, val, wide]) =>
    `<div class="spec${wide ? ' wide' : ''}"><dt>${esc(l)}</dt><dd>${esc(val)}</dd></div>`).join('');
  return `<dl class="specs">${cells}</dl>`;
}

function featBlock(kind, label, items) {
  if (!Array.isArray(items) || !items.length) return '';
  const chips = items.map((x) => `<span class="hl">${esc(x)}</span>`).join('');
  return `<div class="featblock ${kind}"><span class="flabel">${esc(label)}</span><div class="featrow">${chips}</div></div>`;
}

function carCard(c) {
  const id = keyOf(c);
  const v = VOTES[id] || null;
  const cls = (v === 'up' ? ' v-up' : v === 'down' ? ' v-down' : '') + (c.benchmark ? ' bench' : '');
  const priceHtml = c.price != null
    ? `<div class="price">${money(c.price)}${c.priceNote ? `<span class="note">${esc(c.priceNote)}</span>` : ''}</div>`
    : `<div class="price"><span class="calld">Call for price</span></div>`;
  const highlights = (c.highlights || []).map((h) => `<span class="hl">${esc(h)}</span>`).join('');
  const alt = carName(c);
  const thumbInner = c.photo
    ? `<img src="${esc(c.photo)}" alt="${esc(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : '';
  const thumbHtml = c.photo
    ? (c.url
        ? `<a class="thumb" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open listing — ${esc(alt)}">${thumbInner}</a>`
        : `<span class="thumb">${thumbInner}</span>`)
    : `<span class="thumb placeholder" aria-hidden="true">${c.powertrain === 'EV' ? '⚡' : '🚗'}</span>`;
  const rangeTag = c.rangeMi ? `<span class="badge">${esc(c.rangeMi)} mi range</span>` : '';
  return `
    <div class="carcard${cls}">
      <div class="cardhead">
        ${thumbHtml}
        <div class="headinfo">
          <div class="top">
            <h2>${esc(carName(c))}</h2>
            ${priceHtml}
          </div>
          <div class="badges">
            ${benchBadge(c)}
            ${ptBadge(c.powertrain)}
            ${rangeTag}
            ${aebBadge(c.aeb)}
            ${bsmBadge(c.bsm)}
            ${titleBadge(c)}
          </div>
        </div>
      </div>
      ${keySpecs(c)}
      ${highlights ? `<div class="featblock"><div class="featrow">${highlights}</div></div>` : ''}
      ${featBlock('safety', '🛡️ Safety features', c.safety)}
      ${featBlock('comfort', '✨ Comfort & convenience', c.comfort)}
      ${c.tco ? `<p class="carnote"><b>💰 Cost to own:</b> ${esc(c.tco)}</p>` : ''}
      ${c.batteryNote ? `<p class="carnote batt"><b>🔋 Battery:</b> ${esc(c.batteryNote)}</p>` : ''}
      ${c.titleNote ? `<p class="carnote warn"><b>⚠️ Title:</b> ${esc(c.titleNote)}</p>` : ''}
      ${c.note ? `<p class="carnote"><b>📝 Bottom line:</b> ${esc(c.note)}</p>` : ''}
      <div class="carfoot">
        <div class="vote">
          <button class="vbtn up${v === 'up' ? ' on' : ''}" data-id="${esc(id)}" data-v="up" aria-label="Like">👍</button>
          <button class="vbtn down${v === 'down' ? ' on' : ''}" data-id="${esc(id)}" data-v="down" aria-label="Pass">👎</button>
        </div>
        ${c.url ? `<a class="listing-link" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">More info ↗</a>` : ''}
      </div>
      <div class="comment-row">
        <textarea class="comment" data-id="${esc(id)}" rows="2"
          placeholder="Add a note — what do you think? (optional)"
          aria-label="Your note on this car">${esc(COMMENTS[id] || '')}</textarea>
      </div>
    </div>`;
}

function vote(id, v) {
  if (VOTES[id] === v) delete VOTES[id];
  else VOTES[id] = v;
  saveVotes();
  renderFilters();
  renderCars();
  updateTally();
}

function updateTally() {
  const up = Object.values(VOTES).filter((v) => v === 'up').length;
  const down = Object.values(VOTES).filter((v) => v === 'down').length;
  const notes = Object.values(COMMENTS).filter((t) => t && t.trim()).length;
  $('#tally').innerHTML = `<b>${up}</b> 👍 &nbsp; <b>${down}</b> 👎 &nbsp; <b>${notes}</b> 💬`;
  $('#send-btn').disabled = (up + down + notes === 0);
}

// ---------- send picks ----------
function buildSummary() {
  const byId = {};
  (DATA.cars || []).forEach((c) => { byId[keyOf(c)] = c; });
  const label = (c) => {
    const price = c.price != null ? money(c.price) : 'call for price';
    return `${carName(c)} — ${c.powertrain}, ${price}${c.miles != null ? ', ' + milesFmt(c.miles) : ''}`;
  };
  const noteOf = (id) => {
    const t = (COMMENTS[id] || '').trim();
    return t ? `\n    💬 "${t}"` : '';
  };
  const up = [], down = [], notesOnly = [];
  const voted = new Set();
  Object.entries(VOTES).forEach(([id, v]) => {
    const c = byId[id];
    if (!c) return;
    voted.add(id);
    (v === 'up' ? up : down).push(label(c) + noteOf(id));
  });
  Object.keys(COMMENTS).forEach((id) => {
    const c = byId[id];
    if (!c || voted.has(id)) return;
    const t = (COMMENTS[id] || '').trim();
    if (t) notesOnly.push(`${label(c)}\n    💬 "${t}"`);
  });
  let out = `Jordyn's car picks (${DATA.updated || ''})\n`;
  out += `\n👍 Liked (${up.length}):\n` + (up.length ? up.map((x) => '  • ' + x).join('\n') : '  (none)');
  out += `\n\n👎 Passed (${down.length}):\n` + (down.length ? down.map((x) => '  • ' + x).join('\n') : '  (none)');
  if (notesOnly.length) {
    out += `\n\n💬 Notes (${notesOnly.length}):\n` + notesOnly.map((x) => '  • ' + x).join('\n');
  }
  out += `\n\n(Sent from Jordyn's car page)`;
  return out;
}

async function sendPicks() {
  const summary = buildSummary();
  const shareData = { title: "Jordyn's car picks", text: summary };
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch (err) { if (err && err.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(summary);
    toast('Picks copied — paste them to Jonathan 👍');
    return;
  } catch { /* fall through */ }
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
const JORDYN_PUBLIC_URL = 'https://jonathancarlson.github.io/france-2026/jordyn.html';
function currentCarKey() {
  if (KEY) return KEY;
  try { return localStorage.getItem(CARKEY_KEY) || ''; } catch { return ''; }
}
async function shareLink() {
  const k = currentCarKey();
  if (!k) { toast('No link to share yet — open the car page from your invite first'); return; }
  const url = `${JORDYN_PUBLIC_URL}#k=${k}`;
  const shareData = { title: "Jordyn's first car", text: 'Cars we\u2019re looking at for Jordyn — 👍/👎 the ones you like:', url };
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch (err) { if (err && err.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied — paste it to share the car page 🔗');
    return;
  } catch { /* fall through */ }
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
