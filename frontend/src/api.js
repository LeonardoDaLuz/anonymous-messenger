// A sessão vai em cookie HttpOnly: o JS da página nunca enxerga o token.
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
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

export const api = {
  me: () => request('GET', '/me'),
  register: (login, password) => request('POST', '/register', { login, password }),
  login: (login, password) => request('POST', '/login', { login, password }),
  logout: () => request('POST', '/logout'),
  friends: () => request('GET', '/friends'),
  requests: () => request('GET', '/requests'),
  blocks: () => request('GET', '/blocks'),
  addFriend: (login) => request('POST', '/friends', { login }),
  acceptRequest: (login) => request('POST', `/requests/${enc(login)}/accept`),
  rejectRequest: (login) => request('DELETE', `/requests/${enc(login)}`),
  removeFriend: (login) => request('DELETE', `/friends/${enc(login)}`),
  block: (login) => request('POST', `/blocks/${enc(login)}`),
  unblock: (login) => request('DELETE', `/blocks/${enc(login)}`),
  messages: (friend) => request('GET', `/messages/${enc(friend)}`),
  clearMessages: (friend) => request('DELETE', `/messages/${enc(friend)}`),
  send: (friend, data) => request('POST', `/messages/${enc(friend)}`, { data }),
};
