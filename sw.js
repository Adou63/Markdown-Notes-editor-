/* sw.js — app-shell service worker for the Notes PWA.
 *
 * Pre-caches the static app shell (HTML/CSS/JS, the vendored Toast UI Editor,
 * fonts and icons) so the app loads and runs fully offline once installed.
 *
 * It deliberately caches ONLY same-origin app assets. The user's notes are
 * real .md files reached through the File System Access API — they never pass
 * through fetch()/the cache and are untouched by this worker.
 *
 * Bump CACHE_VERSION whenever a shell file changes so clients pick it up.
 */
const CACHE_VERSION = 'notes-shell-v1';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './icons.css',
  './app.js',
  './fs.js',
  './manifest.json',
  './favicon.png',
  './icon-192.png',
  './icon-512.png',
  './vendor/toastui-editor-all.min.js',
  './vendor/toastui-editor.min.css',
  './vendor/toastui-editor-dark.min.css',
  './vendor/fonts/hanken-400.woff2',
  './vendor/fonts/hanken-500.woff2',
  './vendor/fonts/hanken-600.woff2',
  './vendor/fonts/hanken-700.woff2',
  './vendor/fonts/newsreader-400.woff2',
  './vendor/fonts/newsreader-400-italic.woff2',
  './vendor/fonts/newsreader-500.woff2',
  './vendor/fonts/newsreader-600.woff2',
];

// Pre-cache the shell on install; activate the new worker immediately.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Drop old caches when a new version activates, then take control of open tabs.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for same-origin GET requests; fall back to the network and cache
// the result. Cross-origin requests are left to the network untouched.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
