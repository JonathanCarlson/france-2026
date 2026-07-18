'use strict';

// ---------- Service worker (offline) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------- Platform / install ----------
const IS_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const IS_ANDROID = /android/i.test(navigator.userAgent);
// Chrome/Edge/Samsung on Android fire this when the PWA is installable. Capture it
// so we can offer a one-tap "Install" button (iOS has no such API — manual hint).
let DEFERRED_INSTALL = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  DEFERRED_INSTALL = e;
  const app = document.getElementById('app');
  if (app && !app.hidden) { document.querySelector('.ios-hint')?.remove(); maybeShowInstallHint(); }
});

// ---------- Crypto ----------
const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function decryptPayload(payload, passphrase) {
  const enc = new TextEncoder();
  const salt = b64ToU8(payload.salt);
  const iv = b64ToU8(payload.iv);
  const ct = b64ToU8(payload.ct);
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: payload.kdf.iterations, hash: payload.kdf.hash },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(buf));
}

// ---------- State ----------
const PASS_KEY = 'trip_pass';
let PAYLOAD = null;   // encrypted blob
let DATA = null;      // decrypted itinerary
let PASSPHRASE = null; // kept in memory to decrypt ticket assets on demand
let TAB = 'today';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Boot ----------
(async function boot() {
  try {
    const res = await fetch('data/itinerary.enc.json', { cache: 'no-cache' });
    PAYLOAD = await res.json();
  } catch (e) {
    // offline + not cached yet
  }
  const saved = localStorage.getItem(PASS_KEY);
  if (saved && PAYLOAD) {
    try { DATA = await decryptPayload(PAYLOAD, saved); PASSPHRASE = saved; openApp(); return; } catch (e) { localStorage.removeItem(PASS_KEY); }
  }
  $('#unlock-form').addEventListener('submit', onUnlock);
})();

async function onUnlock(e) {
  e.preventDefault();
  const pass = $('#passphrase').value.trim();
  const err = $('#lock-error');
  err.hidden = true;
  if (!pass) return;
  $('#unlock-btn').textContent = 'Unlocking…';
  try {
    if (!PAYLOAD) {
      const res = await fetch('data/itinerary.enc.json', { cache: 'no-cache' });
      PAYLOAD = await res.json();
    }
    DATA = await decryptPayload(PAYLOAD, pass);
    PASSPHRASE = pass;
    if ($('#remember').checked) localStorage.setItem(PASS_KEY, pass);
    openApp();
  } catch (e2) {
    err.textContent = 'Wrong passphrase (or trip data not downloaded yet). Try again while online.';
    err.hidden = false;
    $('#unlock-btn').textContent = 'Unlock';
  }
}

function openApp() {
  $('#lock').hidden = true;
  $('#app').hidden = false;
  $('#trip-title').textContent = DATA.trip.title;
  $('#trip-dates').textContent = DATA.trip.dates;
  $('#trip-updated').textContent = DATA.trip.updated ? 'Updated ' + fmtUpdated(DATA.trip.updated) : '';
  $('#lock-btn').addEventListener('click', () => { localStorage.removeItem(PASS_KEY); location.reload(); });
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#view').addEventListener('click', onViewClick);
  maybeShowInstallHint();
  render();
  loadWeather();
}

// Prompt the user to install the PWA to their home screen. iOS has no install API,
// so it gets a manual Share→Add-to-Home-Screen tip; Android/Chrome gets a one-tap
// Install button when available, falling back to a manual ⋮-menu tip.
function maybeShowInstallHint() {
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (standalone) return; // already installed
  const dismissed = localStorage.getItem('install_hint_dismissed') || localStorage.getItem('ios_hint_dismissed');
  if (dismissed) return;
  if (IS_IOS) {
    showInstallBar('Tip: tap <b>Share</b> then <b>Add to Home Screen</b> to install &amp; use offline.');
  } else if (IS_ANDROID) {
    if (DEFERRED_INSTALL) {
      showInstallBar('Install this trip as an app for a home-screen icon &amp; offline use.', {
        label: 'Install',
        onAction: async () => {
          const e = DEFERRED_INSTALL; DEFERRED_INSTALL = null;
          try { e.prompt(); await e.userChoice; } catch (_) { /* dismissed */ }
        },
      });
    } else {
      showInstallBar('Tip: tap the <b>⋮</b> menu then <b>Add to Home screen</b> to install &amp; use offline.');
    }
  }
}

function showInstallBar(html, opts) {
  if (document.querySelector('.ios-hint')) return;
  const b = document.createElement('div');
  b.className = 'ios-hint';
  let inner = `<span>${html}</span>`;
  if (opts && opts.label) inner += `<button class="hint-action">${esc(opts.label)}</button>`;
  inner += `<button class="hint-dismiss" aria-label="Dismiss">✕</button>`;
  b.innerHTML = inner;
  if (opts && opts.onAction) b.querySelector('.hint-action').addEventListener('click', () => { b.remove(); opts.onAction(); });
  b.querySelector('.hint-dismiss').addEventListener('click', () => { b.remove(); localStorage.setItem('install_hint_dismissed', '1'); });
  document.body.appendChild(b);
}

function glanceCard() {
  const t = todayISO();
  const s = DATA.trip.startDate, e = DATA.trip.endDate;
  let phase;
  if (t < s) phase = `<div class="g-num">${daysBetween(t, s)}</div><div class="g-lbl">days to go</div>`;
  else if (t > e) phase = `<div class="g-num">✓</div><div class="g-lbl">complete</div>`;
  else phase = `<div class="g-num">${daysBetween(s, t) + 1}</div><div class="g-lbl">of ${DATA.days.length} days</div>`;
  const tkTodo = DATA.tickets.filter((x) => x.status !== 'booked').length;
  const packTotal = (DATA.prep?.packing || []).reduce((n, c) => n + c.items.length, 0);
  const packDone = (DATA.prep?.packing || []).reduce((n, c) => n + c.items.filter((it) => isChecked('pack', it)).length, 0);
  return `<div class="glance">
    <div class="g-cell">${phase}</div>
    <div class="g-cell tap" data-goto="bookings"><div class="g-num">${tkTodo}</div><div class="g-lbl">to book</div></div>
    <div class="g-cell tap" data-goto="prep"><div class="g-num">${packDone}/${packTotal}</div><div class="g-lbl">packed</div></div>
  </div>`;
}

function switchTab(tab) {
  TAB = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  render();
  $('#view').scrollTo({ top: 0 });
  window.scrollTo({ top: 0 });
}

