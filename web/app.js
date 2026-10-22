/* Dockside Training: staff training calendar, talking to server.js.
   Managers plan, edit and reschedule; staff book places. The server decides who may change what. */

var CATS = [
  { id: 'safety', label: 'Safety & equipment', v: '--c-safety' },
  { id: 'rescue', label: 'First aid & rescue', v: '--c-rescue' },
  { id: 'fire', label: 'Fire & emergency', v: '--c-fire' },
  { id: 'systems', label: 'Systems & IT', v: '--c-systems' },
  { id: 'environment', label: 'Environment', v: '--c-env' },
  { id: 'induction', label: 'Induction & service', v: '--c-induction' }
];
var CAT = {};
CATS.forEach(function (c) { CAT[c.id] = c; });
function catOf(id) { return CAT[id] || CAT.induction; }
function catVar(s) { return 'var(' + catOf(s.category).v + ')'; }

var RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
var RE_MONTH = /^\d{4}-\d{2}$/;
var RE_TIME = /^\d{2}:\d{2}$/;
var RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var STATUSES = ['going', 'attended', 'absent'];

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
function endMs(s) { return atMs(s.date, s.end); }
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
var VIEWS = ['month', 'week', 'agenda', 'mine', 'people'];
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
  auth: 'loading',  /* loading | setup | signedOut | link | badLink | in */
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
  var data = null;
  try { data = await res.json(); } catch (e) { /* empty or not JSON */ }
  if (res.status === 401 && state.auth === 'in') signedOutBy('Your sign-in has ended. Sign in again.');
  if (!res.ok) { var err = new Error((data && data.error) || 'Something went wrong. Try again.'); err.status = res.status; throw err; }
  return data || {};
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
  return {
    id: id, title: d.title.slice(0, 120), category: CAT[d.category] ? d.category : 'induction',
    kind: d.kind === 'drill' ? 'drill' : 'training',
    date: dated ? d.date : '', month: dated ? '' : month, unscheduled: !dated,
    start: start, end: end,
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
  return { id: str(d.id, 64), name: str(d.name, 80), email: str(d.email, 200), role: d.role === 'manager' ? 'manager' : 'staff', active: d.active !== false };
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
  list.slice().sort(byStart).forEach(function (s) { (m[s.date] = m[s.date] || []).push(s); });
  return m;
}
function nameOf(uid) {
  if (uid === state.me.id) return state.me.name || 'You';
  return (state.users[uid] && state.users[uid].name) || 'Former staff member';
}
function isAdmin() { return state.auth === 'in' && state.me.admin; }
function whenOf(s) { return s.unscheduled ? 'Day to be set, ' + monthName(s.month) : fmtDay.format(fromYmd(s.date)) + ', ' + s.start; }

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
  renderWho();
  if (state.auth !== 'in') {
    $('bar').replaceChildren();
    $('filters').hidden = true;
    $('view').replaceChildren(authView());
  } else {
    index();
    if (state.view === 'people' && !state.me.admin) state.view = 'month';
    renderBar(); renderFilters();
    var v = state.view;
    $('view').replaceChildren(v === 'agenda' ? agendaView() : v === 'mine' ? mineView() : v === 'week' ? weekView() : v === 'people' ? peopleView() : monthView());
  }
  if (fk) {
    var el = Array.prototype.find.call(document.querySelectorAll('[data-fk]'), function (e) { return e.dataset.fk === fk; });
    if (el) el.focus({ preventScroll: true });
  }
}

/* ---------- header, tabs, filters ---------- */
function renderWho() {
  var kids = [];
  if (state.auth === 'in') {
    kids.push(h('span', { class: 'who-name' }, state.me.name || state.me.email));
    kids.push(h('span', { class: 'tag tag-accent' }, state.me.admin ? 'Manager' : 'Staff'));
  }
  if (state.auth === 'in') kids.push(h('button', { class: 'btn', type: 'button', 'data-fk': 'signout', onclick: doSignOut }, 'Sign out'));
  $('who').replaceChildren.apply($('who'), kids);
}

