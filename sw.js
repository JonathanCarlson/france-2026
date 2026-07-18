// Service worker — offline support for the trip PWA.
// Bump CACHE when you change the app shell so clients pick up new code.
const CACHE = 'france2026-v20';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Network-first with a timeout: return the freshest copy when online (and cache
// it), but fall back to cache fast if the network is slow or offline. This is
// why an online reload always shows the latest app + data.
function networkFirst(req, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const serveCache = () => { if (!done) { done = true; caches.match(req).then((c) => resolve(c || fetch(req))); } };
    const timer = setTimeout(serveCache, timeoutMs);
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)); // always refresh cache
      if (done) return;
      done = true; clearTimeout(timer);
      resolve(res);
    }).catch(() => { clearTimeout(timer); if (!done) { done = true; caches.match(req).then((c) => resolve(c || Response.error())); } });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Icons never change → cache-first (instant).
  if (url.pathname.includes('/icons/')) {
    e.respondWith(caches.match(req).then((c) => c || fetch(req)));
    return;
  }
  // App shell (HTML/JS/CSS/manifest) + encrypted data → network-first, so a
  // reload while online always shows the latest; cache keeps it working offline.
  e.respondWith(networkFirst(req, 3000));
});
