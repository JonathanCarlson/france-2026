'use strict';

// ---------- Service worker (offline) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

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
  $('#lock-btn').addEventListener('click', () => { localStorage.removeItem(PASS_KEY); location.reload(); });
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#view').addEventListener('click', onViewClick);
  maybeShowIosHint();
  render();
}

function maybeShowIosHint() {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (!isIos || standalone || localStorage.getItem('ios_hint_dismissed')) return;
  const b = document.createElement('div');
  b.className = 'ios-hint';
  b.innerHTML = `<span>Tip: tap <b>Share</b> then <b>Add to Home Screen</b> to install &amp; use offline.</span><button aria-label="Dismiss">✕</button>`;
  b.querySelector('button').addEventListener('click', () => { b.remove(); localStorage.setItem('ios_hint_dismissed', '1'); });
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

// ---------- Link helpers ----------
const telLink = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;
const waLink = (p) => `https://wa.me/${String(p).replace(/[^\d]/g, '')}`;
const mapLink = (q) => `https://maps.google.com/?q=${encodeURIComponent(q)}`;

// ---------- Render ----------
function render() {
  const v = $('#view');
  if (TAB === 'today') v.innerHTML = renderToday();
  else if (TAB === 'days') v.innerHTML = renderDays();
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
    html += `<div class="section-title">First up</div>` + dayRow(DATA.days[0], false);
    return html;
  }
  if (t > end) {
    html += `<div class="hero"><div class="big">Bon retour! ✈️</div><div class="sub">Hope it was magnifique. This trip has wrapped.</div></div>`;
    return html;
  }
  if (current) {
    html += `<div class="hero"><div class="sub">${current.flag || ''} Today · ${esc(fmtDate(current.date))}</div><div class="big">${esc(current.title)}</div><div class="sub">${esc(current.city)}</div></div>`;
    html += glanceCard();
    html += `<div class="card">${(current.items || []).map(itemRow).join('') || '<div class="muted">Free day.</div>'}
      ${ideasBlock(current)}
      ${current.lodging ? `<div class="kv" style="margin-top:8px"><span class="k">🛏️ Stay</span><span class="v">${esc(current.lodging)}</span></div>` : ''}</div>`;
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
  html += `<p class="muted tiny" style="text-align:center;margin-top:18px">Updated ${esc(DATA.trip.updated)} · encrypted · offline-ready</p>`;
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

function ticketOverlay() {
  let o = document.getElementById('ticket-overlay');
  if (!o) {
    o = document.createElement('div');
    o.id = 'ticket-overlay'; o.className = 'tv'; o.hidden = true;
    o.innerHTML = `<div class="tv-bar"><span class="tv-title"></span><button class="tv-close" aria-label="Close">✕</button></div><div class="tv-body"></div>`;
    o.querySelector('.tv-close').addEventListener('click', () => { o.hidden = true; o.querySelector('.tv-body').innerHTML = ''; });
    document.body.appendChild(o);
  }
  return o;
}

async function showTicket(file, mime, label) {
  const o = ticketOverlay();
  o.querySelector('.tv-title').textContent = label || 'Ticket';
  const body = o.querySelector('.tv-body');
  body.innerHTML = '<div class="tv-msg">Decrypting…</div>';
  o.hidden = false;
  try {
    const url = await decryptAsset(file, mime || 'application/pdf');
    if ((mime || '').startsWith('image/')) {
      body.innerHTML = `<img class="tv-img" src="${url}" alt="ticket" />`;
    } else {
      body.innerHTML = `<iframe class="tv-frame" src="${url}"></iframe><a class="tv-open" href="${url}" target="_blank" rel="noopener">Open full screen ↗</a>`;
    }
  } catch (e) {
    body.innerHTML = `<div class="tv-msg">Couldn't load this ticket. If you're offline, open it once while online so it caches.</div>`;
  }
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
function dayOverlay() {
  let o = document.getElementById('day-overlay');
  if (!o) {
    o = document.createElement('div');
    o.id = 'day-overlay'; o.className = 'tv'; o.hidden = true;
    o.innerHTML = `<div class="tv-bar"><button class="tv-back">‹ Back</button><span class="tv-title"></span><span style="width:64px"></span></div><div class="tv-body day-detail"></div>`;
    o.querySelector('.tv-back').addEventListener('click', () => { o.hidden = true; o.querySelector('.day-detail').innerHTML = ''; });
    o.querySelector('.day-detail').addEventListener('click', onViewClick);
    document.body.appendChild(o);
  }
  return o;
}
function openDay(date) {
  const day = DATA.days.find((d) => d.date === date);
  if (!day) return;
  const o = dayOverlay();
  o.querySelector('.tv-title').textContent = fmtDate(day.date);
  const b = o.querySelector('.day-detail');
  b.innerHTML = `
    <div class="hero"><div class="sub">${day.flag || ''} ${esc(fmtDate(day.date))} · ${esc(day.city)}</div><div class="big">${esc(day.title)}</div></div>
    ${day.dress ? dressWarn() : ''}
    <div class="card">${(day.items || []).map(itemRow).join('') || '<div class="muted">Free day \u2014 enjoy!</div>'}</div>
    ${dayTicketsBlock(day)}
    ${ideasBlock(day)}
    ${day.bring && day.bring.length ? `<div class="section-title">🎒 Bring</div><div class="card">${day.bring.map((x) => `<div class="brow">• ${esc(x)}</div>`).join('')}</div>` : ''}
    ${stayBlock(day)}
    ${dayContactsBlock(day)}`;
  o.hidden = false;
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
  const scroll = e.target.closest('[data-scroll]');
  if (scroll) {
    const city = scroll.getAttribute('data-scroll');
    const day = DATA.days.find((d) => d.city === city);
    if (day) document.getElementById('day-' + day.date)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
