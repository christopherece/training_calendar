/* Dockside Training: staff training calendar, talking to server.js.
   Managers plan, edit and reschedule; admins also run Settings; staff book places. The server decides who may change what. */

/* training and drill types come from the server (Settings → Training types), each with its spreadsheet colour */
var TYPES = [], TYPE = {};
var OTHER = { id: 'other', name: 'Other', color: '#C9CED6', drill: false };
function setTypes(list) {
  TYPES = (list || []).filter(function (t) { return t && typeof t.id === 'string' && /^#[0-9A-F]{6}$/i.test(t.color || ''); })
    .map(function (t) { return { id: t.id, name: String(t.name).slice(0, 80), color: t.color, drill: t.drill === true, expiry: EXPIRY_MONTHS.indexOf(t.expiry) >= 0 ? t.expiry : 0, supplier: typeof t.supplier === 'string' ? t.supplier.slice(0, 120) : '' }; });
  TYPE = {};
  TYPES.forEach(function (t) { TYPE[t.id] = t; });
}
function catOf(id) { return TYPE[id] || TYPE.other || OTHER; }
function catVar(s) { return catOf(s.category).color; }
/* black or white text, whichever reads better on the type's colour */
function inkOn(hex) {
  var n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.18 ? '#111111' : '#FFFFFF';
}
function catStyle(s) { var c = catVar(s); return { '--cat': c, '--cat-ink': inkOn(c) }; }

var RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
var RE_MONTH = /^\d{4}-\d{2}$/;
var RE_TIME = /^\d{2}:\d{2}$/;
var RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var STATUSES = ['going', 'attended', 'absent'];
var ROLES = [['admin', 'Admin'], ['manager', 'Manager'], ['staff', 'Staff']];
var ROLE_ABOUT = {
  admin: 'Admin: can change Settings (training types and the team), and add, edit and move training.',
  manager: 'Manager: can add, edit and move training, and see reports.',
  staff: 'Staff: can view the calendar and book places.'
};
function roleSelect(props, value) { return h('select', props, ROLES.map(function (r) { return h('option', { value: r[0], selected: r[0] === value }, r[1]); })); }
function roleWord(role) { return role === 'admin' ? 'an admin' : role === 'manager' ? 'a manager' : 'staff'; }

/* choices from the marina's training spreadsheet */
var DURATIONS = ['1 hour', '2 hours', '3 hours', '1/2 Day', '1 Day', '2 Days', '3 Days', '4 Days', '5 Days', '1 Week', '2 Weeks'];
var SESSION_STATUS = [
  ['planning', 'In planning'], ['vendor', 'With vendor'], ['in-progress', 'In progress'], ['booked', 'Booked'],
  ['on-hold', 'On hold'], ['postponed', 'Postponed'], ['cancelled', 'Cancelled'], ['complete', 'Complete']
];
var SETTINGS = [['classroom', 'Classroom'], ['practical', 'Practical'], ['mixed', 'Mixed'], ['debrief', 'Debrief'], ['na', 'N/A']];
var EXPIRY_MONTHS = [0, 3, 6, 12, 24, 36, 48, 60];
function labelOf(pairs, v) { var p = pairs.filter(function (x) { return x[0] === v; })[0]; return p ? p[1] : ''; }
function expiryText(m) { return !m ? 'No expiry' : m < 12 ? m + ' months' : m === 12 ? '1 year' : (m / 12) + ' years'; }
function isOff(s) { return s.status === 'cancelled' || s.status === 'postponed'; }
/* New Zealand financial year, 1 July to 30 June */
function finYear(date) { var y = +date.slice(0, 4), start = +date.slice(5, 7) >= 7 ? y : y - 1; return start + '/' + String(start + 1).slice(2); }

/* ---------- dates ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function fromYmd(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2] || 1); }
function todayYmd() { return ymd(new Date()); }
function addDays(s, n) { var d = fromYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function atMs(date, time) {
  var p = date.split('-').map(Number), t = time.split(':').map(Number);
  return new Date(p[0], p[1] - 1, p[2], t[0], t[1]).getTime();
}
function startMs(s) { return atMs(s.date, s.start); }
function lastDay(s) { return s.endDate || s.date; }
function endMs(s) { return atMs(lastDay(s), s.end); }
/* every day a session covers (courses can run several days) */
function daysOf(s) { var out = [s.date]; for (var d = s.date; d < lastDay(s) && out.length < 32;) { d = addDays(d, 1); out.push(d); } return out; }
function byStart(a, b) { return startMs(a) - startMs(b) || a.title.localeCompare(b.title); }
function toMin(t) { var p = t.split(':'); return +p[0] * 60 + +p[1]; }
function toTime(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
function dayDiff(a, b) { return Math.round((fromYmd(b) - fromYmd(a)) / 864e5); }
function mondayOf(key) { return addDays(key, -((fromYmd(key).getDay() + 6) % 7)); }
function monthKey(y, m) { return y + '-' + pad(m + 1); }
var fmtDay = new Intl.DateTimeFormat('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
var fmtLong = new Intl.DateTimeFormat('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' });
var fmtMonth = new Intl.DateTimeFormat('en-NZ', { month: 'long', year: 'numeric' });
var fmtWd = new Intl.DateTimeFormat('en-NZ', { weekday: 'short' });
var fmtDM = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short' });
var fmtDMY = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
function monthName(key) { return fmtMonth.format(fromYmd(key + '-01')); }

/* ---------- state ---------- */
var VIEWS = ['month', 'week', 'agenda', 'mine', 'reports', 'settings'];
function savedView() {
  try { var v = localStorage.getItem('dockside-view'); return VIEWS.indexOf(v) >= 0 ? v : 'month'; } catch (e) { return 'month'; }
}
function setView(v) {
  state.view = v;
  try { localStorage.setItem('dockside-view', v); } catch (e) { /* per-viewer nicety only */ }
  render();
}

var now0 = new Date();
var state = {
  auth: 'loading',  /* loading | setup | signedOut | link | badLink | public (read-only, not signed in) | in */
  publicRead: false,
  counts: {},       /* places taken per session, for visitors who cannot see names */
  weather: null,
  weatherError: '',
  push: null,       /* this device's notification status, from refreshPushState() */
  keyOpen: false,   /* colour key and type filter open */
  detailId: null,   /* the session shown in the details window, if open */
  authNote: '',
  link: null,       /* { token, kind: 'invite'|'reset', email, name } from an invite or reset link */
  events: null,
  view: savedView(),
  drag: null,
  renderPending: false,
  month: { y: now0.getFullYear(), m: now0.getMonth() },
  selected: todayYmd(),
  filter: new Set(),
  expanded: new Set(),
  confirmDelete: null,
  confirmRemove: null,
  showPast: false,
  reportYear: null, /* financial year on the Reports tab, '' for all years; null until first shown */
  sessions: [],   /* sessions with a day */
  plans: [],      /* sessions planned for a month, day not set yet */
  signups: [],
  bySession: new Map(),
  users: {},
  invites: [],
  loaded: { sessions: false, signups: false },
  error: '',
  me: { id: null, name: '', email: '', role: 'staff', admin: false },
  lastFocus: null
};

/* ---------- tiny DOM helper (user text only ever goes through text nodes) ---------- */
function h(tag, props) {
  var el = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'style') Object.keys(v).forEach(function (p) { el.style.setProperty(p, v[p]); });
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
  }
  var kids = Array.prototype.slice.call(arguments, 2);
  (function add(list) {
    list.forEach(function (kid) {
      if (kid == null || kid === false) return;
      if (Array.isArray(kid)) { add(kid); return; }
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    });
  })(kids);
  return el;
}
function $(id) { return document.getElementById(id); }

/* ---------- server calls ---------- */
async function api(method, url, body) {
  var opts = { method: method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
  var res;
  try { res = await fetch(url, opts); } catch (e) { throw new Error('No connection to the calendar server. Check your network and try again.'); }
  if (method === 'GET' && (url === '/api/data' || url === '/api/public')) {
    state.offline = res.headers.get('X-Offline') === '1';
    state.savedAt = +res.headers.get('X-Saved-At') || 0;
  }
  var data = null;
  try { data = await res.json(); } catch (e) { /* empty or not JSON */ }
  if (data && data.build && res.headers.get('X-Offline') !== '1') checkBuild(data.build);
  if (res.status === 401 && state.auth === 'in') signedOutBy('Your sign-in has ended. Sign in again.');
  if (!res.ok) { var err = new Error((data && data.error) || 'Something went wrong. Try again.'); err.status = res.status; throw err; }
  return data || {};
}
/* the calendar was updated while this page was open: load the new code, waiting for any open window to close first */
var pageBuild = null, reloadPending = false;
function checkBuild(build) {
  if (!pageBuild) { pageBuild = build; return; }
  if (build === pageBuild || reloadPending) return;
  reloadPending = true;
  if (!$('modal-root').firstChild) location.reload();
}
function newId() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-z0-9]/gi, '').slice(0, 24); }
/* several calendar changes that must land together: [{op: 'set'|'update'|'delete', path: 'sessions/ID', data}] */
function batchWrite(ops) { return api('POST', '/api/batch', { ops: ops }); }

/* ---------- data cleaning (shared data is untrusted) ---------- */
function str(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }
function cleanSession(id, d) {
  if (!d || typeof d.title !== 'string') return null;
  var dated = RE_DATE.test(d.date || ''), month = RE_MONTH.test(d.month || '') ? d.month : '';
  if (!dated && !month) return null;
  var start = RE_TIME.test(d.start || '') ? d.start : '09:00';
  var end = RE_TIME.test(d.end || '') ? d.end : start;
  var endDate = dated && RE_DATE.test(d.endDate || '') && d.endDate > d.date ? d.endDate : '';
  return {
    id: id, title: d.title.slice(0, 120), category: TYPE[d.category] ? d.category : 'other',
    kind: d.kind === 'drill' ? 'drill' : 'training',
    date: dated ? d.date : '', endDate: endDate, month: dated ? '' : month, unscheduled: !dated,
    start: start, end: end,
    status: labelOf(SESSION_STATUS, d.status) ? d.status : 'planning',
    duration: DURATIONS.indexOf(d.duration) >= 0 ? d.duration : '',
    setting: labelOf(SETTINGS, d.setting) ? d.setting : '',
    provider: d.provider === 'inhouse' || d.provider === 'external' ? d.provider : '',
    location: str(d.location, 120), trainer: str(d.trainer, 80), notes: str(d.notes, 600),
    capacity: Math.max(0, Math.min(500, parseInt(d.capacity, 10) || 0)),
    mandatory: d.mandatory === true, example: d.example === true,
    seriesId: str(d.seriesId, 60),
    movedFrom: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.movedFrom || '') ? d.movedFrom : ''
  };
}
function cleanSignup(id, d) {
  if (!d) return null;
  var sid = str(d.sessionId, 200), uid = str(d.uid, 200);
  if (!sid || !uid) return null;
  return { id: id, sessionId: sid, uid: uid, status: STATUSES.indexOf(d.status) >= 0 ? d.status : 'going' };
}
function cleanUser(d) {
  return { id: str(d.id, 64), name: str(d.name, 80), email: str(d.email, 200), role: labelOf(ROLES, d.role) ? d.role : 'staff', active: d.active !== false };
}
function index() {
  state.bySession = new Map();
  state.signups.forEach(function (x) {
    if (!state.bySession.has(x.sessionId)) state.bySession.set(x.sessionId, []);
    state.bySession.get(x.sessionId).push(x);
  });
}
function signupsOf(s) { return state.bySession.get(s.id) || []; }
function inFilter(s) { return state.filter.size === 0 || state.filter.has(s.category); }
function visible() { return state.sessions.filter(inFilter); }
function groupByDate(list) {
  var m = Object.create(null);
  list.slice().sort(byStart).forEach(function (s) { daysOf(s).forEach(function (d) { (m[d] = m[d] || []).push(s); }); });
  return m;
}
function dateRange(s) {
  return s.endDate ? fmtDay.format(fromYmd(s.date)) + ' – ' + fmtDay.format(fromYmd(s.endDate)) : fmtDay.format(fromYmd(s.date));
}
function nameOf(uid) {
  if (uid === state.me.id) return state.me.name || 'You';
  return (state.users[uid] && state.users[uid].name) || 'Former staff member';
}
/* isAdmin: can change the calendar (managers and admins). canSettings: the admin role alone */
function isAdmin() { return state.auth === 'in' && state.me.admin; }
function canSettings() { return state.auth === 'in' && state.me.role === 'admin'; }
function whenOf(s) { return s.unscheduled ? 'Day to be set, ' + monthName(s.month) : dateRange(s) + ', ' + s.start; }

/* ---------- toast ---------- */
var toastTimer;
function toast(msg, action) {
  var el = $('toast');
  el.replaceChildren(h('span', null, msg));
  if (action) {
    el.append(h('button', {
      class: 'toast-act', type: 'button',
      onclick: function () { el.classList.remove('show'); action.fn(); }
    }, action.label));
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, action ? 9000 : 4200);
}

/* ---------- render scheduling ---------- */
var raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(function () { raf = 0; render(); });
}
function render() {
  /* never rebuild the DOM under a pointer that is holding a session */
  if (state.drag) { state.renderPending = true; return; }
  state.renderPending = false;
  var active = document.activeElement;
  var fk = active && active.dataset ? active.dataset.fk : null;
  /* live updates redraw the page; keep whatever someone is typing into a form on it */
  var typed = {};
  $('view').querySelectorAll('input[id], textarea[id], select[id]').forEach(function (el) { if (el.type !== 'checkbox') typed[el.id] = el.value; });
  var focusId = active && active.id && active.closest && active.closest('#view') ? active.id : null;
  renderWho();
  renderBottomNav();
  if (state.auth !== 'in' && state.auth !== 'public') {
    $('bar').replaceChildren();
    $('filters').hidden = true;
    $('view').replaceChildren(authView());
  } else {
    index();
    if (state.auth === 'public' && (state.view === 'mine' || state.view === 'settings')) state.view = 'month';
    if (state.view === 'reports' && !isAdmin()) state.view = 'month';
    if (state.view === 'settings' && !canSettings()) state.view = state.auth === 'in' ? 'mine' : 'month';
    renderBar(); renderFilters();
    var v = state.view;
    var calendar = v === 'month' || v === 'week' || v === 'agenda';
    $('view').replaceChildren(calendar ? weatherStrip() || '' : '',
      v === 'agenda' ? agendaView() : v === 'mine' ? mineView() : v === 'week' ? weekView() : v === 'settings' ? settingsView() : v === 'reports' ? reportsView() : monthView());
  }
  Object.keys(typed).forEach(function (id) {
    var el = document.getElementById(id);
    if (el && $('view').contains(el)) el.value = typed[id];
  });
  refreshDetails();
  if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus({ preventScroll: true });
  else if (fk) {
    /* with a window open, focus stays inside it rather than jumping to the same button behind it */
    var scope = $('modal-root').firstChild ? $('modal-root') : document;
    var el = Array.prototype.find.call(scope.querySelectorAll('[data-fk]'), function (e) { return e.dataset.fk === fk; });
    if (el) el.focus({ preventScroll: true });
  }
}

/* ---------- header, tabs, filters ---------- */
function renderWho() {
  var kids = [];
  if (state.auth === 'in') {
    kids.push(h('span', { class: 'who-name' }, state.me.name || state.me.email));
    kids.push(h('span', { class: 'tag tag-accent' }, labelOf(ROLES, state.me.role)));
    kids.push(h('button', { class: 'btn', type: 'button', 'data-fk': 'signout', onclick: doSignOut }, 'Sign out'));
  } else if (state.auth === 'public') {
    kids.push(h('span', { class: 'tag' }, 'View only'));
    kids.push(h('button', { class: 'btn', type: 'button', 'data-fk': 'signin', onclick: function () { state.auth = 'signedOut'; state.authNote = ''; render(); } }, 'Sign in'));
  }
  $('who').replaceChildren.apply($('who'), kids);
}

function viewTabs() {
  var tabs = [['month', 'Month'], ['week', 'Week'], ['agenda', 'Agenda']];
  if (state.auth === 'in') tabs.push(['mine', 'My training']);
  if (isAdmin()) tabs.push(['reports', 'Reports']);
  if (canSettings()) tabs.push(['settings', 'Settings']);
  return tabs;
}

/* phones: app-style tab bar along the bottom */
var NAV_ICONS = {
  month: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  week: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 5v15M12 5v15M16 5v15"/></svg>',
  agenda: '<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
  mine: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg>',
  reports: '<svg viewBox="0 0 24 24"><path d="M3.5 20.5h17M6.5 20.5V13M11 20.5V6M15.5 20.5v-9M20 20.5V9"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>'
};
function renderBottomNav() {
  var nav = $('bottom-nav'), on = state.auth === 'in' || state.auth === 'public';
  nav.hidden = !on;
  if (!on) { nav.replaceChildren(); return; }
  nav.replaceChildren.apply(nav, viewTabs().map(function (t) {
    var icon = h('span', { class: 'bn-ic', 'aria-hidden': 'true' });
    icon.innerHTML = NAV_ICONS[t[0]];   /* fixed artwork above, never user text */
    return h('button', {
      class: 'bn-item', type: 'button', 'aria-current': state.view === t[0] ? 'page' : null, 'data-fk': 'bn-' + t[0],
      onclick: function () { setView(t[0]); window.scrollTo(0, 0); }
    }, icon, h('span', { class: 'bn-l' }, t[1]));
  }));
}

function renderBar() {
  var tabs = viewTabs();
  var left = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Calendar views' },
    tabs.map(function (t) {
      return h('button', {
        class: 'tab', role: 'tab', 'aria-selected': String(state.view === t[0]), 'data-fk': 'tab-' + t[0],
        onclick: function () { setView(t[0]); }
      }, t[1]);
    }));
  var right = h('div', { class: 'actions' });
  if (isAdmin()) {
    right.append(
      h('button', { class: 'btn primary', 'data-fk': 'add', onclick: function () { openForm(null); } }, 'Add training or drill'),
      h('button', { class: 'btn', 'data-fk': 'csv', onclick: exportCsv }, 'Download attendance')
    );
  }
  $('bar').replaceChildren(left, right);
}

