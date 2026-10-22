/* Service worker: makes the calendar installable on phones.
   Always goes to the network, so the calendar never shows stale sessions.
   Push notifications will be handled here later. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* network only */ });
