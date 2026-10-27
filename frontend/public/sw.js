// Cache só do "casco" do app, para ele abrir como app instalado.
// Nada de /api nem /ws passa por aqui: mensagens e chaves nunca são cacheadas.
const CACHE = 'shell-v4';
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

// ---------- Web Push ----------
// O servidor não lê as mensagens (são cifradas): o aviso só diz quem escreveu.
self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data.json(); } catch {}
  e.waitUntil((async () => {
    // com o app aberto e em foco o próprio app já mostra a mensagem
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.focused)) return;
    const from = p.from || 'Alguém';
    const text = {
      message: ['Nova mensagem 🔒', `msg:${from}:${p.channel || 'main'}`],
      call: ['está ligando 📞', `call:${from}`],
      request: ['quer ser seu amigo', `req:${from}`],
    }[p.type] || ['Nova atividade', 'misc'];
    await self.registration.showNotification(from, {
      body: text[0],
      tag: text[1],
      renotify: true,
      icon: `${APP_BASE}icon-192.png`,
      badge: `${APP_BASE}icon-192.png`,
      requireInteraction: p.type === 'call',
      data: { from: p.from, channel: p.channel },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { from, channel } = e.notification.data || {};
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins[0];
    if (win) {
      await win.focus();
      if (from) win.postMessage({ type: 'open-chat', from, channel: channel || 'main' });
    } else {
      const q = from ? `?open=${encodeURIComponent(from)}&ch=${encodeURIComponent(channel || 'main')}` : '';
      await self.clients.openWindow(APP_BASE + q);
    }
  })());
});

// o navegador trocou/expirou a inscrição: renova sozinho (o cookie da sessão vai junto)
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const { key } = await (await fetch(`${APP_BASE}api/push/key`)).json();
    const pad = '='.repeat((4 - (key.length % 4)) % 4);
    const applicationServerKey = Uint8Array.from(atob((key + pad).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    await fetch(`${APP_BASE}api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
  })());
});