function renderFilters() {
  var box = $('filters');
  box.hidden = state.view === 'mine' || state.view === 'settings';
  /* the filter doubles as the colour key, like the legend in the training spreadsheet */
  var row = h('div', { class: 'filter-row' },
    h('button', {
      class: 'fchip', 'aria-pressed': String(state.filter.size === 0), 'data-fk': 'f-all',
      onclick: function () { state.filter.clear(); render(); }
    }, 'All types'),
    h('button', {
      class: 'fchip key-toggle', 'aria-expanded': String(state.keyOpen), 'aria-controls': 'type-key', 'data-fk': 'f-key',
      onclick: function () { state.keyOpen = !state.keyOpen; render(); }
    }, 'Filter training ' + (state.keyOpen ? '▴' : '▾')),
    Array.from(state.filter).filter(function (id) { return TYPE[id]; }).map(function (id) {
      var t = TYPE[id];
      return h('button', {
        class: 'fchip picked', 'data-fk': 'fx-' + id, 'aria-label': 'Stop showing only ' + t.name, style: catStyle({ category: id }),
        onclick: function () { state.filter.delete(id); render(); }
      }, t.name, h('span', { 'aria-hidden': 'true' }, ' ×'));
    }));
  var kids = [row];
  if (state.keyOpen) {
    kids.push(h('div', { class: 'type-key', id: 'type-key', role: 'group', 'aria-label': 'Show only these types' },
      TYPES.map(function (t) {
        return h('button', {
          class: 'key-item', 'aria-pressed': String(state.filter.has(t.id)), 'data-fk': 'f-' + t.id, style: catStyle({ category: t.id }),
          onclick: function () {
            if (state.filter.has(t.id)) state.filter.delete(t.id); else state.filter.add(t.id);
            render();
          }
        }, t.name);
      })));
  }
  box.replaceChildren.apply(box, kids);
}

/* ---------- notices ---------- */
function notices() {
  var out = [];
  var admin = isAdmin();
  if (state.offline) {
    out.push(h('div', { class: 'note offline' }, '📴 You’re offline. Showing the calendar as it was' +
      (state.savedAt ? ' at ' + new Date(state.savedAt).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' }) : '') + '. Changes need a connection.'));
  }
  if (state.error && !state.offline) {
    out.push(h('div', { class: 'note' }, state.error));
  } else if (!(state.loaded.sessions && state.loaded.signups)) {
    out.push(h('div', { class: 'note muted' }, 'Loading sessions…'));
  } else if (!state.sessions.length && !state.plans.length) {
    out.push(h('div', { class: 'empty' },
      h('h3', null, 'Nothing planned yet'),
      h('p', { class: 'muted' }, admin
        ? 'Add the first training or drill, or load a few examples to see how planning, bookings and attendance work. Examples can be removed in one click.'
        : 'Training and drills will show up here as soon as a manager adds them.'),
      admin && h('div', { class: 'actions' },
        h('button', { class: 'btn primary', 'data-fk': 'add-empty', onclick: function () { openForm(null); } }, 'Add training or drill'),
        h('button', { class: 'btn', 'data-fk': 'add-examples', onclick: addExamples }, 'Load examples'))));
  }
  if (state.sessions.concat(state.plans).some(function (s) { return s.example; })) {
    out.push(h('div', { class: 'note' },
      h('span', null, 'Example sessions are showing.'),
      admin && h('button', { class: 'btn small', 'data-fk': 'rm-examples', onclick: removeExamples }, 'Remove examples')));
  }
  return out;
}

/* ---------- month view ---------- */
function chip(s, day) {
  /* a multi-day course shows its start time on the first day and a continuation mark after */
  var cont = day && day !== s.date;
  var el = chipEl(s, cont);
  el.addEventListener('click', function (e) { e.stopPropagation(); state.selected = day || s.date; render(); openDetails(s); });
  return el;
}
function chipEl(s, cont) {
  return h('span', { class: 'chip' + (isOff(s) ? ' off' : ''), style: catStyle(s), title: s.title + (s.endDate ? ' · ' + dateRange(s) : '') + (isOff(s) ? ' · ' + labelOf(SESSION_STATUS, s.status) : '') },
    h('span', { class: 'tm' }, cont ? '↳' : s.start),
    h('span', { class: 't' }, s.title),
    s.kind === 'drill' && h('span', { class: 'chip-drill' }, 'DRILL'),
    s.mandatory && h('span', { class: 'chip-req' }, 'REQ'));
}
function shiftMonth(n) {
  var d = new Date(state.month.y, state.month.m + n, 1);
  state.month = { y: d.getFullYear(), m: d.getMonth() };
  var sd = fromYmd(state.selected);
  if (sd.getFullYear() !== d.getFullYear() || sd.getMonth() !== d.getMonth()) {
    var t = new Date();
    state.selected = (t.getFullYear() === d.getFullYear() && t.getMonth() === d.getMonth()) ? todayYmd() : ymd(d);
  }
  render();
}
function goToday() {
  var t = new Date();
  state.month = { y: t.getFullYear(), m: t.getMonth() };
  state.selected = todayYmd();
  render();
}
function selectDay(key) {
  var d = fromYmd(key);
  state.selected = key;
  state.month = { y: d.getFullYear(), m: d.getMonth() };
  render();
}

function planRow(p) {
  var admin = isAdmin();
  var row = h('div', { class: 'plan-row', style: catStyle(p) },
    p.kind === 'drill' && h('span', { class: 'tag tag-drill' }, 'Drill'),
    h('span', { class: 't' }, p.title),
    h('span', { class: 'mono muted' }, p.start + '–' + p.end),
    admin && h('button', { class: 'btn small', type: 'button', 'data-fk': 'pd-' + p.id, onclick: function () { openMoveForm(p); } }, 'Set date'),
    admin && h('button', { class: 'btn quiet small', type: 'button', 'data-fk': 'pe-' + p.id, onclick: function () { openForm(p); } }, 'Edit'));
  row.addEventListener('click', function (e) { if (!e.target.closest('button')) openDetails(p); });
  return makeDraggable(row, p, 'month');
}

function plansPanel(key) {
  var list = state.plans.filter(function (p) { return p.month === key && inFilter(p); })
    .sort(function (a, b) { return a.title.localeCompare(b.title); });
  if (!list.length) return null;
  return h('section', { class: 'plans', 'aria-label': 'Planned for this month, day not set yet' },
    h('h3', null, 'Still to schedule in ' + monthName(key)),
    h('p', { class: 'hint-line' }, isAdmin()
      ? 'Drag one onto a day, or use Set date.'
      : 'Planned for this month. A manager will set the day.'),
    list.map(planRow));
}

function monthView() {
  var y = state.month.y, m = state.month.m;
  var first = new Date(y, m, 1);
  var off = (first.getDay() + 6) % 7;
  var dim = new Date(y, m + 1, 0).getDate();
  var rows = Math.ceil((off + dim) / 7);
  var by = groupByDate(visible());
  var today = todayYmd();

  function nav(label, aria, fn, fk) {
    return h('button', { class: 'btn small', 'aria-label': aria, 'data-fk': fk, onclick: fn }, label);
  }
  var head = h('div', { class: 'cal-head' },
    h('h2', { class: 'month-label' }, fmtMonth.format(first)),
    h('div', { class: 'cal-nav' },
      nav('←', 'Previous month', function () { shiftMonth(-1); }, 'prev'),
      nav('Today', 'Go to today', goToday, 'today'),
      nav('→', 'Next month', function () { shiftMonth(1); }, 'next')));
  var dow = h('div', { class: 'dow', 'aria-hidden': 'true' },
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) { return h('span', null, d); }));
  var grid = h('div', { class: 'grid' });
  for (var i = 0; i < rows * 7; i++) {
    (function (i) {
      var d = new Date(y, m, 1 - off + i), key = ymd(d), list = by[key] || [];
      var cell = h('button', {
        class: 'cell' + (d.getMonth() === m ? '' : ' out') + (key === today ? ' today' : '') + (key === state.selected ? ' sel' : ''),
        'aria-label': fmtDay.format(d) + ', ' + list.length + (list.length === 1 ? ' session' : ' sessions'),
        'aria-pressed': String(key === state.selected), 'data-fk': 'd-' + key, 'data-day': key,
        onclick: function () {
          selectDay(key);
          /* on a phone the day's details sit under the grid; bring them into view */
          var sh = $('day-sheet');
          if (narrowQuery.matches && list.length && sh) sh.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      cell.append(h('span', { class: 'num' }, String(d.getDate())));
      var chips = h('div', { class: 'chips' });
      list.slice(0, 4).forEach(function (s) { chips.append(makeDraggable(chip(s, key), s, 'month', key)); });
      if (list.length > 4) chips.append(h('span', { class: 'more' }, '+' + (list.length - 4) + ' more'));
      var dots = h('div', { class: 'dots', 'aria-hidden': 'true' });
      list.slice(0, 6).forEach(function (s) { dots.append(h('span', { class: 'dot', style: catStyle(s) })); });
      cell.append(chips, dots);
      grid.append(cell);
    })(i);
  }

  return h('div', null, notices(), plansPanel(monthKey(y, m)),
    h('div', { class: 'cal-layout' }, h('section', null, head, dow, grid), h('div', { class: 'side' }, weatherCard(), duePanel(), daySheet(state.selected))));
}

function daySheet(sel) {
  var list = groupByDate(visible())[sel] || [];
  var admin = isAdmin();
  var sheet = h('aside', { class: 'sheet', id: 'day-sheet', 'aria-label': 'Sessions on the selected day' });
  sheet.append(h('div', { class: 'sheet-head' },
    h('h3', { class: 'sheet-title' }, fmtLong.format(fromYmd(sel))),
    sel === todayYmd() && h('span', { class: 'tag tag-accent' }, 'Today')));
  if (!list.length) {
    sheet.append(h('p', { class: 'muted' }, 'Nothing on this day.'));
    if (admin) {
      sheet.append(h('button', { class: 'btn', 'data-fk': 'add-day', onclick: function () { openForm(null, { date: sel }); } }, 'Add something here'));
    }
  } else {
    list.forEach(function (s) { sheet.append(sessionCard(s, { showDate: false })); });
  }
  if (admin && state.view === 'month' && state.sessions.some(canMove)) {
    sheet.append(h('p', { class: 'hint-line' }, narrowQuery.matches
      ? 'To change a session’s day or time, tap Move on it.'
      : 'Drag a session onto another day to move it, or use Move. Hold Alt or Ctrl as you drop to copy it instead.'));
  }
  if (admin && list.some(function (s) { return !s.unscheduled && endMs(s) < Date.now(); })) {
    sheet.append(h('p', { class: 'hint-line' }, 'Finished sessions can’t be moved. Use Edit to change their date.'));
  }
  return sheet;
}

/* ---------- today's weather (beside the calendar) ---------- */
/* WMO weather codes as Open-Meteo reports them: [words, daytime icon, night icon] */
var WMO = {
  0: ['Clear', '☀️', '🌙'], 1: ['Mostly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'], 56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '🌨️'], 77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '⛈️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '🌨️'],
  95: ['Thunderstorms', '⛈️'], 96: ['Thunderstorms with hail', '⛈️'], 99: ['Thunderstorms with hail', '⛈️']
};
var STRONG_GUST_KN = 25;
function wx(code, day) { var w = WMO[code] || ['Weather', '🌡️']; return { text: w[0], icon: day === 0 && w[2] ? w[2] : w[1] }; }
function compass(deg) { return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16]; }
/* the arrow points where the wind is blowing to; the letters say where it comes from */
function windArrow(deg) { return h('span', { class: 'wx-arrow', 'aria-hidden': 'true', style: { transform: 'rotate(' + Math.round(deg + 180) + 'deg)' } }, '↑'); }

async function loadWeather() {
  try { state.weather = await api('GET', '/api/weather'); state.weatherError = ''; state.weatherAt = Date.now(); }
  catch (e) { state.weatherError = 'The forecast is not available right now.'; }
  scheduleRender();
}
setInterval(function () { if (state.auth === 'in' || state.auth === 'public') loadWeather(); }, 15 * 60e3);

function weatherCard() {
  var w = state.weather;
  var card = h('section', { class: 'wx', 'aria-label': 'Today’s weather' });
  if (!w) {
    card.append(h('h3', { class: 'wx-title' }, 'Today’s weather'), h('p', { class: 'muted', style: { margin: 0 } }, state.weatherError || 'Loading the forecast…'));
    return card;
  }
  var c = w.current, t = w.today, now = wx(c.code, c.day);
  function fact(label, value, extra) { return h('span', { class: 'wx-fact' }, h('span', { class: 'wx-fact-l' }, label), ' ', extra, h('b', null, value)); }
  var hours = w.hours.slice(0, 6);
  /* compact: one headline line, one line of facts, the next hours; through h() so missing parts are skipped */
  card = h('section', { class: 'wx', 'aria-label': 'Today’s weather' },
    h('div', { class: 'wx-head' },
      h('h3', { class: 'wx-title' }, 'Today at ' + w.place),
      h('span', { class: 'wx-upd' }, (w.stale ? 'Last known, ' : 'Updated ') + w.updated.slice(11, 16))),
    h('div', { class: 'wx-now' },
      h('span', { class: 'wx-icon', 'aria-hidden': 'true' }, now.icon),
      h('span', { class: 'wx-temp' }, Math.round(c.temp) + '°'),
      h('span', { class: 'wx-cond' }, now.text, h('br'), 'Feels like ' + Math.round(c.feels) + '° · ' + Math.round(t.max) + '° / ' + Math.round(t.min) + '°')),
    t.gustMax >= STRONG_GUST_KN && h('p', { class: 'wx-warn' },
      '⚠ Gusts up to ' + Math.round(t.gustMax) + ' kn today. Check conditions before on-water training and drills.'),
    h('p', { class: 'wx-facts' },
      fact('Wind', Math.round(c.wind) + ' kn ' + compass(c.dir), windArrow(c.dir)),
      fact('Gusts', Math.round(c.gust) + ' kn'),
      fact('Rain', Math.round(t.rain) + '%')),
    hours.length > 0 && h('ol', { class: 'wx-hours', 'aria-label': 'Next hours' }, hours.map(function (x) {
      var hw = wx(x.code, x.day);
      return h('li', { 'aria-label': x.time + ', ' + hw.text + ', ' + Math.round(x.temp) + ' degrees, wind ' + Math.round(x.wind) + ' knots ' + compass(x.dir) },
        h('span', { class: 'wx-h-time' }, x.time),
        h('span', { class: 'wx-h-icon', 'aria-hidden': 'true' }, hw.icon),
        h('span', { class: 'wx-h-temp' }, Math.round(x.temp) + '°'),
        h('span', { class: 'wx-h-wind' }, windArrow(x.dir), Math.round(x.wind)));
    })),
    h('p', { class: 'wx-src' }, 'Sunrise ' + t.sunrise + ' · sunset ' + t.sunset + ' · UV ' + Math.round(t.uv) + ' · knots · ',
      h('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener' }, 'Open-Meteo')));
  return card;
}

/* ---------- coming due (managers): types that must be redone, from their expiry ---------- */
function addMonths(date, n) { var d = fromYmd(date), day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return ymd(d); }
function dueList() {
  var today = todayYmd(), soon = addDays(today, 30), nowT = Date.now(), out = [], never = [];
  TYPES.forEach(function (t) {
    if (!t.expiry) return;
    var mine = state.sessions.filter(function (s) { return s.category === t.id && !isOff(s); });
    var done = mine.filter(function (s) { return endMs(s) < nowT; }).map(lastDay).sort();
    var next = mine.filter(function (s) { return endMs(s) >= nowT; }).map(function (s) { return s.date; }).sort()[0];
    var planned = state.plans.filter(function (p) { return p.category === t.id && !isOff(p); }).map(function (p) { return p.month; }).sort()[0];
    if (!done.length) { if (!next && !planned) never.push(t); return; }
    var last = done[done.length - 1], due = addMonths(last, t.expiry);
    var covered = (next && next <= due) || (planned && planned <= due.slice(0, 7));
    if (covered || due > soon) return;
    out.push({ t: t, last: last, due: due, overdue: due < today });
  });
  out.sort(function (a, b) { return a.due.localeCompare(b.due); });
  return { items: out, never: never };
}
function duePanel() {
  if (!isAdmin() || !state.loaded.sessions) return null;
  var d = dueList();
  var box = h('section', { class: 'due', 'aria-label': 'Coming due' }, h('h3', { class: 'wx-title' }, 'Coming due'));
  if (!d.items.length) box.append(h('p', { class: 'muted', style: { margin: 0, fontSize: '14px' } }, 'Nothing overdue or due in the next 30 days without a session planned.'));
  d.items.forEach(function (x) {
    box.append(h('div', { class: 'due-row' + (x.overdue ? ' overdue' : '') },
      h('span', { class: 'sw', 'aria-hidden': 'true', style: { '--cat': x.t.color } }),
      h('div', { class: 'due-text' },
        h('b', null, x.t.name),
        h('span', null, (x.overdue ? 'Overdue since ' : 'Due by ') + fmtDay.format(fromYmd(x.due)) + ' · last done ' + fmtDay.format(fromYmd(x.last)) + ' · every ' + expiryText(x.t.expiry))),
      h('button', { class: 'btn small', type: 'button', 'data-fk': 'due-' + x.t.id, onclick: function () {
        /* suggest a week before it falls due, but never a day already gone */
        var on = addDays(x.due, -7);
        openForm(null, { category: x.t.id, date: on < todayYmd() ? todayYmd() : on });
      } }, 'Plan it')));
  });
  if (d.never.length) {
    box.append(h('details', { class: 'due-never' },
      h('summary', null, d.never.length + (d.never.length === 1 ? ' type with an expiry has' : ' types with an expiry have') + ' nothing on the calendar yet'),
      h('ul', null, d.never.map(function (t) { return h('li', null, t.name + ' (every ' + expiryText(t.expiry) + ')'); }))));
  }
  return box;
}

/* phones: a slim strip above the calendar with just the hours ahead (the full card is hidden there by CSS) */
function weatherStrip() {
  var w = state.weather;
  if (!w) return null;
  var c = w.current, now = wx(c.code, c.day);
  function cell(cls, time, icon, label, temp, wind, dir) {
    return h('li', { class: cls, 'aria-label': label },
      h('span', { class: 'wx-h-time' }, time),
      h('span', { class: 'wx-h-icon', 'aria-hidden': 'true' }, icon),
      h('span', { class: 'wx-h-temp' }, Math.round(temp) + '°'),
      h('span', { class: 'wx-h-wind' }, windArrow(dir), Math.round(wind)));
  }
  var list = h('ol', { class: 'wx-strip-hours' },
    cell('now', 'Now', now.icon, 'Now at ' + w.place + ', ' + now.text + ', ' + Math.round(c.temp) + ' degrees, wind ' + Math.round(c.wind) + ' knots ' + compass(c.dir), c.temp, c.wind, c.dir),
    w.hours.map(function (x) {
      var hw = wx(x.code, x.day);
      return cell('', x.time, hw.icon, x.time + ', ' + hw.text + ', ' + Math.round(x.temp) + ' degrees, wind ' + Math.round(x.wind) + ' knots ' + compass(x.dir), x.temp, x.wind, x.dir);
    }));
  return h('section', { class: 'wx-strip', 'aria-label': 'Weather at ' + w.place + ' for the next hours, wind in knots' },
    w.today.gustMax >= STRONG_GUST_KN && h('p', { class: 'wx-strip-warn' }, '⚠ Gusts up to ' + Math.round(w.today.gustMax) + ' kn today'),
    list);
}

/* ---------- week view ---------- */
var HOUR_PX = 60, SNAP = 15, LAST_MIN = 23 * 60 + 45;
function snapMin(m) { return Math.round(m / SNAP) * SNAP; }

/* changing day inside the week keeps the grid in place, so a double-click still lands */
function selectInWeek(key) {
  var d = fromYmd(key);
  state.selected = key;
  state.month = { y: d.getFullYear(), m: d.getMonth() };
  document.querySelectorAll('[data-col], [data-dh]').forEach(function (el) {
    var k = el.dataset.col || el.dataset.dh;
    el.classList.toggle('sel', k === key);
    if (el.dataset.dh) el.setAttribute('aria-pressed', String(k === key));
  });
  var sh = $('day-sheet');
  if (sh) sh.replaceWith(daySheet(key));
}

/* side-by-side lanes for sessions that overlap on one day */
function layoutDay(list) {
  var out = [], cluster = [], laneEnds = [], clusterEnd = -1;
  function flush() { cluster.forEach(function (o) { o.lanes = laneEnds.length; }); cluster = []; laneEnds = []; }
  list.forEach(function (s) {
    var a = toMin(s.start), b = Math.max(toMin(s.end), a + SNAP);
    if (a >= clusterEnd) flush();
    var lane = -1;
    for (var i = 0; i < laneEnds.length; i++) if (laneEnds[i] <= a) { lane = i; break; }
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(b); } else laneEnds[lane] = b;
    clusterEnd = Math.max(clusterEnd, b);
    var o = { s: s, lane: lane, a: a, b: b };
    cluster.push(o); out.push(o);
  });
  flush();
  return out;
}

