'use strict';
/* Dockside Training server: serves the web app and a small JSON API backed by SQLite.
   No third-party packages: Node 22.13+ (built-in node:sqlite). Data lives in DATA_DIR/training.db. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* `npm run dev` passes --dev: its own data and port, so it can run beside the real calendar without touching it */
const DEV = process.argv.includes('--dev');
const PORT = +process.env.PORT || (DEV ? 8081 : 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, DEV ? 'data-dev' : 'data');
const WEB_DIR = path.join(__dirname, 'web');
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
/* the address staff use to reach the calendar, for invite and reset links, e.g. http://192.168.1.20:8080 */
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
/* anyone who can reach the calendar may view it (never change it) without signing in; PUBLIC_READ=0 turns this off */
const PUBLIC_READ = process.env.PUBLIC_READ !== '0';
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
  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS reminded (session_id TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session_id, day));
  CREATE TABLE IF NOT EXISTS types (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, drill INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL);
`);
/* added after the first release: each person's notification choices */
if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'notify'").get()) {
  db.exec("ALTER TABLE users ADD COLUMN notify TEXT NOT NULL DEFAULT '{}'");
}
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
const STATUSES = ['going', 'attended', 'absent'];
const RE_COLOR = /^#[0-9A-F]{6}$/i;

/* choices from the marina's training spreadsheet */
const DURATIONS = ['1 hour', '2 hours', '3 hours', '1/2 Day', '1 Day', '2 Days', '3 Days', '4 Days', '5 Days', '1 Week', '2 Weeks'];
const SESSION_STATUSES = ['planning', 'vendor', 'in-progress', 'booked', 'on-hold', 'postponed', 'cancelled', 'complete'];
const SETTINGS = ['classroom', 'practical', 'mixed', 'debrief', 'na'];
const EXPIRY_MONTHS = [0, 3, 6, 12, 24, 36, 48, 60];   /* 0 = no expiry (N/A) */

/* training and drill types: [id, name, colour, drill, expiry in months, supplier], from the marina's training
   spreadsheet and supplier list; managers can edit them in Settings */
const STARTING_TYPES = [
  ['holidays', 'Holidays', '#FF0000', 0, 0, ''],
  ['rya-level-2', 'PBL Level 2 (initial)', '#00CCFF', 0, 0, 'Powerboat Training NZ (Atlantic 21 Ltd)'],
  ['vhf', 'Maritime VHF Operator Certificate', '#CCFFFF', 0, 0, 'Boating Education (Coastguard)'],
  ['first-aid', 'First Aid (Initial)', '#CCFFCC', 0, 24, ''],
  ['first-aid-refresher', 'First Aid - Workplace Refresher', '#B4C6E7', 0, 24, 'First Aid NZ Ltd'],
  ['twin-engine', 'Twin engine power boat training', '#FFFF99', 0, 0, 'Powerboat Training NZ (Atlantic 21 Ltd)'],
  ['towing', 'Marina Towing Course', '#99CCFF', 0, 0, 'Powerboat Training NZ (Atlantic 21 Ltd)'],
  ['risk-assessment', 'Dynamic Risk Assessment Evaluation', '#FF99CC', 0, 0, 'Internal'],
  ['powerboat-assessment', 'Power Boat Competency assessment', '#CC99FF', 0, 12, 'Powerboat Training NZ (Atlantic 21 Ltd)'],
  ['er-storm', 'ER - Storm Response Drills', '#FFCC99', 1, 3, 'Internal'],
  ['er-fire', 'ER - Fire Response Drills (carpark, office, piers & evacuations)', '#FFCC00', 1, 3, 'Internal'],
  ['er-spill', 'ER - Spill Response Drills (Tiers 1, 2 & 3)', '#993300', 1, 3, 'Internal; Tier 2 exercise: Harbour Master'],
  ['er-public-disorder', 'ER - Public Disorder Drill', '#969696', 1, 3, 'Internal'],
  ['er-maritime', 'ER - Maritime Incidents Drills (Vessel Sinking)', '#008800', 1, 3, 'Internal'],
  ['er-natural-disaster', 'ER - Natural Disaster Drills (Earthquake & Tsunami)', '#FF6600', 1, 3, 'Internal'],
  ['er-medical', 'ER - Medical Emergency Drills', '#99CC00', 1, 3, 'Internal'],
  ['er-powerboat', 'ER - Power boat Drills', '#666699', 1, 3, 'Internal'],
  ['mtoc', 'Marina Tender Operators Certificate (MTOC)', '#3366FF', 0, 60, 'Maritime NZ - issued in-house by MNZ delegate'],
  ['water-survival', 'Drowning Prevention/In water survival', '#33CCCC', 0, 0, 'Boating Education (Coastguard)'],
  ['transitional-facility', 'Transitional Facility Operator (PoFA)', '#993366', 0, 24, 'SPS Biosecurity Ltd'],
  ['melanoma', 'Melanoma Awareness', '#333399', 0, 0, 'Melanoma NZ'],
  ['sop-management-review', 'Marina Operational SOP - Management Review', '#FF3300', 0, 6, 'Internal'],
  ['sop-staff-sign-off', 'Marina Operational SOP - Staff Sign Off', '#00FF00', 0, 6, 'Internal'],
  ['er-man-overboard', 'ER - Man overboard', '#7030A0', 1, 6, 'Internal'],
  ['hs-noggin', 'H & S Noggin', '#F6D6DD', 0, 3, ''],
  ['electrical-compliance', 'Electrical Compliance', '#ECECEC', 0, 12, ''],
  ['panuku-hosted', 'Panuku Hosted - Various', '#EEC5FB', 0, 12, ''],
  /* on the supplier list but not the colour sheet: colours picked to be told apart, change them in Settings */
  ['commercial-launch', 'Commercial Launch Master/SRL (Skipper Restricted Limits)', '#2E75B6', 0, 0, 'Various'],
  ['coastal-boatmaster', 'Coastal Boat master', '#1F4E79', 0, 0, 'Various'],
  ['aquatic-first-aid', 'Aquatic Based First Aid & Emergency Care Training', '#9DC3E6', 0, 0, 'Drowning Prevention Auckland (Water Safe Auckland Inc)'],
  ['fire-awareness', 'Fire awareness & Extinguisher Training (Option 3)', '#F8CBAD', 0, 0, 'Chubb Training Division'],
  ['er-training', 'Emergency Response Training', '#FFE699', 0, 0, 'Internal'],
  ['forklift', 'Forklift Operators Certificate', '#BF8F00', 0, 0, 'National Forklift Training Ltd'],
  ['imm', 'Intermediate Marina Management (IMM)', '#C5E0B4', 0, 0, 'Marina Industries Association (MIA)'],
  ['amm', 'Advanced Marina Management (AMM)', '#70AD47', 0, 0, 'Marina Industries Association (MIA)'],
  ['skills-basic', 'Westhaven Skills Matrix - Basic Skills', '#DDEBF7', 0, 0, 'Internal'],
  ['skills-hs-env', 'Westhaven Skills Matrix - H&S and Environmental', '#E2F0D9', 0, 0, 'Internal'],
  ['skills-systems', 'Westhaven Skills Matrix - Systems', '#EDE7F6', 0, 0, 'Internal'],
  ['skills-powerboat', 'Westhaven Skills Matrix - Power Boat', '#D9E1F2', 0, 0, 'Internal'],
  ['skills-maintenance', 'Westhaven Skills Matrix - Maintenance', '#FCE4D6', 0, 0, 'Internal'],
  ['skills-admin', 'Westhaven Skills Matrix - Administration', '#FFF2CC', 0, 0, 'Internal'],
  ['other', 'Other', '#C9CED6', 0, 0, '']
];
if (!db.prepare("SELECT 1 FROM pragma_table_info('types') WHERE name = 'supplier'").get()) {
  db.exec("ALTER TABLE types ADD COLUMN supplier TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('types') WHERE name = 'expiry'").get()) {
  db.exec('ALTER TABLE types ADD COLUMN expiry INTEGER NOT NULL DEFAULT 0');
}
/* a database made with the first, shorter list gets the spreadsheet's full names, colours and expiries once */
if (db.prepare('SELECT 1 FROM types LIMIT 1').get() && !db.prepare("SELECT 1 FROM settings WHERE key = 'types_v2'").get()) {
  const up = db.prepare(`INSERT INTO types (id, name, color, drill, sort, expiry) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, drill = excluded.drill, expiry = excluded.expiry, sort = excluded.sort`);
  STARTING_TYPES.forEach((t, i) => up.run(t[0], t[1], t[2], t[3], i, t[4]));
  db.prepare("INSERT INTO settings (key, value) VALUES ('types_v2', '1')").run();
}
if (!db.prepare('SELECT 1 FROM types LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO types (id, name, color, drill, sort, expiry, supplier) VALUES (?, ?, ?, ?, ?, ?, ?)');
  STARTING_TYPES.forEach((t, i) => ins.run(t[0], t[1], t[2], t[3], i, t[4], t[5]));
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('types_v2', '1')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('types_v3', '1')").run();
  /* sessions made before types existed used six general categories: give each the closest type */
  const guess = [[/overboard/i, 'er-man-overboard'], [/fire/i, 'er-fire'], [/earth ?quake|tsunami|natural disaster/i, 'er-natural-disaster'],
    [/spill/i, 'er-spill'], [/storm/i, 'er-storm'], [/medical/i, 'er-medical'], [/first aid/i, 'first-aid'], [/vhf/i, 'vhf'], [/tow/i, 'towing']];
  const old = { fire: 'er-fire', rescue: 'first-aid', environment: 'er-spill' };
  db.prepare('SELECT id, data FROM sessions').all().forEach(r => {
    const s = JSON.parse(r.data);
    const hit = guess.find(g => g[0].test(s.title || ''));
    s.category = hit ? hit[1] : old[s.category] || 'other';
    s.kind = STARTING_TYPES.find(t => t[0] === s.category)[3] ? 'drill' : s.kind;
    db.prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(s), r.id);
  });
}
/* once: suppliers from the supplier list, and the courses on it that were not types yet (nothing a manager set is overwritten) */
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'types_v3'").get()) {
  const setSupplier = db.prepare("UPDATE types SET supplier = ? WHERE id = ? AND supplier = ''");
  const add = db.prepare('INSERT INTO types (id, name, color, drill, sort, expiry, supplier) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');
  const order = db.prepare('UPDATE types SET sort = ? WHERE id = ?');
  STARTING_TYPES.forEach((t, i) => { setSupplier.run(t[5], t[0]); add.run(t[0], t[1], t[2], t[3], i, t[4], t[5]); order.run(i, t[0]); });
  db.prepare("INSERT INTO settings (key, value) VALUES ('types_v3', '1')").run();
}
function allTypes() {
  return q('SELECT id, name, color, drill, expiry, supplier FROM types ORDER BY sort, name').all()
    .map(t => ({ id: t.id, name: t.name, color: t.color, drill: !!t.drill, expiry: t.expiry, supplier: t.supplier }));
}

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
  const type = q('SELECT id, drill FROM types WHERE id = ?').get(str(d.category, 64)) || q("SELECT id, drill FROM types WHERE id = 'other'").get() || { id: 'other', drill: 0 };
  /* a course can run over several days, up to a month */
  let endDate = date && RE_DATE.test(d.endDate || '') && d.endDate > date ? d.endDate : '';
  if (endDate && (new Date(endDate) - new Date(date)) / DAY > 31) endDate = '';
  return {
    title, kind: type.drill ? 'drill' : 'training', category: type.id,
    date, endDate, month, start: d.start, end: d.end,
    status: SESSION_STATUSES.includes(d.status) ? d.status : 'planning',
    duration: DURATIONS.includes(d.duration) ? d.duration : '',
    setting: SETTINGS.includes(d.setting) ? d.setting : '',
    provider: d.provider === 'inhouse' || d.provider === 'external' ? d.provider : '',
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
  return { setup: q('SELECT COUNT(*) n FROM users').get().n === 0, publicRead: PUBLIC_READ, me: me && publicUser(me) };
});

/* the read-only calendar for visitors who are not signed in: sessions and how many places are taken, no names */
route('GET', '/api/public', 'none', () => {
  if (!PUBLIC_READ) fail(401, 'Please sign in to see the calendar.');
  const counts = {};
  q('SELECT session_id s, COUNT(*) n FROM signups GROUP BY session_id').all().forEach(r => { counts[r.s] = r.n; });
  return {
    version,
    types: allTypes(),
    sessions: q('SELECT id, data FROM sessions').all().map(r => Object.assign({ id: r.id }, JSON.parse(r.data))),
    counts
  };
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
    me: Object.assign(publicUser(me), { notify: prefsOf(q('SELECT notify FROM users WHERE id = ?').get(me.id).notify) }),
    version,
    types: allTypes(),
    sessions: q('SELECT id, data FROM sessions').all().map(r => Object.assign({ id: r.id }, JSON.parse(r.data))),
    signups: q('SELECT id, session_id sessionId, user_id uid, status FROM signups').all(),
    users: q('SELECT id, name, email, role, active FROM users').all().map(u => ({
      id: u.id, name: u.name, role: u.role, active: !!u.active, email: manager || u.id === me.id ? u.email : ''
    })),
    invites: manager ? q("SELECT id, email, role, expires FROM links WHERE kind = 'invite' AND expires > ? ORDER BY email").all(now()) : []
  };
});

route('GET', '/api/events', 'none', (req, res) => {
  if (!PUBLIC_READ && !currentUser(req)) fail(401, 'Please sign in again.');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
  return undefined;
});

/* managers: several calendar changes at once, all or nothing */
route('POST', '/api/batch', 'manager', (req, res, body, p, me) => {
  const ops = Array.isArray(body.ops) ? body.ops : fail(400, 'Nothing to save.');
  if (ops.length > 500) fail(400, 'Too many changes at once.');
  const events = [];   /* what changed, for notifications once it is saved */
  tx(() => {
    /* who was booked before anything in this save, since deleting a session removes its bookings first */
    const bookedBefore = new Map();
    for (const o of ops) {
      const [col, id] = String(o && o.path).split('/');
      if (col === 'sessions' && !bookedBefore.has(id)) bookedBefore.set(id, q('SELECT user_id FROM signups WHERE session_id = ?').all(id).map(r => r.user_id));
    }
    for (const o of ops) {
      const [col, id] = String(o && o.path).split('/');
      if (!RE_ID.test(id || '')) fail(400, 'Bad id.');
      if (col === 'sessions') {
        const cur = q('SELECT data FROM sessions WHERE id = ?').get(id);
        const before = cur ? JSON.parse(cur.data) : null;
        const booked = bookedBefore.get(id) || [];
        if (o.op === 'delete') {
          q('DELETE FROM sessions WHERE id = ?').run(id);
          if (before && !before.example) events.push({ kind: 'cancelled', id, before, booked });
          continue;
        }
        let data = o.data;
        if (o.op === 'update') {
          if (!cur) fail(404, 'That session no longer exists. Reload the page.');
          data = Object.assign(JSON.parse(cur.data), o.data);
        } else if (o.op !== 'set') fail(400, 'Bad change.');
        const clean = cleanSession(data);
        if (!clean) fail(400, 'A session is missing its title, day or times.');
        q('INSERT INTO sessions (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(id, JSON.stringify(clean));
        if (!clean.example) {
          if (!before) events.push({ kind: 'new', id, after: clean, booked });
          else if ((clean.status === 'cancelled' || clean.status === 'postponed') && before.status !== clean.status) events.push({ kind: clean.status, id, before, after: clean, booked });
          else if (['date', 'endDate', 'month', 'start', 'end'].some(k => (before[k] || '') !== (clean[k] || ''))) events.push({ kind: 'moved', id, before, after: clean, booked });
        }
      } else if (col === 'signups') {
        if (o.op === 'delete') q('DELETE FROM signups WHERE id = ?').run(id);
        else if (o.op === 'update' && STATUSES.includes(o.data && o.data.status)) q('UPDATE signups SET status = ? WHERE id = ?').run(o.data.status, id);
        else fail(400, 'Bad change.');
      } else fail(400, 'Bad change.');
    }
  });
  changed();
  announceChanges(events, me.id);
  return {};
});

route('POST', '/api/signups', 'member', (req, res, body, p, me) => {
  const sid = String(body.sessionId || '');
  tx(() => {
    const row = q('SELECT data FROM sessions WHERE id = ?').get(sid);
    if (!row) fail(404, 'That session no longer exists.');
    const s = JSON.parse(row.data);
    if (!s.date) fail(400, 'Booking opens once the day is set.');
    if (s.status === 'cancelled' || s.status === 'postponed') fail(400, 'This session is ' + s.status + ', so it cannot be booked.');
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

/* today's weather at the marina, from Open-Meteo (free, no key). Everyone shares one cached copy, refreshed every 15 minutes. */
const WEATHER = {
  lat: +process.env.WEATHER_LAT || -36.8406, lon: +process.env.WEATHER_LON || 174.748,
  name: process.env.WEATHER_NAME || 'Westhaven', tz: process.env.WEATHER_TZ || 'Pacific/Auckland'
};
const WEATHER_TTL = 15 * 60e3;
let weatherCache = null, weatherAt = 0, weatherPending = null;
async function fetchWeather() {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.search = new URLSearchParams({
    latitude: WEATHER.lat, longitude: WEATHER.lon, timezone: WEATHER.tz, wind_speed_unit: 'kn', forecast_days: '2',
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
    hourly: 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation_probability,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset,uv_index_max'
  });
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Open-Meteo answered ' + r.status);
  const d = await r.json(), c = d.current, hr = d.hourly, dy = d.daily;
  const nowHour = c.time.slice(0, 13);
  const hours = [];
  for (let i = 0; i < hr.time.length && hours.length < 8; i++) {
    if (hr.time[i].slice(0, 13) <= nowHour) continue;
    hours.push({ time: hr.time[i].slice(11, 16), code: hr.weather_code[i], temp: hr.temperature_2m[i], wind: hr.wind_speed_10m[i], dir: hr.wind_direction_10m[i], rain: hr.precipitation_probability[i], day: hr.is_day[i] });
  }
  return {
    place: WEATHER.name, updated: c.time,
    current: { code: c.weather_code, temp: c.temperature_2m, feels: c.apparent_temperature, wind: c.wind_speed_10m, dir: c.wind_direction_10m, gust: c.wind_gusts_10m, day: c.is_day },
    today: {
      code: dy.weather_code[0], max: dy.temperature_2m_max[0], min: dy.temperature_2m_min[0], rain: dy.precipitation_probability_max[0],
      windMax: dy.wind_speed_10m_max[0], gustMax: dy.wind_gusts_10m_max[0], dir: dy.wind_direction_10m_dominant[0],
      sunrise: dy.sunrise[0].slice(11, 16), sunset: dy.sunset[0].slice(11, 16), uv: dy.uv_index_max[0]
    },
    hours
  };
}
route('GET', '/api/weather', 'none', async () => {
  if (weatherCache && now() - weatherAt < WEATHER_TTL) return weatherCache;
  if (!weatherPending) {
    weatherPending = fetchWeather()
      .then(w => { weatherCache = w; weatherAt = now(); return w; })
      .finally(() => { weatherPending = null; });
  }
  try { return await weatherPending; }
  catch (e) {
    console.error('Weather:', e.message);
    if (weatherCache) return Object.assign({}, weatherCache, { stale: true });
    fail(503, 'The forecast is not available right now.');
  }
});

/* ---------- push notifications (Web Push: RFC 8030 delivery, RFC 8291 encryption, RFC 8292 VAPID) ---------- */
const PUSH_CONTACT = process.env.PUSH_CONTACT || 'https://www.westhaven.co.nz';
const PUSH_DRY_RUN = process.env.PUSH_DRY_RUN === '1';   /* tests: log notifications instead of sending them */
const REMINDER_HOUR = Math.min(23, Math.max(0, parseInt(process.env.REMINDER_HOUR || '17', 10)));
/* only the browsers' own push services; a subscription can never make the server call anywhere else */
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)mozilla\.com$/, /(^|\.)mozaws\.net$/, /(^|\.)notify\.windows\.com$/];
const NOTIFY_KINDS = ['changes', 'reminders', 'new'];

/* the server's push identity: made once, kept in the database so existing subscriptions keep working */
const VAPID = (function () {
  let row = q("SELECT value FROM settings WHERE key = 'vapid'").get();
  if (!row) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    row = { value: JSON.stringify({ pub: publicKey.export({ format: 'jwk' }), priv: privateKey.export({ format: 'jwk' }) }) };
    q("INSERT INTO settings (key, value) VALUES ('vapid', ?)").run(row.value);
  }
  const v = JSON.parse(row.value);
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(v.pub.x, 'base64url'), Buffer.from(v.pub.y, 'base64url')]);
  return { privateKey: crypto.createPrivateKey({ key: v.priv, format: 'jwk' }), key: raw.toString('base64url') };
})();

const vapidHeaders = new Map();
function vapidAuth(endpoint) {
  const aud = new URL(endpoint).origin, t = Math.floor(now() / 1000);
  const cached = vapidHeaders.get(aud);
  if (cached && cached.exp - 3600 > t) return cached.header;
  const exp = t + 12 * 3600;
  const part = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = part({ typ: 'JWT', alg: 'ES256' }) + '.' + part({ aud, exp, sub: PUSH_CONTACT });
  const sig = crypto.sign('sha256', Buffer.from(data), { key: VAPID.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const header = 'vapid t=' + data + '.' + sig + ', k=' + VAPID.key;
  vapidHeaders.set(aud, { header, exp });
  return header;
}

/* aes128gcm content encoding: only the person's own device can read the message */
function encryptPush(sub, text) {
  const uaPublic = Buffer.from(sub.p256dh, 'base64url'), authSecret = Buffer.from(sub.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, sealed]);
}

async function pushTo(sub, msg) {
  if (PUSH_DRY_RUN) { console.log('PUSH ' + sub.user_id + ' ' + JSON.stringify(msg)); return; }
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST', signal: AbortSignal.timeout(10000), body: encryptPush(sub, JSON.stringify(msg)),
      headers: { Authorization: vapidAuth(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' }
    });
    /* the device unsubscribed or the app was removed: forget it */
    if (r.status === 404 || r.status === 410) q('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
    else if (!r.ok) console.error('Push refused (' + r.status + '):', (await r.text()).slice(0, 200));
  } catch (e) { console.error('Push failed:', e.message); }
}

function prefsOf(json) {
  let p = {};
  try { p = JSON.parse(json || '{}') || {}; } catch (e) { /* defaults */ }
  const out = {};
  NOTIFY_KINDS.forEach(k => { out[k] = p[k] !== false; });
  return out;
}
/* sends to every device the person turned notifications on for, if they want this kind */
function notifyUser(userId, msg, kind) {
  const subs = q('SELECT s.endpoint, s.p256dh, s.auth, s.user_id, u.notify FROM push_subs s JOIN users u ON u.id = s.user_id WHERE s.user_id = ? AND u.active = 1').all(userId);
  for (const s of subs) if (!kind || prefsOf(s.notify)[kind]) pushTo(s, msg);
  return subs.length;
}

/* wording */
const fmtPushDay = new Intl.DateTimeFormat('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtPushMonth = new Intl.DateTimeFormat('en-NZ', { month: 'long', year: 'numeric', timeZone: 'UTC' });
function pushWhen(s) {
  if (!s.date) return 'day to be set in ' + fmtPushMonth.format(new Date(s.month + '-01T00:00:00Z'));
  const first = fmtPushDay.format(new Date(s.date + 'T00:00:00Z'));
  return s.endDate ? first + ' – ' + fmtPushDay.format(new Date(s.endDate + 'T00:00:00Z')) + ', from ' + s.start : first + ', ' + s.start;
}
const kindWord = s => s.kind === 'drill' ? 'Drill' : 'Training';
const dayUrl = s => s && s.date ? '/?day=' + s.date : '/';
function listTitles(evs) { const t = evs.map(e => e.title); return t.slice(0, 3).join(', ') + (t.length > 3 ? ' and ' + (t.length - 3) + ' more' : ''); }

function changeMessage(evs) {
  if (evs.length === 1) {
    const e = evs[0];
    if (e.kind === 'cancelled' || e.kind === 'postponed') return { title: kindWord(e.before) + ' ' + e.kind, body: e.before.title + ' on ' + pushWhen(e.before) + ' has been ' + e.kind + '.', url: e.after ? dayUrl(e.after) : '/', tag: 'change-' + e.id };
    return { title: kindWord(e.after) + ' moved', body: e.after.title + ' is now ' + pushWhen(e.after) + ' (was ' + pushWhen(e.before) + ').', url: dayUrl(e.after), tag: 'change-' + e.id };
  }
  const moved = evs.filter(e => e.kind === 'moved').map(e => ({ title: e.after.title }));
  const cancelled = evs.filter(e => e.kind === 'cancelled' || e.kind === 'postponed').map(e => ({ title: e.before.title }));
  return {
    title: evs.length + ' changes to your training',
    body: [moved.length && 'Moved: ' + listTitles(moved) + '.', cancelled.length && 'Cancelled or postponed: ' + listTitles(cancelled) + '.'].filter(Boolean).join(' '),
    url: '/', tag: 'changes'
  };
}
function newMessage(fresh) {
  const first = fresh.map(e => e.after).sort((a, b) => (a.date || a.month).localeCompare(b.date || b.month))[0];
  if (fresh.length === 1) {
    return { title: 'New ' + kindWord(first).toLowerCase() + ': ' + first.title, body: pushWhen(first) + (first.location ? ' · ' + first.location : '') + (first.mandatory ? ' · Required' : ''), url: dayUrl(first), tag: 'new-' + fresh[0].id };
  }
  const sameTitle = fresh.every(e => e.after.title === first.title);
  return {
    title: fresh.length + ' new sessions added',
    body: sameTitle ? first.title + ', ' + fresh.length + ' dates from ' + pushWhen(first) + '.' : listTitles(fresh.map(e => ({ title: e.after.title }))) + '.',
    url: dayUrl(first), tag: 'new'
  };
}

/* after managers change the calendar: tell booked people about moves and cancellations, everyone about new sessions */
function announceChanges(events, actorId) {
  const perUser = new Map();
  for (const e of events) {
    if (e.kind === 'new') continue;
    for (const uid of e.booked) if (uid !== actorId) { if (!perUser.has(uid)) perUser.set(uid, []); perUser.get(uid).push(e); }
  }
  for (const [uid, evs] of perUser) notifyUser(uid, changeMessage(evs), 'changes');
  const fresh = events.filter(e => e.kind === 'new');
  if (fresh.length) {
    const msg = newMessage(fresh);
    q('SELECT id FROM users WHERE active = 1 AND id != ?').all(actorId).forEach(u => notifyUser(u.id, msg, 'new'));
  }
}

/* day-before reminders: from REMINDER_HOUR (marina time), each session tomorrow is reminded once,
   including ones added later that evening */
function marinaNow() {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: WEATHER.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  return { date: p.year + '-' + p.month + '-' + p.day, hour: +p.hour };
}
function nextDay(date) { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
function sendReminders() {
  const t = marinaNow();
  if (t.hour < REMINDER_HOUR) return;
  const day = nextDay(t.date);
  const sessions = q('SELECT id, data FROM sessions').all()
    .map(r => Object.assign({ id: r.id }, JSON.parse(r.data)))
    .filter(s => s.date === day && !s.example && s.status !== 'cancelled' && s.status !== 'postponed' && !q('SELECT 1 FROM reminded WHERE session_id = ? AND day = ?').get(s.id, day))
    .sort((a, b) => a.start.localeCompare(b.start));
  if (!sessions.length) return;
  sessions.forEach(s => q('INSERT INTO reminded (session_id, day, at) VALUES (?, ?, ?)').run(s.id, day, now()));
  const everyone = q('SELECT id FROM users WHERE active = 1').all().map(u => u.id);
  const perUser = new Map();
  for (const s of sessions) {
    const booked = new Set(q('SELECT user_id FROM signups WHERE session_id = ?').all(s.id).map(r => r.user_id));
    for (const uid of s.mandatory ? everyone : [...booked]) {
      if (!perUser.has(uid)) perUser.set(uid, []);
      perUser.get(uid).push({ s, unbooked: !booked.has(uid) });
    }
  }
  for (const [uid, items] of perUser) {
    const one = items[0].s;
    const msg = items.length === 1
      ? { title: 'Tomorrow: ' + one.title, body: one.start + '–' + one.end + (one.location ? ' · ' + one.location : '') + (items[0].unbooked ? ' · Required, and you have not booked yet' : ''), url: '/?day=' + day, tag: 'reminder-' + day }
      : { title: 'Tomorrow: ' + items.length + ' sessions', body: items.map(i => i.s.start + ' ' + i.s.title).join(' · '), url: '/?day=' + day, tag: 'reminder-' + day };
    notifyUser(uid, msg, 'reminders');
  }
}
setInterval(sendReminders, 10 * 60e3).unref();
setTimeout(sendReminders, 5000).unref();

function validSubscription(b) {
  let u;
  try { u = new URL(String(b.endpoint || '')); } catch (e) { fail(400, 'That is not a valid push subscription.'); }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.some(re => re.test(u.hostname))) fail(400, 'That push service is not supported.');
  const k = b.keys || {};
  const p256dh = Buffer.from(String(k.p256dh || ''), 'base64url'), auth = Buffer.from(String(k.auth || ''), 'base64url');
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) fail(400, 'That is not a valid push subscription.');
  return { endpoint: u.href, p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') };
}

route('GET', '/api/push/key', 'member', () => ({ key: VAPID.key }));

route('POST', '/api/push/subscribe', 'member', (req, res, body, p, me) => {
  const s = validSubscription(body);
  q(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(s.endpoint, me.id, s.p256dh, s.auth, now());
  return {};
});

route('POST', '/api/push/unsubscribe', 'member', (req, res, body, p, me) => {
  q('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(body.endpoint || ''), me.id);
  return {};
});

route('POST', '/api/push/test', 'member', (req, res, body, p, me) => {
  const devices = notifyUser(me.id, { title: 'Notifications are on', body: 'This is how training updates will look on this device.', url: '/', tag: 'test' });
  if (!devices) fail(400, 'Notifications are not turned on for any of your devices yet.');
  return { devices };
});

route('PATCH', '/api/me/notify', 'member', (req, res, body, p, me) => {
  const prefs = {};
  NOTIFY_KINDS.forEach(k => { prefs[k] = body[k] !== false; });
  q('UPDATE users SET notify = ? WHERE id = ?').run(JSON.stringify(prefs), me.id);
  return { notify: prefs };
});

/* everyone signed in: their own account */
route('PATCH', '/api/me', 'member', (req, res, body, p, me) => {
  q('UPDATE users SET name = ? WHERE id = ?').run(cleanName(body.name), me.id);
  changed();
  return {};
});

route('POST', '/api/me/password', 'member', (req, res, body, p, me) => {
  const u = q('SELECT pass FROM users WHERE id = ?').get(me.id);
  if (typeof body.current !== 'string' || !checkPassword(body.current, u.pass)) fail(400, 'Your current password is not right.');
  const pass = validPassword(body.password);
  /* sign out every other device, keep this one */
  const t = parseCookies(req).dt_login;
  tx(() => {
    q('UPDATE users SET pass = ? WHERE id = ?').run(hashPassword(pass), me.id);
    q('DELETE FROM logins WHERE user_id = ? AND token != ?').run(me.id, sha(t));
  });
  return {};
});

/* managers: training and drill types */
function cleanType(body) {
  const name = str(body.name, 80);
  if (!name) fail(400, 'Give the type a name.');
  if (!RE_COLOR.test(body.color || '')) fail(400, 'Pick a colour.');
  const expiry = parseInt(body.expiry, 10) || 0;
  return { name, color: body.color.toUpperCase(), drill: body.drill === true ? 1 : 0, expiry: EXPIRY_MONTHS.includes(expiry) ? expiry : 0, supplier: str(body.supplier, 120) };
}
route('POST', '/api/types', 'manager', (req, res, body) => {
  const t = cleanType(body);
  const base = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'type';
  let id = base, n = 2;
  while (q('SELECT 1 FROM types WHERE id = ?').get(id)) id = base + '-' + n++;
  q('INSERT INTO types (id, name, color, drill, expiry, supplier, sort) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM types))').run(id, t.name, t.color, t.drill, t.expiry, t.supplier);
  changed();
  return { id };
});
route('PATCH', '/api/types/:id', 'manager', (req, res, body, p) => {
  const t = cleanType(body);
  if (!q('SELECT 1 FROM types WHERE id = ?').get(p.id)) fail(404, 'That type no longer exists.');
  tx(() => {
    q('UPDATE types SET name = ?, color = ?, drill = ?, expiry = ?, supplier = ? WHERE id = ?').run(t.name, t.color, t.drill, t.expiry, t.supplier, p.id);
    /* sessions of this type follow its drill setting */
    q('SELECT id, data FROM sessions').all().forEach(r => {
      const s = JSON.parse(r.data);
      if (s.category === p.id && (s.kind === 'drill') !== !!t.drill) { s.kind = t.drill ? 'drill' : 'training'; q('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(s), r.id); }
    });
  });
  changed();
  return {};
});
route('DELETE', '/api/types/:id', 'manager', (req, res, body, p) => {
  if (p.id === 'other') fail(400, '“Other” is kept for sessions that do not fit a type.');
  const used = q('SELECT data FROM sessions').all().filter(r => JSON.parse(r.data).category === p.id).length;
  if (used) fail(409, used + (used === 1 ? ' session uses' : ' sessions use') + ' this type. Change them to another type first.');
  q('DELETE FROM types WHERE id = ?').run(p.id);
  changed();
  return {};
});

/* managers: people */
route('POST', '/api/users', 'manager', (req, res, body) => {
  const name = cleanName(body.name), email = cleanEmail(body.email), pass = validPassword(body.password);
  const role = body.role === 'staff' ? 'staff' : 'manager';
  tx(() => {
    const existing = q('SELECT id, active FROM users WHERE email = ?').get(email);
    if (existing && existing.active) fail(409, 'That email already has an account.');
    if (existing) q('UPDATE users SET name = ?, role = ?, pass = ?, active = 1 WHERE id = ?').run(name, role, hashPassword(pass), existing.id);
    else q('INSERT INTO users (id, name, email, role, pass, created) VALUES (?, ?, ?, ?, ?, ?)').run(newId(), name, email, role, hashPassword(pass), now());
    q("DELETE FROM links WHERE kind = 'invite' AND email = ?").run(email);
  });
  changed();
  return {};
});

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
    q('DELETE FROM push_subs WHERE user_id = ?').run(p.id);
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
  server.listen(PORT, () => console.log('Dockside Training' + (DEV ? ' (development)' : '') + ' on http://localhost:' + PORT + ' (data in ' + DATA_DIR + ')'));
  const stop = () => { server.close(); db.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
module.exports = { server, encryptPush, vapidAuth, VAPID, sendReminders };
