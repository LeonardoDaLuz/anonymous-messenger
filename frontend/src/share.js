// Lê o que o service worker guardou quando o usuário compartilhou algo para este app (Android).
const SHARE_CACHE = 'share-inbox';
const MAX_AGE_MS = 10 * 60 * 1000;
const base = import.meta.env.BASE_URL;

export async function takeShare() {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const metaRes = await cache.match(`${base}share-data/meta`);
    if (!metaRes) return null;
    const meta = await metaRes.json();
    const files = [];
    for (let i = 0; i < meta.files; i++) {
      const res = await cache.match(`${base}share-data/${i}`);
      if (!res) continue;
      const blob = await res.blob();
      files.push(new File([blob], decodeURIComponent(res.headers.get('X-Name') || 'compartilhado'), { type: blob.type }));
    }
    for (const k of await cache.keys()) await cache.delete(k);
    if (Date.now() - meta.ts > MAX_AGE_MS || (!meta.text && !files.length)) return null;
    return { text: meta.text, files };
  } catch {
    return null;
  }
}