function weekBlock(o, from, ppm, day) {
  var s = o.s, ended = endMs(s) < Date.now(), clash = clashesOf(s).length > 0, w = 100 / o.lanes;
  var el = h('button', {
    type: 'button', class: 'wk-ev' + (o.b - o.a < 45 ? ' short' : '') + (ended ? ' past' : '') + (clash ? ' clash' : '') + (isOff(s) ? ' off' : ''), 'data-fk': 'wb-' + s.id,
    style: {
      '--cat': catVar(s), '--cat-ink': inkOn(catVar(s)), top: (o.a - from) * ppm + 'px', height: Math.max(18, (o.b - o.a) * ppm - 2) + 'px',
      left: 'calc(' + (o.lane * w) + '% + 2px)', width: 'calc(' + w + '% - 4px)'
    },
    'aria-label': s.title + ', ' + fmtDay.format(fromYmd(s.date)) + ', ' + s.start + ' to ' + s.end + (clash ? ', overlaps another session' : ''),
    onclick: function () { selectInWeek(s.date); openDetails(s); }
  },
    h('span', { class: 'tm' }, s.start + '–' + s.end),
    h('span', { class: 't' }, (clash ? '⚠ ' : '') + (s.kind === 'drill' ? 'Drill: ' : '') + s.title),
    s.location && h('span', { class: 'loc' }, s.location));
  if (canMove(s)) el.append(h('span', { class: 'wk-rs', 'aria-hidden': 'true' }));
  return makeDraggable(el, s, 'week', day);
}

/* phones get the week as a list of days; a seven-column time grid is unreadable that narrow */
var narrowQuery = window.matchMedia('(max-width: 700px)');
narrowQuery.addEventListener('change', function () { render(); renderInstall(); });

function weekHead(mon, days) {
  function nav(label, aria, fn, fk) { return h('button', { class: 'btn small', 'aria-label': aria, 'data-fk': fk, onclick: fn }, label); }
  return h('div', { class: 'cal-head' },
    h('h2', { class: 'month-label' }, fmtDM.format(fromYmd(mon)) + ' – ' + fmtDMY.format(fromYmd(days[6]))),
    h('div', { class: 'cal-nav' },
      nav('←', 'Previous week', function () { selectDay(addDays(state.selected, -7)); }, 'wprev'),
      nav('Today', 'Go to today', goToday, 'wtoday'),
      nav('→', 'Next week', function () { selectDay(addDays(state.selected, 7)); }, 'wnext')));
}

function weekListView(mon, days) {
  var admin = isAdmin(), by = groupByDate(visible()), today = todayYmd();
  var list = h('div', { class: 'wk-list' });
  days.forEach(function (k) {
    var items = by[k] || [];
    var sec = h('section', { class: 'wk-day' + (k === today ? ' today' : '') },
      h('h3', { class: 'day-h' },
        h('span', null, fmtLong.format(fromYmd(k)), k === today && h('span', { class: 'tag tag-accent', style: { marginLeft: '8px' } }, 'Today')),
        admin && h('button', { class: 'btn quiet small', type: 'button', 'data-fk': 'wl-add-' + k, onclick: function () { openForm(null, { date: k }); } }, '+ Add')));
    if (!items.length) sec.append(h('p', { class: 'muted wk-none' }, 'Nothing planned.'));
    else {
      var c = h('div', { class: 'cards' });
      items.forEach(function (s) { c.append(sessionCard(s, { showDate: false })); });
      sec.append(c);
    }
    list.append(sec);
  });
  return h('div', null, notices(), h('div', { class: 'wk-wrap' }, weekHead(mon, days), weatherCard(), list));
}

function weekView() {
  if (narrowQuery.matches) {
    var m0 = mondayOf(state.selected), d0 = [];
    for (var j = 0; j < 7; j++) d0.push(addDays(m0, j));
    return weekListView(m0, d0);
  }
  var admin = isAdmin();
  var mon = mondayOf(state.selected), days = [];
  for (var i = 0; i < 7; i++) days.push(addDays(mon, i));
  var by = groupByDate(visible()), today = todayYmd();
  var from = 7 * 60, to = 19 * 60;
  days.forEach(function (k) {
    (by[k] || []).forEach(function (s) {
      from = Math.min(from, Math.floor(toMin(s.start) / 60) * 60);
      to = Math.max(to, Math.ceil(toMin(s.end) / 60) * 60);
    });
  });
  var ppm = HOUR_PX / 60, height = (to - from) * ppm + 'px';
  var head = weekHead(mon, days);

  var wk = h('div', { class: 'wk', style: { '--hour': HOUR_PX + 'px' } }, h('div', { class: 'wk-corner' }));
  days.forEach(function (k) {
    var d = fromYmd(k), n = (by[k] || []).length;
    wk.append(h('button', {
      class: 'wk-dh' + (k === today ? ' today' : '') + (k === state.selected ? ' sel' : ''), 'data-dh': k, 'data-fk': 'wh-' + k,
      'aria-pressed': String(k === state.selected), 'aria-label': fmtLong.format(d) + ', ' + n + (n === 1 ? ' session' : ' sessions'),
      onclick: function () { selectInWeek(k); }
    }, h('span', { class: 'dname' }, fmtWd.format(d)), h('span', { class: 'dnum' }, String(d.getDate()))));
  });
  var times = h('div', { class: 'wk-times', 'aria-hidden': 'true', style: { height: height } });
  for (var m = from; m < to; m += 60) times.append(h('span', { style: { top: (m - from) * ppm + 'px' } }, toTime(m)));
  wk.append(times);

  var now = new Date(), nowM = now.getHours() * 60 + now.getMinutes();
  days.forEach(function (k) {
    var dow = fromYmd(k).getDay();
    var col = h('div', {
      class: 'wk-col' + (dow === 0 || dow === 6 ? ' wkend' : '') + (k === state.selected ? ' sel' : ''),
      'data-col': k, 'data-from': String(from), 'data-to': String(to), style: { height: height }
    });
    col.addEventListener('click', function (e) { if (e.target === col) selectInWeek(k); });
    if (admin) {
      col.addEventListener('dblclick', function (e) {
        if (e.target !== col) return;
        var at = Math.floor((from + (e.clientY - col.getBoundingClientRect().top) / ppm) / 30) * 30;
        openForm(null, { date: k, start: toTime(Math.max(0, Math.min(at, 23 * 60))) });
      });
    }
    if (k === today && nowM >= from && nowM <= to) col.append(h('div', { class: 'wk-now', 'aria-hidden': 'true', style: { top: (nowM - from) * ppm + 'px' } }));
    layoutDay(by[k] || []).forEach(function (o) { col.append(weekBlock(o, from, ppm, k)); });
    wk.append(col);
  });

  var wrap = h('div', { class: 'wk-wrap' }, head, h('div', { class: 'wk-scroll' }, wk));
  if (admin) {
    wrap.append(h('p', { class: 'hint-line' },
      'Drag a session to another day or time, or drag its bottom edge to change how long it runs. Hold Alt or Ctrl as you drop to copy it. ' +
      'On a touch screen, press and hold first. Double-click an empty slot to add something there.'));
  }
  wrap.append(h('div', { class: 'with-side' }, daySheet(state.selected), h('div', { class: 'side' }, weatherCard(), duePanel())));
  return h('div', null, notices(), wrap);
}

/* ---------- drag to reschedule (mouse, pen and touch) ---------- */
function canMove(s) { return isAdmin() && (s.unscheduled || endMs(s) >= Date.now()); }

function makeDraggable(el, s, mode, day) {
  if (!canMove(s)) {
    if (isAdmin()) explainLocked(el, s);
    return el;
  }
  el.classList.add('can-drag');
  el.addEventListener('pointerdown', function (e) {
    /* buttons inside the item (Set date, Edit) stay buttons; the day cell a chip sits in is not one of them */
    var b = e.target.closest('button');
    if (b && b !== el && el.contains(b)) return;
    beginPress(e, el, s, mode, day);
  });
  el.addEventListener('contextmenu', function (e) { if (state.drag) e.preventDefault(); });
  return el;
}

/* a manager trying to drag a finished session is told why nothing happens, instead of nothing happening */
function explainLocked(el, s) {
  el.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var x0 = e.clientX, y0 = e.clientY;
    function move(ev) {
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 8) return;
      off();
      toast('“' + s.title + '” has already finished, so it can’t be dragged. Use Edit to change its date.');
    }
    function off() { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', off); }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', off);
  });
}

function beginPress(e, el, s, mode, day) {
  if (e.button !== 0 || state.drag) return;
  var r = el.getBoundingClientRect();
  var d = {
    s: s, el: el, fromDay: day || s.date, mode: mode === 'week' && e.target.closest('.wk-rs') ? 'resize' : mode,
    id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
    grabX: Math.min(e.clientX - r.left, 260), grabY: e.clientY - r.top,
    touch: e.pointerType !== 'mouse', active: false, copy: false, target: null, timer: 0
  };
  state.drag = d;
  /* on touch a short press-and-hold picks the session up, so a plain swipe still scrolls */
  if (d.touch) d.timer = setTimeout(function () { if (state.drag === d) startDrag(); }, 350);
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragCancel);
  document.addEventListener('keydown', onDragKey);
  window.addEventListener('blur', onDragCancel);
}

function startDrag() {
  var d = state.drag;
  clearTimeout(d.timer);
  d.active = true;
  document.body.classList.add('dragging');
  if (d.touch && navigator.vibrate) { try { navigator.vibrate(10); } catch (x) { /* ignore */ } }
  if (d.mode === 'month') {
    d.ghost = d.el.cloneNode(true);
    d.ghost.classList.add('drag-ghost');
    d.ghost.style.width = Math.min(260, d.el.getBoundingClientRect().width) + 'px';
    document.body.append(d.ghost);
    d.el.classList.add('is-dragging');
  } else {
    d.el.classList.add('lifted');
    d.el.style.left = '2px';
    d.el.style.width = 'calc(100% - 4px)';
    d.label = d.el.querySelector('.tm');
  }
  trackDrag();
  d.scrollRaf = requestAnimationFrame(autoScroll);
}

/* holding a session near the top or bottom edge scrolls the page, so days off-screen can be reached */
function autoScroll() {
  var d = state.drag;
  if (!d || !d.active) return;
  var head = document.querySelector('.site-head');
  var top = (head && getComputedStyle(head).position === 'sticky' ? head.getBoundingClientRect().bottom : 0) + 60;
  var bottom = window.innerHeight - 60, v = 0;
  if (d.y > bottom) v = Math.min(24, Math.ceil((d.y - bottom) / 3));
  else if (d.y < top) v = -Math.min(24, Math.ceil((top - d.y) / 3));
  if (v) {
    var before = window.scrollY;
    window.scrollBy(0, v);
    if (window.scrollY !== before) trackDrag();
  }
  d.scrollRaf = requestAnimationFrame(autoScroll);
}

function onDragMove(e) {
  var d = state.drag;
  if (!d || e.pointerId !== d.id) return;
  d.x = e.clientX; d.y = e.clientY;
  d.copy = d.mode !== 'resize' && !d.s.unscheduled && (e.altKey || e.ctrlKey || e.metaKey);
  if (!d.active) {
    if (Math.abs(d.x - d.x0) + Math.abs(d.y - d.y0) < (d.touch ? 10 : 5)) return;
    if (d.touch) { endPress(); return; }
    startDrag();
  }
  e.preventDefault();
  document.body.classList.toggle('copying', d.copy);
  trackDrag();
}

function trackDrag() {
  var d = state.drag, s = d.s;
  var hit = document.elementFromPoint(d.x, d.y);
  if (d.mode === 'month') {
    d.ghost.style.transform = 'translate(' + (d.x - d.grabX) + 'px,' + (d.y - d.grabY) + 'px)';
    var cell = hit && hit.closest('[data-day]');
    if (d.over && d.over !== cell) d.over.classList.remove('drop');
    d.over = cell;
    d.target = cell ? { date: cell.dataset.day, start: s.start, end: s.end } : null;
    if (cell) cell.classList.add('drop');
    return;
  }
  var col = d.mode === 'resize' ? d.el.parentNode : hit && hit.closest('[data-col]');
  if (!col || !col.dataset.col) return;
  var from = +col.dataset.from, to = Math.min(+col.dataset.to, LAST_MIN), ppm = HOUR_PX / 60;
  var top = col.getBoundingClientRect().top, a0 = toMin(s.start), dur = Math.max(SNAP, toMin(s.end) - a0), a, b;
  if (d.mode === 'resize') {
    a = a0;
    b = Math.max(a + SNAP, Math.min(to, snapMin(from + (d.y - top) / ppm)));
  } else {
    a = Math.max(from, Math.min(snapMin(from + (d.y - d.grabY - top) / ppm), to - dur));
    b = a + dur;
  }
  if (d.el.parentNode !== col) col.append(d.el);
  d.el.style.top = (a - from) * ppm + 'px';
  d.el.style.height = Math.max(18, (b - a) * ppm - 2) + 'px';
  d.label.textContent = toTime(a) + '–' + toTime(b);
  d.target = { date: col.dataset.col, start: toTime(a), end: toTime(b) };
}

function endPress() {
  var d = state.drag;
  if (!d) return;
  clearTimeout(d.timer);
  cancelAnimationFrame(d.scrollRaf);
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', onDragCancel);
  document.removeEventListener('keydown', onDragKey);
  window.removeEventListener('blur', onDragCancel);
  if (d.ghost) d.ghost.remove();
  if (d.over) d.over.classList.remove('drop');
  document.body.classList.remove('dragging', 'copying');
  state.drag = null;
  if (state.renderPending) scheduleRender();
}

function onDragEnd(e) {
  var d = state.drag;
  if (!d || e.pointerId !== d.id) return;
  var t = d.target, copy = d.mode !== 'resize' && !d.s.unscheduled && (e.altKey || e.ctrlKey || e.metaKey);
  endPress();
  if (!d.active) return;
  swallowNextClick();
  /* a multi-day course grabbed on its third day and dropped on a Friday starts two days before that Friday */
  if (t && d.s.date && d.fromDay) t = Object.assign({}, t, { date: addDays(d.s.date, dayDiff(d.fromDay, t.date)) });
  if (t) dropSession(d.s, t, copy);
  render();
}

