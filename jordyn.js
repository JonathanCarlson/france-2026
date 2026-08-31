'use strict';

// jordyn.js — the shareable browser for Jordyn's first-car roster.
//
// Sibling of cars.js (Kate's Mach-E page), deliberately built on the same proven
// bones: the access key lives in the URL fragment jordyn.html#k=<key> (never
// sent to the server), decrypts ONLY data/jordyn.enc.json, and 👍/👎 stay in
// localStorage until "Send my picks" hands them to the native share sheet.
//
// What differs is the RANKING, which follows the teen brief:
//   1. SAFETY FIRST — cars are grouped by whether automatic emergency braking is
//      CONFIRMED standard for that model year, or was optional and needs a
//      per-VIN check. We never claim a feature a car merely could have had.
//      (Kate's page learned this lesson with the glass roof.)
//   2. TOTAL COST TO OWN over 2 years (Jordyn) and 6 years (through Emma), at
//      130 mi/week. Every line item is shown — the model is auditable rather
//      than a magic number, because several inputs are genuinely uncertain.
//   3. EVs/PHEVs get NO thumb on the scale. They win, where they win, purely by
//      being cheaper to own over the window.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

let KEY = null;
let DATA = null;
let VOTES = {};
let COMMENTS = {};
let SORT = 'match-desc';
let HORIZON = 6; // cost window on the cards: 2 (Jordyn) or 6 (through Emma)
const FACETS = {};
const STORE_KEY = 'jordyn-cars-votes-v1';
const COMMENTS_KEY = 'jordyn-cars-comments-v1';
const JKEY_KEY = 'jordyn-cars-key-v1';

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
    DATA = await decryptPayload(await res.json());
    return true;
  } catch { return false; }
}

