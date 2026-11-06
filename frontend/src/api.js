// A sessão vai em cookie HttpOnly: o JS da página nunca enxerga o token.
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

async function request(method, path, body) {
  const res = await fetch(`${basePath}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    const err = new Error(json.error || 'Erro na requisição');
    err.status = res.status;
    throw err;
  }
  return json;
}

const enc = encodeURIComponent;

// Uma parte do arquivo cifrado (corpo binário). Repete em falhas de rede/servidor: o servidor descarta o
// que sobrou de uma tentativa anterior (o offset é sempre explícito).
async function putPart(path, blob) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${basePath}/api${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
      if (res.ok) return;
      if (res.status === 401) onUnauthorized();
      const json = await res.json().catch(() => ({}));
      lastErr = new Error(json.error || 'Falha ao enviar o arquivo');
      if (![400, 500, 502, 503, 504].includes(res.status)) throw lastErr;
    } catch (err) {
      if (err === lastErr) throw err;
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr;
}

// O áudio vai cru (não JSON) para o backend repassar ao Whisper; ele não é guardado lá.
async function transcribe(blob) {
  const res = await fetch(`${basePath}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
    signal: AbortSignal.timeout(110_000),
  });
  if (res.status === 401) onUnauthorized();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Falha na transcrição');
  return json;
}

const gifMediaUrl = (u) => `${basePath}/api/gifs/media?u=${enc(u)}`;

export const api = {
  gifMediaUrl,
  gifs: (q, page) => request('GET', `/gifs?q=${enc(q)}&page=${page}`),
  gifBlob: async (u) => {
    const res = await fetch(gifMediaUrl(u));
    if (!res.ok) throw new Error('Não foi possível baixar o GIF');
    return res.blob();
  },
  transcribe,
  me: () => request('GET', '/me'),
  avatars: () => request('GET', '/avatars'),
  avatarUrl: (login, v) => `${basePath}/api/avatars/${enc(login)}?v=${v}`,
  removeAvatar: () => request('DELETE', '/avatar'),
  setAvatar: async (blob) => {
    const res = await fetch(`${basePath}/api/avatar`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    if (res.status === 401) onUnauthorized();
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Não foi possível enviar o avatar');
    return json;
  },
  register: (login, email, password) => request('POST', '/register', { login, email, password }),
  confirmEmail: (token) => request('POST', '/confirm-email', { token }),
  resendConfirmation: (email) => request('POST', '/resend-confirmation', { email }),
  forgotPassword: (email) => request('POST', '/forgot-password', { email }),
  resetPassword: (token, password) => request('POST', '/reset-password', { token, password }),
  login: (login, password) => request('POST', '/login', { login, password }),
  logout: () => request('POST', '/logout'),
  presence: () => request('GET', '/presence'),
  friends: () => request('GET', '/friends'),
  requests: () => request('GET', '/requests'),
  blocks: () => request('GET', '/blocks'),
  addFriend: (email) => request('POST', '/friends', { email }),
  acceptRequest: (login) => request('POST', `/requests/${enc(login)}/accept`),
  rejectRequest: (login) => request('DELETE', `/requests/${enc(login)}`),
  removeFriend: (login) => request('DELETE', `/friends/${enc(login)}`),
  block: (login) => request('POST', `/blocks/${enc(login)}`),
  unblock: (login) => request('DELETE', `/blocks/${enc(login)}`),
  servers: () => request('GET', '/servers'),
  server: (id) => request('GET', `/servers/${enc(id)}`),
  createServer: (name, icon, color) => request('POST', '/servers', { name, icon, color }),
  deleteServer: (id) => request('DELETE', `/servers/${enc(id)}`),
  addServerMember: (id, login) => request('POST', `/servers/${enc(id)}/members`, { login }),
  removeServerMember: (id, login) => request('DELETE', `/servers/${enc(id)}/members/${enc(login)}`),
  callSignal: (friend, type, data) => request('POST', `/call/${enc(friend)}`, { type, data }),
  pushKey: () => request('GET', '/push/key'),
  pushSubscribe: (sub) => request('POST', '/push/subscribe', sub),
  pushUnsubscribe: (endpoint) => request('POST', '/push/unsubscribe', { endpoint }),
};

// Canais e mensagens de uma conversa: de um amigo ({ friend }) ou de um servidor ({ server }).
export function convApi(target) {
  const msgs = target.server ? `/servers/${enc(target.server)}/messages` : `/messages/${enc(target.friend)}`;
  const chans = target.server ? `/servers/${enc(target.server)}/channels` : `/channels/${enc(target.friend)}`;
  const files = target.server ? `/servers/${enc(target.server)}/files` : `/files/${enc(target.friend)}`;
  return {
    fileUrl: (fid) => `${basePath}/api${files}/${enc(fid)}`,
    putFilePart: (fid, channel, offset, final, blob) =>
      putPart(`${files}/${enc(fid)}?channel=${enc(channel)}&offset=${offset}&final=${final ? 1 : 0}`, blob),
    channels: () => request('GET', chans),
    createChannel: (name) => request('POST', chans, { name }),
    deleteChannel: (id) => request('DELETE', `${chans}/${enc(id)}`),
    messages: (channel, before) => request('GET', `${msgs}?channel=${enc(channel)}${before ? `&before=${before}` : ''}`),
    markRead: (channel, seq) => request('POST', `${msgs}/read`, { channel, seq }),
    clearMessages: (channel) => request('DELETE', `${msgs}?channel=${enc(channel)}`),
    react: (id, emoji) => request('POST', `${msgs}/${enc(id)}/reactions`, { emoji }),
    editMessage: (id, data, edited) => request('PATCH', `${msgs}/${enc(id)}`, { data, edited }),
    deleteMessage: (id) => request('DELETE', `${msgs}/${enc(id)}`),
    send: (channel, data, file) => request('POST', msgs, { channel, data, ...(file && { file }) }),
  };
}