function onDragCancel() {
  var d = state.drag;
  endPress();
  if (d && d.active) render();
}
function onDragKey(e) { if (e.key === 'Escape') onDragCancel(); }

/* the click that follows a drop must not also select a day */
function swallowNextClick() {
  function kill(e) { e.stopPropagation(); e.preventDefault(); }
  document.addEventListener('click', kill, true);
  setTimeout(function () { document.removeEventListener('click', kill, true); }, 0);
}

/* ---------- clashes ---------- */
function same(a, b) { a = a.trim().toLowerCase(); return !!a && a !== 'online' && a === b.trim().toLowerCase(); }
function clashesOf(s, at) {
  var w = at || s;
  if (!w.date || isOff(s)) return [];
  var a = atMs(w.date, w.start), b = atMs(w.endDate || w.date, w.end);
  return state.sessions.filter(function (o) {
    return o.id !== s.id && !isOff(o) && startMs(o) < b && endMs(o) > a &&
      (same(s.trainer, o.trainer) || same(s.location, o.location));
  });
}
function clashWhy(s, o) { return same(s.trainer, o.trainer) ? 'same trainer' : 'same location'; }

/* ---------- moving and copying ---------- */
function whenText(t) { return (t.endDate ? fmtDay.format(fromYmd(t.date)) + ' – ' + fmtDay.format(fromYmd(t.endDate)) : fmtDay.format(fromYmd(t.date))) + ', ' + t.start; }

function dropSession(s, t, copy) {
  if (t.date === s.date && t.start === s.start && t.end === s.end) return;
  /* the last day moves with the first, so a course keeps its length */
  t = Object.assign({}, t, { endDate: s.endDate && s.date ? addDays(s.endDate, dayDiff(s.date, t.date)) : '' });
  if (atMs(t.date, t.start) < Date.now()) { toast('That time has already passed. Pick a later day or time.'); return; }
  var c = clashesOf(s, t)[0];
  var extra = c ? ' Heads up: it overlaps “' + c.title + '” (' + clashWhy(s, c) + ').' : '';
  state.selected = t.date;
  if (copy) { copySession(s, t, extra); return; }
  var n = signupsOf(s).length;
  moveSessions([{ s: s, t: t }], (s.unscheduled ? 'Scheduled “' : 'Moved “') + s.title + '” for ' + whenText(t) + '.' +
    (n ? ' ' + n + (n === 1 ? ' booking moves' : ' bookings move') + ' with it.' : '') + extra);
}

/* bookings stay attached; booked staff see a "Moved from" tag on the session */
async function moveSessions(moves, msg) {
  var undo = [];
  moves.forEach(function (mv) {
    var s = mv.s, t = mv.t;
    var patch = { date: t.date, endDate: t.endDate || '', start: t.start, end: t.end };
    var back = { date: s.date, endDate: s.endDate || '', start: s.start, end: s.end };
    if (s.unscheduled) { patch.month = ''; back.month = s.month; }
    if (signupsOf(s).length && (t.date !== s.date || t.start !== s.start)) {
      var orig = s.movedFrom || s.date + 'T' + s.start;
      patch.movedFrom = orig === t.date + 'T' + t.start ? '' : orig;
      back.movedFrom = s.movedFrom;
    }
    undo.push({ op: 'update', path: 'sessions/' + s.id, data: back });
    mv.patch = patch;
  });
  try {
    await batchWrite(moves.map(function (mv) { return { op: 'update', path: 'sessions/' + mv.s.id, data: mv.patch }; }));
  } catch (e) {
    toast('Could not move it. Only managers can change the calendar.');
    return;
  }
  toast(msg, { label: 'Undo', fn: async function () {
    try { await batchWrite(undo); toast('Moved back.'); }
    catch (e) { toast('Could not undo the move. Try again.'); }
  } });
}

async function copySession(s, t, extra) {
  var id = newId();
  var data = {
    title: s.title, category: s.category, kind: s.kind, date: t.date, endDate: t.endDate || '', month: '', start: t.start, end: t.end,
    location: s.location, trainer: s.trainer, capacity: s.capacity, mandatory: s.mandatory, notes: s.notes,
    status: s.status, duration: s.duration, setting: s.setting, provider: s.provider
  };
  try {
    await batchWrite([{ op: 'set', path: 'sessions/' + id, data: data }]);
    toast('Copied “' + s.title + '” to ' + whenText(t) + '.' + extra, { label: 'Undo', fn: async function () {
      try { await batchWrite([{ op: 'delete', path: 'sessions/' + id }]); toast('Copy removed.'); }
      catch (e) { toast('Could not remove the copy. Try again.'); }
    } });
  } catch (e) { toast('Could not copy it. Only managers can change the calendar.'); }
}

/* ---------- agenda view ---------- */
function agendaView() {
  var root = h('div', null, notices());
  var wrap = h('div', { class: 'agenda' });
  var vis = visible(), nowT = Date.now();
  var up = vis.filter(function (s) { return endMs(s) >= nowT; }).sort(byStart);
  var past = vis.filter(function (s) { return endMs(s) < nowT; }).sort(function (a, b) { return byStart(b, a); });
  var plans = state.plans.filter(inFilter).sort(function (a, b) { return a.month.localeCompare(b.month) || a.title.localeCompare(b.title); });
  var today = todayYmd();

  if (plans.length) {
    var pc = h('div', { class: 'cards' });
    plans.forEach(function (p) { pc.append(sessionCard(p, { showDate: true })); });
    wrap.append(h('section', null, h('h2', { class: 'sec-h' }, 'Planned, day not set yet'), pc));
  }
  if (!up.length && state.sessions.length) {
    wrap.append(h('p', { class: 'muted pad' }, 'Nothing coming up' + (state.filter.size ? ' in these categories' : '') + '.'));
  }
  var lastMonth = '', group = null, lastDate = '';
  up.forEach(function (s) {
    var mk = s.date.slice(0, 7);
    if (mk !== lastMonth) {
      lastMonth = mk;
      wrap.append(h('h2', { class: 'month-div' }, fmtMonth.format(fromYmd(s.date))));
    }
    if (s.date !== lastDate) {
      lastDate = s.date;
      group = h('section', { class: 'day-group' },
        h('h3', { class: 'day-h' }, fmtLong.format(fromYmd(s.date)), s.date === today && h('span', { class: 'tag tag-accent' }, 'Today')));
      group.append(h('div', { class: 'cards' }));
      wrap.append(group);
    }
    group.lastChild.append(sessionCard(s, { showDate: false }));
  });
  if (past.length) {
    wrap.append(h('div', null, h('button', {
      class: 'btn', 'data-fk': 'toggle-past', 'aria-expanded': String(state.showPast),
      onclick: function () { state.showPast = !state.showPast; render(); }
    }, (state.showPast ? 'Hide' : 'Show') + ' earlier sessions (' + past.length + ')')));
    if (state.showPast) {
      var c = h('div', { class: 'cards' });
      past.forEach(function (s) { c.append(sessionCard(s, { showDate: true })); });
      wrap.append(h('section', null, h('h2', { class: 'sec-h' }, 'Earlier sessions'), c));
    }
  }
  root.append(h('div', { class: 'with-side' }, wrap, h('div', { class: 'side' }, weatherCard(), duePanel())));
  return root;
}

/* ---------- my training ---------- */
function mineView() {
  var root = h('div', null, notices());
  var mySu = new Map();
  state.signups.forEach(function (x) { if (x.uid === state.me.id) mySu.set(x.sessionId, x); });
  var nowT = Date.now();
  var started = function (s) { return startMs(s) <= nowT; };
  var booked = state.sessions.filter(function (s) { return mySu.has(s.id) && !started(s); }).sort(byStart);
  var history = state.sessions.filter(function (s) { return mySu.has(s.id) && started(s); }).sort(function (a, b) { return byStart(b, a); });
  var needs = state.sessions.filter(function (s) { return s.mandatory && !started(s) && !mySu.has(s.id); }).sort(byStart);
  var attended = history.filter(function (s) { return mySu.get(s.id).status === 'attended'; }).length;

  var wrap = h('div', { class: 'mine' });
  wrap.append(h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('b', null, String(attended)), h('span', null, 'Sessions attended')),
    h('div', { class: 'stat' }, h('b', null, String(booked.length)), h('span', null, 'Booked and coming up')),
    h('div', { class: 'stat' }, h('b', null, String(needs.length)), h('span', null, 'Required, not yet booked'))));

  function section(title, list, empty) {
    var c = h('div', { class: 'cards' });
    list.forEach(function (s) { c.append(sessionCard(s, { showDate: true })); });
    return h('section', null, h('h2', { class: 'sec-h' }, title), list.length ? c : h('p', { class: 'muted' }, empty));
  }
  var p = state.push;
  if (p && p.supported && !p.subscribed && p.permission !== 'denied') {
    wrap.append(h('div', { class: 'note' },
      h('span', null, 'Get reminders and changes to your bookings on this device.'),
      h('button', { class: 'btn primary small', type: 'button', 'data-fk': 'mine-push-on', onclick: enablePush }, 'Turn on notifications')));
  }
  if (needs.length) wrap.append(section('Required sessions to book', needs, ''));
  wrap.append(section('Your upcoming sessions', booked, 'You have nothing booked. Pick a session from the Month, Week or Agenda view.'));
  wrap.append(section('Your history', history, 'Sessions you have attended will be listed here.'));
  /* your own account and notifications live here, since Settings is for admins only */
  wrap.append(myAccountSection(), notifySection());
  root.append(wrap);
  return root;
}

/* ---------- reports (managers): attendance at sessions that have started, by financial year ---------- */
var RP_PARTS = [['attended', 'Attended'], ['absent', 'Absent'], ['going', 'Not marked yet']];
function reportYears() {
  var ys = new Set();
  state.sessions.forEach(function (s) { if (startMs(s) <= Date.now()) ys.add(finYear(s.date)); });
  return Array.from(ys).sort().reverse();
}
function pct(n, d) { return d ? Math.round(n / d * 100) + '%' : '–'; }
/* round an axis maximum up to 1, 2 or 5 times a power of ten */
function niceMax(v) {
  if (v <= 4) return 4;
  var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
  return (f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
function tally() { return { attended: 0, absent: 0, going: 0 }; }

function reportsView() {
  var root = h('div', null, notices());
  var years = reportYears();
  /* starts on this financial year, or the latest one with sessions, once the data is in */
  if (state.reportYear == null && years.length) state.reportYear = years.indexOf(finYear(todayYmd())) >= 0 ? finYear(todayYmd()) : years[0];
  if (state.reportYear && years.indexOf(state.reportYear) < 0) state.reportYear = '';
  var year = state.reportYear || '', nowT = Date.now();
  var held = state.sessions.filter(function (s) {
    return inFilter(s) && !isOff(s) && startMs(s) <= nowT && (!year || finYear(s.date) === year);
  }).sort(byStart);

  /* everything below is counted once, from these */
  var total = tally(), byMonth = {}, byType = {}, byPerson = {};
  held.forEach(function (s) {
    var mk = s.date.slice(0, 7), t = s.category;
    byMonth[mk] = byMonth[mk] || tally();
    byType[t] = byType[t] || Object.assign(tally(), { sessions: 0 });
    byType[t].sessions++;
    signupsOf(s).forEach(function (x) {
      total[x.status]++; byMonth[mk][x.status]++; byType[t][x.status]++;
      byPerson[x.uid] = byPerson[x.uid] || Object.assign(tally(), { missed: 0 });
      byPerson[x.uid][x.status]++;
    });
  });
  /* required sessions each current staff member did not attend */
  var people = Object.keys(state.users).filter(function (id) { return state.users[id].active; });
  Object.keys(byPerson).forEach(function (id) { if (people.indexOf(id) < 0) people.push(id); });
  people.forEach(function (id) { byPerson[id] = byPerson[id] || Object.assign(tally(), { missed: 0 }); });
  held.filter(function (s) { return s.mandatory; }).forEach(function (s) {
    var came = new Set(signupsOf(s).filter(function (x) { return x.status === 'attended'; }).map(function (x) { return x.uid; }));
    people.forEach(function (id) { if (state.users[id] && state.users[id].active && !came.has(id)) byPerson[id].missed++; });
  });

  var marked = total.attended + total.absent;
  var head = h('div', { class: 'rp-head' },
    h('h2', { class: 'sec-h' }, 'Attendance report'),
    h('label', { class: 'rp-year' }, h('span', null, 'Financial year'),
      h('select', { 'data-fk': 'rp-year', onchange: function (e) { state.reportYear = e.target.value; render(); } },
        years.map(function (y) { return h('option', { value: y, selected: y === year }, y); }),
        h('option', { value: '', selected: !year }, 'All years'))));
  var wrap = h('div', { class: 'mine reports' }, head,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', null, String(held.length)), h('span', null, 'Sessions held')),
      h('div', { class: 'stat' }, h('b', null, String(marked + total.going)), h('span', null, 'Places booked')),
      h('div', { class: 'stat' }, h('b', null, pct(total.attended, marked)), h('span', null, 'Attendance rate (of those marked)')),
      h('div', { class: 'stat' }, h('b', null, String(total.absent)), h('span', null, 'Absences')),
      h('div', { class: 'stat' + (total.going ? ' rp-todo' : '') }, h('b', null, String(total.going)), h('span', null, 'Not marked yet'))));
  if (!held.length) {
    wrap.append(h('p', { class: 'muted' }, 'No sessions have been held' + (year ? ' in ' + year : '') + (state.filter.size ? ' for these types' : '') + ' yet.'));
    root.append(wrap);
    return root;
  }
  wrap.append(monthChart(byMonth, year), typeChart(byType), personTable(people, byPerson));
  root.append(wrap);
  return root;
}

function rpLegend() {
  return h('ul', { class: 'rp-legend' }, RP_PARTS.map(function (p) {
    return h('li', null, h('span', { class: 'rp-sw rp-' + p[0], 'aria-hidden': 'true' }), p[1]);
  }));
}
/* one shared tooltip per chart, shown on hover or keyboard focus */
function withTip(chart) {
  var tip = h('div', { class: 'rp-tip', role: 'status', hidden: true });
  function show(e) {
    var col = e.target.closest('[data-tip]');
    if (!col) return;
    tip.replaceChildren.apply(tip, JSON.parse(col.dataset.tip).map(function (l, i) { return h(i ? 'div' : 'b', null, l); }));
    tip.hidden = false;
    var box = chart.getBoundingClientRect(), r = col.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(r.left - box.left + r.width / 2 - tip.offsetWidth / 2, box.width - tip.offsetWidth)) + 'px';
    tip.style.top = Math.max(0, r.top - box.top - tip.offsetHeight - 6) + 'px';
  }
  function hide() { tip.hidden = true; }
  chart.addEventListener('pointerover', show);
  chart.addEventListener('focusin', show);
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('focusout', hide);
  chart.append(tip);
  return chart;
}

function monthChart(byMonth, year) {
  var keys = Object.keys(byMonth).sort(), months = [];
  /* a financial year always shows July to June; all years run from the first month to the last */
  var first = year ? (+year.slice(0, 4)) + '-07' : keys[0], last = year ? (+year.slice(0, 4) + 1) + '-06' : keys[keys.length - 1];
  for (var d = fromYmd(first + '-01'); monthKey(d.getFullYear(), d.getMonth()) <= last; d.setMonth(d.getMonth() + 1)) months.push(monthKey(d.getFullYear(), d.getMonth()));
  var top = niceMax(Math.max.apply(null, months.map(function (m) { var t = byMonth[m]; return t ? t.attended + t.absent + t.going : 0; })));
  var fmtShort = new Intl.DateTimeFormat('en-NZ', { month: 'short' });
  var plot = h('div', { class: 'rp-plot' },
    [1, 0.75, 0.5, 0.25, 0].map(function (f) { return h('div', { class: 'rp-grid', style: { bottom: f * 100 + '%' } }, h('span', null, String(Math.round(top * f)))); }),
    months.map(function (m) {
      var t = byMonth[m] || tally(), n = t.attended + t.absent + t.going, label = monthName(m);
      var tip = [label, 'Attended ' + t.attended, 'Absent ' + t.absent, 'Not marked yet ' + t.going, 'Rate ' + pct(t.attended, t.attended + t.absent)];
      return h('div', { class: 'rp-col', tabindex: n ? '0' : null, 'data-tip': n ? JSON.stringify(tip) : null, 'aria-label': n ? tip.join(', ') : label + ', no bookings' },
        h('div', { class: 'rp-stack', style: { height: n / top * 100 + '%' } },
          RP_PARTS.map(function (p) { return t[p[0]] ? h('span', { class: 'rp-seg rp-' + p[0], style: { 'flex-grow': String(t[p[0]]) } }) : null; })),
        h('span', { class: 'rp-x' }, fmtShort.format(fromYmd(m + '-01')) + (year ? '' : ' ’' + m.slice(2, 4))));
    }));
  var table = h('table', { class: 'ptable' },
    h('thead', null, h('tr', null, h('th', null, 'Month'), RP_PARTS.map(function (p) { return h('th', null, p[1]); }), h('th', null, 'Rate'))),
    h('tbody', null, months.filter(function (m) { return byMonth[m]; }).map(function (m) {
      var t = byMonth[m];
      return h('tr', null, h('td', null, monthName(m)), RP_PARTS.map(function (p) { return h('td', null, String(t[p[0]])); }), h('td', null, pct(t.attended, t.attended + t.absent)));
    })));
  return h('section', { class: 'sheet rp-card' },
    h('h3', { class: 'wx-title' }, 'Attendance by month'),
    h('p', { class: 'muted rp-sub' }, 'Places booked on sessions held each month, by what happened.'),
    rpLegend(),
    withTip(h('div', { class: 'rp-chart' }, plot)),
    h('details', { class: 'rp-table' }, h('summary', null, 'Show as a table'), table));
}

