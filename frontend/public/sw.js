// Cache só do "casco" do app, para ele abrir como app instalado.
// Nada de /api nem /ws passa por aqui: mensagens e chaves nunca são cacheadas.
const CACHE = 'shell-v2';
const APP_BASE = new URL('./', self.location.href).pathname;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(APP_BASE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith(`${APP_BASE}api/`) || url.pathname === `${APP_BASE}ws`) return;

  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match(APP_BASE)));
    return;
  }
  if (url.pathname.startsWith(`${APP_BASE}assets/`)) {
    e.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
        return res;
      }))
    );
  }
});
