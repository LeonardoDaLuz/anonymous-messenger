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
  register: (login, password) => request('POST', '/register', { login, password }),
  login: (login, password) => request('POST', '/login', { login, password }),
  logout: () => request('POST', '/logout'),
  presence: () => request('GET', '/presence'),
  friends: () => request('GET', '/friends'),
  requests: () => request('GET', '/requests'),
  blocks: () => request('GET', '/blocks'),
  addFriend: (login) => request('POST', '/friends', { login }),
  acceptRequest: (login) => request('POST', `/requests/${enc(login)}/accept`),
  rejectRequest: (login) => request('DELETE', `/requests/${enc(login)}`),
  removeFriend: (login) => request('DELETE', `/friends/${enc(login)}`),
  block: (login) => request('POST', `/blocks/${enc(login)}`),
  unblock: (login) => request('DELETE', `/blocks/${enc(login)}`),
  channels: (friend) => request('GET', `/channels/${enc(friend)}`),
  createChannel: (friend, name) => request('POST', `/channels/${enc(friend)}`, { name }),
  deleteChannel: (friend, id) => request('DELETE', `/channels/${enc(friend)}/${enc(id)}`),
  messages: (friend, channel, before) =>
    request('GET', `/messages/${enc(friend)}?channel=${enc(channel)}${before ? `&before=${before}` : ''}`),
  markRead: (friend, channel, seq) => request('POST', `/messages/${enc(friend)}/read`, { channel, seq }),
  clearMessages: (friend, channel) => request('DELETE', `/messages/${enc(friend)}?channel=${enc(channel)}`),
  callSignal: (friend, type, data) => request('POST', `/call/${enc(friend)}`, { type, data }),
  react: (friend, id, emoji) => request('POST', `/messages/${enc(friend)}/${enc(id)}/reactions`, { emoji }),
  pushKey: () => request('GET', '/push/key'),
  pushSubscribe: (sub) => request('POST', '/push/subscribe', sub),
  pushUnsubscribe: (endpoint) => request('POST', '/push/unsubscribe', { endpoint }),
  editMessage: (friend, id, data) => request('PATCH', `/messages/${enc(friend)}/${enc(id)}`, { data }),
  send: (friend, channel, data) => request('POST', `/messages/${enc(friend)}`, { channel, data }),
};
