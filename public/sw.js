// App-shell service worker: caches the app's own static files (this page, its JS/CSS, the
// manifest/icon) so the shell loads with zero network, matching the pattern already used by
// the Audit Tool's own PWA. API calls (/api/*) are deliberately left untouched here -- the
// app's own online/offline handling and IndexedDB cache (see app.js) decide what happens with
// those, not this service worker; this file is shell-caching only.
//
// Registered with a relative path ('./sw.js') from app.js, so its scope naturally becomes
// wherever the app itself is served from -- the domain root when standalone, or "/testtag/"
// when reverse-proxied under the Audit Tool -- without needing any proxy-awareness here.
const CACHE_NAME = 'testtag-shell-v2';
const SHELL_FILES = ['./', './index.html', './app.js', './technician-profile.js', './style.css', './manifest.webmanifest', './icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never intercept writes -- those go straight to the network
  const url = new URL(request.url);
  if (url.pathname.includes('/api/')) return; // API calls are the app's own concern, not the shell's

  // Network-first with cache fallback: picks up app updates immediately when online, still
  // works with zero connection by falling back to whatever was last cached.
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
  );
});
