// Minimal service worker — exists only so the browser considers this page
// installable as an app. Deliberately does no caching: this is a live
// Firestore-backed dashboard, and stale cached data or JS would be actively
// harmful here, not helpful. Every request just passes straight through to
// the network, same as if there were no service worker at all.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