// ---------- local state ----------
function loadVotes() { try { VOTES = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { VOTES = {}; } }
function saveVotes() { try { localStorage.setItem(STORE_KEY, JSON.stringify(VOTES)); } catch { /* private mode */ } }
function loadComments() { try { COMMENTS = JSON.parse(localStorage.getItem(COMMENTS_KEY) || '{}') || {}; } catch { COMMENTS = {}; } }
function saveComments() { try { localStorage.setItem(COMMENTS_KEY, JSON.stringify(COMMENTS)); } catch { /* private mode */ } }
function setComment(vin, text) {
  const t = (text || '').trim();
  if (t) COMMENTS[vin] = t; else delete COMMENTS[vin];
  saveComments();
}
function rememberKey(k) { try { localStorage.setItem(JKEY_KEY, k); } catch { /* ignore */ } }
function forgetKey() { try { localStorage.removeItem(JKEY_KEY); } catch { /* ignore */ } }

// ---------- boot ----------
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
  try { saved = localStorage.getItem(JKEY_KEY); } catch { /* ignore */ }
  if (saved) {
    KEY = saved;
    if (await tryLoadData()) { openApp(true); return; }
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
  if (await tryLoadData()) {
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
  if (!alreadyLoaded && !(await tryLoadData())) {
    $('#cars-status').innerHTML = '<div class="big">🔒</div>Couldn’t open this link. Ask Jonathan to resend it.';
    return;
  }
  render();
}

// ---------- formatting ----------
const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US'));
const milesFmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US') + ' mi');
const POWER_LABEL = { BEV: '⚡ Electric', PHEV: '🔌 Plug-in hybrid', HYB: '🍃 Hybrid', ICE: '⛽ Gas' };

/** The safety headline. Never claims a trim-gated feature is actually present. */
function safetyBadge(c) {
  if (c.tier === 'confirmed') return '<span class="sb sb-ok">✅ AEB standard</span>';
  if (c.tier === 'verify') return '<span class="sb sb-warn">⚠️ AEB optional — verify VIN</span>';
  return '<span class="sb sb-bad">❌ No AEB</span>';
}
function bsmBadge(c) {
  const b = c.safety?.bsm;
  if (b === 'standard') return '<span class="sb sb-ok">✅ Blind-spot standard</span>';
  if (b === 'trim') return '<span class="sb sb-warn">⚠️ Blind-spot — verify trim</span>';
  return '<span class="sb sb-bad">❌ No blind-spot</span>';
}

const tcoOf = (c) => (HORIZON === 2 ? c.tco2 : c.tco6);

/** The cost panel — shows its work so the model can be argued with. */
function tcoBlock(c) {
  const t = tcoOf(c);
  if (!t) return '';
  const it = t.items;
  const rows = [
    ['Sales tax', it.salesTax],
    ['Fuel / charging', it.energy],
    ['Insurance (teen driver)', it.insurance],
    ['Maintenance', it.maintenance],
    ['Tabs + WA EV fee', it.registration],
    ['Battery allowance', it.batteryAllowance],
    ['Depreciation', it.depreciation],
  ].filter(([, v]) => v > 0);
  return `
    <details class="tco">
      <summary><b>${money(t.total)}</b> to own over ${t.years} yr <span class="tco-mo">≈ ${money(t.perMonth)}/mo</span></summary>
      <table class="tco-tbl">
        ${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${money(v)}</td></tr>`).join('')}
        <tr class="tco-total"><td>Total</td><td>${money(t.total)}</td></tr>
      </table>
      <p class="tco-note">Running cost on top of the ${money(it.purchase)} purchase price, at ${DATA.assumptions?.milesPerWeek ?? 130} mi/week.</p>
    </details>`;
}

function carCard(c) {
  const vote = VOTES[c.vin];
  const note = COMMENTS[c.vin] || '';
  const chips = [safetyBadge(c), bsmBadge(c)];
  if (/Top Safety Pick/.test(c.safety?.iihs || '')) chips.push('<span class="sb sb-ok">🏆 IIHS Top Safety Pick</span>');
  chips.push(`<span class="sb">${POWER_LABEL[c.power] || esc(c.power)}</span>`);
  if (c.evRange) chips.push(`<span class="sb">${c.evRange} mi electric</span>`);
  if (c.cert === 'Certified') chips.push('<span class="sb sb-ok">Certified</span>');

  return `
  <article class="car${c.standout ? ' standout' : ''}" data-vin="${esc(c.vin)}">
    ${c.new ? '<div class="ribbon">🆕 Just added</div>' : ''}
    ${c.photo ? `<img class="car-photo" loading="lazy" src="${esc(c.photo)}" alt="${esc(c.label)}">` : ''}
    <div class="car-body">
      <div class="car-head">
        <h3>${esc(c.label)}${c.trim ? ` <span class="trim">${esc(c.trim)}</span>` : ''}</h3>
        <div class="price">${money(c.price)}</div>
      </div>
      <div class="car-sub">${milesFmt(c.miles)}${c.location ? ` · ${esc(c.location)}` : ''}${c.distanceMi != null ? ` · ${c.distanceMi} mi away` : ''}</div>
      ${c.priceNote ? `<div class="pricenote">${esc(c.priceNote)}</div>` : ''}
      <div class="chips">${chips.join('')}</div>
      ${c.note ? `<p class="standout-note">⭐ ${esc(c.note)}</p>` : ''}
      ${tcoBlock(c)}
      ${c.safety?.note ? `<p class="fineprint">🛡️ ${esc(c.safety.note)}</p>` : ''}
      ${c.batteryNote ? `<p class="fineprint">🔋 ${esc(c.batteryNote)}</p>` : ''}
      <div class="actions">
        <button class="vote up${vote === 'up' ? ' on' : ''}" data-v="up" type="button" aria-label="Thumbs up">👍</button>
        <button class="vote down${vote === 'down' ? ' on' : ''}" data-v="down" type="button" aria-label="Thumbs down">👎</button>
        <a class="listing" href="${esc(c.url)}" target="_blank" rel="noopener">View listing ↗</a>
      </div>
      <input class="note-input" type="text" placeholder="Add a note…" value="${esc(note)}" aria-label="Note about this car">
    </div>
  </article>`;
}

// ---------- filters / sort ----------
const FACET_DEFS = [
  { id: 'safety', label: 'Safety', opts: [['confirmed', '✅ AEB standard'], ['verify', '⚠️ Verify AEB']], test: (c, v) => c.tier === v },
  { id: 'power', label: 'Power', opts: [['BEV', '⚡ Electric'], ['PHEV', '🔌 Plug-in'], ['HYB', '🍃 Hybrid'], ['ICE', '⛽ Gas']], test: (c, v) => c.power === v },
  { id: 'bsm', label: 'Blind-spot', opts: [['any', 'Available']], test: (c) => c.safety?.bsm === 'standard' || c.safety?.bsm === 'trim' },
  { id: 'price', label: 'Price', opts: [['u10', 'Under $10k'], ['u13', 'Under $13k']], test: (c, v) => (v === 'u10' ? (c.price ?? 9e9) < 10000 : (c.price ?? 9e9) < 13000) },
  { id: 'miles', label: 'Miles', opts: [['u80', 'Under 80k']], test: (c) => (c.miles ?? 9e9) < 80000 },
];

function passesFacets(c) {
  for (const def of FACET_DEFS) {
    const active = FACETS[def.id];
    if (!active || !active.size) continue;
    let ok = false;
    for (const v of active) if (def.test(c, v)) { ok = true; break; }
    if (!ok) return false;
  }
  return true;
}

const SORTS = [
  { id: 'match-desc', label: '⭐ Best overall' },
  { id: 'tco-asc', label: '💸 Cheapest to own' },
  { id: 'price-asc', label: '🏷️ Lowest price' },
  { id: 'miles-asc', label: '🛣️ Fewest miles' },
  { id: 'year-desc', label: '📅 Newest' },
];
function sortCars(list) {
  const a = [...list];
  if (SORT === 'tco-asc') a.sort((x, y) => (tcoOf(x)?.total ?? 9e9) - (tcoOf(y)?.total ?? 9e9));
  else if (SORT === 'price-asc') a.sort((x, y) => (x.price ?? 9e9) - (y.price ?? 9e9));
  else if (SORT === 'miles-asc') a.sort((x, y) => (x.miles ?? 9e9) - (y.miles ?? 9e9));
  else if (SORT === 'year-desc') a.sort((x, y) => (y.year ?? 0) - (x.year ?? 0));
  else a.sort((x, y) => (y.matchScore ?? 0) - (x.matchScore ?? 0));
  return a;
}

// ---------- render ----------
function render() {
  $('#cars-status').hidden = true;
  $('#tabbar').hidden = false;
  renderIntro();
  renderControls();
  renderList();
  renderGuide();
  renderTally();
  wireDelegates();
}

function renderIntro() {
  const s = DATA.stats || {};
  const a = DATA.assumptions || {};
  $('#intro').innerHTML = `
    <div class="card">
      <p class="lede">${esc(DATA.intro || '')}</p>
      <div class="stat-grid">
        <div class="stat"><div class="n">${s.count ?? '—'}</div><div class="l">cars found</div></div>
        <div class="stat"><div class="n">${s.confirmedAeb ?? '—'}</div><div class="l">AEB standard</div></div>
        <div class="stat"><div class="n">${s.plugCount ?? '—'}</div><div class="l">electric / plug-in</div></div>
      </div>
      <p class="fineprint">Cost-to-own assumes <b>${a.milesPerWeek ?? 130} mi/week</b> (${(a.milesPerYear ?? 6760).toLocaleString()} mi/yr) —
      the barn is 16 mi away, four round trips, plus local driving. Electricity at ${money(a.electricityPerKwh)}/kWh, gas at ${money(a.gasPerGallon)}/gal,
      and a teen-driver insurance premium that scales with the car's value. Washington's ${money(a.waEvFeePerYear)}/yr EV registration fee
      is included — which is why the electric cars don't win by as much as the fuel savings alone would suggest.</p>
    </div>`;
}

function renderControls() {
  $('#sortbar').innerHTML = `
    <label class="sortlbl">Sort <select id="sort-sel">${SORTS.map((s) => `<option value="${s.id}"${s.id === SORT ? ' selected' : ''}>${s.label}</option>`).join('')}</select></label>
    <div class="horizon" role="group" aria-label="Cost window">
      <button type="button" class="hz${HORIZON === 2 ? ' on' : ''}" data-hz="2">2 yr · Jordyn</button>
      <button type="button" class="hz${HORIZON === 6 ? ' on' : ''}" data-hz="6">6 yr · thru Emma</button>
    </div>`;
  $('#filterbar').innerHTML = FACET_DEFS.map((d) => `
    <div class="fgroup"><span class="flabel">${d.label}</span>
      ${d.opts.map(([v, l]) => `<button type="button" class="facet${FACETS[d.id]?.has(v) ? ' on' : ''}" data-g="${d.id}" data-v="${v}">${l}</button>`).join('')}
    </div>`).join('');
  $('#filterbar').hidden = false;
}

// Grouped by safety tier so a "verify" car is never presented as equivalent to
// one where AEB is genuinely standard.
const TIER_GROUPS = [
  ['confirmed', '✅ Automatic emergency braking is standard', 'The safest starting point — every car of this model year has AEB. Blind-spot may still depend on trim.'],
  ['verify', '⚠️ AEB was optional — check the specific car', 'Good cars, but in these years automatic braking came in a package. Confirm it on the window sticker before trusting it.'],
  ['no', '❌ No automatic emergency braking', 'Shown for completeness — these fall short of the teen-safety bar.'],
];

function renderList() {
  const shown = sortCars((DATA.cars || []).filter(passesFacets));
  const grid = $('#cars-grid');
  if (!shown.length) {
    grid.innerHTML = '<p class="empty">No cars match those filters. Loosen one above.</p>';
    return;
  }
  grid.innerHTML = TIER_GROUPS.map(([tier, title, blurb]) => {
    const list = shown.filter((c) => c.tier === tier);
    if (!list.length) return '';
    return `<section class="tier tier-${tier}">
      <h2 class="tier-h">${title} <span class="tier-n">${list.length}</span></h2>
      <p class="tier-blurb">${blurb}</p>
      ${list.map(carCard).join('')}
    </section>`;
  }).join('');
}

/** The buyer's guide tab — what to look for, by model. */
function renderGuide() {
  const g = DATA.guide;
  const w = DATA.wants;
  const parts = [];
  if (w) {
    parts.push(`<div class="card">
      <h3>What we're looking for</h3>
      <p class="glabel">Must have</p><ul class="glist">${(w.mustHaves || []).map((x) => `<li>✅ ${esc(x)}</li>`).join('')}</ul>
      <p class="glabel">Nice to have</p><ul class="glist">${(w.niceToHaves || []).map((x) => `<li>➕ ${esc(x)}</li>`).join('')}</ul>
      <p class="glabel">Avoid</p><ul class="glist">${(w.avoid || []).map((x) => `<li>🚫 ${esc(x)}</li>`).join('')}</ul>
    </div>`);
  }
  if (g) {
    parts.push(`<div class="card"><h3>${esc(g.headline || 'By model')}</h3><p class="fineprint">${esc(g.note || '')}</p></div>`);
    for (const m of g.models || []) {
      parts.push(`<div class="card gmodel">
        <div class="car-head"><h3>${esc(m.model)} <span class="trim">${esc(m.years || '')}</span></h3><div class="price">${esc(m.priceBand || '')}</div></div>
        <div class="chips"><span class="sb">${esc(m.powertrain || '')}</span>${m.range ? `<span class="sb">${esc(m.range)}</span>` : ''}</div>
        ${m.aeb ? `<p class="fineprint"><b>AEB:</b> ${esc(m.aeb)}</p>` : ''}
        ${m.bsm ? `<p class="fineprint"><b>Blind-spot:</b> ${esc(m.bsm)}</p>` : ''}
        ${m.tco ? `<p class="fineprint"><b>Cost to own:</b> ${esc(m.tco)}</p>` : ''}
      </div>`);
    }
  }
  if (DATA.resources?.length) {
    parts.push(`<div class="card"><h3>Reference</h3><div class="resource-row">${DATA.resources.map((r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener">🔎 ${esc(r.label)} ↗</a>`).join('')}</div></div>`);
  }
  $('#guide').innerHTML = parts.join('');
}

function renderTally() {
  const up = Object.values(VOTES).filter((v) => v === 'up').length;
  const down = Object.values(VOTES).filter((v) => v === 'down').length;
  const notes = Object.keys(COMMENTS).length;
  $('#tally').textContent = `${up} 👍  ${down} 👎  ${notes} 📝`;
  $('#send-btn').disabled = up + down + notes === 0;
  $('#sendbar').hidden = false;
}

// ---------- tabs ----------
function switchTab(name) {
  $('#panel-cars').hidden = name !== 'cars';
  $('#panel-guide').hidden = name !== 'guide';
  document.querySelectorAll('#tabbar .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#sendbar').hidden = name !== 'cars';
  window.scrollTo(0, 0);
}

// ---------- interaction ----------
let wired = false;
function wireDelegates() {
  if (wired) return;
  wired = true;

  document.querySelectorAll('#tabbar .tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  document.addEventListener('click', (e) => {
    const facet = e.target.closest('.facet');
    if (facet) {
      const g = facet.dataset.g;
      const v = facet.dataset.v;
      FACETS[g] = FACETS[g] || new Set();
      if (FACETS[g].has(v)) FACETS[g].delete(v); else FACETS[g].add(v);
      renderControls();
      renderList();
      return;
    }
    const hz = e.target.closest('.hz');
    if (hz) { HORIZON = Number(hz.dataset.hz); renderControls(); renderList(); return; }
    const vote = e.target.closest('.vote');
    if (vote) {
      const vin = vote.closest('.car')?.dataset.vin;
      if (!vin) return;
      const v = vote.dataset.v;
      if (VOTES[vin] === v) delete VOTES[vin]; else VOTES[vin] = v;
      saveVotes();
      vote.closest('.actions').querySelectorAll('.vote').forEach((b) => b.classList.toggle('on', VOTES[vin] === b.dataset.v));
      renderTally();
      return;
    }
    if (e.target.closest('#send-btn')) sendPicks();
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'sort-sel') { SORT = e.target.value; renderList(); }
  });
  document.addEventListener('input', (e) => {
    const ni = e.target.closest('.note-input');
    if (ni) { setComment(ni.closest('.car')?.dataset.vin, ni.value); renderTally(); }
  });
}

