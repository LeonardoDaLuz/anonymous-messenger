import express from 'express';
import helmet from 'helmet';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import webpush from 'web-push';

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || './app.db';
const MAX_USERS = Number(process.env.MAX_USERS) || 10000;
const MIN_PASSWORD = 6; // só no cadastro; o login aceita contas antigas
const MAX_FRIENDS = 500;
const MAX_PENDING_REQUESTS = 100; // pedidos recebidos simultâneos por usuário
const MAX_SOCKETS_PER_USER = 10;
const MAX_CIPHERTEXT = 6 * 1024 * 1024; // cabe um MP4/GIF de ~3 MB (base64 + AES-GCM + base64)
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = 'sid';
const TRANSCRIBER_URL = process.env.TRANSCRIBER_URL || ''; // serviço Whisper interno; vazio = sem transcrição
const KLIPY_KEY = process.env.KLIPY_API_KEY || ''; // busca de GIFs; vazio = recurso desligado
const MAX_GIF_BYTES = 4 * 1024 * 1024;
const MAX_SEND_GIF_BYTES = 2.5 * 1024 * 1024; // cabe no limite de mídia da mensagem (~3 MB) com folga
const MAX_AUDIO_BYTES = 6 * 1024 * 1024;
const MAX_CONCURRENT_TRANSCRIPTIONS = 4; // o serviço processa uma por vez; o resto espera na fila

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
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conv TEXT NOT NULL,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    conv TEXT NOT NULL,
    name TEXT NOT NULL,
    created_by INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS channels_conv ON channels (conv);
  CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS reactions_message ON reactions (message_id);
  CREATE TABLE IF NOT EXISTS reads (
    conv TEXT NOT NULL,
    channel TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (conv, channel, user_id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (user_id);
`);

// Chaves VAPID do Web Push: geradas na primeira execução e guardadas no banco.
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
if (!getSetting.get('vapid_public')) {
  const keys = webpush.generateVAPIDKeys();
  putSetting.run('vapid_public', keys.publicKey);
  putSetting.run('vapid_private', keys.privateKey);
}
const VAPID_PUBLIC = getSetting.get('vapid_public').value;
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC, getSetting.get('vapid_private').value);
// Bancos antigos: as mensagens existentes caem no canal padrão.
if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'channel')) {
  db.exec(`ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'main'`);
}
db.exec('CREATE INDEX IF NOT EXISTS messages_conv_channel_ts ON messages (conv, channel, ts)');

const q = {
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  pushSubsOf: db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?'),
  countPushSubs: db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?'),
  upsertPushSub: db.prepare(
    `INSERT INTO push_subs (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
  ),
  dropOldestPushSub: db.prepare(
    'DELETE FROM push_subs WHERE rowid = (SELECT MIN(rowid) FROM push_subs WHERE user_id = ?)'
  ),
  deletePushSub: db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?'),
  deletePushSubAny: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
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

  messageOwner: db.prepare('SELECT channel, from_id, ts FROM messages WHERE id = ? AND conv = ?'),
  updateMessageData: db.prepare('UPDATE messages SET data = ? WHERE id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO messages (id, conv, channel, from_id, to_id, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  // `seq` (rowid) é a posição da mensagem na conversa: serve de cursor da paginação e de marca de leitura.
  messagesPage: db.prepare(
    `SELECT m.rowid AS seq, m.id, m.channel, a.login AS "from", b.login AS "to", m.data, m.ts
     FROM messages m JOIN users a ON a.id = m.from_id JOIN users b ON b.id = m.to_id
     WHERE m.conv = ? AND m.channel = ? AND m.rowid < ? ORDER BY m.rowid DESC LIMIT ?`
  ),
  maxSeq: db.prepare('SELECT MAX(rowid) AS n FROM messages WHERE conv = ? AND channel = ?'),
  readOf: db.prepare('SELECT seq FROM reads WHERE conv = ? AND channel = ? AND user_id = ?'),
  upsertRead: db.prepare(
    `INSERT INTO reads (conv, channel, user_id, seq) VALUES (?, ?, ?, ?)
     ON CONFLICT (conv, channel, user_id) DO UPDATE SET seq = MAX(seq, excluded.seq)`
  ),
  deleteReadsConv: db.prepare('DELETE FROM reads WHERE conv = ?'),
  deleteReadsChannel: db.prepare('DELETE FROM reads WHERE conv = ? AND channel = ?'),
  deleteMessages: db.prepare('DELETE FROM messages WHERE conv = ?'),
  deleteChannelMessages: db.prepare('DELETE FROM messages WHERE conv = ? AND channel = ?'),
  messageChannel: db.prepare('SELECT channel FROM messages WHERE id = ? AND conv = ?'),

  deleteReactionsConv: db.prepare(
    'DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE conv = ?)'
  ),
  deleteReactionsChannel: db.prepare(
    'DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE conv = ? AND channel = ?)'
  ),
  reactionsInRange: db.prepare(
    `SELECT r.message_id, r.emoji, u.login FROM reactions r
     JOIN messages m ON m.id = r.message_id JOIN users u ON u.id = r.user_id
     WHERE m.conv = ? AND m.channel = ? AND m.rowid BETWEEN ? AND ? ORDER BY r.rowid`
  ),
  reactionsOfMessage: db.prepare(
    `SELECT r.message_id, r.emoji, u.login FROM reactions r JOIN users u ON u.id = r.user_id
     WHERE r.message_id = ? ORDER BY r.rowid`
  ),
  hasReaction: db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
  insertReaction: db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'),
  deleteReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
  countEmojis: db.prepare('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?'),

  channelsOf: db.prepare('SELECT id, name FROM channels WHERE conv = ? ORDER BY rowid'),
  channelExists: db.prepare('SELECT 1 FROM channels WHERE id = ? AND conv = ?'),
  channelByName: db.prepare('SELECT 1 FROM channels WHERE conv = ? AND name = ? COLLATE NOCASE'),
  countChannels: db.prepare('SELECT COUNT(*) AS n FROM channels WHERE conv = ?'),
  insertChannel: db.prepare('INSERT INTO channels (id, conv, name, created_by) VALUES (?, ?, ?, ?)'),
  deleteChannel: db.prepare('DELETE FROM channels WHERE id = ? AND conv = ?'),
  deleteChannels: db.prepare('DELETE FROM channels WHERE conv = ?'),

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

// ---------- mensagens (SQLite; só texto cifrado) ----------
const convKey = (idA, idB) => (idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`);

// Cada conversa tem o canal padrão ("main", exibido como #geral) mais os criados pelos dois lados.
const MAIN_CHANNEL = { id: 'main', name: 'geral' };
const MAX_CHANNELS = 20;
const MAX_CHANNEL_NAME = 32;
const wipeConversation = (conv) => {
  tx(() => {
    q.deleteReactionsConv.run(conv);
    q.deleteMessages.run(conv);
    q.deleteChannels.run(conv);
    q.deleteReadsConv.run(conv);
  });
};
const wipeChannelMessages = (conv, channel) => {
  q.deleteReactionsChannel.run(conv, channel);
  q.deleteChannelMessages.run(conv, channel);
  q.deleteReadsChannel.run(conv, channel);
};

// [{message_id, emoji, login}] -> Map<message_id, [{emoji, users}]> (na ordem da primeira reação)
function groupReactions(rows) {
  const out = new Map();
  for (const { message_id, emoji, login } of rows) {
    if (!out.has(message_id)) out.set(message_id, []);
    const list = out.get(message_id);
    const entry = list.find((r) => r.emoji === emoji);
    if (entry) entry.users.push(login);
    else list.push({ emoji, users: [login] });
  }
  return out;
}

// Um único emoji (com variação/ZWJ); o servidor só guarda isso, nunca texto livre.
const EMOJI_RE = /^\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*$/u;
const MAX_EMOJIS_PER_MESSAGE = 20;

// ---------- tempo real ----------
const sockets = new Map(); // login -> Set<WebSocket>

function push(login, event) {
  for (const ws of sockets.get(login) ?? []) ws.send(JSON.stringify(event));
}

// Web Push: avisa os aparelhos do usuário mesmo com o app fechado. O servidor não lê as mensagens
// (são cifradas), então o aviso só diz quem escreveu; o service worker decide se mostra.
function pushNotify(userId, payload, { ttl = 86400, urgency = 'normal' } = {}) {
  const body = JSON.stringify(payload);
  for (const s of q.pushSubsOf.all(userId)) {
    webpush
      .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: ttl, urgency, timeout: 10_000 })
      .catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) q.deletePushSubAny.run(s.endpoint); // inscrição expirada
      });
  }
}

// Presença: os amigos veem quem está online. O "offline" espera alguns segundos para um refresh
// da página não piscar.
const offlineTimers = new Map();
function announcePresence(user, online) {
  for (const f of q.friendsOf.all(user.id)) push(f.login, { type: 'presence', login: user.login, online });
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
const limitChannels = rateLimit({ windowMs: 60 * MIN, max: 60, key: (req) => req.user.id });
const limitTranscribe = rateLimit({ windowMs: 10 * MIN, max: 30, key: (req) => req.user.id });
const limitRead = rateLimit({ windowMs: MIN, max: 300, key: (req) => req.user.id });
const limitSend = rateLimit({ windowMs: MIN, max: 120, key: (req) => req.user.id });
const limitCall = rateLimit({ windowMs: MIN, max: 600, key: (req) => req.user.id }); // inclui candidatos ICE

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
app.use(express.json({ limit: '6200kb' }));

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

app.get('/api/presence', auth, (req, res) => res.json(q.friendsOf.all(req.user.id).map((r) => r.login).filter((l) => sockets.has(l))));
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
  pushNotify(target.id, { type: 'request', from: req.user.login });
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
  wipeConversation(convKey(req.user.id, friend.id));
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
  wipeConversation(convKey(req.user.id, target.id));
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

// Canal pedido (?channel=...); sem o parâmetro vale o padrão. Responde 404 se não existir na conversa.
function channelOf(req, res, friend) {
  const id = req.query.channel ?? req.body?.channel ?? MAIN_CHANNEL.id;
  if (typeof id === 'string' && (id === MAIN_CHANNEL.id || q.channelExists.get(id, convKey(req.user.id, friend.id)))) {
    return id;
  }
  res.status(404).json({ error: 'Canal não encontrado' });
  return null;
}

app.get('/api/channels/:friend', auth, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  res.json([MAIN_CHANNEL, ...q.channelsOf.all(convKey(req.user.id, friend.id))]);
});

app.post('/api/channels/:friend', auth, limitChannels, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/^#+/, '').trim() : '';
  if (name === '' || name.length > MAX_CHANNEL_NAME || CONTROL_CHARS.test(name)) {
    return res.status(400).json({ error: `Nome de canal inválido (até ${MAX_CHANNEL_NAME} caracteres)` });
  }
  const conv = convKey(req.user.id, friend.id);
  if (name.toLowerCase() === MAIN_CHANNEL.name || q.channelByName.get(conv, name)) {
    return res.status(409).json({ error: 'Já existe um canal com esse nome' });
  }
  if (q.countChannels.get(conv).n >= MAX_CHANNELS) {
    return res.status(400).json({ error: `Limite de ${MAX_CHANNELS} canais por conversa` });
  }
  const channel = { id: crypto.randomUUID(), name };
  q.insertChannel.run(channel.id, conv, name, req.user.id);
  push(req.user.login, { type: 'channels', with: friend.login });
  push(friend.login, { type: 'channels', with: req.user.login });
  res.json(channel);
});

// Apaga o canal e as mensagens dele, para os dois lados. O canal padrão não pode ser apagado.
app.delete('/api/channels/:friend/:id', auth, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  const conv = convKey(req.user.id, friend.id);
  if (req.params.id === MAIN_CHANNEL.id) return res.status(400).json({ error: 'O canal #geral não pode ser apagado' });
  if (!q.channelExists.get(req.params.id, conv)) return res.status(404).json({ error: 'Canal não encontrado' });
  tx(() => {
    wipeChannelMessages(conv, req.params.id);
    q.deleteChannel.run(req.params.id, conv);
  });
  push(req.user.login, { type: 'channels', with: friend.login });
  push(friend.login, { type: 'channels', with: req.user.login });
  res.json({});
});

const PAGE_SIZE = 50;

// Últimas mensagens do canal; com ?before=<seq> devolve a página anterior (rolagem para cima).
// `read` = até que seq a outra pessoa já leu (para os "visto").
app.get('/api/messages/:friend', auth, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  const channel = channelOf(req, res, friend);
  if (!channel) return;
  const conv = convKey(req.user.id, friend.id);
  const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
  if (!Number.isInteger(before) || before < 0) return res.status(400).json({ error: 'Cursor inválido' });
  const rows = q.messagesPage.all(conv, channel, before, PAGE_SIZE + 1);
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE).reverse();
  const reactions = page.length
    ? groupReactions(q.reactionsInRange.all(conv, channel, page[0].seq, page[page.length - 1].seq))
    : new Map();
  res.json({
    messages: page.map((m) => ({ ...m, reactions: reactions.get(m.id) ?? [] })),
    hasMore,
    read: q.readOf.get(conv, channel, friend.id)?.seq ?? 0,
  });
});

// Marca como lido (até o seq informado) o que a outra pessoa enviou; avisa quem enviou.
app.post('/api/messages/:friend/read', auth, limitRead, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  const channel = channelOf(req, res, friend);
  if (!channel) return;
  const conv = convKey(req.user.id, friend.id);
  const asked = Number(req.body?.seq);
  if (!Number.isInteger(asked) || asked < 0) return res.status(400).json({ error: 'Marca inválida' });
  const seq = Math.min(asked, q.maxSeq.get(conv, channel).n ?? 0);
  if (seq > (q.readOf.get(conv, channel, req.user.id)?.seq ?? 0)) {
    q.upsertRead.run(conv, channel, req.user.id, seq);
    push(friend.login, { type: 'read', with: req.user.login, channel, seq });
  }
  res.json({});
});

// `data` já chega criptografado (AES-GCM) pelo navegador; o servidor nunca vê o texto.
app.post('/api/messages/:friend', auth, limitSend, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  const channel = channelOf(req, res, friend);
  if (!channel) return;
  const { data } = req.body ?? {};
  if (typeof data !== 'string' || data === '' || data.length > MAX_CIPHERTEXT) {
    return res.status(400).json({ error: 'Mensagem inválida' });
  }
  const msg = { id: crypto.randomUUID(), channel, from: req.user.login, to: friend.login, data, ts: Date.now(), reactions: [] };
  msg.seq = Number(q.insertMessage.run(msg.id, convKey(req.user.id, friend.id), channel, req.user.id, friend.id, data, msg.ts).lastInsertRowid);
  push(msg.from, { type: 'message', message: msg });
  push(msg.to, { type: 'message', message: msg });
  pushNotify(friend.id, { type: 'message', from: msg.from, channel });
  res.json(msg);
});

// Apaga todas as mensagens do canal para os dois lados, de forma permanente.
app.delete('/api/messages/:friend', auth, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  const channel = channelOf(req, res, friend);
  if (!channel) return;
  tx(() => wipeChannelMessages(convKey(req.user.id, friend.id), channel));
  push(req.user.login, { type: 'cleared', with: friend.login, channel });
  push(friend.login, { type: 'cleared', with: req.user.login, channel });
  res.json({});
});

// Transcrição de áudio (Whisper, CPU). O áudio chega em claro (o navegador o decifra/grava localmente),
// é repassado ao serviço interno só na memória e descartado: nada é salvo nem registrado aqui.
// Quem envia a mensagem recebe o texto e o embute na mensagem já cifrada.
let transcribing = 0;
app.post('/api/transcribe', auth, limitTranscribe, express.raw({ type: () => true, limit: MAX_AUDIO_BYTES }), ah(async (req, res) => {
  if (!TRANSCRIBER_URL) return res.status(503).json({ error: 'Transcrição indisponível' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Áudio inválido' });
  if (transcribing >= MAX_CONCURRENT_TRANSCRIPTIONS) {
    return res.status(503).json({ error: 'Transcrição ocupada. Tente novamente em instantes.' });
  }
  transcribing++;
  try {
    const r = await fetch(`${TRANSCRIBER_URL}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: req.body,
      signal: AbortSignal.timeout(130_000),
    });
    if (r.status === 400) return res.status(400).json({ error: 'Áudio inválido' });
    if (!r.ok) throw new Error(`transcriber ${r.status}`);
    const { text, language } = await r.json();
    res.json({ text: typeof text === 'string' ? text.slice(0, 5000) : '', language });
  } catch (err) {
    console.error('transcrição falhou:', err.message);
    res.status(502).json({ error: 'Falha na transcrição' });
  } finally {
    transcribing--;
  }
}));

