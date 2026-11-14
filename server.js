const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const db = require('./lib/db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const SIGNUP_CODE = process.env.SIGNUP_CODE || '';
const SESSION_DAYS = 30;
// 1 接続あたりの連打上限（回/秒）。これを超えた分は数えない
const MAX_PRESSES_PER_SEC = 15;
const MAX_OPTIONS = 4;

db.load();
migrate();

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20kb' }));

const server = http.createServer(app);
const io = new Server(server);

// ---------- ユーティリティ ----------

const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
// 全角/半角・大文字/小文字を区別しない比較用
const fold = (s) => String(s || '').normalize('NFKC').trim().toLowerCase();
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const zeros = (n) => Array(n).fill(0);

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

function newCurrent(ev, round) {
  return {
    round,
    presenter: '',
    counts: zeros(ev.options.length),
    guests: {}, // guestId -> 各ボタンの押下数
    displayBase: zeros(ev.options.length), // 合計表示を 0 に戻したときの基準値
    restoredId: null, // 保存済みセッションを復元して編集中ならその id
    dirty: false, // 保存していない変更があるか
    reason: null, // 直前にラウンドが変わった理由（saved / reset / restored）
  };
}

// 旧バージョンのデータを新しい形に合わせる
function migrate() {
  for (const u of db.data.users) {
    if (!u.username) u.username = u.email || u.name || u.id;
    u.usernameKey = fold(u.username);
  }
  for (const ev of db.data.events) {
    if (!ev.options) ev.options = ['へぇ'];
    if (!ev.saved) ev.saved = [];
    if (!ev.nextNo) ev.nextNo = ev.saved.reduce((m, s) => Math.max(m, s.no), 0) + 1;
    if (!['ready', 'live', 'ended'].includes(ev.status)) {
      ev.accepting = ev.status === 'open';
      ev.status = ev.status === 'ready' ? 'ready' : 'live';
    }
    if (ev.autoStartNext === undefined) ev.autoStartNext = true;
    if (!ev.view) ev.view = 'count';
    if (!ev.current) {
      ev.current = newCurrent(ev, ev.round || 1);
      ev.current.counts[0] = ev.total || 0;
      ev.current.dirty = !!ev.total;
    }
    delete ev.total;
    delete ev.round;
  }
  db.save();
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

const publicUser = (u) => ({ id: u.id, username: u.username });

// ---------- 集計・ランキング ----------

function displayCounts(ev) {
  const c = ev.current;
  return c.counts.map((n, i) => Math.max(0, n - (c.displayBase[i] || 0)));
}

// 「へぇ」（最初のボタン）の票が多い順。同票は同順位で、発表が早い順に並べる
function ranking(ev) {
  const rows = [...ev.saved].sort((a, b) => b.counts[0] - a.counts[0] || a.no - b.no);
  return rows.map((s) => {
    const rank = 1 + rows.filter((o) => o.counts[0] > s.counts[0]).length;
    const tie = rows.some((o) => o !== s && o.counts[0] === s.counts[0]);
    return { id: s.id, no: s.no, presenter: s.presenter, hee: s.counts[0], total: sum(s.counts), rank, tie };
  });
}

function savedView(ev) {
  const top = Math.max(0, ...ev.saved.map((s) => s.counts[0]));
  return [...ev.saved]
    .sort((a, b) => a.no - b.no)
    .map((s) => ({
      id: s.id,
      no: s.no,
      presenter: s.presenter,
      counts: s.counts,
      total: sum(s.counts),
      savedAt: s.savedAt,
      best: top > 0 && s.counts[0] === top,
    }));
}

function currentNo(ev) {
  const r = ev.current.restoredId && ev.saved.find((s) => s.id === ev.current.restoredId);
  return r ? r.no : ev.nextNo;
}

const guestRoom = (ev) => `g:${ev.id}`;
const displayRoom = (ev) => `d:${ev.id}`;
const guestCount = (ev) => io.sockets.adapter.rooms.get(guestRoom(ev))?.size || 0;

// 参加者・合計表示・管理画面に共通の公開状態
function publicState(ev) {
  const c = ev.current;
  return {
    title: ev.title,
    status: ev.status,
    accepting: ev.accepting,
    options: ev.options,
    round: c.round,
    reason: c.reason,
    presenter: c.presenter,
    no: currentNo(ev),
    shown: displayCounts(ev),
    view: ev.view,
    playAt: ev.playAt || 0,
    ranking: ev.status === 'ended' || ev.view === 'ranking' ? ranking(ev) : null,
    serverNow: Date.now(),
  };
}

function guestState(ev, gid) {
  return { ...publicState(ev), mine: ev.current.guests[gid] || zeros(ev.options.length) };
}

function fullState(ev, req) {
  const c = ev.current;
  const base = req ? baseUrl(req) : '';
  return {
    ...publicState(ev),
    ranking: ranking(ev),
    id: ev.id,
    slug: ev.slug,
    displayKey: ev.displayKey,
    autoStartNext: ev.autoStartNext,
    counts: c.counts,
    total: sum(c.counts),
    dirty: c.dirty && sum(c.counts) > 0,
    restoredId: c.restoredId,
    saved: savedView(ev),
    guests: guestCount(ev),
    createdAt: ev.createdAt,
    ...(req && {
      guestUrl: `${base}/e/${ev.slug}`,
      displayUrl: `${base}/display/${ev.slug}?key=${ev.displayKey}`,
    }),
  };
}

function broadcast(ev) {
  db.save();
  for (const id of io.sockets.adapter.rooms.get(guestRoom(ev)) || []) {
    const s = io.sockets.sockets.get(id);
    if (s) s.emit('state', guestState(ev, s.data.gid));
  }
  io.to(displayRoom(ev)).emit('state', fullState(ev));
}

// 押下は 100ms ごとにまとめて送る（大人数の同時連打でも負荷を抑える）
const pending = new Map(); // eventId -> 未送信の押下数

setInterval(() => {
  for (const [id, delta] of pending) {
    pending.delete(id);
    const ev = db.data.events.find((e) => e.id === id);
    if (!ev) continue;
    const payload = { round: ev.current.round, shown: displayCounts(ev), counts: ev.current.counts, delta };
    io.to(displayRoom(ev)).emit('tally', payload);
    io.to(guestRoom(ev)).emit('tally', { round: payload.round, shown: payload.shown, delta });
  }
}, 100);

function emitGuestCount(ev) {
  io.to(displayRoom(ev)).emit('guests', { guests: guestCount(ev) });
}

function nextRound(ev, reason, current) {
  pending.delete(ev.id);
  ev.current = current || newCurrent(ev, ev.current.round + 1);
  ev.current.reason = reason;
}

// ---------- 認証 API ----------

app.get('/api/signup-info', (req, res) => res.json({ codeRequired: true, codeConfigured: !!SIGNUP_CODE }));

app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').normalize('NFKC').trim().slice(0, 40);
  const password = String(req.body.password || '');
  if (!SIGNUP_CODE) {
    return res.status(403).json({ error: '招待コードがまだ設定されていません。Render の環境変数 SIGNUP_CODE を設定してください' });
  }
  if (fold(req.body.code) !== fold(SIGNUP_CODE)) {
    return res.status(403).json({ error: '招待コードが違います' });
  }
  if (!username || password.length < 8) {
    return res.status(400).json({ error: 'ユーザー名と8文字以上のパスワードを入力してください' });
  }
  if (db.data.users.some((u) => u.usernameKey === fold(username))) {
    return res.status(409).json({ error: 'このユーザー名は使われています' });
  }
  const user = { id: newId(), username, usernameKey: fold(username), ...hashPassword(password), createdAt: Date.now() };
  db.data.users.push(user);
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const user = db.data.users.find((u) => u.usernameKey === fold(req.body.username));
  if (!user || !verifyPassword(String(req.body.password || ''), user)) {
    return res.status(401).json({ error: 'ユーザー名かパスワードが違います' });
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

// ---------- マイルーム ----------

app.get('/api/events', requireUser, (req, res) => {
  const events = db.data.events
    .filter((e) => e.ownerId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => ({ id: e.id, title: e.title, status: e.status, savedCount: e.saved.length, guests: guestCount(e), createdAt: e.createdAt }));
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
    status: 'ready', // ready: 準備中 / live: 開催中 / ended: 終了
    accepting: false,
    autoStartNext: true,
    options: ['へぇ'],
    view: 'count',
    playAt: 0,
    saved: [],
    nextNo: 1,
    createdAt: Date.now(),
  };
  ev.current = newCurrent(ev, 1);
  db.data.events.push(ev);
  db.save();
  res.json({ event: fullState(ev, req) });
});

const eventRoute = (method, p, handler) =>
  app[method](`/api/events/:id${p}`, requireUser, ownEvent, (req, res) => {
    const err = handler(req.event, req.body || {}, req, res);
    if (res.headersSent) return;
    if (err) return res.status(err.status || 400).json(err);
    broadcast(req.event);
    res.json({ event: fullState(req.event, req) });
  });

app.get('/api/events/:id', requireUser, ownEvent, (req, res) => res.json({ event: fullState(req.event, req) }));

eventRoute('patch', '', (ev, body) => {
  if (body.title !== undefined) {
    const title = String(body.title).trim().slice(0, 80);
    if (!title) return { error: 'イベント名を入力してください' };
    ev.title = title;
  }
  if (body.autoStartNext !== undefined) ev.autoStartNext = !!body.autoStartNext;
  if (body.presenter !== undefined) ev.current.presenter = String(body.presenter).slice(0, 60);
  if (body.options !== undefined) {
    const options = (Array.isArray(body.options) ? body.options : [])
      .map((o) => String(o).trim().slice(0, 12))
      .filter(Boolean)
      .slice(0, MAX_OPTIONS);
    if (!options.length) return { error: 'ボタンを1つ以上入力してください' };
    const resize = (arr) => options.map((_, i) => arr[i] || 0);
    ev.options = options;
    const c = ev.current;
    c.counts = resize(c.counts);
    c.displayBase = resize(c.displayBase);
    for (const g of Object.keys(c.guests)) c.guests[g] = resize(c.guests[g]);
    for (const s of ev.saved) {
      s.counts = resize(s.counts);
      for (const g of Object.keys(s.guests || {})) s.guests[g] = resize(s.guests[g]);
    }
  }
});

app.delete('/api/events/:id', requireUser, ownEvent, (req, res) => {
  db.data.events = db.data.events.filter((e) => e !== req.event);
  db.save();
  io.to(guestRoom(req.event)).to(displayRoom(req.event)).emit('deleted');
  res.json({ ok: true });
});

// イベントのリセット: 保存済みも含めてすべてのセッションを消す
eventRoute('post', '/reset-event', (ev) => {
  ev.saved = [];
  ev.nextNo = 1;
  ev.status = 'ready';
  ev.accepting = false;
  ev.view = 'count';
  nextRound(ev, 'reset');
});

eventRoute('post', '/start', (ev) => {
  ev.status = 'live';
  ev.accepting = true;
  ev.view = 'count';
});

eventRoute('post', '/end', (ev) => {
  ev.status = 'ended';
  ev.accepting = false;
  ev.view = 'ranking';
  ev.playAt = Date.now() + 600;
});

eventRoute('post', '/resume', (ev) => {
  ev.status = 'live';
  ev.accepting = true;
  ev.view = 'count';
});

eventRoute('post', '/accepting', (ev, body) => {
  if (ev.status !== 'live') return { error: '先に「イベントを開始」を押してください' };
  ev.accepting = !!body.on;
});

eventRoute('post', '/reset-session', (ev) => {
  const keep = { presenter: ev.current.presenter, restoredId: ev.current.restoredId };
  nextRound(ev, 'reset');
  Object.assign(ev.current, keep, { dirty: !!keep.restoredId });
});

eventRoute('post', '/save', (ev, body) => {
  const c = ev.current;
  if (body.presenter !== undefined) c.presenter = String(body.presenter).slice(0, 60);
  const record = {
    presenter: c.presenter.trim(),
    counts: [...c.counts],
    guests: c.guests,
    savedAt: Date.now(),
  };
  const existing = c.restoredId && ev.saved.find((s) => s.id === c.restoredId);
  if (existing) Object.assign(existing, record);
  else ev.saved.push({ id: newId(), no: ev.nextNo++, ...record });
  nextRound(ev, 'saved');
  ev.accepting = ev.status === 'live' && ev.autoStartNext;
});

eventRoute('post', '/display-zero', (ev) => {
  ev.current.displayBase = [...ev.current.counts];
});

eventRoute('post', '/view', (ev, body) => {
  ev.view = body.view === 'ranking' ? 'ranking' : 'count';
  if (ev.view === 'ranking') ev.playAt = Date.now() + 600;
});

eventRoute('post', '/replay', (ev) => {
  ev.view = 'ranking';
  ev.playAt = Date.now() + 600;
});

function savedSession(ev, sid) {
  return ev.saved.find((s) => s.id === sid);
}

eventRoute('patch', '/saved/:sid', (ev, body, req) => {
  const s = savedSession(ev, req.params.sid);
  if (!s) return { status: 404, error: '保存済みセッションが見つかりません' };
  s.presenter = String(body.presenter || '').trim().slice(0, 60);
});

eventRoute('delete', '/saved/:sid', (ev, body, req) => {
  const s = savedSession(ev, req.params.sid);
  if (!s) return { status: 404, error: '保存済みセッションが見つかりません' };
  ev.saved = ev.saved.filter((x) => x !== s);
  if (ev.current.restoredId === s.id) ev.current.restoredId = null;
});

// 復元: 保存済みの結果を現在のセッションに戻して、修正や追加投票ができるようにする
eventRoute('post', '/saved/:sid/restore', (ev, body, req) => {
  const s = savedSession(ev, req.params.sid);
  if (!s) return { status: 404, error: '保存済みセッションが見つかりません' };
  const c = ev.current;
  if (c.dirty && sum(c.counts) > 0 && !body.force) {
    return { status: 409, needConfirm: true, unsaved: sum(c.counts), error: '保存していない票があります' };
  }
  const restored = newCurrent(ev, c.round + 1);
  restored.presenter = s.presenter;
  restored.counts = [...s.counts];
  restored.guests = JSON.parse(JSON.stringify(s.guests || {}));
  restored.restoredId = s.id;
  nextRound(ev, 'restored', restored);
  ev.accepting = false;
});

app.get('/api/events/:id/csv', requireUser, ownEvent, (req, res) => {
  const ev = req.event;
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const date = (t) => new Date(t).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const rank = new Map(ranking(ev).map((r) => [r.id, r.rank]));
  const lines = [['番号', '発表者', ...ev.options, '合計', '順位', '保存日時'].map(cell).join(',')];
  for (const s of savedView(ev)) {
    lines.push([s.no, s.presenter, ...s.counts, s.total, rank.get(s.id), date(s.savedAt)].map(cell).join(','));
  }
  const name = `${ev.title.replace(/[\\/:*?"<>|]/g, '_')}_結果.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="result.csv"; filename*=UTF-8''${encodeURIComponent(name)}`);
  // Excel で文字化けしないよう BOM を付ける
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

async function sendQr(res, url, req) {
  const big = req.query.size === 'large';
  const svg = await QRCode.toString(url, { type: 'svg', margin: 2, width: big ? 1024 : 512 });
  res.type('image/svg+xml').send(svg);
}

app.get('/api/events/:id/qr', requireUser, ownEvent, (req, res) => sendQr(res, `${baseUrl(req)}/e/${req.event.slug}`, req));

// 合計表示ページ用（秘密の表示キーで認可）
app.get('/api/display/:slug/qr', (req, res) => {
  const ev = db.data.events.find((e) => e.slug === req.params.slug && e.displayKey === req.query.key);
  if (!ev) return res.status(404).end();
  sendQr(res, `${baseUrl(req)}/e/${ev.slug}`, req);
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

io.on('connection', (socket) => {
  let joined = null;
  let pressWindow = { start: 0, count: 0 };

  socket.on('join-guest', ({ slug, gid } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ev = db.data.events.find((e) => e.slug === slug);
    if (!ev) return reply({ error: 'not_found' });
    // 同じブラウザなら回数を引き継げるよう、端末ごとの id をブラウザ側で保存してもらう
    socket.data.gid = /^[A-Za-z0-9_-]{8,40}$/.test(gid || '') ? gid : newId();
    joined = ev;
    socket.join(guestRoom(ev));
    emitGuestCount(ev);
    reply({ state: guestState(ev, socket.data.gid), gid: socket.data.gid });
  });

  socket.on('join-display', ({ slug, key } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ev = db.data.events.find((e) => e.slug === slug && e.displayKey === key);
    if (!ev) return reply({ error: 'not_found' });
    socket.join(displayRoom(ev));
    reply({ state: fullState(ev) });
  });

  socket.on('vote', ({ round, opt = 0 } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ev = joined && db.data.events.find((e) => e.id === joined.id);
    const c = ev && ev.current;
    if (!ev || ev.status !== 'live' || !ev.accepting || round !== c.round) {
      return reply({ ok: false, state: ev && guestState(ev, socket.data.gid) });
    }
    if (!Number.isInteger(opt) || opt < 0 || opt >= ev.options.length) return reply({ ok: false });

    const now = Date.now();
    if (now - pressWindow.start > 1000) pressWindow = { start: now, count: 0 };
    if (++pressWindow.count > MAX_PRESSES_PER_SEC) return reply({ ok: false, limited: true });

    const mine = c.guests[socket.data.gid] || (c.guests[socket.data.gid] = zeros(ev.options.length));
    mine[opt] += 1;
    c.counts[opt] += 1;
    c.dirty = true;
    pending.set(ev.id, (pending.get(ev.id) || 0) + 1);
    db.save();
    reply({ ok: true, mine });
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
  if (!SIGNUP_CODE) console.log('注意: 環境変数 SIGNUP_CODE が未設定のため、アカウント作成はできません');
});