function typeChart(byType) {
  var rows = Object.keys(byType).map(function (id) { return Object.assign({ t: catOf(id) }, byType[id]); })
    .sort(function (a, b) { return (b.attended + b.absent + b.going) - (a.attended + a.absent + a.going) || a.t.name.localeCompare(b.t.name); });
  return h('section', { class: 'sheet rp-card' },
    h('h3', { class: 'wx-title' }, 'Attendance rate by training type'),
    h('p', { class: 'muted rp-sub' }, 'Share of marked places that attended. Types with nothing marked yet show a dash.'),
    withTip(h('div', { class: 'rp-chart rp-bars' }, rows.map(function (r) {
      var m = r.attended + r.absent, rate = m ? r.attended / m : 0;
      var tip = [r.t.name, r.sessions + (r.sessions === 1 ? ' session' : ' sessions'), 'Attended ' + r.attended + ' of ' + m + ' marked', 'Absent ' + r.absent, 'Not marked yet ' + r.going];
      return h('div', { class: 'rp-bar-row', tabindex: '0', 'data-tip': JSON.stringify(tip), 'aria-label': tip.join(', ') },
        h('span', { class: 'rp-bar-name' }, h('span', { class: 'sw', 'aria-hidden': 'true', style: { '--cat': r.t.color } }), r.t.name),
        h('span', { class: 'rp-track' }, m ? h('span', { class: 'rp-fill', style: { width: rate * 100 + '%' } }) : null),
        h('span', { class: 'rp-val' }, pct(r.attended, m), h('small', null, ' ' + r.attended + '/' + m)));
    }))));
}

function personTable(people, byPerson) {
  people = people.slice().sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
  return h('section', { class: 'rp-card' },
    h('h2', { class: 'sec-h' }, 'By person'),
    h('table', { class: 'ptable rp-people' },
      h('thead', null, h('tr', null, ['Name', 'Attended', 'Absent', 'Not marked yet', 'Required, not attended', 'Rate'].map(function (c) { return h('th', null, c); }))),
      h('tbody', null, people.map(function (id) {
        var p = byPerson[id], m = p.attended + p.absent;
        return h('tr', null,
          h('td', null, nameOf(id), state.users[id] && !state.users[id].active ? h('span', { class: 'muted' }, ' (removed)') : null),
          h('td', { 'data-l': 'Attended' }, String(p.attended)),
          h('td', { 'data-l': 'Absent' }, String(p.absent)),
          h('td', { 'data-l': 'Not marked yet' }, String(p.going)),
          h('td', { 'data-l': 'Required, not attended', class: p.missed ? 'rp-miss' : null }, String(p.missed)),
          h('td', { 'data-l': 'Rate' }, h('span', { class: 'rp-meter' }, h('span', { class: 'rp-track' }, m ? h('span', { class: 'rp-fill', style: { width: p.attended / m * 100 + '%' } }) : null), pct(p.attended, m))));
      }))));
}

/* ---------- push notifications on this device ---------- */
var NOTIFY_LABELS = [
  ['booked', 'I book a place (a confirmation)'],
  ['changes', 'A session I booked is moved, cancelled, or my place is removed'],
  ['reminders', 'Reminders: the evening before and 1 hour before my sessions, and reminders from managers'],
  ['new', 'New training or drills are added'],
  ['confirmed', 'A training is confirmed (its status is set to Booked)'],
  ['bookings', 'Someone books or withdraws from a session', 'manager']
];
function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function isInstalled() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
function keyBytes(b64) {
  var s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function swReady() {
  /* never wait forever if the service worker could not register */
  return Promise.race([navigator.serviceWorker.ready, new Promise(function (_, no) { setTimeout(function () { no(new Error('timeout')); }, 4000); })]);
}
async function currentSubscription() {
  try { return await (await swReady()).pushManager.getSubscription(); } catch (e) { return null; }
}

/* what this device can do: supported, on, off, or why not */
async function refreshPushState() {
  var p = { supported: false, reason: '', permission: 'default', subscribed: false };
  if (!window.isSecureContext) p.reason = 'insecure';
  else if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) p.reason = isIOS() && !isInstalled() ? 'ios-install' : 'unsupported';
  else {
    p.supported = true;
    p.permission = Notification.permission;
    p.subscribed = !!(await currentSubscription());
  }
  state.push = p;
  scheduleRender();
}

async function enablePush() {
  try {
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast(perm === 'denied' ? 'Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.' : 'Notifications were not turned on.');
      return refreshPushState();
    }
    var reg = await swReady();
    var key = keyBytes((await api('GET', '/api/push/key')).key);
    var sub = await reg.pushManager.getSubscription();
    /* a subscription made for a different server key cannot be reused */
    if (sub && sub.options && sub.options.applicationServerKey &&
        new Uint8Array(sub.options.applicationServerKey).join() !== key.join()) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('POST', '/api/push/subscribe', sub.toJSON());
    toast('Notifications are on for this device.');
  } catch (e) {
    toast(e.message && e.status ? e.message : 'Could not turn on notifications on this device. Try again.');
  }
  refreshPushState();
}

async function disablePush(quiet) {
  var sub = await currentSubscription();
  if (sub) {
    try { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch (e) { /* the server forgets it when delivery fails */ }
    try { await sub.unsubscribe(); } catch (e) { /* already gone */ }
  }
  if (!quiet) toast('Notifications are off for this device.');
  refreshPushState();
}

async function testPush() {
  try {
    var r = await api('POST', '/api/push/test');
    toast('Sent to ' + r.devices + (r.devices === 1 ? ' device' : ' devices') + '. It should arrive in a few seconds.');
  } catch (e) { toast(e.message); }
}

/* ---------- installing the app (phones) ---------- */
var installPrompt = null;
window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installPrompt = e; renderInstall(); });
window.addEventListener('appinstalled', function () { installPrompt = null; renderInstall(); });
function installDismissed() { try { return localStorage.getItem('westhaven-install') === 'no'; } catch (e) { return false; } }
function dismissInstall() {
  try { localStorage.setItem('westhaven-install', 'no'); } catch (e) { /* hides for this visit only */ }
  renderInstall();
}
var SHARE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
function renderInstall() {
  var box = $('install');
  /* iPhone and iPad have no install button; Safari's Share menu does it */
  var iosSafari = isIOS() && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
  var show = narrowQuery.matches && !isInstalled() && !installDismissed() && (installPrompt || iosSafari);
  box.hidden = !show;
  if (!show) { box.replaceChildren(); return; }
  var share = h('span', { class: 'share-ic', 'aria-label': 'Share' });
  share.innerHTML = SHARE_ICON;   /* fixed artwork, never user text */
  var text = installPrompt
    ? h('span', { class: 'install-text' }, h('b', null, 'Install the Training app'), h('br'), 'Opens full-screen, works offline and can send notifications.')
    : h('span', { class: 'install-text' }, h('b', null, 'Add to your Home Screen'), h('br'), 'Tap ', share, ' Share, then “Add to Home Screen”.');
  var buttons = installPrompt
    ? [h('button', { class: 'btn primary small', type: 'button', 'data-fk': 'install-go', onclick: function () {
        var pr = installPrompt;
        installPrompt = null;
        pr.prompt();
        pr.userChoice.then(function () { renderInstall(); }, function () { renderInstall(); });
      } }, 'Install'),
      h('button', { class: 'btn quiet small', type: 'button', 'data-fk': 'install-no', onclick: dismissInstall }, 'Not now')]
    : [h('button', { class: 'btn quiet small', type: 'button', 'data-fk': 'install-ok', onclick: dismissInstall }, 'Got it')];
  box.replaceChildren(h('img', { src: 'apple-touch-icon.png', alt: '', width: '40', height: '40' }), text, h('span', { class: 'install-actions' }, buttons));
}

/* coming back to the app (or back online) brings the calendar and weather up to date */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible' || (state.auth !== 'in' && state.auth !== 'public')) return;
  load();
  if (!state.weatherAt || Date.now() - state.weatherAt > 10 * 60e3) loadWeather();
});
window.addEventListener('online', function () { if (state.auth === 'in' || state.auth === 'public') { load(); loadWeather(); } });
window.addEventListener('offline', function () { state.offline = true; scheduleRender(); });

function notifySection() {
  var p = state.push;
  var box = h('div', { class: 'notify-box' });
  if (!p) box.append(h('p', { class: 'muted' }, 'Checking this device…'));
  else if (p.reason === 'insecure') {
    box.append(h('p', null, 'Notifications need the calendar to be opened at a secure https:// address. Ask whoever runs the calendar server to set that up.'));
  } else if (p.reason === 'ios-install') {
    box.append(h('p', null, 'On iPhone and iPad, notifications work once the calendar is on your Home Screen:'),
      h('ol', { class: 'steps' },
        h('li', null, 'Tap the Share button in Safari.'),
        h('li', null, 'Choose “Add to Home Screen”.'),
        h('li', null, 'Open the calendar from the new icon, sign in, and come back to My training.')));
  } else if (p.reason === 'unsupported') {
    box.append(h('p', null, 'This browser cannot receive notifications. Try Chrome, Edge, Firefox or Safari.'));
  } else if (p.permission === 'denied') {
    box.append(h('p', null, 'Notifications are blocked for this site. Allow them in your browser or phone settings, then reload this page.'));
  } else if (p.subscribed) {
    box.append(h('p', { class: 'ok-line' }, '✓ Notifications are on for this device.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', 'data-fk': 'push-test', onclick: testPush }, 'Send a test notification'),
        h('button', { class: 'btn quiet', type: 'button', 'data-fk': 'push-off', onclick: function () { disablePush(false); } }, 'Turn off on this device')));
  } else {
    box.append(h('p', null, 'Get updates about your training on this ' + (isIOS() || /Android/.test(navigator.userAgent) ? 'phone' : 'device') + ', even when the calendar is closed.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', 'data-fk': 'push-on', onclick: enablePush }, 'Turn on notifications')));
  }

  var prefs = state.me.notify || {};
  var list = h('div', { class: 'notify-prefs' });
  NOTIFY_LABELS.forEach(function (n) {
    if (n[2] === 'manager' && !state.me.admin) return;
    var cb = h('input', { type: 'checkbox', id: 'np-' + n[0], checked: prefs[n[0]] !== false });
    cb.addEventListener('change', async function () {
      var next = Object.assign({}, state.me.notify || {});
      next[n[0]] = cb.checked;
      try { var r = await api('PATCH', '/api/me/notify', next); state.me.notify = r.notify; toast('Saved.'); }
      catch (e) { cb.checked = !cb.checked; toast(e.message); }
    });
    list.append(h('div', { class: 'field check' }, cb, h('label', { for: 'np-' + n[0] }, n[1])));
  });
  return h('section', null,
    h('h2', { class: 'sec-h' }, 'Notifications'),
    box,
    h('h3', { class: 'notify-h' }, 'Notify me when'),
    list,
    h('p', { class: 'hint-line' }, 'These choices apply to every device you turn notifications on for.'));
}

/* ---------- settings (admins only): training types and the team ---------- */
function settingsView() {
  var root = h('div', { class: 'people' });
  root.append(typesSection(), teamSection(), addPersonSection(), inviteSection());
  return root;
}

function expirySelect(id, value) {
  return h('select', { id: id }, EXPIRY_MONTHS.map(function (m) { return h('option', { value: String(m), selected: m === value }, m ? expiryText(m) : 'No expiry (N/A)'); }));
}

function typesSection() {
  var used = {};
  state.sessions.concat(state.plans).forEach(function (s) { used[s.category] = (used[s.category] || 0) + 1; });
  var list = h('div', { class: 'types-list' });
  TYPES.forEach(function (t) {
    var color = h('input', { type: 'color', value: t.color.toLowerCase(), 'aria-label': 'Colour for ' + t.name, id: 'ty-c-' + t.id });
    var name = h('input', { type: 'text', maxlength: '80', value: t.name, 'aria-label': 'Name', id: 'ty-n-' + t.id });
    var drill = h('input', { type: 'checkbox', checked: t.drill, id: 'ty-d-' + t.id });
    var expiry = expirySelect('ty-e-' + t.id, t.expiry);
    var supplier = h('input', { type: 'text', maxlength: '120', value: t.supplier, placeholder: 'Supplier', 'aria-label': 'Supplier for ' + t.name, id: 'ty-s-in-' + t.id, class: 'type-supplier' });
    var save = h('button', { class: 'btn small', type: 'button', 'data-fk': 'ty-s-' + t.id }, 'Save');
    save.addEventListener('click', async function () {
      try { await api('PATCH', '/api/types/' + t.id, { name: name.value, color: color.value, drill: drill.checked, expiry: +expiry.value, supplier: supplier.value }); toast('Saved “' + name.value.trim() + '”.'); }
      catch (e) { toast(e.message); }
    });
    var n = used[t.id] || 0;
    var del = t.id === 'other' ? h('span', { class: 'muted small-note' }, 'Kept') : h('button', {
      class: 'btn quiet small', type: 'button', 'data-fk': 'ty-x-' + t.id, disabled: n > 0,
      title: n ? 'Used by ' + n + (n === 1 ? ' session' : ' sessions') : 'Delete this type',
      onclick: async function () {
        try { await api('DELETE', '/api/types/' + t.id); toast('Deleted “' + t.name + '”.'); }
        catch (e) { toast(e.message); }
      }
    }, 'Delete');
    list.append(h('div', { class: 'type-row' },
      color, name, supplier,
      h('label', { class: 'type-drill', for: 'ty-d-' + t.id }, drill, 'Drill'),
      h('label', { class: 'type-expiry' }, 'Valid ', expiry),
      h('span', { class: 'muted small-note' }, n ? n + ' in use' : 'Not used'),
      save, del));
  });

  var nName = h('input', { id: 'ty-new-name', type: 'text', maxlength: '80', placeholder: 'e.g. Forklift refresher' });
  var nColor = h('input', { id: 'ty-new-color', type: 'color', value: '#7fb3d5' });
  var nDrill = h('input', { id: 'ty-new-drill', type: 'checkbox' });
  var nExpiry = expirySelect('ty-new-expiry', 0);
  var nSupplier = h('input', { id: 'ty-new-supplier', type: 'text', maxlength: '120', placeholder: 'e.g. Internal' });
  var err = h('p', { class: 'form-error', role: 'alert' });
  var form = h('form', { class: 'invite-form', novalidate: true },
    fld('ty-new-name', 'New type', nName), fld('ty-new-color', 'Colour', nColor), fld('ty-new-expiry', 'Valid for', nExpiry), fld('ty-new-supplier', 'Supplier', nSupplier),
    h('div', { class: 'field check', style: { marginTop: '25px' } }, nDrill, h('label', { for: 'ty-new-drill' }, 'Drill')),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add type'));
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    err.textContent = '';
    if (!nName.value.trim()) { err.textContent = 'Give the type a name.'; nName.focus(); return; }
    try {
      await api('POST', '/api/types', { name: nName.value, color: nColor.value, drill: nDrill.checked, expiry: +nExpiry.value, supplier: nSupplier.value });
      toast('Added “' + nName.value.trim() + '”.');
      nName.value = '';
    } catch (ex) { err.textContent = ex.message; }
  });
  return h('section', null,
    h('h2', { class: 'sec-h' }, 'Training types'),
    h('p', { class: 'hint-line', style: { marginBottom: '10px' } }, 'The colour key for the calendar. Change a name, colour or how long it stays valid, and press Save; every session of that type updates. “Valid” drives the Coming due list and the suggested repeat. Ticking “Drill” labels its sessions as drills. A type can be deleted once no sessions use it.'),
    list, form, err);
}

function myAccountSection() {
  var name = h('input', { id: 'my-name', type: 'text', maxlength: '80', autocomplete: 'name', value: state.me.name });
  var nerr = h('p', { class: 'form-error', role: 'alert' });
  var nameForm = h('form', { class: 'invite-form', novalidate: true },
    fld('my-name', 'Your name', name), h('button', { class: 'btn', type: 'submit' }, 'Save name'));
  nameForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    nerr.textContent = '';
    if (!name.value.trim()) { nerr.textContent = 'Enter your name.'; name.focus(); return; }
    try { await api('PATCH', '/api/me', { name: name.value }); toast('Name saved.'); }
    catch (ex) { nerr.textContent = ex.message; }
  });

  var cur = h('input', { id: 'my-cur', type: 'password', autocomplete: 'current-password' });
  var np = h('input', { id: 'my-new', type: 'password', autocomplete: 'new-password' });
  var perr = h('p', { class: 'form-error', role: 'alert' });
  var passForm = h('form', { class: 'invite-form', novalidate: true },
    fld('my-cur', 'Current password', cur), fld('my-new', 'New password', np, 'At least 8 characters.'),
    h('button', { class: 'btn', type: 'submit' }, 'Change password'));
  passForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    perr.textContent = '';
    if (!cur.value) { perr.textContent = 'Enter your current password.'; cur.focus(); return; }
    if (np.value.length < 8) { perr.textContent = 'Use a new password of at least 8 characters.'; np.focus(); return; }
    try {
      await api('POST', '/api/me/password', { current: cur.value, password: np.value });
      cur.value = ''; np.value = '';
      toast('Password changed. Any other devices you were signed in on have been signed out.');
    } catch (ex) { perr.textContent = ex.message; }
  });

  return h('section', null,
    h('h2', { class: 'sec-h' }, 'My account'),
    h('p', { class: 'hint-line', style: { marginBottom: '10px' } }, state.me.email + ' · ' + ROLE_ABOUT[state.me.role]),
    h('div', { class: 'settings-grid' }, h('div', null, nameForm, nerr), h('div', null, passForm, perr)));
}

