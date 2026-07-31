'use strict';

// album.js — the friends-shareable, photos-ONLY album.
//
// Access model ("security by obscurity", as requested): the album key lives in
// the URL fragment  album.html#k=<key>  which the browser NEVER sends to the
// server. That key is an independent, high-entropy token — NOT the family
// passphrase — so this page can decrypt ONLY data/album/* (the photos). It can
// never touch the itinerary, tickets, or contacts, and it never exposes the
// family passphrase. If the link has no #k=, we fall back to a manual code box.
//
// Crypto matches the rest of the app: PBKDF2(SHA-256, 250000) -> AES-GCM-256.
//   data/album/index.enc       JSON payload {v,kdf,salt,iv,ct} -> the manifest
//   data/album/photos/<id>.enc raw [16 salt][12 iv][ct]        -> each JPEG

const ITERATIONS = 250000;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

let KEY = null;         // the album key string
let MANIFEST = null;    // decrypted manifest
const PHOTO_URLS = {};  // session cache of decrypted blob URLs by id

// ---------- crypto ----------
async function deriveKey(salt, usage) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, [usage],
  );
}

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

async function decryptPhoto(file) {
  const res = await fetch(`data/album/photos/${encodeURIComponent(file)}.enc`, { cache: 'force-cache' });
  if (!res.ok) throw new Error('fetch ' + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const ct = bytes.slice(28);
  const key = await deriveKey(salt, 'decrypt');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  const blob = new Blob([pt], { type: 'image/jpeg' });
  return URL.createObjectURL(blob);
}

async function photoUrl(id) {
  if (PHOTO_URLS[id]) return PHOTO_URLS[id];
  const ph = (MANIFEST.photos || []).find((p) => p.id === id);
  const file = (ph && ph.file) || id;
  const url = await decryptPhoto(file);
  PHOTO_URLS[id] = url;
  return url;
}

// ---------- boot ----------
(function boot() {
  const m = /[#&]k=([^&]+)/.exec(location.hash || '');
  if (m) {
    KEY = decodeURIComponent(m[1]).trim();
    // Strip the key from the visible URL bar (it stays in memory) so a casual
    // over-the-shoulder glance / screenshot of the address doesn't reveal it.
    // The link the user shared still works; only the on-screen bar is cleaned.
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
    openAlbum();
  } else {
    $('#gate').hidden = false;
    $('#gate-form').addEventListener('submit', onGate);
  }
})();

async function onGate(e) {
  e.preventDefault();
  const code = $('#album-code').value.trim();
  const err = $('#gate-error');
  err.hidden = true;
  if (!code) return;
  KEY = code;
  $('#gate-btn').textContent = 'Opening…';
  const ok = await tryLoadManifest();
  if (ok) {
    $('#gate').hidden = true;
    openAlbum(true);
  } else {
    KEY = null;
    err.textContent = 'That code didn’t work. Check it and try again.';
    err.hidden = false;
    $('#gate-btn').textContent = 'View photos';
  }
}

async function tryLoadManifest() {
  try {
    const res = await fetch('data/album/index.enc', { cache: 'no-cache' });
    const payload = await res.json();
    MANIFEST = await decryptPayload(payload);
    return true;
  } catch {
    return false;
  }
}

async function openAlbum(alreadyLoaded) {
  $('#album').hidden = false;
  if (!alreadyLoaded) {
    const ok = await tryLoadManifest();
    if (!ok) {
      $('#album-status').innerHTML = '<div class="big">🔒</div>Couldn’t open this album. '
        + 'The link may be incomplete or the album may have moved. Ask for a fresh link.';
      return;
    }
  }
  render();
}

function render() {
  document.title = (MANIFEST.title || 'Trip Photos') + ' — Photos';
  $('#album-title').textContent = MANIFEST.title || 'Trip Photos';
  const parts = [];
  if (MANIFEST.dates) parts.push(MANIFEST.dates);
  parts.push(`${MANIFEST.count || (MANIFEST.photos || []).length} photos`);
  $('#album-sub').textContent = parts.join(' · ');

  const photos = (MANIFEST.photos || []).slice();
  const status = $('#album-status');
  if (!photos.length) {
    status.innerHTML = '<div class="big">📷</div>No photos in this album yet.';
    return;
  }
  status.hidden = true;

  photos.sort((a, b) => String(a.taken || a.date).localeCompare(String(b.taken || b.date)));
  const groups = [];
  const byDate = {};
  for (const p of photos) {
    if (!byDate[p.date]) { byDate[p.date] = { date: p.date, label: p.caption || p.dayTitle || p.date, items: [] }; groups.push(byDate[p.date]); }
    byDate[p.date].items.push(p);
  }
  groups.sort((a, b) => a.date.localeCompare(b.date));

  let html = '';
  for (const g of groups) {
    html += `<div class="photo-group-title">${esc(g.label)}</div><div class="photo-grid">`;
    for (const p of g.items) {
      html += `<button class="photo-tile" data-photo="${esc(p.id)}" aria-label="${esc(p.desc || 'Photo')}">`
        + `<span class="photo-thumb-wrap"><img class="photo-thumb" data-photo-img="${esc(p.id)}" alt="${esc(p.desc || '')}" /></span>`
        + (p.desc ? `<span class="photo-cap">${esc(p.desc)}</span>` : '')
        + (p.people && p.people.length ? `<span class="photo-people">👥 ${esc(p.people.join(', '))}</span>` : '')
        + '</button>';
    }
    html += '</div>';
  }
  $('#album-grid').innerHTML = html;
  $('#album-grid').addEventListener('click', onGridClick);
  hydrateThumbs();
}

// Sequentially decrypt thumbnails so a phone isn't hit with 100 parallel PBKDF2 runs.
async function hydrateThumbs() {
  const imgs = Array.from(document.querySelectorAll('#album-grid [data-photo-img]'));
  for (const img of imgs) {
    const id = img.getAttribute('data-photo-img');
    try {
      img.src = await photoUrl(id);
      img.closest('.photo-tile')?.classList.add('loaded');
    } catch {
      img.closest('.photo-tile')?.classList.add('failed');
    }
  }
}

function onGridClick(e) {
  const tile = e.target.closest('[data-photo]');
  if (tile) showPhoto(tile.getAttribute('data-photo'));
}

// ---------- full-screen viewer ----------
function orderedIds() {
  const photos = (MANIFEST.photos || []).slice();
  photos.sort((a, b) => String(a.taken || a.date).localeCompare(String(b.taken || b.date)));
  const groups = [];
  const byDate = {};
  for (const p of photos) {
    if (!byDate[p.date]) { byDate[p.date] = []; groups.push({ date: p.date, items: byDate[p.date] }); }
    byDate[p.date].push(p);
  }
  groups.sort((a, b) => a.date.localeCompare(b.date));
  const ids = [];
  for (const g of groups) for (const p of g.items) ids.push(p.id);
  return ids;
}

function overlay() {
  let o = document.getElementById('photo-overlay');
  if (!o) {
    o = document.createElement('div');
    o.id = 'photo-overlay'; o.className = 'tv'; o.hidden = true;
    o.innerHTML = '<div class="tv-bar"><span class="tv-title"></span>'
      + '<div class="tv-bar-actions">'
      + '<button class="tv-dl" aria-label="Save photo" title="Save photo">⬇</button>'
      + '<button class="tv-close" aria-label="Close">✕</button>'
      + '</div></div>'
      + '<div class="tv-body"></div>'
      + '<button class="tv-nav tv-prev" aria-label="Previous photo" hidden>‹</button>'
      + '<button class="tv-nav tv-next" aria-label="Next photo" hidden>›</button>';
    o.querySelector('.tv-close').addEventListener('click', () => dismiss(o));
    o.querySelector('.tv-dl').addEventListener('click', () => downloadCurrent(o));
    o.querySelector('.tv-prev').addEventListener('click', () => step(o, -1));
    o.querySelector('.tv-next').addEventListener('click', () => step(o, 1));
    document.body.appendChild(o);
  }
  return o;
}

function updateNav(o) {
  const nav = o._nav;
  const prev = o.querySelector('.tv-prev');
  const next = o.querySelector('.tv-next');
  if (!nav || nav.ids.length <= 1) { prev.hidden = true; next.hidden = true; return; }
  prev.hidden = nav.index <= 0;
  next.hidden = nav.index >= nav.ids.length - 1;
}

function step(o, delta) {
  const nav = o._nav;
  if (!nav) return;
  const i = nav.index + delta;
  if (i < 0 || i >= nav.ids.length) return;
  nav.index = i;
  renderAt(o);
}

async function renderAt(o) {
  const nav = o._nav;
  const id = nav.ids[nav.index];
  const total = nav.ids.length;
  const ph = (MANIFEST.photos || []).find((p) => p.id === id);
  const body = o.querySelector('.tv-body');
  o.querySelector('.tv-title').textContent = ((ph && ph.caption) || 'Photo') + (total > 1 ? `  ·  ${nav.index + 1} / ${total}` : '');
  body.innerHTML = '<div class="tv-msg">Decrypting…</div>';
  updateNav(o);
  try {
    const url = await photoUrl(id);
    const capBits = [];
    if (ph && ph.desc) capBits.push(esc(ph.desc));
    if (ph && ph.people && ph.people.length) capBits.push('👥 ' + esc(ph.people.join(', ')));
    body.innerHTML = `<div class="tv-zoom"><img class="tv-img" src="${url}" alt="" /></div>`
      + (capBits.length ? `<div class="photo-caption">${capBits.join('<br>')}</div>` : '');
    initZoom(o, body);
  } catch {
    body.innerHTML = '<div class="tv-msg">Couldn’t load this photo. If you’re offline, open it once while online.</div>';
  }
}

function initZoom(o, body) {
  const zoom = body.querySelector('.tv-zoom');
  const img = zoom.querySelector('.tv-img');
  if (!img) return;
   
  let nw = 0, nh = 0, base = 1, scale = 1, tx = 0, ty = 0;
  let mode = 0, last = null, startDist = null, startScale = null, startX = null;
   
  img.addEventListener('load', () => {
    if (!img.naturalWidth) return;
    nw = img.naturalWidth;
    nh = img.naturalHeight;
    fit();
    apply();
  });
   
  if (img.complete) img.dispatchEvent(new Event('load'));
   
  function clamp() {
    const cw = zoom.clientWidth, ch = zoom.clientHeight;
    const iw = nw * scale, ih = nh * scale;
    if (iw <= cw) tx = (cw - iw) / 2; else { tx = Math.max(-iw + cw, Math.min(0, tx)); }
    if (ih <= ch) ty = (ch - ih) / 2; else { ty = Math.max(-ih + ch, Math.min(0, ty)); }
  }
   
  function fit() {
    const cw = zoom.clientWidth, ch = zoom.clientHeight;
    if (nw === 0 || nh === 0) return;
    base = Math.min(cw / nw, ch / nh);
    scale = base;
    tx = (cw - nw * scale) / 2;
    ty = (ch - nh * scale) / 2;
  }
   
  function apply() {
    img.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${scale})`;
  }
   
  function rel(px, py) {
    const r = zoom.getBoundingClientRect();
    return { x: px - r.left, y: py - r.top };
  }
   
  function tdist(t1, t2) {
    const dx = t1.clientX - t2.clientX, dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
   
  function zoomAt(px, py, next) {
    next = Math.max(base, Math.min(next, base * 3));
    const cx = (px - tx) / scale, cy = (py - ty) / scale;
    scale = next;
    tx = px - cx * scale;
    ty = py - cy * scale;
    clamp();
    apply();
  }
   
  zoom.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      mode = 1;
      last = rel(e.touches[0].clientX, e.touches[0].clientY);
      startX = e.touches[0].clientX;
    } else if (e.touches.length === 2) {
      mode = 2;
      startDist = tdist(e.touches[0], e.touches[1]);
      startScale = scale;
    }
  }, { passive: true });
   
  zoom.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && startDist) {
      const d = tdist(e.touches[0], e.touches[1]);
      const m = rel((e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
      zoomAt(m.x, m.y, startScale * (d / startDist));
    } else if (e.touches.length === 1 && mode === 1 && last) {
      const p = rel(e.touches[0].clientX, e.touches[0].clientY);
      tx += p.x - last.x;
      ty += p.y - last.y;
      clamp();
      apply();
      last = p;
    }
  }, { passive: true });
   
  zoom.addEventListener('touchend', (e) => {
    if (e.touches.length >= 1) {
      mode = e.touches.length === 1 ? 1 : 2;
      if (e.touches[0]) last = rel(e.touches[0].clientX, e.touches[0].clientY);
      return;
    }
    const z = { scale, base };
    if (z.scale > z.base * 1.05) {
      mode = 0;
      startDist = null;
      startScale = null;
      startX = null;
      last = null;
      return;
    }
    if (startX !== null && e.changedTouches.length > 0) {
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 55) step(o, dx < 0 ? 1 : -1);
    }
    mode = 0;
    startDist = null;
    startScale = null;
    startX = null;
    last = null;
  }, { passive: true });
}

function showPhoto(id) {
  if (!(MANIFEST.photos || []).some((p) => p.id === id)) return;
  const ids = orderedIds();
  const index = Math.max(0, ids.indexOf(id));
  const o = overlay();
  o._nav = { ids, index };
  o.hidden = false;
  document.body.style.overflow = 'hidden';
  renderAt(o);
}

function dismiss(o) {
  o.hidden = true;
  o._nav = null;
  o.querySelector('.tv-body').innerHTML = '';
  document.body.style.overflow = '';
}

async function downloadCurrent(o) {
  const nav = o && o._nav;
  if (!nav) return;
  const id = nav.ids[nav.index];
  const ph = (MANIFEST.photos || []).find((p) => p.id === id);
  const name = 'france-2026-' + String((ph && ph.date) || 'photo') + '-'
    + String(id).replace(/^photo-/, '').replace(/[^\w.-]+/g, '-') + '.jpg';
  try {
    const url = await photoUrl(id);
    if (navigator.share && navigator.canShare) {
      try {
        const blob = await (await fetch(url)).blob();
        const file = new File([blob], name, { type: 'image/jpeg' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: (ph && ph.caption) || 'Trip photo' });
          return;
        }
      } catch { /* fall through to <a download> */ }
    }
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  } catch { /* viewer already shows an error */ }
}

document.addEventListener('keydown', (e) => {
  const o = document.getElementById('photo-overlay');
  if (!o || o.hidden || !o._nav) return;
  if (e.key === 'Escape') { dismiss(o); }
  else if (e.key === 'ArrowLeft') { step(o, -1); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { step(o, 1); e.preventDefault(); }
});