// ---------- Date helpers ----------
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysBetween(aISO, bISO) {
  return Math.round((Date.parse(bISO + 'T00:00:00') - Date.parse(aISO + 'T00:00:00')) / 86400000);
}
function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtUpdated(val) {
  if (!val) return '';
  const d = new Date(val);
  if (isNaN(d.getTime())) return String(val);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------- Link helpers ----------
const telLink = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;
const waLink = (p) => `https://wa.me/${String(p).replace(/[^\d]/g, '')}`;
const mapLink = (q) => `https://maps.google.com/?q=${encodeURIComponent(q)}`;

// ---------- Weather (city-specific daily forecast, refreshes on every online open) ----------
// Free Open-Meteo API (no key). Fetched once per unique location whenever the app
// opens online; cached in localStorage so the last-known forecast still shows offline.
const WX_KEY = 'trip_weather_v1';
let WEATHER = null;   // { fetchedAt, byDate: { 'YYYY-MM-DD': { loc, code, tmax, tmin, pop } } }
let OPEN_DAY = null;  // date of the currently-open day overlay (so weather can refresh it)

// Ordered so the FIRST keyword match wins = the city where the daytime is spent
// (e.g. "Venice → Rome" → Venice; "Lille → Toulouse" → Lille).
const WX_LOCS = [
  { k: 'lille', name: 'Lille', lat: 50.6292, lon: 3.0573 },
  { k: 'belgium', name: 'Bruges', lat: 51.2093, lon: 3.2247 },
  { k: 'bruges', name: 'Bruges', lat: 51.2093, lon: 3.2247 },
  { k: 'ghent', name: 'Ghent', lat: 51.0543, lon: 3.7174 },
  { k: 'carcassonne', name: 'Carcassonne', lat: 43.2130, lon: 2.3491 },
  { k: 'cathar', name: 'Foix', lat: 42.9660, lon: 1.6058 },
  { k: 'toulouse', name: 'Toulouse', lat: 43.6045, lon: 1.4442 },
  { k: 'venice', name: 'Venice', lat: 45.4408, lon: 12.3155 },
  { k: 'venezia', name: 'Venice', lat: 45.4408, lon: 12.3155 },
  { k: 'pompeii', name: 'Pompeii', lat: 40.7497, lon: 14.4869 },
  { k: 'vatican', name: 'Rome', lat: 41.9028, lon: 12.4964 },
  { k: 'rome', name: 'Rome', lat: 41.9028, lon: 12.4964 },
  { k: 'paris', name: 'Paris', lat: 48.8566, lon: 2.3522 },
];

function weatherLocationFor(day) {
  const c = (day.city || '').toLowerCase();
  return WX_LOCS.find((l) => c.includes(l.k)) || null;
}

// WMO weather-code → [emoji, short label].
function wmo(code) {
  const m = {
    0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly sunny'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
    45: ['🌫️', 'Fog'], 48: ['🌫️', 'Freezing fog'],
    51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌦️', 'Heavy drizzle'],
    56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'],
    61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
    66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
    71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['🌨️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
    80: ['🌦️', 'Showers'], 81: ['🌦️', 'Showers'], 82: ['⛈️', 'Heavy showers'],
    85: ['🌨️', 'Snow showers'], 86: ['🌨️', 'Snow showers'],
    95: ['⛈️', 'Thunderstorms'], 96: ['⛈️', 'Thunderstorms'], 99: ['⛈️', 'Hailstorms'],
  };
  return m[code] || ['🌡️', ''];
}
const cToF = (c) => Math.round(c * 9 / 5 + 32);

async function loadWeather() {
  // 1) Show cached forecast immediately (works offline).
  try {
    const cached = JSON.parse(localStorage.getItem(WX_KEY) || 'null');
    if (cached && cached.byDate) WEATHER = cached;
  } catch { /* ignore bad cache */ }

  if (!navigator.onLine) { refreshWeatherViews(); return; }

  // 2) Fetch fresh forecast per unique location, keyed by the dates actually visited.
  try {
    const locs = [];
    const seen = new Set();
    for (const d of DATA.days) {
      const l = weatherLocationFor(d);
      if (l && !seen.has(l.name)) { seen.add(l.name); locs.push(l); }
    }
    const byDate = {};
    await Promise.all(locs.map(async (l) => {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${l.lat}&longitude=${l.lon}`
        + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`
        + `&timezone=auto&forecast_days=16`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      const dd = j.daily || {};
      (dd.time || []).forEach((date, i) => {
        // Only keep a day's forecast for the location that day is actually spent in.
        if (!DATA.days.some((day) => day.date === date && weatherLocationFor(day)?.name === l.name)) return;
        byDate[date] = {
          loc: l.name,
          code: dd.weather_code?.[i],
          tmax: dd.temperature_2m_max?.[i],
          tmin: dd.temperature_2m_min?.[i],
          pop: dd.precipitation_probability_max?.[i],
        };
      });
    }));
    if (Object.keys(byDate).length) {
      WEATHER = { fetchedAt: Date.now(), byDate };
      localStorage.setItem(WX_KEY, JSON.stringify(WEATHER));
    }
  } catch { /* keep whatever cache we have */ }
  refreshWeatherViews();
}

function wxForDay(day) {
  if (!WEATHER || !WEATHER.byDate) return null;
  const w = WEATHER.byDate[day.date];
  if (!w || w.tmax == null) return null;
  const loc = weatherLocationFor(day);
  if (loc && w.loc && w.loc !== loc.name) return null; // stale/mismatched cache
  return w;
}

function weatherBadge(day) {
  const w = wxForDay(day);
  if (!w) return '';
  const [ic] = wmo(w.code);
  return `${ic} ${cToF(w.tmax)}°/${cToF(w.tmin)}°F <span class="wx-c">${Math.round(w.tmax)}°/${Math.round(w.tmin)}°C</span>`;
}

function weatherCard(day) {
  const w = wxForDay(day);
  if (!w) return '';
  const [ic, label] = wmo(w.code);
  const pop = (w.pop != null) ? ` · 💧 ${w.pop}%` : '';
  return `<div class="wx">
    <div class="wx-ic">${ic}</div>
    <div class="wx-body">
      <div class="wx-temp">${cToF(w.tmax)}° / ${cToF(w.tmin)}°F&nbsp; <span class="muted">${Math.round(w.tmax)}° / ${Math.round(w.tmin)}°C</span></div>
      <div class="wx-sub">${esc(label)}${label ? ' in ' : ''}${esc(w.loc)}${pop}</div>
    </div>
  </div>`;
}

function refreshWeatherViews() {
  try {
    render();
    if (OPEN_DAY) {
      const o = document.getElementById('day-overlay');
      if (o && !o.hidden) openDay(OPEN_DAY);
    }
  } catch { /* non-fatal */ }
}

// ---------- Per-day alerts (border / EES / disruptions) ----------
function alertsBlock(day) {
  if (!day.alerts || !day.alerts.length) return '';
  return day.alerts.map((a) => {
    const lvl = a.level === 'red' ? 'red' : a.level === 'info' ? 'info' : 'amber';
    return `<div class="alert ${lvl}">
      <div class="alert-h">${esc(a.icon || '⚠️')} ${esc(a.title)}</div>
      <div>${esc(a.text)}</div>
    </div>`;
  }).join('');
}
function dayHasBorderAlert(day) {
  return (day.alerts || []).some((a) => a.level === 'red' || a.level === 'amber');
}

// ---------- Render ----------
function render() {
  const v = $('#view');
  if (TAB === 'today') v.innerHTML = renderToday();
  else if (TAB === 'days') v.innerHTML = renderDays();
  else if (TAB === 'cities') v.innerHTML = renderCities();
  else if (TAB === 'bookings') v.innerHTML = renderBookings();
  else if (TAB === 'contacts') v.innerHTML = renderContacts();
  else if (TAB === 'prep') v.innerHTML = renderPrep();
}

function itemActions(it) {
  const btns = [];
  const tks = it.tickets || (it.ticket ? [{ label: 'Ticket', file: it.ticket }] : []);
  for (const a of tks) btns.push(`<button class="ia tkt" data-ticket="${esc(a.file)}" data-mime="application/pdf" data-label="${esc(it.title)}${a.label && a.label !== 'Ticket' ? ' \u2014 ' + esc(a.label) : ''}">\uD83C\uDFAB ${esc(a.label || 'Ticket')}</button>`);
  if (it.map) btns.push(`<a class="ia" href="${mapLink(it.map)}" target="_blank" rel="noopener">\uD83D\uDCCD Map</a>`);
  if (it.call) btns.push(`<a class="ia call" href="${telLink(it.call)}">\uD83D\uDCDE Call</a>`);
  if (it.wa) btns.push(`<a class="ia" href="${waLink(it.wa)}">\uD83D\uDCAC WhatsApp</a>`);
  if (it.ref) btns.push(`<span class="ia ref" data-copy="${esc(it.ref)}">${esc(it.ref)} \u29C9</span>`);
  return btns.length ? `<div class="ia-row">${btns.join('')}</div>` : '';
}

function itemRow(it) {
  return `<div class="item">
    <div class="ic">${esc(it.icon || '\u2022')}</div>
    <div class="body">
      ${it.time ? `<div class="t">${esc(it.time)}</div>` : ''}
      <div class="ti">${esc(it.title)}</div>
      ${it.detail ? `<div class="de">${esc(it.detail)}</div>` : ''}
      ${itemActions(it)}
    </div>
  </div>`;
}

function ideasBlock(day) {
  if (!day.ideas || !day.ideas.length) return '';
  return `<div class="ideas"><div class="ideas-h">💡 While you're in the area</div>${day.ideas.map((i) => `<div class="idea"><div class="idea-t">${esc(i.title)}</div><div class="idea-d">${esc(i.detail)}</div></div>`).join('')}</div>`;
}

function dayTicketCount(day) {
  return (day.items || []).reduce((n, it) => n + (it.tickets ? it.tickets.length : (it.ticket ? 1 : 0)), 0);
}

function dayRow(day, isToday) {
  const tix = dayTicketCount(day);
  const sub = [esc(day.city)];
  if (tix) sub.push(`\uD83C\uDFAB ${tix} ticket${tix > 1 ? 's' : ''}`);
  if (day.dress) sub.push('\uD83D\uDC57 modest');
  const wx = weatherBadge(day);
  if (wx) sub.push(wx);
  if (dayHasBorderAlert(day)) sub.push('\uD83D\uDEC2 border check');
  return `<div class="dayrow${isToday ? ' today' : ''}" data-openday="${day.date}">
    <div class="dr-main">
      <div class="dr-top"><span class="dr-date">${day.flag || ''} ${esc(fmtDate(day.date))}</span>${isToday ? '<span class="badge-today">TODAY</span>' : ''}</div>
      <div class="dr-title">${esc(day.title)}</div>
      <div class="dr-sub muted">${sub.join(' \u00b7 ')}</div>
    </div>
    <div class="dr-caret">\u203A</div>
  </div>`;
}

function renderToday() {
  const t = todayISO();
  const start = DATA.trip.startDate, end = DATA.trip.endDate;
  let html = '';
  const current = DATA.days.find((d) => d.date === t);

  if (t < start) {
    const n = daysBetween(t, start);
    html += `<div class="hero"><div class="sub">Trip starts in</div><div class="countdown">${n} day${n === 1 ? '' : 's'}</div><div class="sub">${esc(DATA.trip.dates)}</div></div>`;
    html += glanceCard();
    html += preTripBookAheadBlock();
    html += `<div class="section-title">First up</div>` + dayRow(DATA.days[0], false);
    return html;
  }
  if (t > end) {
    html += `<div class="hero"><div class="big">Bon retour! ✈️</div><div class="sub">Hope it was magnifique. This trip has wrapped.</div></div>`;
    return html;
  }
  if (current) {
    html += `<div class="hero"><div class="sub">${current.flag || ''} Today · ${esc(fmtDate(current.date))}</div><div class="big">${esc(current.title)}</div><div class="sub">${esc(current.city)}</div></div>`;
    html += alertsBlock(current);
    html += weatherCard(current);
    html += glanceCard();
    html += dayBookRemindersBlock(current);
    html += `<div class="card">${(current.items || []).map(itemRow).join('') || '<div class="muted">Free day.</div>'}
      ${ideasBlock(current)}
      ${current.lodging ? `<div class="kv" style="margin-top:8px"><span class="k">🛏️ Stay</span><span class="v">${esc(current.lodging)}</span></div>` : ''}</div>`;
    html += dayToursBlock(current);
    if (current.dress) html += dressWarn();
    const idx = DATA.days.indexOf(current);
    if (DATA.days[idx + 1]) html += `<div class="section-title">Tomorrow</div>` + dayRow(DATA.days[idx + 1], false);
  } else {
    html += `<div class="hero"><div class="big">On the trip 🎉</div><div class="sub">No detailed plan for today — enjoy!</div></div>`;
    html += glanceCard();
  }
  return html;
}

function dressWarn() {
  return `<div class="warn">👗 <strong>Modest dress today</strong> for a strict site — covered shoulders + knees, or you can be refused entry. Keep a scarf/shawl in the day bag.</div>`;
}

function renderDays() {
  const t = todayISO();
  const cities = [...new Set(DATA.days.map((d) => d.city))];
  let html = `<div class="chips">${cities.map((c) => `<span class="chip" data-scroll="${esc(c)}">${esc(c)}</span>`).join('')}</div>`;
  html += DATA.days.map((d) => `<div id="day-${d.date}">${dayRow(d, d.date === t)}</div>`).join('');
  return html;
}

function renderBookings() {
  let html = '';
  // Flights + trains
  html += `<div class="section-title">✈️ Flights &amp; 🚄 Trains</div>`;
  html += `<div class="card">` + [...DATA.flights.map((f) => ({ ...f, ic: '✈️' })), ...DATA.trains.map((tr) => ({ ...tr, ic: '🚄' }))]
    .map((s) => `<details><summary><span>${s.ic} ${esc(s.label)}</span><span class="caret">›</span></summary>
      <div class="kv"><span class="k">When</span><span class="v">${esc(s.date)} · ${esc(s.time)}</span></div>
      ${s.ref && s.ref !== '—' ? `<div class="kv"><span class="k">Conf</span><span class="v"><span class="ref" data-copy="${esc(s.ref)}">${esc(s.ref)} ⧉</span></span></div>` : ''}
      ${s.note ? `<div class="kv"><span class="k">Note</span><span class="v">${esc(s.note)}</span></div>` : ''}
    </details>`).join('') + `</div>`;

  // Hotels
  html += `<div class="section-title">🛏️ Stays</div><div class="card">` + DATA.hotels.map((h) => `<details><summary><span>${esc(h.name)} <span class="c">· ${esc(h.city)}</span></span><span class="caret">›</span></summary>
    <div class="kv"><span class="k">Dates</span><span class="v">${esc(h.dates)}</span></div>
    ${h.ref && h.ref !== '—' ? `<div class="kv"><span class="k">Conf</span><span class="v"><span class="ref" data-copy="${esc(h.ref)}">${esc(h.ref)} ⧉</span></span></div>` : ''}
    ${h.address ? `<div class="kv"><span class="k">Address</span><span class="v"><a href="${mapLink(h.address + ', ' + h.city)}">${esc(h.address)} ↗</a></span></div>` : ''}
    ${h.note ? `<div class="kv"><span class="k">Note</span><span class="v">${esc(h.note)}</span></div>` : ''}
    ${h.phone ? `<div style="padding-top:8px"><a class="act call" href="${telLink(h.phone)}">📞 Call</a></div>` : ''}
  </details>`).join('') + `</div>`;

  // Cars
  html += `<div class="section-title">🚗 Cars</div><div class="card">` + DATA.cars.map((c) => `<details><summary><span>${esc(c.company)} <span class="c">· ${esc(c.city)}</span></span><span class="caret">›</span></summary>
    <div class="kv"><span class="k">Pickup</span><span class="v">${esc(c.pickup)}</span></div>
    <div class="kv"><span class="k">Drop-off</span><span class="v">${esc(c.dropoff)}</span></div>
    <div class="kv"><span class="k">Conf</span><span class="v"><span class="ref" data-copy="${esc(c.ref)}">${esc(c.ref)} ⧉</span></span></div>
    <div class="kv"><span class="k">Vehicle</span><span class="v">${esc(c.vehicle)}</span></div>
    ${c.note ? `<div class="kv"><span class="k">Note</span><span class="v">${esc(c.note)}</span></div>` : ''}
    ${c.phone ? `<div style="padding-top:8px"><a class="act call" href="${telLink(c.phone)}">📞 Call desk</a></div>` : ''}
  </details>`).join('') + `</div>`;

  // Tickets
  html += `<div class="section-title">🎟️ Tickets &amp; Tours</div><div class="card">` + DATA.tickets.map((tk) => {
    const assets = (tk.assets || []).map((a) => `<button class="act tkt" data-ticket="${esc(a.file)}" data-mime="${esc(a.mime || 'application/pdf')}" data-label="${esc(tk.what)}${a.label ? ' — ' + esc(a.label) : ''}">🎫 ${esc(a.label || 'Show ticket')}</button>`).join('');
    const book = tk.bookUrl ? `<a class="act" href="${esc(tk.bookUrl)}" target="_blank" rel="noopener">🔗 Book</a>` : '';
    return `<div class="tk">
      <div class="dayhead"><div class="d">${tk.status === 'booked' ? '✅' : '⏳'} ${esc(tk.what)}</div><span class="pill ${tk.status === 'booked' ? 'booked' : 'todo'}">${tk.status === 'booked' ? 'BOOKED' : 'TO BOOK'}</span></div>
      <div class="tiny muted" style="margin:2px 0 6px">${esc(tk.date)} · ${esc(tk.city)}${tk.ref && tk.ref !== '—' ? ' · ' + esc(tk.ref) : ''}</div>
      ${assets || book ? `<div class="tk-actions">${assets}${book}</div>` : ''}
    </div>`;
  }).join('') + `</div>`;
  return html;
}

function renderContacts() {
  let html = `<div class="section-title">📇 Contacts</div>`;
  html += DATA.contacts.map((c) => `<div class="card">
    <div class="dayhead"><div class="d">${esc(c.name)}</div><span class="c">${esc(c.role || '')}</span></div>
    ${c.note ? `<div class="de muted" style="margin:4px 0 8px">${esc(c.note)}</div>` : '<div style="height:6px"></div>'}
    <div>
      ${c.phone ? `<a class="act call" href="${telLink(c.phone)}">📞 Call</a>` : ''}
      ${c.whatsapp ? `<a class="act" href="${waLink(c.whatsapp)}">💬 WhatsApp</a>` : ''}
      ${c.email ? `<a class="act" href="mailto:${esc(c.email)}">✉️ Email</a>` : ''}
    </div>
  </div>`).join('');
  html += `<div class="section-title">🆘 Emergency</div><div class="card">` + (DATA.emergency || []).map((e) => `<div class="kv"><span class="k">${esc(e.what)}</span><span class="v"><a class="act call" href="${telLink(e.number)}">📞 ${esc(e.number)}</a></span></div>`).join('') + `</div>`;
  return html;
}

// ---------- Checklist state (persisted per device) ----------
function checkState() { try { return JSON.parse(localStorage.getItem('trip_checks') || '{}'); } catch { return {}; } }
function isChecked(ns, id) { return !!checkState()[ns + '::' + id]; }
function toggleCheck(key) { const s = checkState(); if (s[key]) delete s[key]; else s[key] = true; localStorage.setItem('trip_checks', JSON.stringify(s)); }
function checkRow(ns, id, detail) {
  const on = isChecked(ns, id);
  return `<label class="check${on ? ' on' : ''}" data-check="${esc(ns)}::${esc(id)}">
    <span class="box">${on ? '✓' : ''}</span>
    <span class="ctext"><span class="cmain">${esc(id)}</span>${detail ? `<span class="cdetail">${esc(detail)}</span>` : ''}</span>
  </label>`;
}

function renderPrep() {
  let html = '';
  const p = DATA.prep || {};
  if (p.packing) {
    const total = p.packing.reduce((n, c) => n + c.items.length, 0);
    const done = p.packing.reduce((n, c) => n + c.items.filter((it) => isChecked('pack', it)).length, 0);
    html += `<div class="section-title">🧳 Packing list · ${done}/${total} packed</div>`;
    html += p.packing.map((c) => `<div class="card"><h2>${esc(c.cat)}</h2>${c.items.map((it) => checkRow('pack', it)).join('')}</div>`).join('');
  }
  if (p.beforeYouGo) {
    const total = p.beforeYouGo.length;
    const done = p.beforeYouGo.filter((b) => isChecked('btg', b.title)).length;
    html += `<div class="section-title">✅ Before you go · ${done}/${total} done</div><div class="card">`;
    html += p.beforeYouGo.map((b) => checkRow('btg', b.title, b.detail)).join('') + `</div>`;
  }
  if (DATA.dressCode) {
    html += `<div class="section-title">👗 Modest-dress days</div><div class="card">
      <div class="de muted" style="margin-bottom:8px">${esc(DATA.dressCode.note)}</div>
      ${DATA.dressCode.strict.map((s) => `<div class="kv"><span class="k">🔴 ${esc(s.date)}</span><span class="v">${esc(s.site)} · ${esc(s.city)}</span></div>`).join('')}</div>`;
  }
  if (DATA.tips) {
    html += `<div class="section-title">💡 Tips</div><div class="card"><ul class="tips">${DATA.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
  }
  if (DATA.apps) {
    html += `<div class="section-title">📱 Apps to have</div><div class="card"><div class="chips">${DATA.apps.map((a) => `<span class="chip">${esc(a)}</span>`).join('')}</div></div>`;
  }
  html += `<div class="section-title">👥 Travelers</div><div class="card">${DATA.travelers.map((tr) => `<div class="kv"><span class="k">${esc(tr.name)}</span><span class="v">${esc(tr.note)}</span></div>`).join('')}</div>`;
  html += `<p class="muted tiny" style="text-align:center;margin-top:18px">Updated ${esc(fmtUpdated(DATA.trip.updated))} · encrypted · offline-ready</p>`;
  return html;
}

// ---------- Ticket viewer (decrypt asset → blob → show) ----------
async function decryptAsset(file, mime) {
  const res = await fetch('data/tickets/' + encodeURIComponent(file) + '.enc');
  if (!res.ok) throw new Error('missing');
  const buf = new Uint8Array(await res.arrayBuffer());
  const salt = buf.slice(0, 16), iv = buf.slice(16, 28), ct = buf.slice(28);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASSPHRASE || ''), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return URL.createObjectURL(new Blob([pt], { type: mime }));
}

// ---------- Overlay stack (nested-overlay stacking + device Back) ----------
// Every detail view (ticket / tour / city / day) shares `.tv { z-index:100 }`,
// so which one paints on top was decided by DOM insertion order (i.e. the order
// overlays were first lazily created this session), NOT by which one was opened
// last. So a ticket or tour-map opened from *inside* a day/city/tour overlay
// that happened to be created earlier rendered BEHIND its parent — the tap
// looked like it "did nothing," and the overlay only became visible after the
// parent was dismissed (the "hit back and it shows up" symptom). Fix:
//   (a) on every fresh open, bump z-index + move to end of <body> so the
//       just-opened overlay is always on top, and
//   (b) push a history entry per open so the device/browser Back button closes
//       the top overlay instead of leaving the app.
let TOP_Z = 100;
const OVERLAY_STACK = [];

// Show an overlay on top of everything. `onClose` runs when it's dismissed
// (used to clear the overlay's body / reset state). Idempotent: re-showing an
// already-open overlay (e.g. the day overlay re-rendering on weather load) does
// NOT re-stack, re-order, or push a duplicate history entry.
function showOverlay(o, onClose) {
  o._onClose = onClose || o._onClose || null;
  if (!OVERLAY_STACK.includes(o)) {
    o.style.zIndex = String(++TOP_Z);
    document.body.appendChild(o);
    OVERLAY_STACK.push(o);
    try { history.pushState({ overlay: o.id }, ''); } catch { /* history unavailable */ }
  }
  o.hidden = false;
}

// Hide the top overlay (called by popstate — i.e. the device Back button/gesture).
function hideTopOverlay() {
  const o = OVERLAY_STACK.pop();
  if (!o) return;
  o.hidden = true;
  if (typeof o._onClose === 'function') o._onClose(o);
}

// An in-app ✕ / ‹ Back button was tapped. Unwind one history entry so the
// history stack stays in sync with the overlay stack; popstate does the hide.
function dismissOverlay(o) {
  if (OVERLAY_STACK[OVERLAY_STACK.length - 1] === o) {
    history.back();
  } else {
    const i = OVERLAY_STACK.indexOf(o);
    if (i >= 0) OVERLAY_STACK.splice(i, 1);
    o.hidden = true;
    if (typeof o._onClose === 'function') o._onClose(o);
  }
}

window.addEventListener('popstate', () => { if (OVERLAY_STACK.length) hideTopOverlay(); });

function ticketOverlay() {
  let o = document.getElementById('ticket-overlay');
  if (!o) {
    o = document.createElement('div');
    o.id = 'ticket-overlay'; o.className = 'tv'; o.hidden = true;
    o.innerHTML = `<div class="tv-bar"><span class="tv-title"></span><button class="tv-close" aria-label="Close">✕</button></div><div class="tv-body"></div>`;
    o.querySelector('.tv-close').addEventListener('click', () => dismissOverlay(o));
    document.body.appendChild(o);
  }
  return o;
}

async function showTicket(file, mime, label) {
  const o = ticketOverlay();
  o.querySelector('.tv-title').textContent = label || 'Ticket';
  const body = o.querySelector('.tv-body');
  body.innerHTML = '<div class="tv-msg">Decrypting…</div>';
  showOverlay(o, () => { o.querySelector('.tv-body').innerHTML = ''; });
  try {
    const url = await decryptAsset(file, mime || 'application/pdf');
    if ((mime || '').startsWith('image/')) {
      body.innerHTML = `<div class="tv-zoom"><img class="tv-img" draggable="false" src="${url}" alt="map" /></div><div class="tv-hint">Pinch or double-tap to zoom · drag to pan</div>`;
      initZoom(body);
    } else if (IS_ANDROID) {
      // Android Chrome/WebView renders PDFs fine as a top-level page but shows a
      // BLANK box inside an <iframe>. Open the decrypted blob in a new tab (lands
      // in Chrome's built-in PDF viewer) and offer a download as a fallback.
      const dl = String(label || 'ticket').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'ticket';
      body.innerHTML = `<div class="tv-pdf">
        <div class="tv-pdf-icon">🎫</div>
        <div class="tv-pdf-title">${esc(label || 'Ticket')}</div>
        <div class="tv-pdf-hint">Tap to open your ticket full-screen in the PDF viewer.</div>
        <a class="tv-pdf-open" href="${url}" target="_blank" rel="noopener">Open ticket ↗</a>
        <a class="tv-pdf-dl" href="${url}" download="${dl}.pdf">Download PDF</a>
      </div>`;
    } else {
      body.innerHTML = `<iframe class="tv-frame" src="${url}"></iframe><a class="tv-open" href="${url}" target="_blank" rel="noopener">Open full screen ↗</a>`;
    }
  } catch (e) {
    body.innerHTML = `<div class="tv-msg">Couldn't load this ticket. If you're offline, open it once while online so it caches.</div>`;
  }
}

// Pinch-to-zoom + free pan, fit-to-view on open (touch + mouse/wheel for desktop).
function initZoom(scope) {
  const wrap = scope.querySelector('.tv-zoom');
  const img = scope.querySelector('.tv-img');
  const hint = scope.querySelector('.tv-hint');
  if (!wrap || !img) return;

  let nw = 0, nh = 0, base = 1, scale = 1, tx = 0, ty = 0;
  const MAXF = 7;

  function clamp() {
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    const iw = nw * scale, ih = nh * scale;
    tx = iw <= cw ? (cw - iw) / 2 : Math.min(0, Math.max(cw - iw, tx));
    ty = ih <= ch ? (ch - ih) / 2 : Math.min(0, Math.max(ch - ih, ty));
  }
  function apply() { clamp(); img.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${scale})`; }
  function fit() {
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    nw = img.naturalWidth; nh = img.naturalHeight;
    if (!nw || !cw) return;
    base = Math.min(cw / nw, ch / nh);
    scale = base; tx = (cw - nw * scale) / 2; ty = (ch - nh * scale) / 2;
    apply();
  }
  function zoomAt(px, py, next) {
    next = Math.max(base, Math.min(base * MAXF, next));
    const cx = (px - tx) / scale, cy = (py - ty) / scale;
    scale = next; tx = px - cx * scale; ty = py - cy * scale; apply();
  }
  function rel(cx, cy) { const r = wrap.getBoundingClientRect(); return { x: cx - r.left, y: cy - r.top }; }

  let mode = 0, last = null, startDist = 0, startScale = 1, lastTap = 0;
  const tdist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) { mode = 1; last = rel(e.touches[0].clientX, e.touches[0].clientY); }
    else if (e.touches.length === 2) { mode = 2; startDist = tdist(e.touches[0], e.touches[1]); startScale = scale; }
    e.preventDefault();
  }, { passive: false });
  wrap.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      const d = tdist(e.touches[0], e.touches[1]);
      const m = rel((e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
      if (startDist) zoomAt(m.x, m.y, startScale * (d / startDist));
    } else if (e.touches.length === 1 && mode === 1) {
      const p = rel(e.touches[0].clientX, e.touches[0].clientY);
      tx += p.x - last.x; ty += p.y - last.y; last = p; apply();
    }
    e.preventDefault();
  }, { passive: false });
  wrap.addEventListener('touchend', (e) => {
    if (e.touches.length >= 1) { mode = e.touches.length === 1 ? 1 : 2; if (e.touches[0]) last = rel(e.touches[0].clientX, e.touches[0].clientY); return; }
    mode = 0;
    const now = Date.now();
    if (now - lastTap < 300 && e.changedTouches.length) {
      const p = rel(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      zoomAt(p.x, p.y, scale > base * 1.3 ? base : base * 3);
      lastTap = 0;
    } else { lastTap = now; }
    e.preventDefault();
  }, { passive: false });

  let dragging = false, dLast = null;
  wrap.addEventListener('mousedown', (e) => { dragging = true; dLast = rel(e.clientX, e.clientY); e.preventDefault(); });
  wrap.addEventListener('mousemove', (e) => { if (!dragging) return; const p = rel(e.clientX, e.clientY); tx += p.x - dLast.x; ty += p.y - dLast.y; dLast = p; apply(); });
  wrap.addEventListener('mouseup', () => { dragging = false; });
  wrap.addEventListener('mouseleave', () => { dragging = false; });
  wrap.addEventListener('wheel', (e) => { const p = rel(e.clientX, e.clientY); zoomAt(p.x, p.y, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); e.preventDefault(); }, { passive: false });
  wrap.addEventListener('dblclick', (e) => { const p = rel(e.clientX, e.clientY); zoomAt(p.x, p.y, scale > base * 1.3 ? base : base * 3); e.preventDefault(); });

  wrap.__zoom = { fit, zoomAt, pan: (dx, dy) => { tx += dx; ty += dy; apply(); }, state: () => ({ base: +base.toFixed(4), scale: +scale.toFixed(4), tx: +tx.toFixed(1), ty: +ty.toFixed(1), nw, nh, cw: wrap.clientWidth, ch: wrap.clientHeight }) };

  if (img.complete && img.naturalWidth) fit(); else img.addEventListener('load', fit);
  if (hint) setTimeout(() => { hint.style.opacity = '0'; }, 2800);
}