function teamSection() {
  var members = Object.keys(state.users).map(function (k) { return state.users[k]; })
    .filter(function (u) { return u.active; })
    .sort(function (a, b) { return roleRank(a.role) - roleRank(b.role) || (a.name || a.email).localeCompare(b.name || b.email); });
  function roleRank(r) { return ROLES.map(function (x) { return x[0]; }).indexOf(r); }
  function count(r, one, many) { var n = members.filter(function (u) { return u.role === r; }).length; return n + ' ' + (n === 1 ? one : many); }

  var table = h('table', { class: 'ptable' },
    h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Email'), h('th', null, 'Role'), h('th', null, ''))));
  var body = h('tbody');
  members.forEach(function (u) {
    var self = u.id === state.me.id;
    var role = roleSelect({ 'aria-label': 'Role for ' + (u.name || u.email), 'data-fk': 'role-' + u.id, disabled: self }, u.role);
    role.addEventListener('change', async function () {
      try { await api('PATCH', '/api/users/' + u.id, { role: role.value }); toast((u.name || u.email) + ' is now ' + roleWord(role.value) + '.'); }
      catch (e) { toast(e.message); render(); }
    });
    var actions = h('td');
    if (self) actions.append(h('span', { class: 'muted' }, 'You'));
    else if (state.confirmRemove === u.id) {
      actions.append(h('span', { class: 'row' },
        h('button', { class: 'btn danger small', 'data-fk': 'rm-yes-' + u.id, onclick: function () { removeMember(u); } }, 'Remove'),
        ' ',
        h('button', { class: 'btn small', 'data-fk': 'rm-no-' + u.id, onclick: function () { state.confirmRemove = null; render(); } }, 'Keep')));
    } else {
      actions.append(
        h('button', { class: 'btn quiet small', 'data-fk': 'rs-' + u.id, onclick: function () { resetLink(u); } }, 'Password reset link'),
        h('button', { class: 'btn quiet small', 'data-fk': 'rm-' + u.id, onclick: function () { state.confirmRemove = u.id; render(); } }, 'Remove'));
    }
    body.append(h('tr', null, h('td', null, u.name || '—'), h('td', { class: 'e' }, u.email), h('td', null, role), actions));
  });
  table.append(body);
  return h('section', null,
    h('h2', { class: 'sec-h' }, 'Team · ' + count('admin', 'admin', 'admins') + ', ' + count('manager', 'manager', 'managers') + ', ' + count('staff', 'staff', 'staff')),
    h('p', { class: 'hint-line', style: { marginBottom: '10px' } },
      'Admins can change these settings, as well as everything managers can do. Managers can add, edit and move training and see reports. Staff can book places. ' +
      (state.publicRead ? 'Anyone with the address can view the calendar without an account. ' : '') +
      'You cannot change your own role, so there is always at least one admin.'),
    table);
}

function addPersonSection() {
  var name = h('input', { id: 'np-name', type: 'text', maxlength: '80', autocomplete: 'off' });
  var email = h('input', { id: 'np-email', type: 'email', autocomplete: 'off', placeholder: 'name@example.com' });
  var role = roleSelect({ id: 'np-role' }, 'staff');
  var pass = h('input', { id: 'np-pass', type: 'text', autocomplete: 'off', spellcheck: 'false' });
  var err = h('p', { class: 'form-error', role: 'alert' });
  var form = h('form', { class: 'invite-form', novalidate: true },
    fld('np-name', 'Name', name), fld('np-email', 'Email', email), fld('np-role', 'Role', role),
    fld('np-pass', 'Starting password', pass, 'At least 8 characters. They can change it in My training.'),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add'));
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    err.textContent = '';
    if (!name.value.trim()) { err.textContent = 'Enter their name.'; name.focus(); return; }
    if (!RE_EMAIL.test(email.value.trim())) { err.textContent = 'Enter a valid email address.'; email.focus(); return; }
    if (pass.value.length < 8) { err.textContent = 'Use a starting password of at least 8 characters.'; pass.focus(); return; }
    try {
      await api('POST', '/api/users', { name: name.value, email: email.value, role: role.value, password: pass.value });
      toast('Added ' + name.value.trim() + ' as ' + roleWord(role.value) + '. Give them their email and starting password to sign in.');
      name.value = ''; email.value = ''; pass.value = '';
    } catch (ex) { err.textContent = ex.message; }
  });
  return h('section', null,
    h('h2', { class: 'sec-h' }, 'Add a person'),
    h('p', { class: 'hint-line', style: { marginBottom: '10px' } }, 'Creates the account straight away. Tell them their email and starting password.'),
    form, err);
}

function inviteSection() {
  var email = h('input', { id: 'inv-email', type: 'email', autocomplete: 'off', placeholder: 'name@example.com' });
  var role = roleSelect({ id: 'inv-role' }, 'staff');
  var err = h('p', { class: 'form-error', role: 'alert' });
  var form = h('form', { class: 'invite-form', novalidate: true },
    fld('inv-email', 'Email address', email), fld('inv-role', 'Role', role),
    h('button', { class: 'btn', type: 'submit' }, 'Create invite link'));
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    var v = email.value.trim().toLowerCase();
    if (!RE_EMAIL.test(v)) { err.textContent = 'Enter a valid email address.'; email.focus(); return; }
    invite(v, role.value).then(function () { email.value = ''; }, function (ex) { err.textContent = ex.message; });
  });
  var inv = h('div', { class: 'cards' });
  state.invites.forEach(function (i) {
    inv.append(h('div', { class: 'sess' },
      h('div', { class: 'sess-top' }, h('span', { class: 'tag' }, labelOf(ROLES, i.role) || 'Staff'),
        h('span', { class: 'hint' }, 'Link works until ' + fmtDay.format(new Date(i.expires)))),
      h('p', { style: { margin: 0, overflowWrap: 'anywhere', fontWeight: 600 } }, i.email),
      h('div', { class: 'sess-actions' },
        h('button', { class: 'btn small', 'data-fk': 'ri-' + i.id, onclick: function () { invite(i.email, i.role).catch(function (ex) { toast(ex.message); }); } }, 'New link'),
        h('button', { class: 'btn quiet small', 'data-fk': 'ci-' + i.id, onclick: function () { cancelInvite(i); } }, 'Cancel invite'))));
  });
  return h('section', null,
    h('h2', { class: 'sec-h' }, 'Or send an invite link'),
    h('p', { class: 'hint-line', style: { marginBottom: '10px' } }, 'They open the link and choose their own name and password. Works once, for 14 days.'),
    form, err,
    state.invites.length ? h('div', { style: { marginTop: '14px' } }, h('h3', { class: 'sec-h' }, 'Pending invites'), inv) : null);
}

async function invite(email, role) {
  var r = await api('POST', '/api/invites', { email: email, role: role });
  showLink('Invite link for ' + email, 'Send this link to ' + email + '. They open it, enter their name and choose a password. It works for ' + r.days + ' days and only once.', r.link);
}
async function resetLink(u) {
  try {
    var r = await api('POST', '/api/users/' + u.id + '/reset');
    showLink('Password reset link', 'Send this link to ' + (u.name || u.email) + '. They open it and choose a new password. It works for ' + r.days + ' days and only once.', r.link);
  } catch (e) { toast(e.message); }
}
async function removeMember(u) {
  try {
    await api('DELETE', '/api/users/' + u.id);
    state.confirmRemove = null;
    toast((u.name || u.email) + ' was removed. They can no longer open the calendar.');
  } catch (e) { toast(e.message); }
}
async function cancelInvite(i) {
  try { await api('DELETE', '/api/invites/' + i.id); toast('Invite cancelled. Its link no longer works.'); }
  catch (e) { toast(e.message); }
}