// O autor troca o conteúdo cifrado da própria mensagem por pouco tempo: é como o áudio recebe a
// transcrição depois de já ter sido enviado.
const MAX_EDIT_AGE_MS = 10 * 60 * 1000;
app.patch('/api/messages/:friend/:id', auth, limitSend, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  const row = q.messageOwner.get(req.params.id, convKey(req.user.id, friend.id));
  if (!row || row.from_id !== req.user.id) return res.status(404).json({ error: 'Mensagem não encontrada' });
  if (Date.now() - row.ts > MAX_EDIT_AGE_MS) return res.status(400).json({ error: 'Tempo para editar esgotado' });
  const { data } = req.body ?? {};
  if (typeof data !== 'string' || data === '' || data.length > MAX_CIPHERTEXT) {
    return res.status(400).json({ error: 'Mensagem inválida' });
  }
  q.updateMessageData.run(data, req.params.id);
  const event = { type: 'edited', id: req.params.id, channel: row.channel, data };
  push(req.user.login, { ...event, with: friend.login });
  push(friend.login, { ...event, with: req.user.login });
  res.json({});
});

// Alterna a reação do usuário (adiciona se não tinha, remove se já tinha), como no Discord.
app.post('/api/messages/:friend/:id/reactions', auth, limitSend, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  const row = q.messageChannel.get(req.params.id, convKey(req.user.id, friend.id));
  if (!row) return res.status(404).json({ error: 'Mensagem não encontrada' });
  const { emoji } = req.body ?? {};
  if (typeof emoji !== 'string' || emoji.length > 16 || !EMOJI_RE.test(emoji)) {
    return res.status(400).json({ error: 'Emoji inválido' });
  }
  if (q.hasReaction.get(req.params.id, req.user.id, emoji)) {
    q.deleteReaction.run(req.params.id, req.user.id, emoji);
  } else {
    const distinct = q.reactionsOfMessage.all(req.params.id).some((r) => r.emoji === emoji);
    if (!distinct && q.countEmojis.get(req.params.id).n >= MAX_EMOJIS_PER_MESSAGE) {
      return res.status(400).json({ error: 'Limite de reações diferentes nesta mensagem' });
    }
    q.insertReaction.run(req.params.id, req.user.id, emoji);
  }
  const reactions = groupReactions(q.reactionsOfMessage.all(req.params.id)).get(req.params.id) ?? [];
  const event = { type: 'reactions', id: req.params.id, channel: row.channel, reactions };
  push(req.user.login, { ...event, with: friend.login });
  push(friend.login, { ...event, with: req.user.login });
  res.json({ reactions });
});

