const CACHE_NAME = "aquiplex-v1";

const urlsToCache = [
  "/",
  "/index.html",
  "/css/styles.css",
  "/logo/icon-192.png",
  "/logo/icon-512.png"
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