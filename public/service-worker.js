const CACHE_NAME = "aquiplex-v2";

// Only cache paths that actually exist as static files.
// EJS-rendered pages (/, /home, etc.) are excluded to avoid stale HTML.
const urlsToCache = [
  "/css/styles.css",
  "/css/home.css",
  "/css/workspace.css",
  "/js/script.js",
  "/logo/favicon.ico"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});