// ---------- GIFs (Klipy) ----------
// Busca e imagens passam pelo servidor: a chave não vai ao navegador e o Klipy nunca vê o IP nem
// o que cada pessoa pesquisa. O GIF escolhido volta ao navegador, que o cifra como qualquer mídia.
const limitGifs = rateLimit({ windowMs: MIN, max: 600, key: (req) => req.user.id });
const gifUser = (id) => crypto.createHash('sha256').update(`${id}:${VAPID_PUBLIC}`).digest('hex').slice(0, 16);

app.get('/api/gifs', auth, limitGifs, ah(async (req, res) => {
  if (!KLIPY_KEY) return res.status(503).json({ error: 'GIFs indisponíveis' });
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 50);
  const url = new URL(`https://api.klipy.com/api/v1/${KLIPY_KEY}/gifs/${query ? 'search' : 'trending'}`);
  if (query) url.searchParams.set('q', query);
  url.searchParams.set('page', page);
  url.searchParams.set('per_page', 24);
  url.searchParams.set('customer_id', gifUser(req.user.id));
  let json;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`klipy ${r.status}`);
    json = await r.json();
  } catch (err) {
    console.error(err.message);
    return res.status(502).json({ error: 'Não foi possível buscar GIFs' });
  }
  // Os GIFs podem ter dezenas de MB; manda o maior tamanho que cabe no limite de uma mensagem.
  const items = (json.data?.data ?? []).flatMap((i) => {
    const file = i.file ?? {};
    const pick = ['md', 'sm', 'xs'].map((s) => file[s]?.gif).find((g) => g?.url && g.size <= MAX_SEND_GIF_BYTES);
    const sm = file.sm?.webp ?? file.sm?.gif ?? file.xs?.gif;
    if (i.type !== 'gif' || !pick || !sm?.url) return [];
    return [{ id: String(i.id), title: String(i.title ?? ''), w: sm.width, h: sm.height, preview: sm.url, src: pick.url }];
  });
  res.json({ items, hasNext: !!json.data?.has_next });
}));

