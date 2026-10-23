// A chave da conversa nunca sai do navegador. Ela é transformada (PBKDF2) em uma
// chave AES-256-GCM; o salt inclui os dois logins para que a mesma chave digitada
// em conversas diferentes gere chaves diferentes.
const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const cryptoAvailable = !!globalThis.crypto?.subtle;

async function deriveKey(secret, loginA, loginB) {
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
