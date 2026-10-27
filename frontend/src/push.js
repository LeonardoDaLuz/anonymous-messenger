import { api } from './api.js';

const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let pushActive = false; // com Web Push ativo, quem avisa é o service worker (vale também com o app fechado)

const toBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

// Inscreve este aparelho no push (pede a permissão se ainda não foi dada). Devolve a permissão.
export async function enablePush() {
  if (!('Notification' in window)) return 'denied';
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (perm === 'granted') await syncPush();
  return perm;
}

// Garante que a inscrição do navegador existe e pertence ao usuário logado.
export async function syncPush() {
  if (!supported || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes((await api.pushKey()).key) }));
    await api.pushSubscribe(sub.toJSON());
    pushActive = true;
  } catch {
    pushActive = false;
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