app.get('/api/gifs/media', auth, limitGifs, ah(async (req, res) => {
  let u;
  try { u = new URL(req.query.u); } catch { return res.status(400).json({ error: 'URL inválida' }); }
  if (u.protocol !== 'https:' || u.hostname !== 'static.klipy.com') return res.status(400).json({ error: 'URL inválida' });
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    const type = r.headers.get('content-type')?.split(';')[0];
    if (!r.ok || !['image/gif', 'image/webp'].includes(type)) throw new Error('mídia inválida');
    if (Number(r.headers.get('content-length')) > MAX_GIF_BYTES) return res.status(413).json({ error: 'GIF grande demais' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_GIF_BYTES) return res.status(413).json({ error: 'GIF grande demais' });
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
    res.send(buf);
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Não foi possível baixar o GIF' });
  }
}));

// Sinalização de chamadas de áudio (WebRTC). O áudio vai direto entre os navegadores; aqui só
// repassamos convite/oferta/resposta/ICE entre amigos, sem guardar nada.
const CALL_SIGNALS = new Set(['invite', 'accept', 'reject', 'busy', 'end', 'offer', 'answer', 'ice']);
const MAX_SIGNAL = 64 * 1024; // SDP com vídeo pode passar de 10 KB

app.post('/api/call/:friend', auth, limitCall, (req, res) => {
  const friend = friendOf(req, res);
  if (!friend) return;
  const { type, data } = req.body ?? {};
  if (!CALL_SIGNALS.has(type) || (data !== undefined && JSON.stringify(data).length > MAX_SIGNAL)) {
    return res.status(400).json({ error: 'Sinal inválido' });
  }
  push(friend.login, { type: 'call', from: req.user.login, signal: { type, data } });
  if (type === 'invite') pushNotify(friend.id, { type: 'call', from: req.user.login }, { ttl: 30, urgency: 'high' });
  res.json({});
});

