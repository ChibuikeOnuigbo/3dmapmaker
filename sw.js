/**
 * Panorama Maps — sw.js
 * Offline app-shell service worker (system prompt §46, §94–§96).
 *
 * Caches ONLY the application shell (HTML/CSS/JS/static icons). User project
 * data lives in IndexedDB and is NEVER touched by this worker — and an app
 * update never deletes user projects.
 */
const APP_CACHE = 'panorama-maps-shell-v5';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/core/events.js',
  './js/core/scale.js',
  './js/core/world-graph.js',
  './js/core/movement.js',
  './js/viewer/pano-renderer.js',
  './js/viewer/viewer.js',
  './js/viewer/completion.js',
  './js/viewer/sharpen.js',
  './js/viewer/smooth.js',
  './js/gen/provider.js',
  './js/gen/context.js',
  './js/gen/cache.js',
  './js/gen/util.js',
  './js/map/map-renderer.js',
  './js/editors/simple-editor.js',
  './js/editors/advanced-editor.js',
  './js/io/storage.js',
  './js/io/zipex.js',
  './js/worlds/demo-worlds.js',
  './js/worlds/willow-parish.js',
  './js/ui/landing.js',
  './assets/landing-bg.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('panorama-maps-shell-') && k !== APP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    const isShell = SHELL.some((p) => url.pathname.endsWith(p.replace('./', '/')) || (p === './' && (url.pathname === '/' || url.pathname.endsWith('/index.html'))));
    if (isShell) {
      // NETWORK-FIRST with cache fill: fresh code always wins; the cache is the
      // offline fallback. A cache-first strategy made bug fixes invisible to
      // returning users (they kept running week-old JS) — the cost is one
      // conditional request per shell file on load.
      e.respondWith(
        fetch(e.request)
          .then((fresh) => {
            if (fresh && fresh.ok) {
              const copy = fresh.clone();
              caches.open(APP_CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
            }
            return fresh;
          })
          .catch(() => caches.match(e.request))
      );
      return;
    }
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  }
});