function renderBar() {
  var tabs = [['month', 'Month'], ['week', 'Week'], ['agenda', 'Agenda'], ['mine', 'My training']];
  if (state.me.admin) tabs.push(['people', 'People']);
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
  box.hidden = state.view === 'mine' || state.view === 'people';
  var chips = [h('button', {
    class: 'fchip', 'aria-pressed': String(state.filter.size === 0), 'data-fk': 'f-all',
    onclick: function () { state.filter.clear(); render(); }
  }, 'All')];
  CATS.forEach(function (c) {
    chips.push(h('button', {
      class: 'fchip', 'aria-pressed': String(state.filter.has(c.id)), 'data-fk': 'f-' + c.id,
      style: { '--cat': 'var(' + c.v + ')' },
      onclick: function () {
        if (state.filter.has(c.id)) state.filter.delete(c.id); else state.filter.add(c.id);
        render();
      }
    }, h('span', { class: 'sw', 'aria-hidden': 'true' }), c.label));
  });
  box.replaceChildren.apply(box, chips);
}

/* ---------- notices ---------- */
function notices() {
  var out = [];
  var admin = isAdmin();
  if (state.error) {
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
function chip(s) {
  return h('span', { class: 'chip', style: { '--cat': catVar(s) } },
    h('span', { class: 'tm' }, s.start),
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
  var row = h('div', { class: 'plan-row', style: { '--cat': catVar(p) } },
    p.kind === 'drill' && h('span', { class: 'tag tag-drill' }, 'Drill'),
    h('span', { class: 't' }, p.title),
    h('span', { class: 'mono muted' }, p.start + '–' + p.end),
    admin && h('button', { class: 'btn small', type: 'button', 'data-fk': 'pd-' + p.id, onclick: function () { openMoveForm(p); } }, 'Set date'),
    admin && h('button', { class: 'btn quiet small', type: 'button', 'data-fk': 'pe-' + p.id, onclick: function () { openForm(p); } }, 'Edit'));
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
        onclick: function () { selectDay(key); }
      });
      cell.append(h('span', { class: 'num' }, String(d.getDate())));
      var chips = h('div', { class: 'chips' });
      list.slice(0, 2).forEach(function (s) { chips.append(makeDraggable(chip(s), s, 'month')); });
      if (list.length > 2) chips.append(h('span', { class: 'more' }, '+' + (list.length - 2) + ' more'));
      var dots = h('div', { class: 'dots', 'aria-hidden': 'true' });
      list.slice(0, 6).forEach(function (s) { dots.append(h('span', { class: 'dot', style: { '--cat': catVar(s) } })); });
      cell.append(chips, dots);
      grid.append(cell);
    })(i);
  }

  return h('div', null, notices(), plansPanel(monthKey(y, m)),
    h('div', { class: 'cal-layout' }, h('section', null, head, dow, grid), daySheet(state.selected)));
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
    sheet.append(h('p', { class: 'hint-line' }, 'Drag a session onto another day to move it, or use Move. Hold Alt or Ctrl as you drop to copy it instead.'));
  }
  return sheet;
}

/* ---------- week view ---------- */
var HOUR_PX = 44, SNAP = 15, LAST_MIN = 23 * 60 + 45;
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

function weekBlock(o, from, ppm) {
  var s = o.s, ended = endMs(s) < Date.now(), clash = clashesOf(s).length > 0, w = 100 / o.lanes;
  var el = h('button', {
    type: 'button', class: 'wk-ev' + (o.b - o.a < 45 ? ' short' : '') + (ended ? ' past' : '') + (clash ? ' clash' : ''), 'data-fk': 'wb-' + s.id,
    style: {
      '--cat': catVar(s), top: (o.a - from) * ppm + 'px', height: Math.max(18, (o.b - o.a) * ppm - 2) + 'px',
      left: 'calc(' + (o.lane * w) + '% + 2px)', width: 'calc(' + w + '% - 4px)'
    },
    'aria-label': s.title + ', ' + fmtDay.format(fromYmd(s.date)) + ', ' + s.start + ' to ' + s.end + (clash ? ', overlaps another session' : ''),
    onclick: function () { selectInWeek(s.date); }
  },
    h('span', { class: 'tm' }, s.start + '–' + s.end),
    h('span', { class: 't' }, (clash ? '⚠ ' : '') + (s.kind === 'drill' ? 'Drill: ' : '') + s.title),
    s.location && h('span', { class: 'loc' }, s.location));
  if (canMove(s)) el.append(h('span', { class: 'wk-rs', 'aria-hidden': 'true' }));
  return makeDraggable(el, s, 'week');
}