/* the link is shown once; the server keeps only a fingerprint of it */
function showLink(titleText, explain, rel) {
  state.lastFocus = document.activeElement;
  var full = /^https?:/.test(rel) ? rel : location.origin + rel;
  var box = h('input', { id: 'lk-url', type: 'text', readonly: true, value: full });
  var copy = h('button', { class: 'btn primary', type: 'button' }, 'Copy link');
  copy.addEventListener('click', async function () {
    try { await navigator.clipboard.writeText(full); copy.textContent = 'Copied'; }
    catch (e) { box.select(); document.execCommand('copy'); copy.textContent = 'Copied'; }
  });
  var form = h('form', { novalidate: true, 'aria-labelledby': 'm-title' },
    h('h2', { id: 'm-title', class: 'modal-title' }, titleText),
    h('p', { class: 'muted', style: { margin: '-6px 0 12px' } }, explain),
    h('div', { class: 'field' }, h('label', { for: 'lk-url' }, 'Link'), box),
    h('p', { class: 'hint-line', style: { margin: '8px 0 0' } }, 'This is the only time the link is shown. If it gets lost, make a new one.'),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Done'), copy));
  form.addEventListener('submit', function (e) { e.preventDefault(); });
  openModal(form, copy);
  box.addEventListener('focus', function () { box.select(); });
}

/* ---------- session card ---------- */
function statusPill(status, ended) {
  if (status === 'attended') return h('span', { class: 'pill pill-ok' }, 'Attended');
  if (status === 'absent') return h('span', { class: 'pill pill-bad' }, 'Absent');
  return ended ? h('span', { class: 'pill pill-muted' }, 'Not recorded') : h('span', { class: 'pill pill-accent' }, 'Booked');
}

/* ---------- details window: everything about one training or drill ---------- */
function detailBody(s) {
  var t = catOf(s.category);
  var close = h('button', { class: 'detail-close', type: 'button', 'aria-label': 'Close', 'data-fk': 'detail-close', onclick: closeModal }, '×');
  var card = sessionCard(s, { showDate: true, detail: true });
  var title = card.querySelector('.sess-title');
  if (title) title.id = 'm-title';
  return {
    node: h('div', { class: 'detail' },
      h('div', { class: 'detail-band', style: catStyle(s) }, h('span', null, t.name + (s.kind === 'drill' ? ' · Drill' : '')), close),
      card),
    focus: close
  };
}
function openDetails(s) {
  state.lastFocus = document.activeElement;
  state.detailId = s.id;
  var d = detailBody(s);
  openModal(d.node, d.focus, 'detail');
}
/* called after every redraw: an open details window follows live changes, and closes if the session is deleted */
function refreshDetails() {
  if (!state.detailId) return;
  var panel = document.querySelector('.modal-detail');
  if (!panel) return;
  var s = state.sessions.concat(state.plans).filter(function (x) { return x.id === state.detailId; })[0];
  if (!s) { closeModal(); return; }
  panel.replaceChildren(detailBody(s).node);
}

function sessionCard(s, opts) {
  var su = signupsOf(s), signedIn = state.auth === 'in';
  var taken = signedIn ? su.length : (state.counts[s.id] || 0);
  var mine = signedIn ? su.filter(function (x) { return x.uid === state.me.id; })[0] || null : null;
  var nowT = Date.now();
  var started = !s.unscheduled && startMs(s) <= nowT, ended = !s.unscheduled && endMs(s) < nowT;
  var cap = s.capacity, full = cap > 0 && taken >= cap;
  var cat = catOf(s.category);
  var open = state.expanded.has(s.id);
  var admin = isAdmin();

  var card = h('article', { class: 'sess' + (ended ? ' past' : '') + (isOff(s) ? ' off' : ''), style: catStyle(s) });
  card.append(h('div', { class: 'sess-top' },
    h('span', { class: 'cat' }, h('span', { class: 'sw', 'aria-hidden': 'true' }), cat.name),
    h('span', { class: 'tag tag-status st-' + s.status }, labelOf(SESSION_STATUS, s.status)),
    s.kind === 'drill' && h('span', { class: 'tag tag-drill' }, 'Drill'),
    s.mandatory && h('span', { class: 'tag tag-req' }, 'Required'),
    s.movedFrom && !ended && h('span', { class: 'tag tag-moved' }, 'Moved from ' + fmtDay.format(fromYmd(s.movedFrom.slice(0, 10))) + ' ' + s.movedFrom.slice(11)),
    s.example && h('span', { class: 'tag' }, 'Example')));
  card.append(h('h3', { class: 'sess-title' }, s.title));
  var when = s.unscheduled
    ? 'Day to be set · ' + monthName(s.month) + ' · ' + s.start + '–' + s.end
    : (opts.showDate || s.endDate ? dateRange(s) + ' · ' : '') + s.start + '–' + s.end + (s.endDate ? ' each day' : '');
  var facts = [s.duration, labelOf(SETTINGS, s.setting), s.provider === 'inhouse' ? 'In-house' : s.provider === 'external' ? 'External provider' : '']
    .filter(Boolean).join(' · ');
  card.append(h('ul', { class: 'meta' },
    h('li', { class: 'mono' }, when),
    facts && h('li', null, facts),
    s.location && h('li', null, s.location),
    s.trainer ? h('li', null, 'Trainer: ' + s.trainer) : cat.supplier && h('li', null, 'Supplier: ' + cat.supplier),
    (cat.expiry || s.date) && h('li', { class: 'meta-small' },
      [cat.expiry ? 'Valid for ' + expiryText(cat.expiry) : '', s.date ? 'FY ' + finYear(s.date) : ''].filter(Boolean).join(' · '))));
  if (s.notes) card.append(h('p', { class: 'sess-notes' }, s.notes));
  var clashes = admin && !ended ? clashesOf(s) : [];
  if (clashes.length) {
    card.append(h('p', { class: 'clash-line' }, '⚠ Overlaps “' + clashes[0].title + '” at ' + clashes[0].start + ' (' + clashWhy(s, clashes[0]) + ')' +
      (clashes.length > 1 ? ' and ' + (clashes.length - 1) + ' more' : '') + '.'));
  }

  if (!s.unscheduled && (signedIn || cap > 0)) {
    var capText = cap > 0 ? taken + ' of ' + cap + ' places taken' : taken + ' booked';
    card.append(h('div', { class: 'capline' },
      h('span', { class: full ? 'full' : '' }, full ? 'Full · ' + capText : capText),
      cap > 0 && h('span', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: { width: Math.min(100, Math.round(taken / cap * 100)) + '%' } }))));
  }

  var act = h('div', { class: 'sess-actions' });
  if (!signedIn) {
    if (started && !isOff(s)) card.append(h('div', { class: 'sess-actions' }, h('span', { class: 'hint' }, ended ? 'Finished' : 'In progress')));
    return card;
  }
  if (s.unscheduled) {
    act.append(h('span', { class: 'hint' }, 'Booking opens once the day is set.'));
  } else if (isOff(s)) {
    act.append(h('span', { class: 'hint' }, 'This session is ' + s.status + '.'));
  } else if (!started) {
    if (mine) {
      act.append(h('span', { class: 'pill pill-accent' }, "You're booked"),
        h('button', { class: 'btn', 'data-fk': 'wd-' + s.id, onclick: function () { withdraw(s, mine); } }, 'Withdraw'));
    } else if (full) {
      act.append(h('span', { class: 'pill pill-bad' }, 'Full'));
    } else {
      act.append(h('button', { class: 'btn primary', 'data-fk': 'su-' + s.id, onclick: function () { bookPlace(s); } }, 'Book a place'));
    }
  } else if (mine) {
    act.append(statusPill(mine.status, ended));
  } else {
    act.append(h('span', { class: 'hint' }, ended ? 'Finished' : 'In progress'));
  }
  if (!s.unscheduled) {
    act.append(h('button', {
      class: 'btn quiet', 'aria-expanded': String(open), 'data-fk': 'ro-' + s.id,
      onclick: function () { if (open) state.expanded.delete(s.id); else state.expanded.add(s.id); render(); }
    }, (open ? 'Hide' : "Who's going") + ' (' + su.length + ')'));
  }
  if (admin) {
    if (!ended) act.append(h('button', { class: 'btn quiet', 'data-fk': 'mv-' + s.id, onclick: function () { openMoveForm(s); } }, s.unscheduled ? 'Set date' : 'Move'));
    if (!ended && !s.unscheduled && !isOff(s)) act.append(h('button', { class: 'btn quiet', 'data-fk': 'sr-' + s.id, onclick: function () { openRemindForm(s); } }, 'Send reminder'));
    act.append(h('button', { class: 'btn quiet', 'data-fk': 'ed-' + s.id, onclick: function () { openForm(s); } }, 'Edit'),
      h('button', { class: 'btn quiet', 'data-fk': 'del-' + s.id, onclick: function () { state.confirmDelete = s.id; render(); } }, 'Delete'));
  }
  card.append(act);

  if (admin && state.confirmDelete === s.id) {
    card.append(h('div', { class: 'confirm' },
      h('p', null, 'Delete this ' + (s.kind === 'drill' ? 'drill' : 'session') + (su.length ? ' and its ' + su.length + (su.length === 1 ? ' booking' : ' bookings') : '') + '? This cannot be undone.'),
      h('button', { class: 'btn danger small', 'data-fk': 'del-yes-' + s.id, onclick: function () { deleteSession(s); } }, 'Delete'),
      h('button', { class: 'btn small', 'data-fk': 'del-no-' + s.id, onclick: function () { state.confirmDelete = null; render(); } }, 'Keep it')));
  }

  if (open) {
    var people = su.map(function (x) { return { x: x, name: nameOf(x.uid) }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    var list = h('ul', { class: 'roster' });
    if (!people.length) list.append(h('li', { class: 'rrow muted' }, 'No one has booked yet.'));
    people.forEach(function (p) {
      var li = h('li', { class: 'rrow' },
        h('span', { class: 'rname' }, p.name + (p.x.uid === state.me.id ? ' (you)' : '')),
        statusPill(p.x.status, ended));
      if (admin && started) {
        li.append(h('span', { class: 'mark' },
          markBtn(p.x, 'attended', 'Attended'), markBtn(p.x, 'absent', 'Absent')));
      }
      list.append(li);
    });
    card.append(list);
  }
  return card;
}

function markBtn(x, status, label) {
  return h('button', {
    class: 'btn small', 'aria-pressed': String(x.status === status), 'data-fk': 'mk-' + x.id + '-' + status,
    onclick: function () { markStatus(x, status); }
  }, label);
}

/* ---------- actions ---------- */
async function bookPlace(s) {
  var su = signupsOf(s);
  if (s.capacity > 0 && su.length >= s.capacity) { toast('Sorry, that session just filled up.'); return; }
  try {
    await api('POST', '/api/signups', { sessionId: s.id });
    toast("You're booked for " + s.title + '.');
  } catch (e) {
    toast(e.message);
  }
}
async function withdraw(s, mine) {
  try {
    await api('DELETE', '/api/signups/' + encodeURIComponent(mine.id));
    toast('Your booking was removed.');
  } catch (e) { toast(e.message); }
}
async function markStatus(x, status) {
  var next = x.status === status ? 'going' : status;
  try { await api('PATCH', '/api/signups/' + encodeURIComponent(x.id), { status: next }); }
  catch (e) { toast(e.message); }
}
async function deleteSession(s) {
  try {
    await batchWrite(signupsOf(s).map(function (x) { return { op: 'delete', path: 'signups/' + x.id }; })
      .concat([{ op: 'delete', path: 'sessions/' + s.id }]));
    state.confirmDelete = null;
    toast('Deleted.');
  } catch (e) { toast('Could not delete it. Try again.'); }
}
async function addExamples() {
  var t = todayYmd(), next = new Date(); next.setMonth(next.getMonth() + 1);
  var mk = function (off, o) { return Object.assign({ date: addDays(t, off), month: '', kind: 'training', example: true, notes: '' }, o); };
  var list = [
    mk(-4, { title: 'H & S Noggin: manual handling', category: 'hs-noggin', start: '09:00', end: '09:30', location: 'Staff room', trainer: 'Site safety lead', capacity: 0, mandatory: false }),
    mk(3, { title: 'Twin engine power boat training', category: 'twin-engine', start: '08:00', end: '10:00', location: 'Hardstand', trainer: 'Operations lead', capacity: 6, mandatory: true, notes: 'Wear boots and a hi-vis vest.' }),
    mk(6, { title: 'First Aid - Workplace Refresher', category: 'first-aid-refresher', start: '08:30', end: '16:30', location: 'Training room', trainer: 'External provider', capacity: 12, mandatory: true }),
    mk(9, { title: 'Fire evacuation drill', kind: 'drill', category: 'er-fire', start: '10:00', end: '11:00', location: 'All sites', trainer: 'Chief fire warden', capacity: 0, mandatory: true }),
    mk(13, { title: 'Fuel and oil spill response', kind: 'drill', category: 'er-spill', start: '13:00', end: '15:00', location: 'Fuel dock', trainer: 'Environment officer', capacity: 10, mandatory: false }),
    mk(16, { title: 'Maritime VHF Operator Certificate', category: 'vhf', start: '14:00', end: '14:45', location: 'Online', trainer: 'Systems team', capacity: 0, mandatory: false }),
    mk(20, { title: 'Marina Operational SOP - Staff Sign Off', category: 'sop-staff-sign-off', start: '09:00', end: '12:00', location: 'Marina office', trainer: 'Team leader', capacity: 8, mandatory: false }),
    mk(0, { title: 'Person overboard drill', kind: 'drill', category: 'er-man-overboard', date: '', month: monthKey(next.getFullYear(), next.getMonth()), start: '07:30', end: '08:30', location: 'Main pier', trainer: 'Dock master', capacity: 0, mandatory: true })
  ];
  for (var w = 0; w < 4; w++) {
    list.push(mk(2 + w * 7, { title: 'Dynamic Risk Assessment Evaluation', category: 'risk-assessment', start: '07:30', end: '08:00', location: 'Main pier', trainer: 'Site safety lead', capacity: 0, mandatory: false, seriesId: 'ex-dockwalk' }));
  }
  try {
    await batchWrite(list.map(function (d) { return { op: 'set', path: 'sessions/' + newId(), data: d }; }));
    toast('Added ' + list.length + ' examples.');
  } catch (e) { toast('Could not add the examples. Only managers can change the calendar.'); }
}
async function removeExamples() {
  var ops = [];
  state.sessions.concat(state.plans).filter(function (s) { return s.example; }).forEach(function (s) {
    signupsOf(s).forEach(function (x) { ops.push({ op: 'delete', path: 'signups/' + x.id }); });
    ops.push({ op: 'delete', path: 'sessions/' + s.id });
  });
  try { await batchWrite(ops); toast('Examples removed.'); }
  catch (e) { toast('Could not remove the examples. Try again.'); }
}

/* ---------- CSV export ---------- */
function csvCell(c) {
  var t = String(c == null ? '' : c);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
function exportCsv() {
  var label = { going: 'Booked', attended: 'Attended', absent: 'Absent' };
  var rows = [['Financial year', 'Date', 'Last day', 'Start', 'End', 'Course', 'Title', 'Drill', 'Status', 'Duration', 'Setting', 'In-house', 'Valid for', 'Trainer or supplier', 'Required', 'Person', 'Email', 'Attendance']];
  state.sessions.slice().sort(byStart).forEach(function (s) {
    var t = catOf(s.category), su = signupsOf(s);
    var base = [finYear(s.date), s.date, s.endDate, s.start, s.end, t.name, s.title, s.kind === 'drill' ? 'Yes' : 'No', labelOf(SESSION_STATUS, s.status), s.duration,
      labelOf(SETTINGS, s.setting), s.provider === 'inhouse' ? 'Yes' : s.provider === 'external' ? 'No' : '', t.expiry ? expiryText(t.expiry) : 'N/A', s.trainer || t.supplier, s.mandatory ? 'Yes' : 'No'];
    if (!su.length) { rows.push(base.concat(['', '', 'No bookings'])); return; }
    su.forEach(function (x) {
      var u = state.users[x.uid];
      rows.push(base.concat([nameOf(x.uid), u ? u.email : '', label[x.status]]));
    });
  });
  var csv = '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  var a = h('a', { href: url, download: 'dockside-training-attendance-' + todayYmd() + '.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  toast('Attendance file downloaded.');
}

/* ---------- add / edit form ---------- */
var escHandler = null;
function closeModal() {
  state.detailId = null;
  $('modal-root').replaceChildren();
  if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
  if (reloadPending) { location.reload(); return; }
  var f = state.lastFocus;
  if (f && document.contains(f)) f.focus();
  else { var a = document.querySelector('[data-fk="add"]'); if (a) a.focus(); }
}

function fld(id, label, control, hint, cls) {
  return h('div', { class: 'field' + (cls ? ' ' + cls : '') }, h('label', { for: id }, label), control, hint && h('small', { class: 'muted' }, hint));
}

function monthOptions(current) {
  var t = new Date(), keys = [];
  for (var i = 0; i < 18; i++) { var d = new Date(t.getFullYear(), t.getMonth() + i, 1); keys.push(monthKey(d.getFullYear(), d.getMonth())); }
  if (current && keys.indexOf(current) < 0) keys.unshift(current);
  return keys.map(function (k) { return h('option', { value: k, selected: k === current }, monthName(k)); });
}

function openForm(session, preset) {
  if (!isAdmin()) return;
  state.lastFocus = document.activeElement;
  var edit = !!session, today = todayYmd();
  var pStart = (preset && preset.start) || '09:00';
  var v = session || {
    title: '', kind: 'training', category: (preset && preset.category) || '', unscheduled: false, month: '',
    date: (preset && preset.date) || (state.selected >= today ? state.selected : today),
    start: pStart, end: toTime(Math.min(toMin(pStart) + 60, LAST_MIN)), location: '', trainer: '', capacity: 0, mandatory: false, notes: '',
    endDate: '', status: 'planning', duration: '', setting: '', provider: ''
  };
  var title = h('input', { id: 'f-title', type: 'text', maxlength: '120', value: v.title, autocomplete: 'off' });
  /* pick the type first; the title follows it until someone types their own */
  var cat = h('select', { id: 'f-cat' },
    !edit && h('option', { value: '', selected: !v.category }, 'Choose a training or drill type…'),
    TYPES.map(function (c) { return h('option', { value: c.id, selected: c.id === v.category }, c.name); }));
  var swatch = h('span', { class: 'type-swatch', 'aria-hidden': 'true' });
  var lastAuto = edit ? '' : v.title, lastTrainer = '', providerTouched = edit;
  function syncType() {
    var t = TYPE[cat.value];
    swatch.style.background = t ? t.color : 'transparent';
    if (t && (!title.value.trim() || title.value === lastAuto)) { title.value = t.name; lastAuto = t.name; }
    /* the supplier list fills in who runs it, and whether that is in-house */
    if (t && typeof trainer !== 'undefined' && trainer && (!trainer.value.trim() || trainer.value === lastTrainer)) {
      lastTrainer = t.supplier && !/^(internal|various)$/i.test(t.supplier) ? t.supplier : '';
      trainer.value = lastTrainer;
    }
    if (t && t.supplier && typeof provider !== 'undefined' && provider && !providerTouched) {
      provider.value = /^internal|in-house/i.test(t.supplier) ? 'inhouse' : 'external';
    }
    /* a type that has to be redone every 3, 6 or 12 months suggests that repeat for new sessions */
    if (t && !edit && typeof rep !== 'undefined' && !repTouched) { rep.value = { 3: 'm3', 6: 'm6', 12: 'm12' }[t.expiry] || 'none'; sync(); }
  }
  cat.addEventListener('change', syncType);
  syncType();
  var whenSel = h('select', { id: 'f-when' },
    h('option', { value: 'date', selected: !v.unscheduled }, 'On a specific day'),
    h('option', { value: 'month', selected: v.unscheduled }, 'Sometime in a month (set the day later)'));
  var date = h('input', { id: 'f-date', type: 'date', value: v.date || '' });
  var mon = h('select', { id: 'f-month' }, monthOptions(v.month || monthKey(state.month.y, state.month.m)));
  var start = h('input', { id: 'f-start', type: 'time', value: v.start });
  var end = h('input', { id: 'f-end', type: 'time', value: v.end });
  var loc = h('input', { id: 'f-loc', type: 'text', maxlength: '120', value: v.location, placeholder: 'e.g. Staff room' });
  var trainer = h('input', { id: 'f-trainer', type: 'text', maxlength: '80', value: v.trainer, placeholder: 'Who is running it' });
  var cap = h('input', { id: 'f-cap', type: 'number', min: '0', max: '500', step: '1', value: v.capacity ? String(v.capacity) : '', placeholder: 'No limit' });
  var req = h('input', { id: 'f-req', type: 'checkbox', checked: v.mandatory });
  var notes = h('textarea', { id: 'f-notes', maxlength: '600', placeholder: 'What to bring, prerequisites, anything staff should know' }, v.notes);
  function pick(id, pairs, value, blank) {
    return h('select', { id: id }, blank && h('option', { value: '', selected: !value }, blank), pairs.map(function (p) { return h('option', { value: p[0], selected: p[0] === value }, p[1]); }));
  }
  var status = pick('f-status', SESSION_STATUS, v.status || 'planning');
  var duration = pick('f-dur', DURATIONS.map(function (x) { return [x, x]; }), v.duration, 'Not set');
  var setting = pick('f-setting', SETTINGS, v.setting, 'Not set');
  var provider = pick('f-provider', [['inhouse', 'Yes, in-house'], ['external', 'No, external provider']], v.provider, 'Not set');
  provider.addEventListener('change', function () { providerTouched = true; });
  var lastDate = h('input', { id: 'f-last', type: 'date', value: v.endDate || '' });
  /* choosing a duration fills in the end time, and the last day for courses longer than a day */
  duration.addEventListener('change', function () {
    var dur = duration.value, hours = { '1 hour': 1, '2 hours': 2, '3 hours': 3, '1/2 Day': 4 }[dur];
    var days = { '1 Day': 1, '2 Days': 2, '3 Days': 3, '4 Days': 4, '5 Days': 5, '1 Week': 7, '2 Weeks': 14 }[dur];
    if (!start.value) return;
    end.value = toTime(Math.min(toMin(start.value) + 60 * (hours || (days ? 8 : 1)), LAST_MIN));
    if (days && date.value) lastDate.value = days > 1 ? addDays(date.value, days - 1) : '';
    else if (hours) lastDate.value = '';
  });
  var rep = h('select', { id: 'f-rep' },
    h('option', { value: 'none' }, 'Does not repeat'),
    h('option', { value: '7' }, 'Every week'),
    h('option', { value: '14' }, 'Every fortnight'),
    h('option', { value: 'm1' }, 'Every month'),
    h('option', { value: 'm3' }, 'Every 3 months'),
    h('option', { value: 'm6' }, 'Every 6 months'),
    h('option', { value: 'm12' }, 'Every year'));
  var repTouched = false;
  rep.addEventListener('change', function () { repTouched = true; });
  var cnt = h('input', { id: 'f-cnt', type: 'number', min: '2', max: '26', step: '1', value: '4' });
  var dateField = fld('f-date', 'Date', date), monthField = fld('f-month', 'Month', mon);
  var repField = fld('f-rep', 'Repeat', rep, 'Suggested from the type’s expiry. Drills often run every 3 or 6 months.', 'span2');
  var lastField = fld('f-last', 'Last day', lastDate, 'Only for courses over several days.');
  var cntField = fld('f-cnt', 'How many times', cnt, 'Including the first one.');
  function sync() {
    var byMonth = whenSel.value === 'month';
    dateField.hidden = byMonth; monthField.hidden = !byMonth; lastField.hidden = byMonth;
    repField.hidden = edit; cntField.hidden = edit || rep.value === 'none';
  }
  whenSel.addEventListener('change', sync); rep.addEventListener('change', sync);
  sync();
  /* a type chosen before the form opened (Plan it) also suggests its repeat, now that the repeat control exists */
  if (!edit) syncType();

  var err = h('p', { class: 'form-error', id: 'f-err', role: 'alert' });
  var saveBtn = h('button', { class: 'btn primary', type: 'submit' }, edit ? 'Save changes' : 'Add to calendar');
  var cancelBtn = h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel');

  var form = h('form', { novalidate: true, 'aria-labelledby': 'm-title' },
    h('h2', { id: 'm-title', class: 'modal-title' }, edit ? 'Edit ' + (v.kind === 'drill' ? 'drill' : 'session') : 'Add training or a drill'),
    h('div', { class: 'form-grid' },
      h('div', { class: 'field span2' }, h('label', { for: 'f-cat' }, 'Type'), h('div', { class: 'type-pick' }, swatch, cat)),
      fld('f-title', 'Title', title, 'Filled in from the type. Change it if you like, e.g. “Fire drill: north pier”.', 'span2'),
      fld('f-status', 'Status', status),
      fld('f-dur', 'Duration', duration),
      fld('f-when', 'When', whenSel, null, 'span2'),
      h('div', { class: 'three span2' }, dateField, lastField, monthField, fld('f-start', 'Starts', start), fld('f-end', 'Ends', end)),
      fld('f-setting', 'Setting', setting),
      fld('f-provider', 'In-house', provider),
      fld('f-loc', 'Location', loc),
      fld('f-trainer', 'Trainer or lead', trainer),
      fld('f-cap', 'Places', cap, 'Leave empty for no limit.'),
      h('div', { class: 'field check' }, req, h('label', { for: 'f-req' }, 'Required for all staff')),
      fld('f-notes', 'Notes', notes, null, 'span2'),
      repField, cntField),
    err,
    h('div', { class: 'modal-actions' }, cancelBtn, saveBtn));

  function fail(msg, el) { err.textContent = msg; if (el) el.focus(); }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    err.textContent = '';
    var t = title.value.trim(), byMonth = whenSel.value === 'month';
    if (!TYPE[cat.value]) return fail('Choose the training or drill type.', cat);
    if (!t) return fail('Give it a title.', title);
    if (!byMonth && !date.value) return fail('Choose a date.', date);
    if (!start.value || !end.value) return fail('Set a start and end time.', start);
    if (end.value <= start.value) return fail('The end time must be after the start time.', end);
    var last = byMonth || !lastDate.value || lastDate.value === date.value ? '' : lastDate.value;
    if (last && last < date.value) return fail('The last day can’t be before the first day.', lastDate);
    if (last && dayDiff(date.value, last) > 31) return fail('A course can run for up to a month. Split longer ones into parts.', lastDate);
    var capN = cap.value === '' ? 0 : parseInt(cap.value, 10);
    if (!Number.isInteger(capN) || capN < 0 || capN > 500) return fail('Places must be a whole number from 0 to 500. Leave it empty for no limit.', cap);
    var count = 1;
    if (!edit && rep.value !== 'none') {
      count = parseInt(cnt.value, 10);
      if (!(count >= 2 && count <= 26)) return fail('Enter between 2 and 26.', cnt);
      if (byMonth && rep.value.charAt(0) !== 'm') return fail('Weekly repeats need a specific day. Pick a monthly repeat, or set a date.', rep);
    }
    var data = {
      title: t, kind: TYPE[cat.value].drill ? 'drill' : 'training', category: cat.value,
      date: byMonth ? '' : date.value, endDate: last, month: byMonth ? mon.value : '',
      start: start.value, end: end.value,
      status: status.value, duration: duration.value, setting: setting.value, provider: provider.value,
      location: loc.value.trim(), trainer: trainer.value.trim(), capacity: capN,
      mandatory: req.checked, notes: notes.value.trim()
    };
    if (edit && !session.unscheduled && signupsOf(session).length && data.date && (data.date !== session.date || data.start !== session.start)) {
      var orig = session.movedFrom || session.date + 'T' + session.start;
      data.movedFrom = orig === data.date + 'T' + data.start ? '' : orig;
    }
    saveBtn.disabled = true;
    try {
      if (edit) {
        await batchWrite([{ op: 'update', path: 'sessions/' + session.id, data: data }]);
        toast('Saved.');
      } else {
        var series = count > 1 ? newId() : '', ops = [];
        for (var i = 0; i < count; i++) {
          var item = Object.assign({}, data, series ? { seriesId: series } : {});
          if (rep.value.charAt(0) === 'm') {
            var step = +rep.value.slice(1) * i;
            if (byMonth) { var md = fromYmd(data.month + '-01'); md.setMonth(md.getMonth() + step); item.month = monthKey(md.getFullYear(), md.getMonth()); }
            else { var dd = fromYmd(data.date); dd.setMonth(dd.getMonth() + step); item.date = ymd(dd); }
          } else if (rep.value !== 'none') {
            item.date = addDays(data.date, i * +rep.value);
          }
          if (last) item.endDate = addDays(item.date, dayDiff(data.date, last));
          ops.push({ op: 'set', path: 'sessions/' + newId(), data: item });
        }
        await batchWrite(ops);
        toast(count > 1 ? 'Added ' + count + ' to the calendar.' : 'Added to the calendar.');
        var d = fromYmd(byMonth ? data.month + '-01' : data.date);
        state.month = { y: d.getFullYear(), m: d.getMonth() };
        if (!byMonth) state.selected = data.date;
      }
      closeModal();
      render();
    } catch (ex) {
      saveBtn.disabled = false;
      fail('Could not save. Only managers can change the calendar. Check your connection and try again.');
    }
  });
  openModal(form, title);
}