// ---------- Day detail page ----------
function hotelForLodging(lodging) {
  if (!lodging) return null;
  const base = lodging.split(' (')[0].trim();
  return DATA.hotels.find((h) => lodging.includes(h.name) || (base && h.name.includes(base))) || null;
}
function stayBlock(day) {
  if (!day.lodging) return '';
  const hotel = hotelForLodging(day.lodging);
  const btns = [];
  if (hotel) {
    if (hotel.address) btns.push(`<a class="ia" href="${mapLink(hotel.address + ', ' + hotel.city)}" target="_blank" rel="noopener">📍 Map</a>`);
    if (hotel.phone) btns.push(`<a class="ia call" href="${telLink(hotel.phone)}">📞 Call</a>`);
    if (hotel.ref && hotel.ref !== '\u2014') btns.push(`<span class="ia ref" data-copy="${esc(hotel.ref)}">${esc(hotel.ref)} ⧉</span>`);
  }
  return `<div class="section-title">🛏️ Stay</div><div class="card">
    <div class="ti">${esc(day.lodging)}</div>
    ${hotel && hotel.address ? `<div class="de muted">${esc(hotel.address)}</div>` : ''}
    ${btns.length ? `<div class="ia-row">${btns.join('')}</div>` : ''}
  </div>`;
}
function dayContactsBlock(day) {
  const pick = (n) => DATA.contacts.find((c) => c.name === n)
    || DATA.contacts.find((c) => c.name && (c.name.includes(n) || n.includes(c.name)));
  const seen = new Set();
  const cs = (day.contacts || []).map(pick).filter((c) => c && !seen.has(c.name) && seen.add(c.name));
  if (!cs.length) return '';
  return `<div class="section-title">📇 Today's contacts</div>` + cs.map((c) => `<div class="card">
    <div class="dayhead"><div class="d">${esc(c.name)}</div><span class="c">${esc(c.role || '')}</span></div>
    <div class="ia-row">
      ${c.phone ? `<a class="ia call" href="${telLink(c.phone)}">📞 Call</a>` : ''}
      ${c.whatsapp ? `<a class="ia" href="${waLink(c.whatsapp)}">💬 WhatsApp</a>` : ''}
      ${c.email ? `<a class="ia" href="mailto:${esc(c.email)}">✉️ Email</a>` : ''}
    </div>
  </div>`).join('');
}
// Tickets & passes relevant to THIS day, pulled from the top-level tickets list
// (matched by date). Gives a prominent, tappable place to reach each day's
// tickets — view button for ones with an encrypted asset, Book link for todos.
function dayTicketsBlock(day) {
  const d = new Date(day.date + 'T12:00:00');
  const md = d.toLocaleDateString('en-US', { month: 'short' }) + ' ' + d.getDate(); // e.g. "Aug 3"
  const re = new RegExp('\\b' + md.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
  const items = (DATA.tickets || []).filter((t) => t.date && re.test(t.date));
  if (!items.length) return '';
  const rows = items.map((t) => {
    const assets = (t.assets || []).map((a) => `<button class="ia tkt" data-ticket="${esc(a.file)}" data-mime="${esc(a.mime || 'application/pdf')}" data-label="${esc(t.what)}${a.label && a.label !== 'Ticket' && a.label !== 'Pass' ? ' \u2014 ' + esc(a.label) : ''}">🎫 ${esc(a.label || 'Ticket')}</button>`).join('');
    const book = t.bookUrl ? `<a class="ia" href="${esc(t.bookUrl)}" target="_blank" rel="noopener">🔗 Book</a>` : '';
    const pill = `<span class="pill ${t.status === 'booked' ? 'booked' : 'todo'}">${t.status === 'booked' ? 'BOOKED' : 'TO BOOK'}</span>`;
    return `<div class="tkrow">
      <div class="dayhead"><div class="d">${esc(t.what)}</div>${pill}</div>
      ${t.ref && t.ref !== '\u2014' ? `<div class="tiny muted" style="margin:2px 0 6px">${esc(t.ref)}</div>` : ''}
      ${(assets || book) ? `<div class="ia-row">${assets}${book}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="section-title">🎫 Tickets &amp; passes</div><div class="card">${rows}</div>`;
}
// Advance-booking reminders — show on the day you must BOOK (ticket.bookBy),
// not the day of the event. e.g. Notre-Dame (Aug 7) surfaces a reminder Aug 4.
function bookRemindersForDay(day) {
  return (DATA.tickets || []).filter((t) => t.bookBy === day.date && t.status !== 'booked');
}
function dayBookRemindersBlock(day) {
  const rs = bookRemindersForDay(day);
  if (!rs.length) return '';
  return rs.map((t) => `<div class="bookrem">
    <div class="br-h">⏰ Book today: ${esc(t.what)}</div>
    <div class="br-sub">For ${esc(t.date)}${t.bookLead ? ' · ' + esc(t.bookLead) : ''}${t.ref && t.ref !== '—' ? ' · ' + esc(t.ref) : ''}</div>
    ${t.bookUrl ? `<div class="ia-row" style="margin-top:8px"><a class="ia tkt" href="${esc(t.bookUrl)}" target="_blank" rel="noopener">🔗 Book now</a></div>` : ''}
  </div>`).join('');
}
// Book-ahead items (mandatory advance reservation that sells out, e.g. Borghese).
// Shown on the pre-trip countdown screen so they're reserved before you leave.
function preTripBookAheadBlock() {
  const rs = (DATA.tickets || []).filter((t) => t.bookAhead && t.status !== 'booked');
  if (!rs.length) return '';
  return `<div class="section-title">🎟️ Book before you go</div>` + rs.map((t) => `<div class="bookrem">
    <div class="br-h">📌 ${esc(t.what)}${t.date ? ' — ' + esc(t.date) : ''}</div>
    ${t.bookNote ? `<div class="br-sub">${esc(t.bookNote)}</div>` : ''}
    ${t.bookUrl ? `<div class="ia-row" style="margin-top:8px"><a class="ia tkt" href="${esc(t.bookUrl)}" target="_blank" rel="noopener">🔗 Book now</a></div>` : ''}
  </div>`).join('');
}
// Self-guided tours (Rick Steves etc.): a tile on the day → step-by-step view
// with a full-route Google Maps link + per-stop pings. Written narration is
// stubbed (textStatus) until the user adds it from the book.
function toursForDay(day) {
  return (DATA.tours || []).filter((t) => t.date === day.date);
}
function tourRouteUrl(tour) {
  const pts = (tour.stops || []).filter((s) => s.map).map((s) => encodeURIComponent(s.map));
  if (pts.length < 2) return '';
  const origin = pts[0], destination = pts[pts.length - 1];
  const wp = pts.slice(1, -1).join('%7C');
  const mode = tour.type === 'boat' ? 'transit' : 'walking';
  return `https://www.google.com/maps/dir/?api=1&travelmode=${mode}&origin=${origin}&destination=${destination}` + (wp ? `&waypoints=${wp}` : '');
}
function dayToursBlock(day) {
  const ts = toursForDay(day);
  if (!ts.length) return '';
  return `<div class="section-title">🎧 Self-guided tours</div>` + ts.map((t) => `<div class="tourtile" data-opentour="${esc(t.id)}">
    <div class="tt-main">
      <div class="tt-title">${esc(t.title)}</div>
      <div class="tt-sub muted">${esc(t.by || '')}${t.duration ? ' · ' + esc(t.duration) : ''}${(t.stops && t.stops.length) ? ' · ' + t.stops.length + ' stops' : ''}</div>
    </div>
    <div class="tt-caret">›</div>
  </div>`).join('');
}
function tourOverlay() {
  let o = document.getElementById('tour-overlay');
  if (!o) {
    o = document.createElement('div');
    o.id = 'tour-overlay'; o.className = 'tv'; o.hidden = true;
    o.innerHTML = `<div class="tv-bar"><button class="tv-back">‹ Back</button><span class="tv-title"></span><span style="width:64px"></span></div><div class="tv-body tour-detail"></div>`;
    o.querySelector('.tv-back').addEventListener('click', () => dismissOverlay(o));
    o.querySelector('.tour-detail').addEventListener('click', onViewClick);
    document.body.appendChild(o);
  }
  return o;
}
function openTour(id) {
  const t = (DATA.tours || []).find((x) => x.id === id);
  if (!t) return;
  const o = tourOverlay();
  o.querySelector('.tv-title').textContent = t.title;
  const b = o.querySelector('.tour-detail');
  const route = tourRouteUrl(t);
  const stops = t.stops || [];
  b.innerHTML = `
    <div class="hero"><div class="sub">${t.by ? esc(t.by) + ' · ' : ''}${t.type === 'boat' ? '🚤 Boat' : t.type === 'indoor' ? '🏛️ Indoor' : '🚶 Walk'}${t.duration ? ' · ' + esc(t.duration) : ''}</div><div class="big">${esc(t.title)}</div></div>
    ${t.intro ? `<div class="card"><div class="de">${esc(t.intro)}</div></div>` : ''}
    ${(t.audio || t.board || route || t.mapAsset) ? `<div class="card">
      ${t.audio ? `<div class="kv"><span class="k">🎧 Audio</span><span class="v">${esc(t.audio)}</span></div>` : ''}
      ${t.board ? `<div class="kv"><span class="k">🚏 Board</span><span class="v">${esc(t.board)}</span></div>` : ''}
      ${(t.mapAsset || route) ? `<div class="ia-row" style="margin-top:10px">${t.mapAsset ? `<button class="ia tkt" data-ticket="${esc(t.mapAsset)}" data-mime="image/jpeg" data-label="${esc(t.title)} — map">🗺️ Tour map</button>` : ''}${route ? `<a class="ia tkt" href="${route}" target="_blank" rel="noopener">🧭 Route in Google Maps</a>` : ''}</div>` : ''}
    </div>` : ''}
    ${stops.length ? `<div class="section-title">Stops</div><div class="card">${stops.map((s, i) => `
      <div class="tourstop">
        <div class="ts-head"><span class="ts-num">${i + 1}</span><span class="ts-name">${esc(s.name)}</span></div>
        ${s.note ? `<div class="tiny" style="color:var(--amber);margin:3px 0 0 34px">${esc(s.note)}</div>` : ''}
        ${s.text ? `<div class="de" style="margin:4px 0 0 34px">${esc(s.text)}</div>` : ''}
        ${s.map ? `<div class="ia-row" style="margin-left:34px"><a class="ia" href="${mapLink(s.map)}" target="_blank" rel="noopener">📍 Map</a></div>` : ''}
      </div>`).join('')}</div>` : ''}
    ${t.outro ? `<div class="card"><div class="de">${esc(t.outro)}</div></div>` : ''}
    ${t.textStatus === 'stub' ? `<div class="warn" style="margin-top:12px">✍️ Step-by-step written notes aren't in the app yet${stops.length ? '' : ' and the stop list still needs adding'}. Snap photos of these pages in your Rick Steves book and send them — I'll drop the notes under each stop so you can leave the book home.</div>` : ''}
  `;
  showOverlay(o, () => { o.querySelector('.tour-detail').innerHTML = ''; });
  b.scrollTop = 0;
}
// City guide hubs: per-city hotel + self-guided tours + practical tips.
function renderCities() {
  const cs = DATA.cities || [];
  if (!cs.length) return '<div class="muted">No city guides yet.</div>';
  let html = `<div class="section-title">🏙️ City guides</div>`;
  html += cs.map((c) => {
    const nTours = (DATA.tours || []).filter((t) => t.city === c.name).length;
    const bits = [];
    if (nTours) bits.push(`${nTours} tour${nTours > 1 ? 's' : ''}`);
    return `<div class="dayrow" data-opencity="${esc(c.name)}">
      <div class="dr-main">
        <div class="dr-top"><span class="dr-date">${c.flag || ''} ${esc(c.name)}</span></div>
        <div class="dr-sub muted">${esc(c.note || '')}${bits.length ? ' · ' + bits.join(' · ') : ''}</div>
      </div>
      <div class="dr-caret">›</div>
    </div>`;
  }).join('');
  return html;
}
function dayCityLink(day) {
  const c = (DATA.cities || []).find((x) => day.city && day.city.includes(x.name));
  if (!c) return '';
  return `<div class="citylink" data-opencity="${esc(c.name)}"><span>🏙️ ${esc(c.name)} guide — hotel, tours &amp; tips</span><span class="dr-caret">›</span></div>`;
}
function cityOverlay() {
  let o = document.getElementById('city-overlay');
  if (!o) {
    o = document.createElement('div');
    o.id = 'city-overlay'; o.className = 'tv'; o.hidden = true;
    o.innerHTML = `<div class="tv-bar"><button class="tv-back">‹ Back</button><span class="tv-title"></span><span style="width:64px"></span></div><div class="tv-body city-detail"></div>`;
    o.querySelector('.tv-back').addEventListener('click', () => dismissOverlay(o));
    o.querySelector('.city-detail').addEventListener('click', onViewClick);
    document.body.appendChild(o);
  }
  return o;
}
function openCity(name) {
  const c = (DATA.cities || []).find((x) => x.name === name);
  if (!c) return;
  const o = cityOverlay();
  o.querySelector('.tv-title').textContent = c.name;
  const b = o.querySelector('.city-detail');
  const hotels = (DATA.hotels || []).filter((h) => h.city === c.name);
  const tours = (DATA.tours || []).filter((t) => t.city === c.name);
  const stayHtml = hotels.map((h) => {
    const btns = [];
    if (h.address) btns.push(`<a class="ia" href="${mapLink(h.address + ', ' + h.city)}" target="_blank" rel="noopener">📍 Map</a>`);
    if (h.phone) btns.push(`<a class="ia call" href="${telLink(h.phone)}">📞 Call</a>`);
    if (h.ref && h.ref !== '—') btns.push(`<span class="ia ref" data-copy="${esc(h.ref)}">${esc(h.ref)} ⧉</span>`);
    return `<div class="card"><div class="ti">${esc(h.name)}</div>${h.dates ? `<div class="tiny muted">${esc(h.dates)}</div>` : ''}${h.address ? `<div class="de muted" style="margin-top:2px">${esc(h.address)}</div>` : ''}${btns.length ? `<div class="ia-row">${btns.join('')}</div>` : ''}</div>`;
  }).join('');
  const tourHtml = tours.map((t) => `<div class="tourtile" data-opentour="${esc(t.id)}"><div class="tt-main"><div class="tt-title">${esc(t.title)}</div><div class="tt-sub muted">${esc(t.by || '')}${t.duration ? ' · ' + esc(t.duration) : ''}</div></div><div class="tt-caret">›</div></div>`).join('');
  b.innerHTML = `
    <div class="hero"><div class="sub">${c.flag || ''} ${esc(c.note || '')}</div><div class="big">${esc(c.name)}</div></div>
    ${hotels.length ? `<div class="section-title">🛏️ Stay</div>${stayHtml}` : ''}
    ${tours.length ? `<div class="section-title">🎧 Self-guided tours</div>${tourHtml}` : ''}
    ${(c.tips && c.tips.length) ? `<div class="section-title">💡 Good to know</div><div class="card">${c.tips.map((t) => `<div class="brow">• ${esc(t)}</div>`).join('')}</div>` : ''}
  `;
  showOverlay(o, () => { o.querySelector('.city-detail').innerHTML = ''; });
  b.scrollTop = 0;
}
function dayOverlay() {
  let o = document.getElementById('day-overlay');
  if (!o) {
    o = document.createElement('div');
    o.id = 'day-overlay'; o.className = 'tv'; o.hidden = true;
    o.innerHTML = `<div class="tv-bar"><button class="tv-back">‹ Back</button><span class="tv-title"></span><span style="width:64px"></span></div><div class="tv-body day-detail"></div>`;
    o.querySelector('.tv-back').addEventListener('click', () => dismissOverlay(o));
    o.querySelector('.day-detail').addEventListener('click', onViewClick);
    document.body.appendChild(o);
  }
  return o;
}
function openDay(date) {
  const day = DATA.days.find((d) => d.date === date);
  if (!day) return;
  OPEN_DAY = date;
  const o = dayOverlay();
  o.querySelector('.tv-title').textContent = fmtDate(day.date);
  const b = o.querySelector('.day-detail');
  b.innerHTML = `
    <div class="hero"><div class="sub">${day.flag || ''} ${esc(fmtDate(day.date))} · ${esc(day.city)}</div><div class="big">${esc(day.title)}</div></div>
    ${alertsBlock(day)}
    ${weatherCard(day)}
    ${day.dress ? dressWarn() : ''}
    ${dayBookRemindersBlock(day)}
    <div class="card">${(day.items || []).map(itemRow).join('') || '<div class="muted">Free day \u2014 enjoy!</div>'}</div>
    ${dayTicketsBlock(day)}
    ${dayToursBlock(day)}
    ${ideasBlock(day)}
    ${day.bring && day.bring.length ? `<div class="section-title">🎒 Bring</div><div class="card">${day.bring.map((x) => `<div class="brow">• ${esc(x)}</div>`).join('')}</div>` : ''}
    ${stayBlock(day)}
    ${dayContactsBlock(day)}
    ${dayCityLink(day)}`;
  showOverlay(o, () => { o.querySelector('.day-detail').innerHTML = ''; OPEN_DAY = null; });
  b.scrollTop = 0;
}

// ---------- View interactions ----------
let toastT = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(80px + env(safe-area-inset-bottom));background:#0f1830;border:1px solid #2a355c;color:#eef2ff;padding:10px 16px;border-radius:12px;z-index:50;font-size:14px;box-shadow:0 8px 30px rgba(0,0,0,.5)'; document.body.appendChild(el); }
  el.textContent = msg; el.style.opacity = '1';
  clearTimeout(toastT); toastT = setTimeout(() => { el.style.opacity = '0'; }, 1400);
}

function onViewClick(e) {
  const goto = e.target.closest('[data-goto]');
  if (goto) { switchTab(goto.getAttribute('data-goto')); return; }
  const check = e.target.closest('[data-check]');
  if (check) {
    toggleCheck(check.getAttribute('data-check'));
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    return;
  }
  const tkt = e.target.closest('[data-ticket]');
  if (tkt) {
    showTicket(tkt.getAttribute('data-ticket'), tkt.getAttribute('data-mime'), tkt.getAttribute('data-label'));
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const text = copy.getAttribute('data-copy');
    navigator.clipboard?.writeText(text).then(() => toast('Copied ' + text)).catch(() => toast(text));
    return;
  }
  if (e.target.closest('a')) return; // map/call/email/WhatsApp links handle themselves
  const openday = e.target.closest('[data-openday]');
  if (openday) { openDay(openday.getAttribute('data-openday')); return; }
  const opentour = e.target.closest('[data-opentour]');
  if (opentour) { openTour(opentour.getAttribute('data-opentour')); return; }
  const opencity = e.target.closest('[data-opencity]');
  if (opencity) { openCity(opencity.getAttribute('data-opencity')); return; }
  const scroll = e.target.closest('[data-scroll]');
  if (scroll) {
    const city = scroll.getAttribute('data-scroll');
    const day = DATA.days.find((d) => d.city === city);
    if (day) document.getElementById('day-' + day.date)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