// Só serviços de push conhecidos: o servidor faz requisições ao endpoint informado.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[\w.-]+\.push\.apple\.com|[\w.-]+\.notify\.windows\.com)$/;
const MAX_PUSH_SUBS = 10;

app.get('/api/push/key', auth, (req, res) => res.json({ key: VAPID_PUBLIC }));

app.post('/api/push/subscribe', auth, limitRead, (req, res) => {
  const { endpoint, keys } = req.body ?? {};
  let host = '';
  try {
    const u = new URL(endpoint);
    if (u.protocol === 'https:') host = u.hostname;
  } catch {}
  if (
    typeof endpoint !== 'string' || endpoint.length > 1024 || !PUSH_HOSTS.test(host) ||
    typeof keys?.p256dh !== 'string' || keys.p256dh.length > 200 ||
    typeof keys?.auth !== 'string' || keys.auth.length > 100
  ) {
    return res.status(400).json({ error: 'Inscrição inválida' });
  }
  if (q.countPushSubs.get(req.user.id).n >= MAX_PUSH_SUBS) q.dropOldestPushSub.run(req.user.id);
  q.upsertPushSub.run(endpoint, req.user.id, keys.p256dh, keys.auth);
  res.json({});
});

app.post('/api/push/unsubscribe', auth, limitRead, (req, res) => {
  if (typeof req.body?.endpoint === 'string') q.deletePushSub.run(req.body.endpoint, req.user.id);
  res.json({});
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
    const wasOnline = sockets.get(login).size > 0;
    sockets.get(login).add(ws);
    if (offlineTimers.has(login)) { clearTimeout(offlineTimers.get(login)); offlineTimers.delete(login); }
    else if (!wasOnline) announcePresence(session.user, true);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', () => {}); // o cliente não envia nada
    ws.on('close', () => {
      const set = sockets.get(login);
      set.delete(ws);
      if (set.size > 0) return;
      sockets.delete(login);
      offlineTimers.set(login, setTimeout(() => {
        offlineTimers.delete(login);
        if (!sockets.has(login)) announcePresence(session.user, false);
      }, 5000));
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