function openMoveForm(s) {
  if (!isAdmin()) return;
  state.lastFocus = document.activeElement;
  var date = h('input', { id: 'mv-date', type: 'date', value: s.date || '' });
  var start = h('input', { id: 'mv-start', type: 'time', value: s.start });
  var end = h('input', { id: 'mv-end', type: 'time', value: s.end });
  var info = h('p', { class: 'clash-line', 'aria-live': 'polite' });
  function check() {
    info.textContent = '';
    if (!date.value || !start.value || !end.value) return;
    var c = clashesOf(s, { date: date.value, start: start.value, end: end.value })[0];
    if (c) info.textContent = '⚠ Overlaps “' + c.title + '” at ' + c.start + ' (' + clashWhy(s, c) + ').';
  }
  [date, start, end].forEach(function (x) { x.addEventListener('input', check); x.addEventListener('change', check); });
  var quick = !s.unscheduled && h('div', { class: 'quick span2', role: 'group', 'aria-label': 'Shift the date' },
    [[-7, '−1 week'], [-1, '−1 day'], [1, '+1 day'], [7, '+1 week']].map(function (q) {
      return h('button', { class: 'btn small', type: 'button', onclick: function () { if (date.value) { date.value = addDays(date.value, q[0]); check(); } } }, q[1]);
    }));
  var later = s.seriesId && !s.unscheduled ? state.sessions.filter(function (o) {
    return o.seriesId === s.seriesId && o.id !== s.id && o.date > s.date && endMs(o) >= Date.now();
  }).sort(byStart) : [];
  var all = h('input', { id: 'mv-all', type: 'checkbox' });
  var n = signupsOf(s).length;

  var err = h('p', { class: 'form-error', role: 'alert' });
  var saveBtn = h('button', { class: 'btn primary', type: 'submit' }, s.unscheduled ? 'Set date' : 'Move');
  var form = h('form', { novalidate: true, 'aria-labelledby': 'm-title' },
    h('h2', { id: 'm-title', class: 'modal-title' }, s.unscheduled ? 'Set the day' : 'Move ' + (s.kind === 'drill' ? 'drill' : 'session')),
    h('p', { class: 'muted', style: { margin: '-8px 0 14px' } }, s.title + ' · now ' + whenOf(s) +
      (n ? ' · ' + n + (n === 1 ? ' booking moves' : ' bookings move') + ' with it' : '')),
    h('div', { class: 'form-grid' },
      h('div', { class: 'three span2' }, fld('mv-date', 'New date', date), fld('mv-start', 'Starts', start), fld('mv-end', 'Ends', end)),
      quick,
      later.length > 0 && h('div', { class: 'field check span2' }, all,
        h('label', { for: 'mv-all' }, 'Also move the ' + (later.length === 1 ? 'next one' : later.length + ' later ones') + ' in this series by the same amount')),
      h('div', { class: 'span2' }, info)),
    err,
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'), saveBtn));

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    if (!date.value) { err.textContent = 'Choose a date.'; date.focus(); return; }
    if (!start.value || !end.value) { err.textContent = 'Set a start and end time.'; start.focus(); return; }
    if (end.value <= start.value) { err.textContent = 'The end time must be after the start time.'; end.focus(); return; }
    if (atMs(date.value, start.value) < Date.now()) { err.textContent = 'That time has already passed. Pick a later day or time.'; date.focus(); return; }
    var t = { date: date.value, start: start.value, end: end.value };
    if (s.endDate && s.date) t.endDate = addDays(s.endDate, dayDiff(s.date, t.date));
    var moves = [];
    if (t.date !== s.date || t.start !== s.start || t.end !== s.end) moves.push({ s: s, t: t });
    if (all.checked) {
      var shift = dayDiff(s.date, t.date), retime = t.start !== s.start || t.end !== s.end;
      later.forEach(function (o) {
        moves.push({ s: o, t: { date: addDays(o.date, shift), endDate: o.endDate ? addDays(o.endDate, shift) : '', start: retime ? t.start : o.start, end: retime ? t.end : o.end } });
      });
    }
    closeModal();
    if (!moves.length) return;
    var d = fromYmd(t.date);
    state.selected = t.date;
    state.month = { y: d.getFullYear(), m: d.getMonth() };
    moveSessions(moves, moves.length > 1 ? 'Moved ' + moves.length + ' in the series.' : (s.unscheduled ? 'Scheduled “' : 'Moved “') + s.title + '” for ' + whenText(t) + '.');
  });
  openModal(form, date);
}

/* a manager pushes a reminder now: to people booked, to those not booked yet, or to everyone */
function openRemindForm(s) {
  if (!isAdmin()) return;
  state.lastFocus = document.activeElement;
  var booked = signupsOf(s).filter(function (x) { return x.uid !== state.me.id; }).length;
  var everyone = Object.keys(state.users).filter(function (k) { return state.users[k].active && k !== state.me.id; }).length;
  var unbooked = Math.max(0, everyone - booked);
  var choices = [['booked', 'People booked', booked], ['unbooked', 'People who haven’t booked yet', unbooked], ['everyone', 'Everyone', everyone]];
  var pick = booked ? 'booked' : s.mandatory ? 'unbooked' : 'everyone';
  var group = h('div', { class: 'remind-to', role: 'radiogroup', 'aria-label': 'Send to' }, choices.map(function (c) {
    return h('label', { class: 'field check' },
      h('input', { type: 'radio', name: 'remind-to', value: c[0], checked: c[0] === pick, disabled: !c[2] }),
      c[1] + ' (' + c[2] + ')');
  }));
  var note = h('input', { id: 'rm-note', type: 'text', maxlength: '140', placeholder: 'e.g. Bring hi-vis and closed shoes' });
  var preview = h('p', { class: 'remind-preview' });
  function showPreview() { preview.textContent = 'Reminder: ' + s.title + ' · ' + whenOf(s) + (s.location ? ' · ' + s.location : '') + (note.value.trim() ? ' — ' + note.value.trim() : ''); }
  note.addEventListener('input', showPreview);
  showPreview();
  var err = h('p', { class: 'form-error', role: 'alert' });
  var send = h('button', { class: 'btn primary', type: 'submit' }, 'Send reminder');
  var form = h('form', { novalidate: true, 'aria-labelledby': 'm-title' },
    h('h2', { id: 'm-title', class: 'modal-title' }, 'Send a reminder'),
    h('p', { class: 'muted', style: { margin: '-8px 0 12px' } }, s.title + ' · ' + whenOf(s)),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Send to'), group),
    fld('rm-note', 'Add a note (optional)', note),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'People will see'), preview),
    h('p', { class: 'hint-line' }, 'Only people who turned notifications on, and kept reminders switched on, will get it.'),
    err,
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'), send));
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var to = (form.querySelector('input[name="remind-to"]:checked') || {}).value;
    if (!to) { err.textContent = 'Choose who to send it to.'; return; }
    send.disabled = true;
    try {
      var r = await api('POST', '/api/sessions/' + s.id + '/remind', { to: to, note: note.value });
      closeModal();
      toast(r.people
        ? 'Reminder sent to ' + r.people + (r.people === 1 ? ' person' : ' people') + (r.audience > r.people ? '. ' + (r.audience - r.people) + ' haven’t turned notifications on.' : '.')
        : 'Nobody in that group has notifications turned on yet, so nothing was sent.');
    } catch (ex) { err.textContent = ex.message; send.disabled = false; }
  });
  openModal(form, send);
}

function openModal(form, focusEl, kind) {
  if (kind !== 'detail') state.detailId = null;
  var panel = h('div', { class: 'modal' + (kind ? ' modal-' + kind : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'm-title' }, form);
  panel.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var f = Array.prototype.filter.call(panel.querySelectorAll('button, input, select, textarea'), function (x) { return !x.disabled && x.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  var overlay = h('div', { class: 'overlay' }, panel);
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeModal(); });
  escHandler = function (e) { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', escHandler);
  $('modal-root').replaceChildren(overlay);
  focusEl.focus();
}

/* ---------- sign-in screens ---------- */
function authView() {
  var box = h('section', { class: 'auth' });
  var err = h('p', { class: 'form-error', role: 'alert' });

  if (state.auth === 'loading') { box.append(h('p', { class: 'muted' }, 'Loading…')); return box; }

  if (state.auth === 'badLink') {
    box.append(h('h2', null, 'This link does not work'),
      h('p', null, state.authNote || 'It has expired or was already used. Ask a manager for a new one.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', 'data-fk': 'bl-signin', onclick: function () { state.auth = 'signedOut'; state.authNote = ''; render(); } }, 'Go to sign in')));
    return box;
  }

  var setup = state.auth === 'setup', link = state.auth === 'link' ? state.link : null;
  var joining = link && link.kind === 'invite', resetting = link && link.kind === 'reset';
  var name = h('input', { id: 'a-name', type: 'text', autocomplete: 'name', maxlength: '80' });
  var email = h('input', { id: 'a-email', type: 'email', autocomplete: 'email' });
  var pass = h('input', { id: 'a-pass', type: 'password', autocomplete: setup || link ? 'new-password' : 'current-password' });
  var go = h('button', { class: 'btn primary', type: 'submit' },
    setup ? 'Create admin account' : joining ? 'Join the calendar' : resetting ? 'Save new password' : 'Sign in');
  var form = h('form', { novalidate: true },
    (setup || joining) && fld('a-name', 'Your name', name),
    !link && fld('a-email', 'Email', email),
    fld('a-pass', resetting ? 'New password' : 'Password', pass, setup || link ? 'At least 8 characters.' : null),
    go);
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    err.textContent = '';
    if ((setup || joining) && !name.value.trim()) { err.textContent = 'Enter your name so others can see who booked.'; name.focus(); return; }
    if (!link && !RE_EMAIL.test(email.value.trim())) { err.textContent = 'Enter a valid email address.'; email.focus(); return; }
    if (pass.value.length < 8) { err.textContent = setup || link ? 'Use a password of at least 8 characters.' : 'Enter your password.'; pass.focus(); return; }
    go.disabled = true;
    try {
      var r = setup ? await api('POST', '/api/setup', { name: name.value, email: email.value, password: pass.value })
        : link ? await api('POST', '/api/link/' + encodeURIComponent(link.token), { name: name.value, password: pass.value })
        : await api('POST', '/api/login', { email: email.value, password: pass.value });
      if (link) history.replaceState(null, '', location.pathname);
      enterApp(r.me);
    } catch (ex) { err.textContent = ex.message; go.disabled = false; }
  });

  if (setup) {
    box.append(h('h2', null, 'Set up the calendar'),
      h('p', { class: 'muted' }, 'Create the first admin account. You can invite the rest of the team afterwards.'));
  } else if (joining) {
    box.append(h('h2', null, 'Join Dockside Training'),
      h('p', { class: 'muted' }, 'You were invited as ' + link.email + '. Enter your name and choose a password.'));
  } else if (resetting) {
    box.append(h('h2', null, 'Choose a new password'),
      h('p', { class: 'muted' }, 'For ' + (link.name || link.email) + '.'));
  } else {
    box.append(h('h2', null, 'Sign in'), state.authNote && h('p', { class: 'ok-line' }, state.authNote));
  }
  box.append(form, err);
  if (!setup && !link) box.append(h('p', { class: 'hint-line' }, 'Forgot your password, or new here? Ask a manager.'));
  if (!setup && state.publicRead) {
    box.append(h('div', { class: 'auth-links' }, h('button', { class: 'linkbtn', type: 'button', 'data-fk': 'to-public', onclick: function () {
      if (link) history.replaceState(null, '', location.pathname);
      enterPublic();
    } }, 'Back to the calendar')));
  }
  return box;
}

/* ---------- session lifecycle ---------- */
var loading = null, reloadAgain = false;
async function load() {
  if (loading) { reloadAgain = true; return; }
  loading = (async function () {
    try {
      if (state.auth === 'public') {
        var p = await api('GET', '/api/public');
        setTypes(p.types);
        var pub = p.sessions.map(function (x) { return cleanSession(x.id, x); }).filter(Boolean);
        state.sessions = pub.filter(function (s) { return !s.unscheduled; });
        state.plans = pub.filter(function (s) { return s.unscheduled; });
        state.counts = p.counts || {};
        state.signups = []; state.users = {}; state.invites = [];
        state.loaded = { sessions: true, signups: true };
        state.error = '';
        return;
      }
      var d = await api('GET', '/api/data');
      setTypes(d.types);
      var all = d.sessions.map(function (x) { return cleanSession(x.id, x); }).filter(Boolean);
      state.sessions = all.filter(function (s) { return !s.unscheduled; });
      state.plans = all.filter(function (s) { return s.unscheduled; });
      state.signups = d.signups.map(function (x) { return cleanSignup(x.id, x); }).filter(Boolean);
      var users = {};
      d.users.forEach(function (u) { var c = cleanUser(u); users[c.id] = c; });
      state.users = users;
      state.invites = d.invites || [];
      setMe(d.me);
      state.loaded = { sessions: true, signups: true };
      state.error = '';
    } catch (e) {
      if (state.auth === 'in' || state.auth === 'public') state.error = e.message;
    } finally {
      scheduleRender();
    }
  })();
  await loading;
  loading = null;
  if (reloadAgain) { reloadAgain = false; load(); }
}

function setMe(u) {
  var keep = state.me && state.me.id === u.id ? state.me.notify : null;
  state.me = { id: u.id, name: u.name, email: u.email, role: u.role, admin: u.role === 'manager' || u.role === 'admin', notify: u.notify || keep || {} };
}

function enterApp(me) {
  setMe(me);
  state.auth = 'in';
  state.authNote = '';
  startLive();
  refreshPushState();
}

/* the read-only calendar for anyone who is not signed in */
function enterPublic() {
  state.me = { id: null, name: '', email: '', role: 'staff', admin: false };
  state.auth = 'public';
  state.authNote = '';
  startLive();
}

function startLive() {
  state.loaded = { sessions: false, signups: false };
  render();
  load();
  loadWeather();
  if (state.events) state.events.close();
  /* the server says "something changed" after every save; everyone then reloads the calendar */
  state.events = new EventSource('/api/events');
  state.events.addEventListener('change', function () { load(); });
  state.events.addEventListener('error', function () { if (state.auth === 'in' || state.auth === 'public') load(); });
}

function signedOutBy(note) {
  if (state.events) { state.events.close(); state.events = null; }
  state.sessions = []; state.plans = []; state.signups = []; state.users = {}; state.invites = [];
  state.loaded = { sessions: false, signups: false };
  state.error = '';
  if ($('modal-root').firstChild) closeModal();
  if (state.publicRead) {
    enterPublic();
    if (note) toast(note);
    return;
  }
  state.auth = 'signedOut';
  state.authNote = note || '';
  render();
}

async function doSignOut() {
  /* a shared device should stop getting this person's notifications */
  if (state.push && state.push.subscribed) await disablePush(true);
  try { await api('POST', '/api/logout'); } catch (e) { /* signed out locally either way */ }
  if (window.caches) { try { await caches.delete('data-v1'); } catch (e) { /* nothing saved */ } }
  signedOutBy('');
}

/* ---------- boot ---------- */
/* while a session is held on a touch screen, the finger drags it instead of scrolling the page */
document.addEventListener('touchmove', function (e) { if (state.drag && state.drag.active) e.preventDefault(); }, { passive: false });
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(function () { /* still works without it */ });
}

(async function boot() {
  render();
  var params = new URLSearchParams(location.search);
  var token = params.get('invite') || params.get('reset');
  /* a notification opens the calendar on its day; a home-screen shortcut opens a view */
  var day = params.get('day'), view = params.get('view');
  if (day && RE_DATE.test(day)) {
    var dd = fromYmd(day);
    state.selected = day;
    state.month = { y: dd.getFullYear(), m: dd.getMonth() };
  }
  if (VIEWS.indexOf(view) >= 0) state.view = view;
  if (day || view) history.replaceState(null, '', location.pathname);
  renderInstall();
  try {
    if (token) {
      try { state.publicRead = !!(await api('GET', '/api/status')).publicRead; } catch (e) { /* link screen works without it */ }
      try {
        var l = await api('GET', '/api/link/' + encodeURIComponent(token));
        state.link = { token: token, kind: l.kind, email: l.email, name: l.name };
        state.auth = 'link';
      } catch (e) {
        history.replaceState(null, '', location.pathname);
        state.auth = 'badLink';
        state.authNote = e.message;
      }
      render();
      return;
    }
    var st = await api('GET', '/api/status');
    state.publicRead = !!st.publicRead;
    if (st.setup) { state.auth = 'setup'; render(); return; }
    if (st.me) { enterApp(st.me); return; }
    if (st.publicRead) { enterPublic(); return; }
    state.auth = 'signedOut';
  } catch (e) {
    state.auth = 'signedOut';
    toast(e.message);
  }
  render();
})();
