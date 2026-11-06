import { api } from './api.js';

const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let pushActive = false; // com Web Push ativo, quem avisa é o service worker (vale também com o app fechado)

const toBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

// Pede a permissão de notificação se ainda não foi dada (a inscrição é feita por syncPush). Devolve a permissão.
export async function enablePush() {
  if (!('Notification' in window)) return 'denied';
  return Notification.permission === 'default' ? Notification.requestPermission() : Notification.permission;
}

// Garante que a inscrição do navegador existe e pertence ao usuário logado.
// Devolve '' se o push está ativo, ou o motivo de não estar (o aviso com o app fechado depende dele).
export async function syncPush() {
  pushActive = false;
  if (!('Notification' in window)) return 'Este navegador não suporta notificações.';
  if (!supported) {
    return /iPhone|iPad/.test(navigator.userAgent)
      ? 'No iPhone/iPad, instale o app na Tela de Início para receber avisos com ele fechado.'
      : 'Este navegador não suporta avisos com o app fechado.';
  }
  if (Notification.permission !== 'granted') return '';
  try {
    const key = toBytes((await api.pushKey()).key);
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // inscrição criada com outra chave VAPID (ex.: servidor recriado) não recebe nada: refaz
    const old = sub?.options?.applicationServerKey;
    if (sub && old && (old.byteLength !== key.length || new Uint8Array(old).some((v, i) => v !== key[i]))) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api.pushSubscribe(sub.toJSON());
    pushActive = true;
    return '';
  } catch (err) {
    return `Não foi possível ativar avisos com o app fechado (${err?.message || err?.name || 'erro'}).`;
  }
}

// Ao sair, o aparelho deixa de receber os avisos deste usuário.
export async function disablePush() {
  pushActive = false;
  if (!supported) return;
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) await api.pushUnsubscribe(sub.endpoint);
  } catch {}
}

// Aviso gerado pela própria página (sem push). `new Notification` não funciona no Android,
// então passa pelo service worker.
export async function notify(title, options) {
  if (pushActive || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { icon: 'icon-192.png', ...options });
  } catch {
    try { new Notification(title, options); } catch {}
  }
}