function weekView() {
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

  function nav(label, aria, fn, fk) { return h('button', { class: 'btn small', 'aria-label': aria, 'data-fk': fk, onclick: fn }, label); }
  var head = h('div', { class: 'cal-head' },
    h('h2', { class: 'month-label' }, fmtDM.format(fromYmd(mon)) + ' – ' + fmtDMY.format(fromYmd(days[6]))),
    h('div', { class: 'cal-nav' },
      nav('←', 'Previous week', function () { selectDay(addDays(state.selected, -7)); }, 'wprev'),
      nav('Today', 'Go to today', goToday, 'wtoday'),
      nav('→', 'Next week', function () { selectDay(addDays(state.selected, 7)); }, 'wnext')));

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
    layoutDay(by[k] || []).forEach(function (o) { col.append(weekBlock(o, from, ppm)); });
    wk.append(col);
  });

  var wrap = h('div', { class: 'wk-wrap' }, head, h('div', { class: 'wk-scroll' }, wk));
  if (admin) {
    wrap.append(h('p', { class: 'hint-line' },
      'Drag a session to another day or time, or drag its bottom edge to change how long it runs. Hold Alt or Ctrl as you drop to copy it. ' +
      'On a touch screen, press and hold first. Double-click an empty slot to add something there.'));
  }
  wrap.append(daySheet(state.selected));
  return h('div', null, notices(), wrap);
}

/* ---------- drag to reschedule (mouse, pen and touch) ---------- */
function canMove(s) { return isAdmin() && (s.unscheduled || endMs(s) >= Date.now()); }

function makeDraggable(el, s, mode) {
  if (!canMove(s)) return el;
  el.classList.add('can-drag');
  el.addEventListener('pointerdown', function (e) {
    if (e.target.closest('button') && e.target.closest('button') !== el) return;  /* a row's own buttons stay buttons */
    beginPress(e, el, s, mode);
  });
  el.addEventListener('contextmenu', function (e) { if (state.drag) e.preventDefault(); });
  return el;
}