function sendPicks() {
  const byVin = new Map((DATA.cars || []).map((c) => [c.vin, c]));
  const line = (vin, mark) => {
    const c = byVin.get(vin);
    if (!c) return null;
    const n = COMMENTS[vin] ? ` — "${COMMENTS[vin]}"` : '';
    return `${mark} ${c.label} · ${money(c.price)} · ${milesFmt(c.miles)} · ${money(tcoOf(c)?.total)}/${HORIZON}yr${n}\n  ${c.url}`;
  };
  const ups = Object.entries(VOTES).filter(([, v]) => v === 'up').map(([vin]) => line(vin, '👍')).filter(Boolean);
  const downs = Object.entries(VOTES).filter(([, v]) => v === 'down').map(([vin]) => line(vin, '👎')).filter(Boolean);
  const orphan = Object.keys(COMMENTS).filter((vin) => !VOTES[vin]).map((vin) => line(vin, '📝')).filter(Boolean);
  const text = ["Jordyn's car picks:", '', ...ups, ...(downs.length ? ['', ...downs] : []), ...(orphan.length ? ['', ...orphan] : [])].join('\n');
  if (navigator.share) navigator.share({ text }).catch(() => { /* cancelled */ });
  else navigator.clipboard?.writeText(text).then(() => {
    $('#send-btn').textContent = 'Copied ✓';
    setTimeout(() => { $('#send-btn').textContent = 'Send my picks'; }, 1800);
  });
}
