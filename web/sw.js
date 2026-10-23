/* Service worker: makes the calendar an installable app that still opens without a connection,
   and shows push notifications even when the calendar is closed.
   Online, everything comes fresh from the server; offline, the last copy is used and marked as such. */
var SHELL = 'shell-v1', DATA = 'data-v1';
var SHELL_FILES = ['./', 'index.html', 'styles.css', 'app.js', 'theme.js', 'manifest.webmanifest',
  'icon.svg', 'icon-192.png', 'apple-touch-icon.png', 'logo-westhaven-marina.svg'];
/* calendar data kept for offline use; signing out deletes it */
var OFFLINE_API = ['/api/status', '/api/data', '/api/public', '/api/weather'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(SHELL_FILES); }).catch(function () { /* first visit offline */ })
    .then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL && k !== DATA; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) {
    if (OFFLINE_API.indexOf(url.pathname) >= 0) e.respondWith(dataFirst(req));
    return;   /* everything else (live updates, changes) needs the server */
  }
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(SHELL).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(function (hit) {
      return hit || (req.mode === 'navigate' ? caches.match('./') : Response.error());
    });
  }));
});

/* network first; a saved copy says when it was saved, so the app can say it is showing older information */
function dataFirst(req) {
  return fetch(req).then(function (res) {
    if (res.ok) {
      res.clone().text().then(function (body) {
        var headers = new Headers(res.headers);
        headers.set('X-Saved-At', String(Date.now()));
        caches.open(DATA).then(function (c) { c.put(req, new Response(body, { status: 200, headers: headers })); });
      });
    }
    return res;
  }).catch(function () {
    return caches.open(DATA).then(function (c) { return c.match(req); }).then(function (hit) {
      if (!hit) return new Response(JSON.stringify({ error: 'You are offline and this has not been saved on this device yet.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      var headers = new Headers(hit.headers);
      headers.set('X-Offline', '1');
      return hit.text().then(function (body) { return new Response(body, { status: 200, headers: headers }); });
    });
  });
}

self.addEventListener('push', function (e) {
  var msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (x) { msg = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'Training calendar', {
    body: msg.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: msg.tag || undefined,
    renotify: !!msg.tag,
    data: { url: msg.url || '/' }
  }));
});

/* tapping a notification opens the calendar on that day, reusing an open window if there is one */
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || '/', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (new URL(list[i].url).origin === self.location.origin && 'focus' in list[i]) {
        return list[i].navigate(url).then(function (c) { return (c || list[i]).focus(); });
      }
    }
    return self.clients.openWindow(url);
  }));
});
