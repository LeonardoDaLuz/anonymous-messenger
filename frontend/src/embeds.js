// Reconhece links (http/https), vídeos do YouTube e posts do Twitter/X dentro de um texto.
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
const ID_RE = /^[\w-]{11}$/;

// "90", "1m30s", "1h2m3s" -> segundos (limitado a 12 h)
function seconds(v) {
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Math.min(Number(v), 43200);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(v);
  return m ? Math.min((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0), 43200) : 0;
}

export function youtubeOf(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  for (const raw of text.match(URL_RE) ?? []) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (!HOSTS.has(u.hostname.toLowerCase())) continue;
    const parts = u.pathname.split('/').filter(Boolean);
    const short = u.hostname.toLowerCase().endsWith('youtu.be');
    const id = short ? parts[0] : u.pathname === '/watch' ? u.searchParams.get('v') : ['shorts', 'embed', 'live', 'v'].includes(parts[0]) ? parts[1] : null;
    if (id && ID_RE.test(id)) return { id, start: seconds(u.searchParams.get('t') ?? u.searchParams.get('start')) };
  }
  return null;
}

const TWEET_HOSTS = new Set(['twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'x.com', 'www.x.com']);

// https://x.com/usuario/status/1234567890 (também /i/status/ID e /usuario/status/ID/photo/1)
export function tweetOf(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  for (const raw of text.match(URL_RE) ?? []) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (!TWEET_HOSTS.has(u.hostname.toLowerCase())) continue;
    const m = /^\/(?:[\w]{1,15}|i)\/status(?:es)?\/(\d{1,20})(?:\/|$)/.exec(u.pathname);
    if (m) return { id: m[1] };
  }
  return null;
}

// { kind, ...dados } para o primeiro tipo de link reconhecido, ou null.
export function embedOf(text) {
  const yt = youtubeOf(text);
  if (yt) return { kind: 'youtube', ...yt };
  const tw = tweetOf(text);
  return tw ? { kind: 'tweet', ...tw } : null;
}

// Quebra o texto em pedaços { link: false, text } e { link: true, text, href } para virar <a>.
// Só http/https viram link; pontuação no fim ("veja https://x.com/a.") fica fora do link.
export function splitLinks(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0].replace(/[.,;:!?'"]+$/, '');
    while (url.endsWith(')') && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) url = url.slice(0, -1);
    let href;
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') href = u.href;
    } catch {}
    if (!href) continue;
    if (m.index > last) parts.push({ link: false, text: text.slice(last, m.index) });
    parts.push({ link: true, text: url, href });
    last = m.index + url.length;
  }
  if (last < text.length) parts.push({ link: false, text: text.slice(last) });
  return parts;
}
