// A chave da conversa nunca sai do navegador. Ela é transformada (PBKDF2) em uma
// chave AES-256-GCM; o salt inclui os dois logins para que a mesma chave digitada
// em conversas diferentes gere chaves diferentes.
const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map();

const toB64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Imagens colam como data URL (base64) dentro do texto criptografado.
const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
// Link direto (https) para um .gif ou .mp4; só é carregado ao exibir a mensagem.
const LINK_RE = /^https:\/\/[^\s"'<>]+\.(gif|mp4)(\?[^\s"'<>]*)?$/i;
// Mensagem de áudio: JSON {k:'audio', src: data URL, t: transcrição, d: duração em segundos}.
const AUDIO_RE = /^data:audio\/(webm|ogg|mp4|mpeg|wav|aac|x-m4a)(;codecs=[\w.,-]+)?;base64,[A-Za-z0-9+/]+=*$/;
const MAX_IMAGE_CHARS = 512 * 1024;
// Vídeo/GIF grandes não vão dentro da mensagem: ficam num arquivo cifrado no servidor e a mensagem leva
// só a referência {"k":"file","id":<uuid>,"m":<mime>,"n":<nome>,"s":<bytes do original>}.
const FILE_MIMES = new Set(['video/mp4', 'image/gif']);
const MIME_RE = /^[a-z0-9][\w.+-]{0,63}\/[a-z0-9][\w.+-]{0,63}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THUMB_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;
const MAX_THUMB_CHARS = 80_000;
export const MAX_FILE = 2 * 1024 * 1024 * 1024; // acima disto não envia
export const PLAY_LIMIT = 200 * 1024 * 1024; // até aqui o vídeo/GIF toca no app; acima vira arquivo para baixar

// Diz como renderizar o texto decifrado: { kind: 'image' | 'video', src } ou null.
export function mediaOf(text) {
  if (typeof text !== 'string') return null;
  if (text.startsWith('{"k":"audio"')) {
    try {
      const o = JSON.parse(text);
      if (o.k === 'audio' && typeof o.src === 'string' && AUDIO_RE.test(o.src)) {
        return { kind: 'audio', src: o.src, transcript: typeof o.t === 'string' ? o.t.slice(0, 5000) : '', duration: Number(o.d) || 0 };
      }
    } catch {}
    return null;
  }
  if (text.startsWith('{"k":"file"')) {
    try {
      const o = JSON.parse(text);
      if (o.k === 'file' && UUID_RE.test(o.id) && typeof o.m === 'string' && MIME_RE.test(o.m) && Number.isInteger(o.s) && o.s > 0 && o.s <= MAX_FILE) {
        const name = typeof o.n === 'string' ? o.n.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 200) : 'arquivo';
        const thumb = typeof o.t === 'string' && o.t.length <= MAX_THUMB_CHARS && THUMB_RE.test(o.t) ? o.t : null;
        const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 20000 ? v : 0);
        const duration = Number.isFinite(o.d) && o.d > 0 && o.d < 86400 ? Math.round(o.d) : 0;
        // só vídeo MP4 e GIF têm pré-visualização; qualquer outro tipo é um arquivo para baixar
        const inline = FILE_MIMES.has(o.m);
        return {
          kind: !inline ? 'file' : o.m === 'video/mp4' ? 'video' : 'image',
          file: {
            id: o.id, mime: o.m, name, size: o.s, generic: !inline, playable: inline && o.s <= PLAY_LIMIT,
            thumb: inline ? thumb : null, w: dim(o.w), h: dim(o.h), duration,
          },
        };
      }
    } catch {}
    return null;
  }
  if (IMAGE_RE.test(text)) return { kind: 'image', src: text };
  if (text.length <= 2048 && LINK_RE.test(text)) {
    return { kind: /\.mp4(\?|$)/i.test(text) ? 'video' : 'image', src: text, remote: true };
  }
  return null;
}
const MAX_SIDE = 1280;

// GIF pequeno não passa pelo canvas (perderia a animação): vai como veio, dentro da mensagem.
export async function gifToDataUrl(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'GIF8') throw new Error('GIF inválido');
  return `data:image/gif;base64,${toB64(bytes)}`;
}

// Gravação do microfone -> texto da mensagem (a ser cifrado). `transcript` pode ser vazio.
export async function audioMessage(blob, transcript, duration) {
  const src = `data:${blob.type.replace(/\s/g, '')};base64,${toB64(await blob.arrayBuffer())}`;
  if (!AUDIO_RE.test(src)) throw new Error('Formato de áudio não suportado');
  if (src.length > 9 * 1024 * 1024) throw new Error('Áudio grande demais');
  return JSON.stringify({ k: 'audio', src, t: transcript, d: Math.round(duration) });
}

// Reduz e recodifica (também remove metadados) até caber no limite.
export async function imageToDataUrl(file) {
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  for (let quality = 0.85; ; quality -= 0.15, scale *= 0.8) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', Math.max(quality, 0.4));
    if (url.length <= MAX_IMAGE_CHARS) return url;
    if (canvas.width < 64 && canvas.height < 64) throw new Error('Imagem grande demais');
  }
}

