// Cache só do "casco" do app, para ele abrir como app instalado.
// Nada de /api nem /ws passa por aqui: mensagens e chaves nunca são cacheadas.
const CACHE = 'shell-v7';
const SHARE_CACHE = 'share-inbox'; // o que chegou pelo menu Compartilhar, até a página buscar
const APP_BASE = new URL('./', self.location.href).pathname;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(APP_BASE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Menu Compartilhar do Android (Web Share Target): o navegador faz um POST em /share com o texto,
// o link e os arquivos. Guardamos tudo no cache e abrimos o app, que pergunta para quem enviar.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    for (const k of await cache.keys()) await cache.delete(k);
    const text = [...new Set(['title', 'text', 'url'].map((k) => String(form.get(k) ?? '').trim()).filter(Boolean))].join('\n');
    const files = form.getAll('media').filter((f) => typeof f !== 'string' && f.size);
    await Promise.all(files.map((f, i) => cache.put(`${APP_BASE}share-data/${i}`, new Response(f, {
      headers: { 'Content-Type': f.type, 'X-Name': encodeURIComponent(f.name) },
    }))));
    await cache.put(`${APP_BASE}share-data/meta`, new Response(JSON.stringify({ text, files: files.length, ts: Date.now() })));
  } catch {
    // compartilhamento ilegível: abre o app mesmo assim
  }
  return Response.redirect(APP_BASE, 303);
}

// ---------- download de arquivos grandes, decifrados em stream ----------
// A página manda a chave e o endereço do arquivo cifrado ('dl-start') e navega para <base>_download/<id>;
// aqui o arquivo é baixado, decifrado bloco a bloco (mesmo formato de src/crypto.js) e entregue como download,
// sem juntar tudo na memória.
const FILE_CHUNK = 1024 * 1024;
const GCM_OVERHEAD = 28;
const downloads = new Map();

self.addEventListener('message', (e) => {
  const d = e.data;
  if (d?.type !== 'dl-start' || typeof d.id !== 'string') return;
  downloads.set(d.id, d);
  setTimeout(() => downloads.delete(d.id), 60_000);
  e.ports[0]?.postMessage('ok');
});

function decryptingStream(res, d) {
  const aad = new TextEncoder();
  const n = Math.ceil(d.size / FILE_CHUNK);
  const want = (i) => (i < n - 1 ? FILE_CHUNK : d.size - (n - 1) * FILE_CHUNK) + GCM_OVERHEAD;
  const reader = res.body.getReader();
  let i = 0;
  let buf = new Uint8Array(want(0));
  let filled = 0;
  let carry = null;
  let off = 0;
  return new ReadableStream({
    async pull(ctrl) {
      try {
        if (i >= n) { ctrl.close(); return; }
        while (filled < buf.length) {
          if (!carry || off >= carry.length) {
            const { done, value } = await reader.read();
            if (done) throw new Error('arquivo incompleto');
            carry = value;
            off = 0;
          }
          const take = Math.min(carry.length - off, buf.length - filled);
          buf.set(carry.subarray(off, off + take), filled);
          filled += take;
          off += take;
        }
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: buf.subarray(0, 12), additionalData: aad.encode(`${d.fid}|${i}|${i === n - 1 ? 1 : 0}`) },
          d.key, buf.subarray(12)
        );
        i++;
        filled = 0;
        if (i < n) buf = new Uint8Array(want(i));
        ctrl.enqueue(new Uint8Array(pt));
      } catch (err) {
        reader.cancel().catch(() => {});
        ctrl.error(err);
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
}

async function serveDownload(id) {
  const d = downloads.get(id);
  downloads.delete(id);
  if (!d) return new Response('Download expirado', { status: 404 });
  const res = await fetch(d.url, { credentials: 'same-origin' });
  if (!res.ok || !res.body) return new Response('Arquivo indisponível', { status: res.status || 502 });
  const name = String(d.name || 'arquivo').replace(/[\u0000-\u001f\u007f/\\"]/g, '_');
  return new Response(decryptingStream(res, d), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(d.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method === 'GET' && url.origin === location.origin && url.pathname.startsWith(`${APP_BASE}_download/`)) {
    e.respondWith(serveDownload(url.pathname.slice(`${APP_BASE}_download/`.length)));
    return;
  }
  if (request.method === 'POST' && url.origin === location.origin && url.pathname === `${APP_BASE}share`) {
    e.respondWith(receiveShare(request));
    return;
  }
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
      message: ['Nova mensagem 🔒', p.server ? `msg:\u0001${p.server}:${p.channel || 'main'}` : `msg:${from}:${p.channel || 'main'}`],
      call: ['está ligando 📞', `call:${from}`],
      request: ['quer ser seu amigo', `req:${from}`],
    }[p.type] || ['Nova atividade', 'misc'];
    await self.registration.showNotification(p.server ? `${p.serverName || 'Servidor'} · ${from}` : from, {
      body: text[0],
      tag: text[1],
      renotify: true,
      icon: `${APP_BASE}icon-192.png`,
      badge: `${APP_BASE}badge-96.png`,
      requireInteraction: p.type === 'call',
      data: { from: p.from, channel: p.channel, server: p.server },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { from, channel, server } = e.notification.data || {};
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins[0];
    if (win) {
      await win.focus();
      if (from) win.postMessage({ type: 'open-chat', from, channel: channel || 'main', server });
    } else {
      const q = server ? `?server=${encodeURIComponent(server)}&ch=${encodeURIComponent(channel || 'main')}`
        : from ? `?open=${encodeURIComponent(from)}&ch=${encodeURIComponent(channel || 'main')}` : '';
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
