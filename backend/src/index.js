import express from 'express';
import helmet from 'helmet';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import webpush from 'web-push';
import { sendMail } from './mail.js';

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || './app.db';
const MAX_USERS = Number(process.env.MAX_USERS) || 10000;
const MIN_PASSWORD = 6;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, ''); // base dos links enviados por e-mail
const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const MAX_FRIENDS = 500;
const MAX_PENDING_REQUESTS = 100; // pedidos recebidos simultâneos por usuário
const MAX_SOCKETS_PER_USER = 10;
const MAX_CIPHERTEXT = 16 * 1024 * 1024; // texto, imagem pequena ou áudio (base64 + AES-GCM + base64); vídeos/GIFs grandes vão como arquivo
// Arquivos (vídeo/GIF): cifrados no navegador em blocos de 1 MiB (iv 12 B + tag 16 B por bloco) e guardados em disco.
const FILES_DIR = process.env.FILES_DIR || path.join(path.dirname(DB_PATH), 'files');
const FILE_CHUNK = 1024 * 1024;
const GCM_OVERHEAD = 28;
const MAX_FILE_PLAIN = 2 * 1024 * 1024 * 1024;
const MAX_FILE_STORED = MAX_FILE_PLAIN + Math.ceil(MAX_FILE_PLAIN / FILE_CHUNK) * GCM_OVERHEAD;
const MAX_PART_BYTES = 16 * 1024 * 1024; // cada requisição de upload leva uma parte
const MAX_USER_FILE_BYTES = (Number(process.env.FILES_MAX_PER_USER_GB) || 10) * 1024 ** 3;
const MAX_PENDING_FILES = 5; // enviados e ainda não anexados a uma mensagem
const PENDING_FILE_TTL_MS = 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
fs.mkdirSync(FILES_DIR, { recursive: true });
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
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    color TEXT NOT NULL,
    owner_id INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS server_members_user ON server_members (user_id);
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
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'avatar')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar BLOB');
  db.exec('ALTER TABLE users ADD COLUMN avatar_v INTEGER'); // versão (data do envio) para o navegador renovar o cache
}
if (!db.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'edited_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER'); // quando o autor editou o texto (null = nunca)
}
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'email')) {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER'); // null = ainda não confirmou
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email)');
db.exec(`CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  conv TEXT NOT NULL,
  channel TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  updated_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS files_conv ON files (conv, channel)');
db.exec('CREATE INDEX IF NOT EXISTS files_message ON files (message_id)');
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
  insertUser: db.prepare('INSERT INTO users (login, email, password_hash) VALUES (?, ?, ?)'),
  userByLogin: db.prepare('SELECT * FROM users WHERE login = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertEmailToken: db.prepare('INSERT INTO email_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  emailToken: db.prepare('SELECT user_id FROM email_tokens WHERE token_hash = ? AND expires_at > ?'),
  deleteEmailTokensOf: db.prepare('DELETE FROM email_tokens WHERE user_id = ?'),
  verifyEmail: db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?'),
  insertResetToken: db.prepare('INSERT INTO reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  resetToken: db.prepare('SELECT user_id FROM reset_tokens WHERE token_hash = ? AND expires_at > ?'),
  deleteResetTokensOf: db.prepare('DELETE FROM reset_tokens WHERE user_id = ?'),
  purgeResetTokens: db.prepare('DELETE FROM reset_tokens WHERE expires_at <= ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?'),
  deleteSessionsOfUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  purgeEmailTokens: db.prepare('DELETE FROM email_tokens WHERE expires_at <= ?'),
  // cadastros que nunca confirmaram o e-mail liberam o login/e-mail
  purgeUnverified: db.prepare('DELETE FROM users WHERE email_verified_at IS NULL AND email IS NOT NULL AND created_at < ?'),

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
  updateMessageEdited: db.prepare('UPDATE messages SET data = ?, edited_at = ? WHERE id = ?'),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  deleteReactionsOfMessage: db.prepare('DELETE FROM reactions WHERE message_id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO messages (id, conv, channel, from_id, to_id, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  // `seq` (rowid) é a posição da mensagem na conversa: serve de cursor da paginação e de marca de leitura.
  messagesPage: db.prepare(
    `SELECT m.rowid AS seq, m.id, m.channel, a.login AS "from", b.login AS "to", m.data, m.ts, m.edited_at AS edited
     FROM messages m JOIN users a ON a.id = m.from_id LEFT JOIN users b ON b.id = m.to_id
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
  deleteReadsOfUser: db.prepare('DELETE FROM reads WHERE conv = ? AND user_id = ?'),
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

  fileById: db.prepare('SELECT * FROM files WHERE id = ?'),
  insertFile: db.prepare('INSERT INTO files (id, conv, channel, user_id, updated_at) VALUES (?, ?, ?, ?, ?)'),
  setFileProgress: db.prepare('UPDATE files SET size = ?, complete = ?, updated_at = ? WHERE id = ?'),
  deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
  linkFile: db.prepare('UPDATE files SET message_id = ? WHERE id = ?'),
  pendingFilesOf: db.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND message_id IS NULL'),
  fileBytesOf: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE user_id = ?'),
  staleFiles: db.prepare('SELECT id FROM files WHERE message_id IS NULL AND updated_at < ?'),
  fileIdsOfMessage: db.prepare('SELECT id FROM files WHERE message_id = ?'),
  deleteFilesOfMessage: db.prepare('DELETE FROM files WHERE message_id = ?'),
  fileIdsOfConv: db.prepare('SELECT id FROM files WHERE conv = ?'),
  deleteFilesOfConv: db.prepare('DELETE FROM files WHERE conv = ?'),
  fileIdsOfChannel: db.prepare('SELECT id FROM files WHERE conv = ? AND channel = ?'),
  deleteFilesOfChannel: db.prepare('DELETE FROM files WHERE conv = ? AND channel = ?'),
  userById: db.prepare('SELECT id, login FROM users WHERE id = ?'),
  setAvatar: db.prepare('UPDATE users SET avatar = ?, avatar_v = ? WHERE id = ?'),
  avatarOf: db.prepare('SELECT avatar, avatar_v FROM users WHERE login = ? AND avatar IS NOT NULL'),
  // login -> versão do avatar de quem o usuário enxerga: ele mesmo, os amigos e quem divide um servidor
  avatarVersions: db.prepare(
    `SELECT login, avatar_v AS v FROM users WHERE avatar IS NOT NULL AND (
       id = ?1
       OR id IN (SELECT friend_id FROM friendships WHERE user_id = ?1)
       OR id IN (SELECT b.user_id FROM server_members a JOIN server_members b ON b.server_id = a.server_id WHERE a.user_id = ?1)
     )`
  ),
  insertServer: db.prepare('INSERT INTO servers (id, name, icon, color, owner_id) VALUES (?, ?, ?, ?, ?)'),
  serverById: db.prepare('SELECT * FROM servers WHERE id = ?'),
  deleteServer: db.prepare('DELETE FROM servers WHERE id = ?'),
  deleteServerMembers: db.prepare('DELETE FROM server_members WHERE server_id = ?'),
  serversOf: db.prepare(
    `SELECT s.id, s.name, s.icon, s.color, o.login AS owner
     FROM server_members m JOIN servers s ON s.id = m.server_id JOIN users o ON o.id = s.owner_id
     WHERE m.user_id = ? ORDER BY m.rowid`
  ),
  countServersOf: db.prepare('SELECT COUNT(*) AS n FROM server_members WHERE user_id = ?'),
  countOwnedServers: db.prepare('SELECT COUNT(*) AS n FROM servers WHERE owner_id = ?'),
  isMember: db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?'),
  addMember: db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)'),
  removeMember: db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?'),
  countMembers: db.prepare('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?'),
  membersOf: db.prepare(
    `SELECT u.id, u.login FROM server_members m JOIN users u ON u.id = m.user_id
     WHERE m.server_id = ? ORDER BY u.login`
  ),
  // quem divide algum servidor com o usuário (para a presença online)
  coMembersOf: db.prepare(
    `SELECT DISTINCT u.login FROM server_members a
     JOIN server_members b ON b.server_id = a.server_id AND b.user_id != a.user_id
     JOIN users u ON u.id = b.user_id WHERE a.user_id = ?`
  ),

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