export const cryptoAvailable = !!globalThis.crypto?.subtle;

export async function deriveKey(secret, loginA, loginB) {
  const salt = `anon-messenger:${JSON.stringify([loginA, loginB].sort())}`;
  const id = `${salt}\u0000${secret}`;
  if (!keyCache.has(id)) {
    const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 200_000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    keyCache.set(id, key);
  }
  return keyCache.get(id);
}

export async function encryptText(text, secret, me, friend) {
  const key = await deriveKey(secret, me, friend);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), iv.length);
  return toB64(out);
}

// Retorna null se a chave estiver errada ou o dado for inválido.
export async function decryptText(data, secret, me, friend) {
  try {
    const key = await deriveKey(secret, me, friend);
    const raw = fromB64(data);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

// Resposta a uma mensagem: o texto cifrado passa a ser {k:'reply', r:{id, from, p}, b:<corpo>}, em que
// `p` é um trecho do original. Fica dentro da criptografia, então o servidor não vê quem responde a quê.
export function messageOf(text) {
  if (typeof text === 'string' && text.startsWith('{"k":"reply"')) {
    try {
      const o = JSON.parse(text);
      const r = o.r;
      if (o.k === 'reply' && typeof o.b === 'string' && r && typeof r.id === 'string' && typeof r.from === 'string' && typeof r.p === 'string') {
        return { reply: { id: r.id.slice(0, 64), from: r.from.slice(0, 100), p: r.p.slice(0, 120) }, body: o.b };
      }
    } catch {}
  }
  return { reply: null, body: text };
}

export const withReply = (body, reply) => (reply ? JSON.stringify({ k: 'reply', r: reply, b: body }) : body);

// Trecho curto do corpo, para mostrar na resposta.
export function previewOf(body) {
  const media = mediaOf(body);
  if (media) return media.kind === 'audio' ? 'Mensagem de áudio' : media.kind === 'video' ? 'Vídeo' : media.kind === 'file' ? `Arquivo: ${media.file.name}` : 'Imagem';
  return body.replace(/\s+/g, ' ').trim().slice(0, 100);
}

// ---------- arquivos (vídeo/GIF): bytes cifrados direto com AES-GCM, sem base64 ----------
// Formato em disco: blocos de 1 MiB do original; cada bloco guardado como iv(12) + cifra + tag(16).
// O AAD de cada bloco é "<id do arquivo>|<índice>|<é o último?>": reordenar, trocar de arquivo ou cortar o
// final faz a decifragem falhar. A chave é a mesma da conversa. Os blocos têm 1 MiB para que dê para
// decifrar em stream (o AES-GCM do navegador só decifra um bloco inteiro por vez).
export const FILE_CHUNK = 1024 * 1024;
const GCM_OVERHEAD = 28;
const PART_CHUNKS = 8; // blocos por requisição de upload
const fileAad = (fid, i, last) => enc.encode(`${fid}|${i}|${last ? 1 : 0}`);

// Tipo declarado na mensagem: vídeo MP4 e GIF mantêm o seu; o resto é tratado como arquivo genérico.
export const fileMime = (file) => (FILE_MIMES.has(file.type) ? file.type : MIME_RE.test(file.type) ? file.type : 'application/octet-stream');
export const hasPreview = (file) => FILE_MIMES.has(file.type);

export async function assertMediaFile(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const magic = String.fromCharCode(...head);
  if (file.size < 1) throw new Error('Arquivo vazio');
  if (file.size > MAX_FILE) throw new Error('Arquivo grande demais (máx. 2 GB)');
  if (!FILE_MIMES.has(file.type)) return; // arquivo comum: qualquer conteúdo
  if (file.type === 'video/mp4' ? magic.slice(4, 8) !== 'ftyp' : magic.slice(0, 4) !== 'GIF8') {
    throw new Error(file.type === 'video/mp4' ? 'MP4 inválido' : 'GIF inválido');
  }
}

// Miniatura (primeiro quadro, JPEG de até 320 px) que vai dentro da mensagem cifrada, para mostrar o vídeo/GIF
// antes de baixá-lo. Se o navegador não consegue decodificar o arquivo, devolve {} e a mensagem segue sem miniatura.
export async function makeThumb(file) {
  const MAXT = 320;
  let source;
  let w;
  let h;
  let d = 0;
  let cleanup = () => {};
  try {
    if (file.type === 'video/mp4') {
      const url = URL.createObjectURL(file);
      cleanup = () => URL.revokeObjectURL(url);
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = url;
      await new Promise((resolve, reject) => {
        v.onloadeddata = resolve;
        v.onerror = () => reject(new Error('vídeo ilegível'));
        setTimeout(() => reject(new Error('tempo esgotado')), 10_000);
      });
      d = v.duration;
      if (v.duration > 0.5) {
        v.currentTime = Math.min(1, v.duration / 10);
        await new Promise((resolve) => { v.onseeked = resolve; setTimeout(resolve, 3000); });
      }
      source = v;
      w = v.videoWidth;
      h = v.videoHeight;
    } else {
      source = await createImageBitmap(file);
      w = source.width;
      h = source.height;
    }
    if (!w || !h) return {};
    const scale = Math.min(1, MAXT / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    let t = canvas.toDataURL('image/jpeg', 0.7);
    if (t.length > MAX_THUMB_CHARS) t = canvas.toDataURL('image/jpeg', 0.45);
    return { ...(t.length <= MAX_THUMB_CHARS && { t }), w, h, ...(d > 0 && Number.isFinite(d) && { d: Math.round(d) }) };
  } catch {
    return {};
  } finally {
    cleanup();
  }
}

// Cifra o arquivo bloco a bloco e entrega partes de até 8 MiB a putPart(blob, offset, final), em ordem.
// onProgress({ phase: 'encrypt' | 'upload', enc, sent }): a etapa atual e as porcentagens já cifrada e já enviada.
export async function uploadFile(file, fid, key, putPart, onProgress) {
  const total = Math.ceil(file.size / FILE_CHUNK);
  let offset = 0;
  let sent = 0;
  const pct = (n) => Math.min(100, Math.floor((n / total) * 100));
  for (let first = 0; first < total; first += PART_CHUNKS) {
    const count = Math.min(PART_CHUNKS, total - first);
    const pieces = [];
    for (let j = 0; j < count; j++) {
      const i = first + j;
      const plain = await file.slice(i * FILE_CHUNK, (i + 1) * FILE_CHUNK).arrayBuffer();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: fileAad(fid, i, i === total - 1) }, key, plain);
      pieces.push(iv, new Uint8Array(ct));
      onProgress?.({ phase: 'encrypt', enc: pct(i + 1), sent: pct(sent) });
    }
    const part = new Blob(pieces);
    onProgress?.({ phase: 'upload', enc: pct(first + count), sent: pct(sent) });
    await putPart(part, offset, first + count === total);
    offset += part.size;
    sent = first + count;
    onProgress?.({ phase: 'upload', enc: pct(first + count), sent: pct(sent) });
  }
}

// Lê o corpo cifrado (stream de bytes), decifra bloco a bloco e entrega cada bloco em claro a onPlain.
export async function decryptStream(body, { fid, key, size, onPlain, onProgress }) {
  const n = Math.ceil(size / FILE_CHUNK);
  const want = (i) => (i < n - 1 ? FILE_CHUNK : size - (n - 1) * FILE_CHUNK) + GCM_OVERHEAD;
  const reader = body.getReader();
  let i = 0;
  let buf = new Uint8Array(want(0));
  let filled = 0;
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let off = 0;
    while (off < value.length) {
      if (i >= n) throw new Error('Arquivo maior que o esperado');
      const take = Math.min(value.length - off, buf.length - filled);
      buf.set(value.subarray(off, off + take), filled);
      filled += take;
      off += take;
      got += take;
      if (filled === buf.length) {
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: buf.subarray(0, 12), additionalData: fileAad(fid, i, i === n - 1) }, key, buf.subarray(12)
        );
        await onPlain(new Uint8Array(pt));
        i++;
        filled = 0;
        if (i < n) buf = new Uint8Array(want(i));
      }
    }
    onProgress?.(got);
  }
  if (i !== n) throw new Error('Arquivo incompleto');
}

