const CACHE = 'tracar-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './icon.svg',
  './icon-maskable.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first para o app shell; a rede é só fallback (o app não busca mais nada).
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true })
      .then((hit) => hit || fetch(e.request))
  );
});