setInterval(() => {
  q.purgeSessions.run(Date.now());
  q.purgeEmailTokens.run(Date.now());
  q.purgeResetTokens.run(Date.now());
  q.purgeUnverified.run(new Date(Date.now() - CONFIRM_TTL_MS).toISOString().slice(0, 19).replace('T', ' '));
}, 60 * 60 * 1000).unref();

// ---------- mensagens (SQLite; só texto cifrado) ----------
const convKey = (idA, idB) => (idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`);
const serverConv = (serverId) => `s:${serverId}`;

// Cada conversa tem o canal padrão ("main", exibido como #geral) mais os criados pelos dois lados.
const MAIN_CHANNEL = { id: 'main', name: 'geral' };
const MAX_CHANNELS = 20;
const MAX_CHANNEL_NAME = 32;
// Apaga do disco os arquivos cujas linhas acabaram de sair do banco. Roda depois do COMMIT
// (as transações são síncronas); o varredor abaixo recolhe qualquer sobra.
function dropFiles(selectIds, deleteRows, ...args) {
  const ids = selectIds.all(...args).map((r) => r.id);
  deleteRows.run(...args);
  setImmediate(() => { for (const id of ids) fs.unlink(path.join(FILES_DIR, id), () => {}); });
}

function sweepFiles() {
  const stale = q.staleFiles.all(Date.now() - PENDING_FILE_TTL_MS).map((r) => r.id);
  for (const id of stale) {
    q.deleteFile.run(id);
    fs.unlink(path.join(FILES_DIR, id), () => {});
  }
  fs.readdir(FILES_DIR, (err, names) => {
    if (err) return;
    for (const name of names) if (!q.fileById.get(name)) fs.unlink(path.join(FILES_DIR, name), () => {});
  });
}
sweepFiles();
setInterval(sweepFiles, 60 * 60 * 1000).unref();

const wipeConversation = (conv) => {
  tx(() => {
    dropFiles(q.fileIdsOfConv, q.deleteFilesOfConv, conv);
    q.deleteReactionsConv.run(conv);
    q.deleteMessages.run(conv);
    q.deleteChannels.run(conv);
    q.deleteReadsConv.run(conv);
  });
};
const wipeChannelMessages = (conv, channel) => {
  dropFiles(q.fileIdsOfChannel, q.deleteFilesOfChannel, conv, channel);
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
// Quem vê a presença de alguém: os amigos e os membros dos servidores em comum.
const watchersOf = (userId) => new Set([...q.friendsOf.all(userId), ...q.coMembersOf.all(userId)].map((r) => r.login));
function announcePresence(user, online) {
  for (const login of watchersOf(user.id)) push(login, { type: 'presence', login: user.login, online });
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
const limitServers = rateLimit({ windowMs: 60 * MIN, max: 20, key: (req) => req.user.id });
const limitMembers = rateLimit({ windowMs: 60 * MIN, max: 60, key: (req) => req.user.id });
const limitTranscribe =rateLimit({ windowMs: 10 * MIN, max: 30, key: (req) => req.user.id });
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
app.use(express.json({ limit: '24mb' }));

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Sem caracteres de controle no login (evita logins invisíveis ou ambíguos).
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const EMAIL_RE = /^[^\s@<>"',;:()\[\]\\]{1,64}@[^\s@<>"',;:()\[\]\\]{1,253}\.[a-z]{2,}$/i;
const normEmail = (e) => (typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e.trim()) ? e.trim().toLowerCase() : null);

async function sendConfirmation(user) {
  q.deleteEmailTokensOf.run(user.id);
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertEmailToken.run(hashToken(token), user.id, Date.now() + CONFIRM_TTL_MS);
  const link = `${PUBLIC_URL}/confirmar-email?token=${token}`;
  const name = user.login.replace(/[<>&"]/g, '');
  // Em segundo plano; falhas só vão para o log.
  sendMail({
    to: user.email,
    subject: 'Confirme seu e-mail - Anonymous Messenger',
    text: `Olá, ${user.login}!\n\nConfirme seu e-mail para ativar a conta:\n${link}\n\nO link vale por 24 horas. Se não foi você, ignore esta mensagem.`,
    html: `<p>Olá, <b>${name}</b>!</p><p><a href="${link}">Confirmar meu e-mail</a></p><p>Ou abra: ${link}</p><p>O link vale por 24 horas. Se não foi você, ignore esta mensagem.</p>`,
  }).then(
    (info) => console.log(`[mail] confirmação enviada para ${user.email}: ${info.response}`),
    (err) => console.error(`[mail] falha ao enviar para ${user.email}: ${err.message}`)
  );
}

app.post('/api/register', limitRegister, ah(async (req, res) => {
  const { login, email: rawEmail, password } = req.body ?? {};
  if (typeof login !== 'string' || login.trim() === '' || login.length > 100 || CONTROL_CHARS.test(login) || login.includes('@')) {
    return res.status(400).json({ error: 'Nome de usuário inválido (não pode conter @)' });
  }
  const email = normEmail(rawEmail);
  if (!email) return res.status(400).json({ error: 'E-mail inválido' });
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `A senha deve ter no mínimo ${MIN_PASSWORD} caracteres` });
  }
  if (q.countUsers.get().n >= MAX_USERS) return res.status(503).json({ error: 'Cadastros fechados no momento' });
  if (q.userByLogin.get(login)) return res.status(409).json({ error: 'Nome de usuário já existe' });
  if (q.userByEmail.get(email)) return res.status(409).json({ error: 'E-mail já cadastrado' });
  const passwordHash = await hashPassword(password);
  let id;
  try {
    id = Number(q.insertUser.run(login, email, passwordHash).lastInsertRowid);
  } catch {
    return res.status(409).json({ error: 'Nome de usuário ou e-mail já existe' }); // corrida entre dois cadastros
  }
  sendConfirmation({ id, login, email });
  res.json({ pending: true });
}));

// Reenvio do link: resposta sempre igual, para não revelar quais e-mails existem.
const limitResend = rateLimit({ windowMs: 60 * MIN, max: 5, key: (req) => `${req.ip}\u0000${String(req.body?.email).slice(0, 254)}` });
app.post('/api/resend-confirmation', limitResend, (req, res) => {
  const email = normEmail(req.body?.email);
  const user = email && q.userByEmail.get(email);
  if (user && !user.email_verified_at) sendConfirmation(user);
  res.json({});
});

// O link do e-mail leva ao frontend, que chama esta rota (POST, para que leitores de link
// do provedor de e-mail não gastem o token). Confirmar já inicia a sessão.
const limitConfirm = rateLimit({ windowMs: 10 * MIN, max: 30, key: (req) => req.ip });
app.post('/api/confirm-email', limitConfirm, (req, res) => {
  const token = req.body?.token;
  const row = typeof token === 'string' && token.length <= 100 && q.emailToken.get(hashToken(token), Date.now());
  const user = row && q.userById.get(row.user_id);
  if (!user) return res.status(400).json({ error: 'Link inválido ou expirado' });
  q.verifyEmail.run(Date.now(), user.id);
  q.deleteEmailTokensOf.run(user.id);
  startSession(req, res, user);
  res.json({ login: user.login });
});

// Recuperar senha: o link vai para o e-mail cadastrado. A resposta é sempre a mesma, para não revelar
// quais e-mails existem. As conversas não dependem da senha (a chave de cada conversa é digitada à parte),
// então redefinir a senha não faz perder mensagens.
const limitForgot = rateLimit({ windowMs: 60 * MIN, max: 5, key: (req) => `${req.ip}\u0000${String(req.body?.email).slice(0, 254)}` });
const limitForgotIp = rateLimit({ windowMs: 60 * MIN, max: 20, key: (req) => req.ip });
app.post('/api/forgot-password', limitForgotIp, limitForgot, (req, res) => {
  const email = normEmail(req.body?.email);
  const user = email && q.userByEmail.get(email);
  if (user) {
    q.deleteResetTokensOf.run(user.id);
    const token = crypto.randomBytes(32).toString('base64url');
    q.insertResetToken.run(hashToken(token), user.id, Date.now() + RESET_TTL_MS);
    const link = `${PUBLIC_URL}/redefinir-senha?token=${token}`;
    const name = user.login.replace(/[<>&"]/g, '');
    sendMail({
      to: user.email,
      subject: 'Redefinir sua senha - Anonymous Messenger',
      text: `Olá, ${user.login}!\n\nPara criar uma nova senha, abra:\n${link}\n\nO link vale por 1 hora. Se não foi você, ignore esta mensagem: sua senha continua a mesma.`,
      html: `<p>Olá, <b>${name}</b>!</p><p><a href="${link}">Criar nova senha</a></p><p>Ou abra: ${link}</p><p>O link vale por 1 hora. Se não foi você, ignore esta mensagem: sua senha continua a mesma.</p>`,
    }).then(
      (info) => console.log(`[mail] recuperação enviada para ${user.email}: ${info.response}`),
      (err) => console.error(`[mail] falha ao enviar para ${user.email}: ${err.message}`)
    );
  }
  res.json({});
});

const limitReset = rateLimit({ windowMs: 10 * MIN, max: 20, key: (req) => req.ip });
app.post('/api/reset-password', limitReset, ah(async (req, res) => {
  const { token, password } = req.body ?? {};
  const row = typeof token === 'string' && token.length <= 100 && q.resetToken.get(hashToken(token), Date.now());
  const user = row && q.userById.get(row.user_id);
  if (!user) return res.status(400).json({ error: 'Link inválido ou expirado' });
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 1000) {
    return res.status(400).json({ error: `A senha deve ter no mínimo ${MIN_PASSWORD} caracteres` });
  }
  const passwordHash = await hashPassword(password);
  const oldSockets = [...(sockets.get(user.login) ?? [])];
  tx(() => {
    q.setPassword.run(passwordHash, Date.now(), user.id); // abrir o link prova o acesso ao e-mail
    q.deleteResetTokensOf.run(user.id);
    q.deleteEmailTokensOf.run(user.id);
    q.deleteSessionsOfUser.run(user.id); // desloga todos os aparelhos
  });
  for (const ws of oldSockets) ws.close(4401, 'logout');
  startSession(req, res, user);
  res.json({ login: user.login });
}));

// "login" aceita o e-mail ou o nome de usuário.
app.post('/api/login', limitLoginIp, limitLoginUser, ah(async (req, res) => {
  const { login, password } = req.body ?? {};
  const ok0 = typeof login === 'string' && typeof password === 'string' && login.length <= 254;
  const user = ok0 && (login.includes('@') ? q.userByEmail.get(login.trim().toLowerCase()) : q.userByLogin.get(login));
  const ok = await verifyPassword(ok0 ? password : '', user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Usuário/e-mail ou senha incorretos' });
  if (!user.email_verified_at) {
    return res.status(403).json({ error: 'Confirme seu e-mail antes de entrar (veja a caixa de entrada e o spam)', unverified: true, email: user.email });
  }
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

// Avatar: o navegador recorta e reduz para um JPEG pequeno; aqui só se confere que é mesmo um JPEG.
// Fica no banco sem criptografia, pois é a foto de perfil que os outros veem.
const MAX_AVATAR_BYTES = 100 * 1024;
const limitAvatar = rateLimit({ windowMs: 60 * MIN, max: 20, key: (req) => req.user.id });
const isJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

function announceAvatar(user, v) {
  for (const login of new Set([user.login, ...watchersOf(user.id)])) push(login, { type: 'avatar', login: user.login, v });
}

app.get('/api/avatars', auth, (req, res) => {
  res.json(Object.fromEntries(q.avatarVersions.all(req.user.id).map((r) => [r.login, r.v])));
});

app.get('/api/avatars/:login', auth, (req, res) => {
  const row = q.avatarOf.get(req.params.login);
  if (!row) return res.status(404).json({ error: 'Sem avatar' });
  // `?v=` muda a cada troca, então o navegador pode guardar por bastante tempo
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(row.avatar));
});

app.put('/api/avatar', auth, limitAvatar, express.raw({ type: () => true, limit: MAX_AVATAR_BYTES }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !isJpeg(req.body)) return res.status(400).json({ error: 'Imagem inválida' });
  const v = Date.now();
  q.setAvatar.run(req.body, v, req.user.id);
  announceAvatar(req.user, v);
  res.json({ v });
});

app.delete('/api/avatar', auth, limitAvatar, (req, res) => {
  q.setAvatar.run(null, null, req.user.id);
  announceAvatar(req.user, null);
  res.json({});
});

app.get('/api/presence', auth, (req, res) => res.json([...watchersOf(req.user.id)].filter((l) => sockets.has(l))));
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
  // O pedido é feito pelo e-mail da pessoa (o nome de usuário não serve para encontrá-la).
  const email = normEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'E-mail inválido' });
  const target = q.userByEmail.get(email);
  if (!target || !target.email_verified_at) return res.status(404).json({ error: 'Nenhum usuário com esse e-mail' });
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

// Uma conversa é um amigo (mensagem direta) ou um servidor, e os mesmos endpoints de canais e mensagens
// servem às duas. `req.ctx` diz qual é: o `conv` das tabelas, quem pode administrar e como avisar
// os participantes em tempo real.
function dmCtx(req, res, next) {
  const friend = friendOf(req, res);
  if (!friend) return;
  req.ctx = {
    conv: convKey(req.user.id, friend.id),
    friend,
    server: null,
    canManage: true,
    emit(event) {
      push(req.user.login, { ...event, with: friend.login });
      push(friend.login, { ...event, with: req.user.login });
    },
  };
  next();
}

function serverCtx(req, res, next) {
  const server = q.serverById.get(req.params.sid);
  if (!server || !q.isMember.get(server.id, req.user.id)) return res.status(404).json({ error: 'Servidor não encontrado' });
  req.ctx = {
    conv: serverConv(server.id),
    friend: null,
    server,
    canManage: server.owner_id === req.user.id,
    emit(event) {
      for (const m of q.membersOf.all(server.id)) push(m.login, { ...event, server: server.id });
    },
  };
  next();
}

const ownerOnly = (req, res, next) => {
  if (req.ctx.canManage) return next();
  res.status(403).json({ error: 'Só o dono do servidor pode fazer isso' });
};

// Canal pedido (?channel=...); sem o parâmetro vale o padrão. Responde 404 se não existir na conversa.
function channelOf(req, res) {
  const id = req.query.channel ?? req.body?.channel ?? MAIN_CHANNEL.id;
  if (typeof id === 'string' && (id === MAIN_CHANNEL.id || q.channelExists.get(id, req.ctx.conv))) return id;
  res.status(404).json({ error: 'Canal não encontrado' });
  return null;
}

const CHANNEL_SCOPES = [['/api/channels/:friend', dmCtx], ['/api/servers/:sid/channels', serverCtx]];
for (const [base, scope] of CHANNEL_SCOPES) {
  app.get(base, auth, scope, (req, res) => {
    res.json([MAIN_CHANNEL, ...q.channelsOf.all(req.ctx.conv)]);
  });

  app.post(base, auth, scope, ownerOnly, limitChannels, (req, res) => {
    const { conv } = req.ctx;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/^#+/, '').trim() : '';
    if (name === '' || name.length > MAX_CHANNEL_NAME || CONTROL_CHARS.test(name)) {
      return res.status(400).json({ error: `Nome de canal inválido (até ${MAX_CHANNEL_NAME} caracteres)` });
    }
    if (name.toLowerCase() === MAIN_CHANNEL.name || q.channelByName.get(conv, name)) {
      return res.status(409).json({ error: 'Já existe um canal com esse nome' });
    }
    if (q.countChannels.get(conv).n >= MAX_CHANNELS) {
      return res.status(400).json({ error: `Limite de ${MAX_CHANNELS} canais por conversa` });
    }
    const channel = { id: crypto.randomUUID(), name };
    q.insertChannel.run(channel.id, conv, name, req.user.id);
    req.ctx.emit({ type: 'channels' });
    res.json(channel);
  });

  // Apaga o canal e as mensagens dele, para todos. O canal padrão não pode ser apagado.
  app.delete(`${base}/:id`, auth, scope, ownerOnly, (req, res) => {
    const { conv } = req.ctx;
    if (req.params.id === MAIN_CHANNEL.id) return res.status(400).json({ error: 'O canal #geral não pode ser apagado' });
    if (!q.channelExists.get(req.params.id, conv)) return res.status(404).json({ error: 'Canal não encontrado' });
    tx(() => {
      wipeChannelMessages(conv, req.params.id);
      q.deleteChannel.run(req.params.id, conv);
    });
    req.ctx.emit({ type: 'channels' });
    res.json({});
  });
}


// ---------- arquivos cifrados (vídeo/GIF) ----------
// O navegador cifra em blocos e envia em partes sequenciais (PUT ?offset=&final=); cada parte é
// anexada ao arquivo em disco. O arquivo só fica disponível depois da última parte e some junto
// com a mensagem, o canal ou a conversa. O servidor nunca vê o conteúdo nem a chave.
const FILE_SCOPES = [['/api/files/:friend', dmCtx], ['/api/servers/:sid/files', serverCtx]];
const limitUpload = rateLimit({ windowMs: MIN, max: 600, key: (req) => req.user.id });

for (const [base, scope] of FILE_SCOPES) {
  app.put(`${base}/:fid`, auth, scope, limitUpload, ah(async (req, res) => {
    const { conv } = req.ctx;
    const { fid } = req.params;
    if (!UUID_RE.test(fid)) return res.status(400).json({ error: 'Arquivo inválido' });
    const channel = channelOf(req, res);
    if (!channel) return;
    const offset = Number(req.query.offset);
    const final = req.query.final === '1';
    if (!req.headers['content-length']) return res.status(411).json({ error: 'Tamanho obrigatório' });
    const len = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(len) || len < 1 || len > MAX_PART_BYTES || offset + len > MAX_FILE_STORED) {
      return res.status(400).json({ error: 'Parte inválida' });
    }
    let row = q.fileById.get(fid);
    if (row && (row.user_id !== req.user.id || row.conv !== conv || row.complete)) {
      return res.status(409).json({ error: 'Arquivo já existe' });
    }
    if (!row) {
      if (offset !== 0) return res.status(409).json({ error: 'Envio fora de ordem' });
      if (q.pendingFilesOf.get(req.user.id).n >= MAX_PENDING_FILES) {
        return res.status(429).json({ error: 'Muitos envios em andamento' });
      }
      q.insertFile.run(fid, conv, channel, req.user.id, Date.now());
      row = { size: 0 };
    } else if (offset > row.size) {
      return res.status(409).json({ error: 'Envio fora de ordem' });
    }
    if (q.fileBytesOf.get(req.user.id).n - row.size + offset + len > MAX_USER_FILE_BYTES) {
      return res.status(413).json({ error: 'Limite de armazenamento de arquivos atingido' });
    }
    const target = path.join(FILES_DIR, fid);
    try {
      // retentativa de uma parte: descarta o que sobrou de uma tentativa que caiu no meio
      await fsp.truncate(target, offset).catch((err) => { if (err.code !== 'ENOENT') throw err; });
      let got = 0;
      req.on('data', (c) => { got += c.length; });
      await pipeline(req, fs.createWriteStream(target, { flags: 'a' }));
      if (got !== len) throw new Error('parte incompleta');
    } catch (err) {
      if (!res.headersSent) res.status(400).json({ error: 'Falha ao receber a parte' });
      return;
    }
    const size = offset + len;
    if (final) {
      const chunks = Math.ceil(size / (FILE_CHUNK + GCM_OVERHEAD));
      if (size - chunks * GCM_OVERHEAD < 1) {
        q.deleteFile.run(fid);
        fs.unlink(target, () => {});
        return res.status(400).json({ error: 'Arquivo inválido' });
      }
    }
    q.setFileProgress.run(size, final ? 1 : 0, Date.now(), fid);
    res.json({});
  }));

  // Devolve os bytes cifrados (com suporte a Range); só para quem participa da conversa.
  app.get(`${base}/:fid`, auth, scope, limitRead, (req, res) => {
    const row = UUID_RE.test(req.params.fid) ? q.fileById.get(req.params.fid) : null;
    if (!row || row.conv !== req.ctx.conv || !row.complete) return res.status(404).json({ error: 'Arquivo não encontrado' });
    res.sendFile(row.id, {
      root: FILES_DIR,
      dotfiles: 'deny',
      cacheControl: false,
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' },
    }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Arquivo não encontrado' });
    });
  });
}

const PAGE_SIZE = 50;
const MESSAGE_SCOPES = [['/api/messages/:friend', dmCtx], ['/api/servers/:sid/messages', serverCtx]];

for (const [base, scope] of MESSAGE_SCOPES) {
  // Últimas mensagens do canal; com ?before=<seq> devolve a página anterior (rolagem para cima).
  // `read` = até que seq a outra pessoa já leu (para os "visto"); não existe em servidores.
  app.get(base, auth, scope, (req, res) => {
    const { conv, friend, server } = req.ctx;
    const channel = channelOf(req, res);
    if (!channel) return;
    const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
    if (!Number.isInteger(before) || before < 0) return res.status(400).json({ error: 'Cursor inválido' });
    const rows = q.messagesPage.all(conv, channel, before, PAGE_SIZE + 1);
    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE).reverse();
    const reactions = page.length
      ? groupReactions(q.reactionsInRange.all(conv, channel, page[0].seq, page[page.length - 1].seq))
      : new Map();
    res.json({
      messages: page.map((m) => ({ ...m, ...(server && { server: server.id }), reactions: reactions.get(m.id) ?? [] })),
      hasMore,
      read: friend ? q.readOf.get(conv, channel, friend.id)?.seq ?? 0 : 0,
    });
  });

  // Marca como lido (até o seq informado) o que a outra pessoa enviou; avisa quem enviou.
  app.post(`${base}/read`, auth, scope, limitRead, (req, res) => {
    const { conv, friend } = req.ctx;
    const channel = channelOf(req, res);
    if (!channel) return;
    const asked = Number(req.body?.seq);
    if (!Number.isInteger(asked) || asked < 0) return res.status(400).json({ error: 'Marca inválida' });
    const seq = Math.min(asked, q.maxSeq.get(conv, channel).n ?? 0);
    if (seq > (q.readOf.get(conv, channel, req.user.id)?.seq ?? 0)) {
      q.upsertRead.run(conv, channel, req.user.id, seq);
      if (friend) push(friend.login, { type: 'read', with: req.user.login, channel, seq });
    }
    res.json({});
  });

  // `data` já chega criptografado (AES-GCM) pelo navegador; o servidor nunca vê o texto.
  app.post(base, auth, scope, limitSend, (req, res) => {
    const { conv, friend, server } = req.ctx;
    const channel = channelOf(req, res);
    if (!channel) return;
    const { data, file } = req.body ?? {};
    if (typeof data !== 'string' || data === '' || data.length > MAX_CIPHERTEXT) {
      return res.status(400).json({ error: 'Mensagem inválida' });
    }
    let fileRow = null;
    if (file !== undefined) {
      fileRow = typeof file === 'string' && UUID_RE.test(file) ? q.fileById.get(file) : null;
      if (!fileRow || fileRow.user_id !== req.user.id || fileRow.conv !== conv || fileRow.channel !== channel || !fileRow.complete || fileRow.message_id) {
        return res.status(400).json({ error: 'Arquivo inválido' });
      }
    }
    const msg = {
      id: crypto.randomUUID(),
      channel,
      from: req.user.login,
      to: friend ? friend.login : null,
      ...(server && { server: server.id }),
      data,
      ts: Date.now(),
      reactions: [],
    };
    tx(() => {
      msg.seq = Number(q.insertMessage.run(msg.id, conv, channel, req.user.id, friend ? friend.id : 0, data, msg.ts).lastInsertRowid);
      if (fileRow) q.linkFile.run(msg.id, fileRow.id);
    });
    req.ctx.emit({ type: 'message', message: msg });
    if (friend) pushNotify(friend.id, { type: 'message', from: msg.from, channel });
    else {
      for (const m of q.membersOf.all(server.id)) {
        if (m.id !== req.user.id) pushNotify(m.id, { type: 'message', from: msg.from, channel, server: server.id, serverName: server.name });
      }
    }
    res.json(msg);
  });

  // Apaga todas as mensagens do canal para todos, de forma permanente (em servidor, só o dono).
  app.delete(base, auth, scope, ownerOnly, (req, res) => {
    const channel = channelOf(req, res);
    if (!channel) return;
    tx(() => wipeChannelMessages(req.ctx.conv, channel));
    req.ctx.emit({ type: 'cleared', channel });
    res.json({});
  });
}

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

// O autor troca o conteúdo cifrado da própria mensagem. Sem `edited` é o ajuste automático do áudio
// (a transcrição chega depois do envio), só por pouco tempo; com `edited` é uma edição do autor, que
// vale a qualquer momento e marca a mensagem como editada.
const MAX_EDIT_AGE_MS = 10 * 60 * 1000;

for (const [base, scope] of MESSAGE_SCOPES) {
  app.patch(`${base}/:id`, auth, scope, limitSend, (req, res) => {
    const row = q.messageOwner.get(req.params.id, req.ctx.conv);
    if (!row || row.from_id !== req.user.id) return res.status(404).json({ error: 'Mensagem não encontrada' });
    const userEdit = req.body?.edited === true;
    if (!userEdit && Date.now() - row.ts > MAX_EDIT_AGE_MS) return res.status(400).json({ error: 'Tempo para editar esgotado' });
    const { data } = req.body ?? {};
    if (typeof data !== 'string' || data === '' || data.length > MAX_CIPHERTEXT) {
      return res.status(400).json({ error: 'Mensagem inválida' });
    }
    const edited = userEdit ? Date.now() : null;
    if (userEdit) q.updateMessageEdited.run(data, edited, req.params.id);
    else q.updateMessageData.run(data, req.params.id);
    req.ctx.emit({ type: 'edited', id: req.params.id, channel: row.channel, data, ...(edited && { edited }) });
    res.json({});
  });

  // O autor apaga a própria mensagem; o dono do servidor apaga qualquer uma do servidor.
  app.delete(`${base}/:id`, auth, scope, limitSend, (req, res) => {
    const row = q.messageOwner.get(req.params.id, req.ctx.conv);
    if (!row) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (row.from_id !== req.user.id && !(req.ctx.server && req.ctx.canManage)) {
      return res.status(403).json({ error: 'Você só pode apagar suas mensagens' });
    }
    tx(() => {
      q.deleteReactionsOfMessage.run(req.params.id);
      dropFiles(q.fileIdsOfMessage, q.deleteFilesOfMessage, req.params.id);
      q.deleteMessage.run(req.params.id);
    });
    req.ctx.emit({ type: 'deleted', id: req.params.id, channel: row.channel });
    res.json({});
  });

  // Alterna a reação do usuário (adiciona se não tinha, remove se já tinha), como no Discord.
  app.post(`${base}/:id/reactions`, auth, scope, limitSend, (req, res) => {
    const row = q.messageChannel.get(req.params.id, req.ctx.conv);
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
    req.ctx.emit({ type: 'reactions', id: req.params.id, channel: row.channel, reactions });
    res.json({ reactions });
  });
}

// ---------- servidores ----------
// Um servidor tem dono, membros e canais (tabela `channels`, com conv `s:<id>`). As mensagens usam
// as mesmas rotas e a mesma criptografia das conversas diretas, com uma chave por servidor.
const MAX_SERVERS_PER_USER = 50; // servidores em que a pessoa participa
const MAX_OWNED_SERVERS = 10;
const MAX_SERVER_MEMBERS = 100;
const MAX_SERVER_NAME = 32;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

const serverInfo = (s) => ({ id: s.id, name: s.name, icon: s.icon, color: s.color, owner: s.owner });
const notifyServers = (logins) => {
  for (const login of new Set(logins)) push(login, { type: 'servers' });
};

app.get('/api/servers', auth, (req, res) => res.json(q.serversOf.all(req.user.id).map(serverInfo)));

app.post('/api/servers', auth, limitServers, (req, res) => {
  const { name, icon = '', color } = req.body ?? {};
  const clean = typeof name === 'string' ? name.trim() : '';
  if (clean === '' || clean.length > MAX_SERVER_NAME || CONTROL_CHARS.test(clean)) {
    return res.status(400).json({ error: `Nome inválido (até ${MAX_SERVER_NAME} caracteres)` });
  }
  if (typeof icon !== 'string' || (icon !== '' && (icon.length > 16 || !EMOJI_RE.test(icon)))) {
    return res.status(400).json({ error: 'Ícone inválido' });
  }
  if (typeof color !== 'string' || !COLOR_RE.test(color)) return res.status(400).json({ error: 'Cor inválida' });
  if (q.countOwnedServers.get(req.user.id).n >= MAX_OWNED_SERVERS) {
    return res.status(400).json({ error: `Limite de ${MAX_OWNED_SERVERS} servidores criados` });
  }
  if (q.countServersOf.get(req.user.id).n >= MAX_SERVERS_PER_USER) {
    return res.status(400).json({ error: `Limite de ${MAX_SERVERS_PER_USER} servidores` });
  }
  const server = { id: crypto.randomUUID(), name: clean, icon, color: color.toLowerCase(), owner: req.user.login };
  tx(() => {
    q.insertServer.run(server.id, server.name, server.icon, server.color, req.user.id);
    q.addMember.run(server.id, req.user.id);
  });
  push(req.user.login, { type: 'servers' });
  res.json(server);
});

app.get('/api/servers/:sid', auth, serverCtx, (req, res) => {
  const { server } = req.ctx;
  res.json({
    ...serverInfo({ ...server, owner: q.userById.get(server.owner_id).login }),
    members: q.membersOf.all(server.id).map((m) => m.login),
  });
});

// Só o dono adiciona, e só amigos dele (quem bloqueou o dono não é amigo, então fica de fora).
app.post('/api/servers/:sid/members', auth, serverCtx, ownerOnly, limitMembers, (req, res) => {
  const { server } = req.ctx;
  const target = typeof req.body?.login === 'string' && q.userByLogin.get(req.body.login);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!q.areFriends.get(req.user.id, target.id)) {
    return res.status(400).json({ error: 'Só é possível adicionar amigos ao servidor' });
  }
  if (q.isMember.get(server.id, target.id)) return res.status(409).json({ error: 'Já está no servidor' });
  if (q.countMembers.get(server.id).n >= MAX_SERVER_MEMBERS) {
    return res.status(400).json({ error: `Limite de ${MAX_SERVER_MEMBERS} membros` });
  }
  if (q.countServersOf.get(target.id).n >= MAX_SERVERS_PER_USER) {
    return res.status(400).json({ error: 'Este usuário já participa de servidores demais' });
  }
  q.addMember.run(server.id, target.id);
  notifyServers(q.membersOf.all(server.id).map((m) => m.login));
  res.json({});
});

// O dono remove qualquer membro; cada um pode sair sozinho. O dono não sai: apaga o servidor.
app.delete('/api/servers/:sid/members/:login', auth, serverCtx, (req, res) => {
  const { server, canManage } = req.ctx;
  const target = q.userByLogin.get(req.params.login);
  if (!target || !q.isMember.get(server.id, target.id)) return res.status(404).json({ error: 'Membro não encontrado' });
  if (target.id === server.owner_id) return res.status(400).json({ error: 'O dono não pode sair; apague o servidor' });
  if (target.id !== req.user.id && !canManage) return res.status(403).json({ error: 'Só o dono do servidor pode fazer isso' });
  const logins = q.membersOf.all(server.id).map((m) => m.login);
  tx(() => {
    q.removeMember.run(server.id, target.id);
    q.deleteReadsOfUser.run(serverConv(server.id), target.id);
  });
  notifyServers(logins);
  res.json({});
});

app.delete('/api/servers/:sid', auth, serverCtx, ownerOnly, (req, res) => {
  const { server, conv } = req.ctx;
  const logins = q.membersOf.all(server.id).map((m) => m.login);
  wipeConversation(conv);
  tx(() => {
    q.deleteServerMembers.run(server.id);
    q.deleteServer.run(server.id);
  });
  notifyServers(logins);
  res.json({});
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
const PUSH_HOSTS = /^(fcm\.googleapis\.com|jmt17\.google\.com|([\w-]+\.)*push\.services\.mozilla\.com|([\w-]+\.)*push\.apple\.com|([\w-]+\.)*notify\.windows\.com)$/;
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
    return res.status(400).json({ error: `Inscrição inválida${host ? ` (${host})` : ''}` });
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
