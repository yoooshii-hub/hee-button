const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const db = require('./lib/db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const SESSION_DAYS = 30;
// 1 接続あたりの連打上限（回/秒）。これを超えた分は数えない
const MAX_PRESSES_PER_SEC = 15;

db.load();

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));

const server = http.createServer(app);
const io = new Server(server);

// ---------- ユーティリティ ----------

const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function baseUrl(req) {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function findUserBySession(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!sid) return null;
  const session = db.data.sessions.find((s) => s.id === sid && s.expiresAt > Date.now());
  return session ? db.data.users.find((u) => u.id === session.userId) : null;
}

function startSession(res, userId) {
  const id = newId(24);
  db.data.sessions.push({ id, userId, expiresAt: Date.now() + SESSION_DAYS * 86400e3 });
  db.save();
  res.cookie('sid', id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: res.req.secure,
    maxAge: SESSION_DAYS * 86400e3,
  });
}

function requireUser(req, res, next) {
  const user = findUserBySession(req);
  if (!user) return res.status(401).json({ error: 'ログインしてください' });
  req.user = user;
  next();
}

function ownEvent(req, res, next) {
  const ev = db.data.events.find((e) => e.id === req.params.id && e.ownerId === req.user.id);
  if (!ev) return res.status(404).json({ error: 'イベントが見つかりません' });
  req.event = ev;
  next();
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

function adminEventView(ev, req) {
  const base = baseUrl(req);
  return {
    id: ev.id,
    title: ev.title,
    status: ev.status,
    total: ev.total,
    createdAt: ev.createdAt,
    guestUrl: `${base}/e/${ev.slug}`,
    displayUrl: `${base}/display/${ev.slug}?key=${ev.displayKey}`,
    displayKey: ev.displayKey,
    slug: ev.slug,
    guests: guestCount(ev),
  };
}

// ---------- 認証 API ----------

app.post('/api/register', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !email || password.length < 8) {
    return res.status(400).json({ error: '名前・メールアドレス・8文字以上のパスワードを入力してください' });
  }
  if (db.data.users.some((u) => u.email === email)) {
    return res.status(409).json({ error: 'このメールアドレスは登録済みです' });
  }
  const user = { id: newId(), name, email, ...hashPassword(password), createdAt: Date.now() };
  db.data.users.push(user);
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.data.users.find((u) => u.email === email);
  if (!user || !verifyPassword(String(req.body.password || ''), user)) {
    return res.status(401).json({ error: 'メールアドレスかパスワードが違います' });
  }
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req.headers.cookie).sid;
  db.data.sessions = db.data.sessions.filter((s) => s.id !== sid);
  db.save();
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- マイルーム / イベント API ----------

app.get('/api/events', requireUser, (req, res) => {
  const events = db.data.events
    .filter((e) => e.ownerId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => adminEventView(e, req));
  res.json({ events });
});

app.post('/api/events', requireUser, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: 'イベント名を入力してください' });
  const ev = {
    id: newId(),
    ownerId: req.user.id,
    title,
    slug: newId(6),
    displayKey: newId(12),
    status: 'ready', // ready: 開始前 / open: 受付中 / paused: 一時停止
    total: 0,
    round: 1,
    createdAt: Date.now(),
  };
  db.data.events.push(ev);
  db.save();
  res.json({ event: adminEventView(ev, req) });
});

app.get('/api/events/:id', requireUser, ownEvent, (req, res) => {
  res.json({ event: adminEventView(req.event, req) });
});

app.patch('/api/events/:id', requireUser, ownEvent, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 80);
  if (title) req.event.title = title;
  db.save();
  broadcastState(req.event);
  res.json({ event: adminEventView(req.event, req) });
});

app.delete('/api/events/:id', requireUser, ownEvent, (req, res) => {
  db.data.events = db.data.events.filter((e) => e !== req.event);
  db.save();
  io.to(guestRoom(req.event)).to(displayRoom(req.event)).emit('deleted');
  res.json({ ok: true });
});

app.post('/api/events/:id/start', requireUser, ownEvent, (req, res) => {
  req.event.status = 'open';
  db.save();
  broadcastState(req.event);
  res.json({ event: adminEventView(req.event, req) });
});

app.post('/api/events/:id/pause', requireUser, ownEvent, (req, res) => {
  req.event.status = 'paused';
  db.save();
  broadcastState(req.event);
  res.json({ event: adminEventView(req.event, req) });
});