// Baixa o arquivo cifrado inteiro, decifra e devolve um Blob para tocar no app (até PLAY_LIMIT).
export async function fetchDecryptedBlob({ url, fid, key, size, mime, onProgress }) {
  const res = await fetch(url);
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || 'Não foi possível baixar o arquivo');
  }
  const parts = [];
  try {
    await decryptStream(res.body, { fid, key, size, onPlain: (p) => { parts.push(p); }, onProgress });
  } catch (err) {
    throw err.name === 'OperationError' ? new Error('Não foi possível decifrar (chave incorreta?)') : err;
  }
  return new Blob(parts, { type: mime });
}

// Arquivos grandes: o service worker baixa, decifra em stream e entrega ao navegador como download,
// sem nunca juntar o arquivo na memória.
export async function saveFileStreaming({ url, fid, key, size, name }) {
  const reg = await navigator.serviceWorker?.ready;
  if (!reg?.active) throw new Error('Este navegador não suporta o download de arquivos grandes');
  const id = crypto.randomUUID();
  await new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('Serviço de download não respondeu')), 5000);
    ch.port1.onmessage = () => { clearTimeout(timer); resolve(); };
    reg.active.postMessage({ type: 'dl-start', id, url: new URL(url, location.href).href, fid, key, size, name }, [ch.port2]);
  });
  const a = document.createElement('a');
  a.href = `${import.meta.env.BASE_URL}_download/${id}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const decryptAny = decryptText;
