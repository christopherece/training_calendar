'use strict';
/* Dockside Training server: serves the web app and a small JSON API backed by SQLite.
   No third-party packages: Node 22.13+ (built-in node:sqlite). Data lives in DATA_DIR/training.db. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WEB_DIR = path.join(__dirname, 'web');
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
/* the address staff use to reach the calendar, for invite and reset links, e.g. http://192.168.1.20:8080 */
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const LOGIN_DAYS = 30, INVITE_DAYS = 14, RESET_DAYS = 3, DAY = 864e5;

/* ---------- database ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'training.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
    pass TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS logins (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, email TEXT, role TEXT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS signups (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL);
`);
const q = sql => db.prepare(sql);
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------- small helpers ---------- */
const now = () => Date.now();
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const newId = () => crypto.randomBytes(10).toString('hex');
const RE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/, RE_MONTH = /^\d{4}-\d{2}$/, RE_TIME = /^\d{2}:\d{2}$/;
const RE_MOVED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const CATS = ['safety', 'rescue', 'fire', 'systems', 'environment', 'induction'];
const STATUSES = ['going', 'attended', 'absent'];

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}
function validPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) fail(400, 'Use a password of at least 8 characters.');
  if (pw.length > 200) fail(400, 'That password is too long.');
  return pw;
}
function cleanName(v) {
  const n = typeof v === 'string' ? v.trim().slice(0, 80) : '';
  if (!n) fail(400, 'Enter your name so others can see who booked.');
  return n;
}
function cleanEmail(v) {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!RE_EMAIL.test(e) || e.length > 200) fail(400, 'Enter a valid email address.');
  return e;
}
function str(v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : ''; }

/* the server's own copy of what a training session may contain; anything else is dropped */
function cleanSession(d) {
  if (!d || typeof d !== 'object') return null;
  const title = str(d.title, 120);
  const date = RE_DATE.test(d.date || '') ? d.date : '';
  const month = !date && RE_MONTH.test(d.month || '') ? d.month : '';
  if (!title || (!date && !month) || !RE_TIME.test(d.start || '') || !RE_TIME.test(d.end || '')) return null;
  return {
    title, kind: d.kind === 'drill' ? 'drill' : 'training', category: CATS.includes(d.category) ? d.category : 'induction',
    date, month, start: d.start, end: d.end,
    location: str(d.location, 120), trainer: str(d.trainer, 80), notes: str(d.notes, 600),
    capacity: Math.max(0, Math.min(500, parseInt(d.capacity, 10) || 0)),
    mandatory: d.mandatory === true, example: d.example === true,
    seriesId: str(d.seriesId, 60), movedFrom: RE_MOVED.test(d.movedFrom || '') ? d.movedFrom : ''
  };
}

/* ---------- live updates (server-sent events) ---------- */
const listeners = new Set();
let version = 0;
function changed() {
  version++;
  for (const res of listeners) res.write('event: change\ndata: ' + version + '\n\n');
}
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 25000).unref();

/* ---------- login state ---------- */
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function cookie(value, maxAge) {
  return 'dt_login=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (SECURE_COOKIE ? '; Secure' : '');
}
function currentUser(req) {
  const t = parseCookies(req).dt_login;
  if (!t) return null;
  return q(`SELECT u.id, u.name, u.email, u.role FROM logins l JOIN users u ON u.id = l.user_id
            WHERE l.token = ? AND l.expires > ? AND u.active = 1`).get(sha(t), now()) || null;
}
function startLogin(res, userId) {
  const t = newToken();
  q('DELETE FROM logins WHERE expires < ?').run(now());
  q('INSERT INTO logins (token, user_id, expires) VALUES (?, ?, ?)').run(sha(t), userId, now() + LOGIN_DAYS * DAY);
  res.setHeader('Set-Cookie', cookie(t, LOGIN_DAYS * 86400));
}
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role }; }