// リセット: 合計を 0 にし、ゲストの回数も 0 に戻して、再び開始されるまで押せなくする
app.post('/api/events/:id/reset', requireUser, ownEvent, (req, res) => {
  const ev = req.event;
  flushPending(ev);
  ev.total = 0;
  ev.round += 1;
  ev.status = 'ready';
  db.save();
  broadcastState(ev);
  io.to(displayRoom(ev)).emit('total', { total: 0, delta: 0 });
  res.json({ event: adminEventView(ev, req) });
});

app.get('/api/events/:id/qr', requireUser, ownEvent, async (req, res) => {
  const url = `${baseUrl(req)}/e/${req.event.slug}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 2, width: 512 });
  res.type('image/svg+xml').send(svg);
});

// 合計表示ページ用（表示キーで認可）
app.get('/api/display/:slug/qr', async (req, res) => {
  const ev = db.data.events.find((e) => e.slug === req.params.slug && e.displayKey === req.query.key);
  if (!ev) return res.status(404).end();
  const svg = await QRCode.toString(`${baseUrl(req)}/e/${ev.slug}`, { type: 'svg', margin: 2, width: 512 });
  res.type('image/svg+xml').send(svg);
});

// ---------- ページ ----------

const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/', page('index.html'));
app.get('/room', page('room.html'));
app.get('/room/events/:id', page('event.html'));
app.get('/e/:slug', page('guest.html'));
app.get('/display/:slug', page('display.html'));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- リアルタイム ----------

const guestRoom = (ev) => `g:${ev.id}`;
const displayRoom = (ev) => `d:${ev.id}`;
const guestCount = (ev) => io.sockets.adapter.rooms.get(guestRoom(ev))?.size || 0;

function guestState(ev) {
  return { title: ev.title, status: ev.status, round: ev.round };
}

function broadcastState(ev) {
  io.to(guestRoom(ev)).emit('state', guestState(ev));
  io.to(displayRoom(ev)).emit('state', { ...guestState(ev), total: ev.total, guests: guestCount(ev) });
}

// 押下は 100ms ごとにまとめて表示側へ送る（大人数の同時連打でも負荷を抑える）
const pending = new Map(); // eventId -> 未送信の押下数

function flushPending(ev) {
  const delta = pending.get(ev.id);
  if (!delta) return;
  pending.delete(ev.id);
  io.to(displayRoom(ev)).emit('total', { total: ev.total, delta });
}

setInterval(() => {
  for (const id of pending.keys()) {
    const ev = db.data.events.find((e) => e.id === id);
    if (ev) flushPending(ev);
    else pending.delete(id);
  }
}, 100);

function emitGuestCount(ev) {
  io.to(displayRoom(ev)).emit('guests', { guests: guestCount(ev) });
}

io.on('connection', (socket) => {
  let joined = null;
  let pressWindow = { start: 0, count: 0 };

  socket.on('join-guest', ({ slug } = {}, ack) => {
    const ev = db.data.events.find((e) => e.slug === slug);
    if (!ev) return typeof ack === 'function' && ack({ error: 'not_found' });
    joined = ev;
    socket.join(guestRoom(ev));
    emitGuestCount(ev);
    typeof ack === 'function' && ack({ state: guestState(ev) });
  });

  socket.on('join-display', ({ slug, key } = {}, ack) => {
    const ev = db.data.events.find((e) => e.slug === slug && e.displayKey === key);
    if (!ev) return typeof ack === 'function' && ack({ error: 'not_found' });
    socket.join(displayRoom(ev));
    typeof ack === 'function' && ack({ state: { ...guestState(ev), total: ev.total, guests: guestCount(ev) } });
  });

  socket.on('hee', ({ round } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ev = joined && db.data.events.find((e) => e.id === joined.id);
    if (!ev || ev.status !== 'open' || round !== ev.round) return reply({ ok: false, state: ev && guestState(ev) });

    const now = Date.now();
    if (now - pressWindow.start > 1000) pressWindow = { start: now, count: 0 };
    if (++pressWindow.count > MAX_PRESSES_PER_SEC) return reply({ ok: false, limited: true });

    ev.total += 1;
    pending.set(ev.id, (pending.get(ev.id) || 0) + 1);
    db.save();
    reply({ ok: true });
  });

  socket.on('disconnect', () => {
    if (joined) emitGuestCount(joined);
  });
});

function shutdown() {
  db.saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`へぇボタン サーバー起動: http://localhost:${PORT}`);
});