function beginPress(e, el, s, mode) {
  if (e.button !== 0 || state.drag) return;
  var r = el.getBoundingClientRect();
  var d = {
    s: s, el: el, mode: mode === 'week' && e.target.closest('.wk-rs') ? 'resize' : mode,
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
  if (!w.date) return [];
  var a = atMs(w.date, w.start), b = atMs(w.date, w.end);
  return state.sessions.filter(function (o) {
    return o.id !== s.id && o.date === w.date && startMs(o) < b && endMs(o) > a &&
      (same(s.trainer, o.trainer) || same(s.location, o.location));
  });
}
function clashWhy(s, o) { return same(s.trainer, o.trainer) ? 'same trainer' : 'same location'; }

/* ---------- moving and copying ---------- */
function whenText(t) { return fmtDay.format(fromYmd(t.date)) + ', ' + t.start; }

function dropSession(s, t, copy) {
  if (t.date === s.date && t.start === s.start && t.end === s.end) return;
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
    var patch = { date: t.date, start: t.start, end: t.end };
    var back = { date: s.date, start: s.start, end: s.end };
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
    title: s.title, category: s.category, kind: s.kind, date: t.date, month: '', start: t.start, end: t.end,
    location: s.location, trainer: s.trainer, capacity: s.capacity, mandatory: s.mandatory, notes: s.notes
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
  root.append(wrap);
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
  if (needs.length) wrap.append(section('Required sessions to book', needs, ''));
  wrap.append(section('Your upcoming sessions', booked, 'You have nothing booked. Pick a session from the Month, Week or Agenda view.'));
  wrap.append(section('Your history', history, 'Sessions you have attended will be listed here.'));
  root.append(wrap);
  return root;
}

/* ---------- people (managers only) ---------- */
function peopleView() {
  var root = h('div', { class: 'people' });
  var members = Object.keys(state.users).map(function (k) { return state.users[k]; })
    .filter(function (u) { return u.active; })
    .sort(function (a, b) { return (a.name || a.email).localeCompare(b.name || b.email); });

  var table = h('table', { class: 'ptable' },
    h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Email'), h('th', null, 'Role'), h('th', null, ''))));
  var body = h('tbody');
  members.forEach(function (u) {
    var self = u.id === state.me.id;
    var role = h('select', { 'aria-label': 'Role for ' + (u.name || u.email), 'data-fk': 'role-' + u.id, disabled: self },
      h('option', { value: 'staff', selected: u.role === 'staff' }, 'Staff'),
      h('option', { value: 'manager', selected: u.role === 'manager' }, 'Manager'));
    role.addEventListener('change', async function () {
      try { await api('PATCH', '/api/users/' + u.id, { role: role.value }); toast((u.name || u.email) + ' is now ' + (role.value === 'manager' ? 'a manager.' : 'staff.')); }
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
  root.append(h('section', null,
    h('h2', { class: 'sec-h' }, 'Team (' + members.length + ')'),
    h('p', { class: 'hint-line', style: { marginBottom: '10px' } }, 'Managers can add, edit and move training. Staff can see the calendar and book places. You cannot change your own role, so there is always at least one manager.'),
    table));

  var email = h('input', { id: 'inv-email', type: 'email', autocomplete: 'off', placeholder: 'name@example.com' });
  var role = h('select', { id: 'inv-role' }, h('option', { value: 'staff' }, 'Staff'), h('option', { value: 'manager' }, 'Manager'));
  var err = h('p', { class: 'form-error', role: 'alert' });
  var form = h('form', { class: 'invite-form', novalidate: true },
    fld('inv-email', 'Email address', email), fld('inv-role', 'Role', role),
    h('button', { class: 'btn primary', type: 'submit' }, 'Invite'));
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    err.textContent = '';
    var v = email.value.trim().toLowerCase();
    if (!RE_EMAIL.test(v)) { err.textContent = 'Enter a valid email address.'; email.focus(); return; }
    if (members.some(function (u) { return u.email === v; })) { err.textContent = 'That person is already on the team.'; email.focus(); return; }
    invite(v, role.value).then(function () { email.value = ''; }, function (ex) { err.textContent = ex.message; });
  });
  var inv = h('div', { class: 'cards' });
  state.invites.forEach(function (i) {
    inv.append(h('div', { class: 'sess' },
      h('div', { class: 'sess-top' }, h('span', { class: 'tag' }, i.role === 'manager' ? 'Manager' : 'Staff'),
        h('span', { class: 'hint' }, 'Link works until ' + fmtDay.format(new Date(i.expires)))),
      h('p', { style: { margin: 0, overflowWrap: 'anywhere', fontWeight: 600 } }, i.email),
      h('div', { class: 'sess-actions' },
        h('button', { class: 'btn small', 'data-fk': 'ri-' + i.id, onclick: function () { invite(i.email, i.role).catch(function (ex) { toast(ex.message); }); } }, 'New link'),
        h('button', { class: 'btn quiet small', 'data-fk': 'ci-' + i.id, onclick: function () { cancelInvite(i); } }, 'Cancel invite'))));
  });
  root.append(h('section', null,
    h('h2', { class: 'sec-h' }, 'Invite someone'),
    h('p', { class: 'hint-line', style: { marginBottom: '10px' } }, 'You get a personal sign-up link to send them (text, Teams or email). Only someone with the link can join.'),
    form, err,
    state.invites.length ? h('div', { style: { marginTop: '14px' } }, h('h3', { class: 'sec-h' }, 'Pending invites'), inv) : null));
  return root;
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

function sessionCard(s, opts) {
  var su = signupsOf(s);
  var mine = su.filter(function (x) { return x.uid === state.me.id; })[0] || null;
  var nowT = Date.now();
  var started = !s.unscheduled && startMs(s) <= nowT, ended = !s.unscheduled && endMs(s) < nowT;
  var cap = s.capacity, full = cap > 0 && su.length >= cap;
  var cat = catOf(s.category);
  var open = state.expanded.has(s.id);
  var admin = isAdmin();

  var card = h('article', { class: 'sess' + (ended ? ' past' : ''), style: { '--cat': catVar(s) } });
  card.append(h('div', { class: 'sess-top' },
    h('span', { class: 'cat' }, h('span', { class: 'sw', 'aria-hidden': 'true' }), cat.label),
    s.kind === 'drill' && h('span', { class: 'tag tag-drill' }, 'Drill'),
    s.mandatory && h('span', { class: 'tag tag-req' }, 'Required'),
    s.movedFrom && !ended && h('span', { class: 'tag tag-moved' }, 'Moved from ' + fmtDay.format(fromYmd(s.movedFrom.slice(0, 10))) + ' ' + s.movedFrom.slice(11)),
    s.example && h('span', { class: 'tag' }, 'Example')));
  card.append(h('h3', { class: 'sess-title' }, s.title));
  var when = s.unscheduled
    ? 'Day to be set · ' + monthName(s.month) + ' · ' + s.start + '–' + s.end
    : (opts.showDate ? fmtDay.format(fromYmd(s.date)) + ' · ' : '') + s.start + '–' + s.end;
  card.append(h('ul', { class: 'meta' },
    h('li', { class: 'mono' }, when),
    s.location && h('li', null, s.location),
    s.trainer && h('li', null, 'Trainer: ' + s.trainer)));
  if (s.notes) card.append(h('p', { class: 'sess-notes' }, s.notes));
  var clashes = admin && !ended ? clashesOf(s) : [];
  if (clashes.length) {
    card.append(h('p', { class: 'clash-line' }, '⚠ Overlaps “' + clashes[0].title + '” at ' + clashes[0].start + ' (' + clashWhy(s, clashes[0]) + ')' +
      (clashes.length > 1 ? ' and ' + (clashes.length - 1) + ' more' : '') + '.'));
  }

  if (!s.unscheduled) {
    var capText = cap > 0 ? su.length + ' of ' + cap + ' places taken' : su.length + ' booked';
    card.append(h('div', { class: 'capline' },
      h('span', { class: full ? 'full' : '' }, full ? 'Full · ' + capText : capText),
      cap > 0 && h('span', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: { width: Math.min(100, Math.round(su.length / cap * 100)) + '%' } }))));
  }

  var act = h('div', { class: 'sess-actions' });
  if (s.unscheduled) {
    act.append(h('span', { class: 'hint' }, 'Booking opens once the day is set.'));
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
    mk(-4, { title: 'Manual handling toolbox talk', category: 'safety', start: '09:00', end: '09:30', location: 'Staff room', trainer: 'Site safety lead', capacity: 0, mandatory: false }),
    mk(3, { title: 'Travelift and hardstand safety', category: 'safety', start: '08:00', end: '10:00', location: 'Hardstand', trainer: 'Operations lead', capacity: 6, mandatory: true, notes: 'Wear boots and a hi-vis vest.' }),
    mk(6, { title: 'First aid refresher', category: 'rescue', start: '08:30', end: '16:30', location: 'Training room', trainer: 'External provider', capacity: 12, mandatory: true }),
    mk(9, { title: 'Fire evacuation drill', kind: 'drill', category: 'fire', start: '10:00', end: '11:00', location: 'All sites', trainer: 'Chief fire warden', capacity: 0, mandatory: true }),
    mk(13, { title: 'Fuel and oil spill response', category: 'environment', start: '13:00', end: '15:00', location: 'Fuel dock', trainer: 'Environment officer', capacity: 10, mandatory: false }),
    mk(16, { title: 'Phishing and password basics', category: 'systems', start: '14:00', end: '14:45', location: 'Online', trainer: 'Systems team', capacity: 0, mandatory: false }),
    mk(20, { title: 'New starter induction', category: 'induction', start: '09:00', end: '12:00', location: 'Marina office', trainer: 'Team leader', capacity: 8, mandatory: false }),
    mk(0, { title: 'Person overboard drill', kind: 'drill', category: 'rescue', date: '', month: monthKey(next.getFullYear(), next.getMonth()), start: '07:30', end: '08:30', location: 'Main pier', trainer: 'Dock master', capacity: 0, mandatory: true })
  ];
  for (var w = 0; w < 4; w++) {
    list.push(mk(2 + w * 7, { title: 'Dock walk toolbox talk', category: 'safety', start: '07:30', end: '08:00', location: 'Main pier', trainer: 'Site safety lead', capacity: 0, mandatory: false, seriesId: 'ex-dockwalk' }));
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
  var rows = [['Date', 'Start', 'End', 'Title', 'Type', 'Category', 'Required', 'Person', 'Email', 'Status']];
  state.sessions.slice().sort(byStart).forEach(function (s) {
    var su = signupsOf(s), base = [s.date, s.start, s.end, s.title, s.kind === 'drill' ? 'Drill' : 'Training', catOf(s.category).label, s.mandatory ? 'Yes' : 'No'];
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
  $('modal-root').replaceChildren();
  if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
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
    title: '', kind: 'training', category: 'safety', unscheduled: false, month: '',
    date: (preset && preset.date) || (state.selected >= today ? state.selected : today),
    start: pStart, end: toTime(Math.min(toMin(pStart) + 60, LAST_MIN)), location: '', trainer: '', capacity: 0, mandatory: false, notes: ''
  };
  var title = h('input', { id: 'f-title', type: 'text', maxlength: '120', value: v.title, autocomplete: 'off' });
  var kind = h('select', { id: 'f-kind' },
    h('option', { value: 'training', selected: v.kind === 'training' }, 'Training session'),
    h('option', { value: 'drill', selected: v.kind === 'drill' }, 'Drill'));
  var cat = h('select', { id: 'f-cat' }, CATS.map(function (c) { return h('option', { value: c.id, selected: c.id === v.category }, c.label); }));
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
  var rep = h('select', { id: 'f-rep' },
    h('option', { value: 'none' }, 'Does not repeat'),
    h('option', { value: '7' }, 'Every week'),
    h('option', { value: '14' }, 'Every fortnight'),
    h('option', { value: 'm1' }, 'Every month'),
    h('option', { value: 'm3' }, 'Every 3 months'),
    h('option', { value: 'm6' }, 'Every 6 months'));
  var cnt = h('input', { id: 'f-cnt', type: 'number', min: '2', max: '26', step: '1', value: '4' });
  var dateField = fld('f-date', 'Date', date), monthField = fld('f-month', 'Month', mon);
  var repField = fld('f-rep', 'Repeat', rep, 'Drills often run every 3 or 6 months.', 'span2');
  var cntField = fld('f-cnt', 'How many times', cnt, 'Including the first one.');
  function sync() {
    var byMonth = whenSel.value === 'month';
    dateField.hidden = byMonth; monthField.hidden = !byMonth;
    repField.hidden = edit; cntField.hidden = edit || rep.value === 'none';
  }
  whenSel.addEventListener('change', sync); rep.addEventListener('change', sync);
  sync();

  var err = h('p', { class: 'form-error', id: 'f-err', role: 'alert' });
  var saveBtn = h('button', { class: 'btn primary', type: 'submit' }, edit ? 'Save changes' : 'Add to calendar');
  var cancelBtn = h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel');

  var form = h('form', { novalidate: true, 'aria-labelledby': 'm-title' },
    h('h2', { id: 'm-title', class: 'modal-title' }, edit ? 'Edit ' + (v.kind === 'drill' ? 'drill' : 'session') : 'Add training or a drill'),
    h('div', { class: 'form-grid' },
      fld('f-title', 'Title', title, null, 'span2'),
      fld('f-kind', 'Type', kind),
      fld('f-cat', 'Category', cat),
      fld('f-when', 'When', whenSel, null, 'span2'),
      h('div', { class: 'three span2' }, dateField, monthField, fld('f-start', 'Starts', start), fld('f-end', 'Ends', end)),
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
    if (!t) return fail('Give it a title.', title);
    if (!byMonth && !date.value) return fail('Choose a date.', date);
    if (!start.value || !end.value) return fail('Set a start and end time.', start);
    if (end.value <= start.value) return fail('The end time must be after the start time.', end);
    var capN = cap.value === '' ? 0 : parseInt(cap.value, 10);
    if (!Number.isInteger(capN) || capN < 0 || capN > 500) return fail('Places must be a whole number from 0 to 500. Leave it empty for no limit.', cap);
    var count = 1;
    if (!edit && rep.value !== 'none') {
      count = parseInt(cnt.value, 10);
      if (!(count >= 2 && count <= 26)) return fail('Enter between 2 and 26.', cnt);
      if (byMonth && rep.value.charAt(0) !== 'm') return fail('Weekly repeats need a specific day. Pick a monthly repeat, or set a date.', rep);
    }
    var data = {
      title: t, kind: kind.value, category: cat.value,
      date: byMonth ? '' : date.value, month: byMonth ? mon.value : '',
      start: start.value, end: end.value,
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
    var moves = [];
    if (t.date !== s.date || t.start !== s.start || t.end !== s.end) moves.push({ s: s, t: t });
    if (all.checked) {
      var shift = dayDiff(s.date, t.date), retime = t.start !== s.start || t.end !== s.end;
      later.forEach(function (o) {
        moves.push({ s: o, t: { date: addDays(o.date, shift), start: retime ? t.start : o.start, end: retime ? t.end : o.end } });
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

function openModal(form, focusEl) {
  var panel = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'm-title' }, form);
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
    setup ? 'Create manager account' : joining ? 'Join the calendar' : resetting ? 'Save new password' : 'Sign in');
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
      h('p', { class: 'muted' }, 'Create the first manager account. You can invite the rest of the team afterwards.'));
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
  if (!setup && !link) box.append(h('p', { class: 'hint-line' }, 'Forgot your password, or new here? Ask a manager for a link.'));
  return box;
}

/* ---------- session lifecycle ---------- */
var loading = null, reloadAgain = false;
async function load() {
  if (loading) { reloadAgain = true; return; }
  loading = (async function () {
    try {
      var d = await api('GET', '/api/data');
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
      if (state.auth === 'in') state.error = e.message;
    }
    scheduleRender();
  })();
  await loading;
  loading = null;
  if (reloadAgain) { reloadAgain = false; load(); }
}

function setMe(u) {
  state.me = { id: u.id, name: u.name, email: u.email, role: u.role, admin: u.role === 'manager' };
}

function enterApp(me) {
  setMe(me);
  state.auth = 'in';
  state.authNote = '';
  render();
  load();
  if (state.events) state.events.close();
  /* the server says "something changed" after every save; everyone then reloads the calendar */
  state.events = new EventSource('/api/events');
  state.events.addEventListener('change', function () { load(); });
  state.events.addEventListener('error', function () { if (state.auth === 'in') load(); });
}

function signedOutBy(note) {
  if (state.events) { state.events.close(); state.events = null; }
  state.auth = 'signedOut';
  state.authNote = note || '';
  state.sessions = []; state.plans = []; state.signups = []; state.users = {}; state.invites = [];
  state.loaded = { sessions: false, signups: false };
  state.error = '';
  if ($('modal-root').firstChild) closeModal();
  render();
}

async function doSignOut() {
  try { await api('POST', '/api/logout'); } catch (e) { /* signed out locally either way */ }
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
  try {
    if (token) {
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
    if (st.setup) { state.auth = 'setup'; render(); return; }
    if (st.me) { enterApp(st.me); return; }
    state.auth = 'signedOut';
  } catch (e) {
    state.auth = 'signedOut';
    toast(e.message);
  }
  render();
})();