/* slow down password guessing: 10 failures per email+address per 15 minutes */
const failures = new Map();
function throttle(key) {
  const f = failures.get(key);
  if (f && f.n >= 10 && now() - f.t < 15 * 60e3) fail(429, 'Too many attempts. Wait 15 minutes and try again.');
}
function noteFailure(key) {
  const f = failures.get(key);
  failures.set(key, f && now() - f.t < 15 * 60e3 ? { n: f.n + 1, t: f.t } : { n: 1, t: now() });
}

function findLink(token) {
  const l = q('SELECT * FROM links WHERE token = ? AND expires > ?').get(sha(token), now());
  if (!l) fail(404, 'This link has expired or was already used. Ask a manager for a new one.');
  return l;
}
function makeLink(kind, fields) {
  const t = newToken(), days = kind === 'invite' ? INVITE_DAYS : RESET_DAYS;
  q(`INSERT INTO links (id, token, kind, email, role, user_id, expires, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId(), sha(t), kind, fields.email || null, fields.role || null, fields.user_id || null, now() + days * DAY, now());
  return { link: PUBLIC_URL + '/?' + kind + '=' + t, days };
}

/* ---------- API ---------- */
const routes = [];
const route = (method, pattern, auth, fn) => routes.push({ method, pattern, auth, fn });

route('GET', '/api/status', 'none', req => {
  const me = currentUser(req);
  return { setup: q('SELECT COUNT(*) n FROM users').get().n === 0, me: me && publicUser(me) };
});

route('POST', '/api/setup', 'none', (req, res, body) => {
  const name = cleanName(body.name), email = cleanEmail(body.email), pass = validPassword(body.password);
  const id = newId();
  tx(() => {
    if (q('SELECT COUNT(*) n FROM users').get().n !== 0) fail(409, 'The calendar is already set up. Sign in instead.');
    q('INSERT INTO users (id, name, email, role, pass, created) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, email, 'manager', hashPassword(pass), now());
  });
  startLogin(res, id);
  return { me: { id, name, email, role: 'manager' } };
});

route('POST', '/api/login', 'none', (req, res, body) => {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const key = email + '|' + req.socket.remoteAddress;
  throttle(key);
  const u = q('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!u || typeof body.password !== 'string' || !checkPassword(body.password, u.pass)) {
    noteFailure(key);
    fail(401, 'That email and password do not match. Check them, or ask a manager for a reset link.');
  }
  failures.delete(key);
  startLogin(res, u.id);
  return { me: publicUser(u) };
});

route('POST', '/api/logout', 'none', (req, res) => {
  const t = parseCookies(req).dt_login;
  if (t) q('DELETE FROM logins WHERE token = ?').run(sha(t));
  res.setHeader('Set-Cookie', cookie('', 0));
  return {};
});

route('GET', '/api/link/:token', 'none', (req, res, body, p) => {
  const l = findLink(p.token);
  const u = l.user_id && q('SELECT name, email FROM users WHERE id = ?').get(l.user_id);
  return { kind: l.kind, email: l.kind === 'invite' ? l.email : u && u.email, name: u ? u.name : '' };
});

route('POST', '/api/link/:token', 'none', (req, res, body, p) => {
  const pass = validPassword(body.password);
  let userId;
  tx(() => {
    const l = findLink(p.token);
    if (l.kind === 'invite') {
      const name = cleanName(body.name);
      const existing = q('SELECT id, active FROM users WHERE email = ?').get(l.email);
      if (existing && existing.active) fail(409, 'That email already has an account. Sign in instead.');
      if (existing) {
        q('UPDATE users SET name = ?, role = ?, pass = ?, active = 1 WHERE id = ?').run(name, l.role, hashPassword(pass), existing.id);
        userId = existing.id;
      } else {
        userId = newId();
        q('INSERT INTO users (id, name, email, role, pass, created) VALUES (?, ?, ?, ?, ?, ?)').run(userId, name, l.email, l.role, hashPassword(pass), now());
      }
      q("DELETE FROM links WHERE kind = 'invite' AND email = ?").run(l.email);
    } else {
      userId = l.user_id;
      q('UPDATE users SET pass = ? WHERE id = ?').run(hashPassword(pass), userId);
      q('DELETE FROM logins WHERE user_id = ?').run(userId);
      q("DELETE FROM links WHERE kind = 'reset' AND user_id = ?").run(userId);
    }
  });
  startLogin(res, userId);
  changed();
  return { me: publicUser(q('SELECT * FROM users WHERE id = ?').get(userId)) };
});

route('GET', '/api/data', 'member', (req, res, body, p, me) => {
  const manager = me.role === 'manager';
  return {
    me: publicUser(me),
    version,
    sessions: q('SELECT id, data FROM sessions').all().map(r => Object.assign({ id: r.id }, JSON.parse(r.data))),
    signups: q('SELECT id, session_id sessionId, user_id uid, status FROM signups').all(),
    users: q('SELECT id, name, email, role, active FROM users').all().map(u => ({
      id: u.id, name: u.name, role: u.role, active: !!u.active, email: manager || u.id === me.id ? u.email : ''
    })),
    invites: manager ? q("SELECT id, email, role, expires FROM links WHERE kind = 'invite' AND expires > ? ORDER BY email").all(now()) : []
  };
});

route('GET', '/api/events', 'member', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
  return undefined;
});

/* managers: several calendar changes at once, all or nothing */
route('POST', '/api/batch', 'manager', (req, res, body) => {
  const ops = Array.isArray(body.ops) ? body.ops : fail(400, 'Nothing to save.');
  if (ops.length > 500) fail(400, 'Too many changes at once.');
  tx(() => {
    for (const o of ops) {
      const [col, id] = String(o && o.path).split('/');
      if (!RE_ID.test(id || '')) fail(400, 'Bad id.');
      if (col === 'sessions') {
        if (o.op === 'delete') { q('DELETE FROM sessions WHERE id = ?').run(id); continue; }
        let data = o.data;
        if (o.op === 'update') {
          const cur = q('SELECT data FROM sessions WHERE id = ?').get(id);
          if (!cur) fail(404, 'That session no longer exists. Reload the page.');
          data = Object.assign(JSON.parse(cur.data), o.data);
        } else if (o.op !== 'set') fail(400, 'Bad change.');
        const clean = cleanSession(data);
        if (!clean) fail(400, 'A session is missing its title, day or times.');
        q('INSERT INTO sessions (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(id, JSON.stringify(clean));
      } else if (col === 'signups') {
        if (o.op === 'delete') q('DELETE FROM signups WHERE id = ?').run(id);
        else if (o.op === 'update' && STATUSES.includes(o.data && o.data.status)) q('UPDATE signups SET status = ? WHERE id = ?').run(o.data.status, id);
        else fail(400, 'Bad change.');
      } else fail(400, 'Bad change.');
    }
  });
  changed();
  return {};
});

route('POST', '/api/signups', 'member', (req, res, body, p, me) => {
  const sid = String(body.sessionId || '');
  tx(() => {
    const row = q('SELECT data FROM sessions WHERE id = ?').get(sid);
    if (!row) fail(404, 'That session no longer exists.');
    const s = JSON.parse(row.data);
    if (!s.date) fail(400, 'Booking opens once the day is set.');
    if (q('SELECT 1 FROM signups WHERE session_id = ? AND user_id = ?').get(sid, me.id)) return;
    if (s.capacity > 0 && q('SELECT COUNT(*) n FROM signups WHERE session_id = ?').get(sid).n >= s.capacity) fail(409, 'Sorry, that session just filled up.');
    q('INSERT INTO signups (id, session_id, user_id, status, at) VALUES (?, ?, ?, ?, ?)').run(sid + '_' + me.id, sid, me.id, 'going', now());
  });
  changed();
  return {};
});

route('DELETE', '/api/signups/:id', 'member', (req, res, body, p, me) => {
  const su = q('SELECT user_id FROM signups WHERE id = ?').get(p.id);
  if (!su) return {};
  if (su.user_id !== me.id && me.role !== 'manager') fail(403, 'You can only remove your own booking.');
  q('DELETE FROM signups WHERE id = ?').run(p.id);
  changed();
  return {};
});

route('PATCH', '/api/signups/:id', 'manager', (req, res, body, p) => {
  if (!STATUSES.includes(body.status)) fail(400, 'Bad status.');
  q('UPDATE signups SET status = ? WHERE id = ?').run(body.status, p.id);
  changed();
  return {};
});

/* managers: people */
route('POST', '/api/invites', 'manager', (req, res, body) => {
  const email = cleanEmail(body.email), role = body.role === 'manager' ? 'manager' : 'staff';
  if (q('SELECT 1 FROM users WHERE email = ? AND active = 1').get(email)) fail(409, 'That person is already on the team.');
  q("DELETE FROM links WHERE kind = 'invite' AND email = ?").run(email);
  const out = makeLink('invite', { email, role });
  changed();
  return out;
});

route('DELETE', '/api/invites/:id', 'manager', (req, res, body, p) => {
  q("DELETE FROM links WHERE id = ? AND kind = 'invite'").run(p.id);
  changed();
  return {};
});

route('PATCH', '/api/users/:id', 'manager', (req, res, body, p, me) => {
  if (p.id === me.id) fail(400, 'You cannot change your own role. Ask another manager.');
  if (!['manager', 'staff'].includes(body.role)) fail(400, 'Bad role.');
  q('UPDATE users SET role = ? WHERE id = ? AND active = 1').run(body.role, p.id);
  changed();
  return {};
});

route('DELETE', '/api/users/:id', 'manager', (req, res, body, p, me) => {
  if (p.id === me.id) fail(400, 'You cannot remove yourself.');
  tx(() => {
    q('UPDATE users SET active = 0 WHERE id = ?').run(p.id);
    q('DELETE FROM logins WHERE user_id = ?').run(p.id);
    q('DELETE FROM links WHERE user_id = ?').run(p.id);
  });
  changed();
  return {};
});

route('POST', '/api/users/:id/reset', 'manager', (req, res, body, p) => {
  const u = q('SELECT id FROM users WHERE id = ? AND active = 1').get(p.id);
  if (!u) fail(404, 'That person is not on the team.');
  q("DELETE FROM links WHERE kind = 'reset' AND user_id = ?").run(u.id);
  return makeLink('reset', { user_id: u.id });
});

/* ---------- HTTP plumbing ---------- */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

function sendJson(res, status, obj) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SECURITY_HEADERS));
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Too much data.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch (e) { reject(new HttpError(400, 'Bad request.')); }
    });
    req.on('error', reject);
  });
}

function match(pattern, pathname) {
  const a = pattern.split('/'), b = pathname.split('/');
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

async function handleApi(req, res, url) {
  try {
    if (req.method !== 'GET') {
      /* only this page may change things: JSON requests from our own origin */
      if (!/^application\/json/.test(req.headers['content-type'] || '')) fail(415, 'Bad request.');
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) fail(403, 'Bad origin.');
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const params = match(r.pattern, url.pathname);
      if (!params) continue;
      const me = r.auth === 'none' ? null : currentUser(req);
      if (r.auth !== 'none' && !me) fail(401, 'Please sign in again.');
      if (r.auth === 'manager' && me.role !== 'manager') fail(403, 'Only managers can change the calendar.');
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await r.fn(req, res, body, params, me);
      if (out !== undefined) sendJson(res, 200, out);
      return;
    }
    fail(404, 'Not found.');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong on the server.' });
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB_DIR, path.normalize(rel));
  if (!file.startsWith(WEB_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
    res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) handleApi(req, res, url);
  else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
  else { res.writeHead(405); res.end(); }
});

if (require.main === module) {
  server.listen(PORT, () => console.log('Dockside Training on http://localhost:' + PORT + ' (data in ' + DATA_DIR + ')'));
  const stop = () => { server.close(); db.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
module.exports = { server };
