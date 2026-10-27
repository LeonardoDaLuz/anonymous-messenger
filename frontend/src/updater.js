// Detecta um deploy novo (version.json mudou) e recarrega a página sozinho.
const CHECK_MS = 60_000;
const blockers = new Set(); // motivos para adiar o reload (chamada, gravação)

export const blockUpdate = (key, on) => (on ? blockers.add(key) : blockers.delete(key));

async function check() {
  if (blockers.size) return;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store' });
    const { id } = await res.json();
    if (id && id !== __BUILD_ID__) {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update().catch(() => {});
      location.reload();
    }
  } catch {
    // offline ou sem version.json (dev): tenta de novo depois
  }
}

export function watchForUpdates() {
  if (import.meta.env.DEV) return;
  setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
  window.addEventListener('online', check);
}
