import express from 'express';
import helmet from 'helmet';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || './app.db';
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES) || 100; // por conversa
const MAX_MEMORY_BYTES = Number(process.env.MAX_MEMORY_BYTES) || 64 * 1024 * 1024; // total de mensagens
const MAX_USERS = Number(process.env.MAX_USERS) || 10000;
const MIN_PASSWORD = 6; // só no cadastro; o login aceita contas antigas
const MAX_FRIENDS = 500;
const MAX_PENDING_REQUESTS = 100; // pedidos recebidos simultâneos por usuário
const MAX_SOCKETS_PER_USER = 10;
const MAX_CIPHERTEXT = 1024 * 1024; // cabe uma imagem colada (base64 + AES-GCM)
const MAX_CONVERSATION_BYTES = 16 * 1024 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = 'sid';

// ---------- usuários, amizades, bloqueios e sessões (SQLite) ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS friendships (
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
  );
  CREATE TABLE IF NOT EXISTS friend_requests (
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id)
  );
  CREATE TABLE IF NOT EXISTS blocks (
    user_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const q = {
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertUser: db.prepare('INSERT INTO users (login, password_hash) VALUES (?, ?)'),
  userByLogin: db.prepare('SELECT * FROM users WHERE login = ?'),

  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  sessionUser: db.prepare(
    `SELECT u.id, u.login FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ),

  addFriend: db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)'),
  removeFriend: db.prepare(
    'DELETE FROM friendships WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)'
  ),
  friendsOf: db.prepare(
    `SELECT u.login FROM friendships f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = ? ORDER BY u.login`
  ),
  areFriends: db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?'),
  countFriends: db.prepare('SELECT COUNT(*) AS n FROM friendships WHERE user_id = ?'),

  insertRequest: db.prepare('INSERT OR IGNORE INTO friend_requests (from_id, to_id) VALUES (?, ?)'),
  deleteRequest: db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?'),
  deleteRequestsBetween: db.prepare(
    'DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)'
  ),
  requestExists: db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?'),
  incomingRequests: db.prepare(
    `SELECT u.login FROM friend_requests r JOIN users u ON u.id = r.from_id
     WHERE r.to_id = ? ORDER BY u.login`
  ),
  countIncoming: db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE to_id = ?'),

  insertBlock: db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)'),
  deleteBlock: db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?'),
  isBlocked: db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?'),
  blocksOf: db.prepare(
    `SELECT u.login FROM blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.user_id = ? ORDER BY u.login`
  ),
};

function tx(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Verificado quando o login não existe, para que o tempo de resposta não revele quais logins existem.
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

// ---------- sessões (token opaco em cookie HttpOnly; só o hash fica no banco) ----------
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionFrom(cookieHeader) {
  const token = parseCookies(cookieHeader)[COOKIE];
  if (!token) return null;
  const sid = hashToken(token);
  const user = q.sessionUser.get(sid, Date.now());
  return user ? { user, sid } : null;
}

function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(hashToken(token), user.id, Date.now() + SESSION_TTL_MS);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

setInterval(() => q.purgeSessions.run(Date.now()), 60 * 60 * 1000).unref();

// ---------- mensagens (apenas em memória) ----------
// conversa -> { messages: [{ id, from, to, data, ts }], bytes }. A ordem do Map é a de uso recente.
const conversations = new Map();
let totalBytes = 0;
const convKey = (a, b) => JSON.stringify([a, b].sort());

function dropConversation(key) {
  const conv = conversations.get(key);
  if (!conv) return;
  totalBytes -= conv.bytes;
  conversations.delete(key);
}

function storeMessage(msg) {
  const key = convKey(msg.from, msg.to);
  const conv = conversations.get(key) ?? { messages: [], bytes: 0 };
  conversations.delete(key);
  conv.messages.push(msg);
  conv.bytes += msg.data.length;
  totalBytes += msg.data.length;
  while (conv.messages.length > MAX_MESSAGES || (conv.bytes > MAX_CONVERSATION_BYTES && conv.messages.length > 1)) {
    const old = conv.messages.shift();
    conv.bytes -= old.data.length;
    totalBytes -= old.data.length;
  }
  conversations.set(key, conv);
  // Acima do teto global de memória, descarta as conversas usadas há mais tempo.
  for (const k of conversations.keys()) {
    if (totalBytes <= MAX_MEMORY_BYTES || k === key) break;
    dropConversation(k);
  }
}

// ---------- tempo real ----------
const sockets = new Map(); // login -> Set<WebSocket>

function push(login, event) {
  for (const ws of sockets.get(login) ?? []) ws.send(JSON.stringify(event));
}

function closeSockets(login, sid) {
  for (const ws of sockets.get(login) ?? []) if (ws.sid === sid) ws.close(4401, 'logout');
}

// ---------- limites de requisições ----------
function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of hits) if (e.reset <= now) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset <= now) {
      if (hits.size >= 100_000) return res.status(429).json({ error: 'Servidor ocupado. Tente mais tarde.' });
      e = { count: 0, reset: now + windowMs };
      hits.set(k, e);
    }
    if (++e.count > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: 'Muitas tentativas. Tente mais tarde.' });
    }
    next();
  };
}

const MIN = 60_000;
const limitGlobal = rateLimit({ windowMs: MIN, max: 600, key: (req) => req.ip });
const limitRegister = rateLimit({ windowMs: 60 * MIN, max: 5, key: (req) => req.ip });
const limitLoginIp = rateLimit({ windowMs: 10 * MIN, max: 30, key: (req) => req.ip });
const limitLoginUser = rateLimit({
  windowMs: 10 * MIN,
  max: 8,
  key: (req) => `${req.ip}\u0000${String(req.body?.login).slice(0, 100)}`,
});
const limitFriendRequests = rateLimit({ windowMs: 60 * MIN, max: 30, key: (req) => req.user.id });
const limitSend = rateLimit({ windowMs: MIN, max: 120, key: (req) => req.user.id });

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 1); // atrás do nginx
app.use(helmet());
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(limitGlobal);

const sameOrigin = (req) => {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
};
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || sameOrigin(req)) return next();
  res.status(403).json({ error: 'Origem inválida' });
});
app.use(express.json({ limit: '1100kb' }));

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Sem caracteres de controle no login (evita logins invisíveis ou ambíguos).
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function credentials(body) {
  const { login, password } = body ?? {};
  if (typeof login !== 'string' || typeof password !== 'string') return null;
  if (login.trim() === '' || login.length > 100 || CONTROL_CHARS.test(login)) return null;
  return { login, password };
}

app.post('/api/register', limitRegister, ah(async (req, res) => {
  const c = credentials(req.body);
  if (!c) return res.status(400).json({ error: 'Login inválido' });
  if (c.password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `A senha deve ter no mínimo ${MIN_PASSWORD} caracteres` });
  }
  if (q.countUsers.get().n >= MAX_USERS) return res.status(503).json({ error: 'Cadastros fechados no momento' });
  if (q.userByLogin.get(c.login)) return res.status(409).json({ error: 'Login já existe' });
  const passwordHash = await hashPassword(c.password);
  let id;
  try {
    id = Number(q.insertUser.run(c.login, passwordHash).lastInsertRowid);
  } catch {
    return res.status(409).json({ error: 'Login já existe' }); // corrida entre dois cadastros
  }
  startSession(req, res, { id });
  res.json({ login: c.login });
}));

app.post('/api/login', limitLoginIp, limitLoginUser, ah(async (req, res) => {
  const c = credentials(req.body);
  const user = c && q.userByLogin.get(c.login);
  const ok = await verifyPassword(c?.password ?? '', user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Login ou senha incorretos' });
  startSession(req, res, user);
  res.json({ login: user.login });
}));

function auth(req, res, next) {
  const session = sessionFrom(req.headers.cookie);
  if (!session) return res.status(401).json({ error: 'Não autenticado' });
  req.user = session.user;
  req.sid = session.sid;
  next();
}

app.post('/api/logout', (req, res) => {
  const session = sessionFrom(req.headers.cookie);
  if (session) {
    q.deleteSession.run(session.sid);
    closeSockets(session.user.login, session.sid);
  }
  res.clearCookie(COOKIE, { path: '/' });
  res.json({});
});

app.get('/api/me', auth, (req, res) => res.json({ login: req.user.login }));

app.get('/api/friends', auth, (req, res) => res.json(q.friendsOf.all(req.user.id).map((r) => r.login)));
app.get('/api/requests', auth, (req, res) => res.json(q.incomingRequests.all(req.user.id).map((r) => r.login)));
app.get('/api/blocks', auth, (req, res) => res.json(q.blocksOf.all(req.user.id).map((r) => r.login)));

function otherUser(req, res) {
  const other = q.userByLogin.get(req.params.login);
  if (!other) res.status(404).json({ error: 'Usuário não encontrado' });
  else if (other.id === req.user.id) {
    res.status(400).json({ error: 'Operação inválida com você mesmo' });
    return null;
  }
  return other ?? null;
}

function makeFriends(a, b) {
  tx(() => {
    q.addFriend.run(a.id, b.id);
    q.addFriend.run(b.id, a.id);
    q.deleteRequestsBetween.run(a.id, b.id);
  });
  push(a.login, { type: 'friend' });
  push(b.login, { type: 'friend' });
}

// Envia um pedido de amizade; se a outra pessoa já tinha pedido, vira amizade.
app.post('/api/friends', auth, limitFriendRequests, (req, res) => {
  const target = typeof req.body?.login === 'string' && q.userByLogin.get(req.body.login);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Você não pode adicionar a si mesmo' });
  if (q.areFriends.get(req.user.id, target.id)) return res.json({ status: 'friends' });
  if (q.isBlocked.get(req.user.id, target.id)) {
    return res.status(400).json({ error: 'Você bloqueou este usuário. Desbloqueie para adicioná-lo.' });
  }
  // Quem foi bloqueado não descobre isso: o pedido parece enviado, mas é descartado.
  if (q.isBlocked.get(target.id, req.user.id)) return res.json({ status: 'pending' });

  if (q.requestExists.get(target.id, req.user.id)) {
    if (q.countFriends.get(req.user.id).n >= MAX_FRIENDS || q.countFriends.get(target.id).n >= MAX_FRIENDS) {
      return res.status(400).json({ error: 'Limite de amigos atingido' });
    }
    makeFriends(req.user, target);
    return res.json({ status: 'friends' });
  }
  if (q.countFriends.get(req.user.id).n >= MAX_FRIENDS) return res.status(400).json({ error: 'Limite de amigos atingido' });
  if (q.countIncoming.get(target.id).n >= MAX_PENDING_REQUESTS) {
    return res.status(400).json({ error: 'Este usuário não pode receber mais pedidos agora' });
  }
  q.insertRequest.run(req.user.id, target.id);
  push(target.login, { type: 'request', login: req.user.login });
  res.json({ status: 'pending' });
});

app.post('/api/requests/:login/accept', auth, (req, res) => {
  const from = otherUser(req, res);
  if (!from) return;
  if (!q.requestExists.get(from.id, req.user.id)) return res.status(404).json({ error: 'Pedido não encontrado' });
  if (q.countFriends.get(req.user.id).n >= MAX_FRIENDS || q.countFriends.get(from.id).n >= MAX_FRIENDS) {
    return res.status(400).json({ error: 'Limite de amigos atingido' });
  }
  makeFriends(req.user, from);
  res.json({});
});

app.delete('/api/requests/:login', auth, (req, res) => {
  const from = otherUser(req, res);
  if (!from) return;
  q.deleteRequest.run(from.id, req.user.id);
  res.json({});
});

app.delete('/api/friends/:login', auth, (req, res) => {
  const friend = otherUser(req, res);
  if (!friend) return;
  q.removeFriend.run(req.user.id, friend.id);
  dropConversation(convKey(req.user.login, friend.login));
  push(friend.login, { type: 'friend' });
  res.json({});
});

app.post('/api/blocks/:login', auth, (req, res) => {
  const target = otherUser(req, res);
  if (!target) return;
  tx(() => {
    q.removeFriend.run(req.user.id, target.id);
    q.deleteRequestsBetween.run(req.user.id, target.id);
    q.insertBlock.run(req.user.id, target.id);
  });
  dropConversation(convKey(req.user.login, target.login));
  push(target.login, { type: 'friend' });
  res.json({});
});

app.delete('/api/blocks/:login', auth, (req, res) => {
  const target = otherUser(req, res);
  if (!target) return;
  q.deleteBlock.run(req.user.id, target.id);
  res.json({});
});

function friendOf(req, res) {
  const friend = q.userByLogin.get(req.params.friend);
  if (!friend || !q.areFriends.get(req.user.id, friend.id)) {
    res.status(404).json({ error: 'Amigo não encontrado' });
    return null;
  }
  return friend;
}

app.get('/api/messages/:friend', auth, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  res.json(conversations.get(convKey(req.user.login, friend.login))?.messages ?? []);
});

// `data` já chega criptografado (AES-GCM) pelo navegador; o servidor nunca vê o texto.
app.post('/api/messages/:friend', auth, limitSend, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  const { data } = req.body ?? {};
  if (typeof data !== 'string' || data === '' || data.length > MAX_CIPHERTEXT) {
    return res.status(400).json({ error: 'Mensagem inválida' });
  }
  const msg = { id: crypto.randomUUID(), from: req.user.login, to: friend.login, data, ts: Date.now() };
  storeMessage(msg);
  push(msg.from, { type: 'message', message: msg });
  push(msg.to, { type: 'message', message: msg });
  res.json(msg);
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requisição grande demais' });
  console.error(err);
  res.status(500).json({ error: 'Erro interno' });
});

// ---------- WebSocket (autenticado pelo cookie da sessão, sem token na URL) ----------
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

server.on('upgrade', (req, socket, head) => {
  const reject = (status) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (new URL(req.url, 'http://x').pathname !== '/ws') return reject('404 Not Found');
  if (!sameOrigin(req)) return reject('403 Forbidden');
  const session = sessionFrom(req.headers.cookie);
  if (!session) return reject('401 Unauthorized');
  if ((sockets.get(session.user.login)?.size ?? 0) >= MAX_SOCKETS_PER_USER) return reject('429 Too Many Requests');
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.sid = session.sid;
    ws.alive = true;
    const { login } = session.user;
    if (!sockets.has(login)) sockets.set(login, new Set());
    sockets.get(login).add(ws);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', () => {}); // o cliente não envia nada
    ws.on('close', () => {
      const set = sockets.get(login);
      set.delete(ws);
      if (set.size === 0) sockets.delete(login);
    });
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30_000).unref();

server.listen(PORT, () => console.log(`backend on :${PORT}`));
