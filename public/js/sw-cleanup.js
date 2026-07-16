/**
 * P0 (cache) — legacy service-worker retirement, page side.
 * Unregisters any installed worker and purges CacheStorage. Idempotent; a
 * clean browser does nothing. Pairs with the kill-switch worker served at
 * /service-worker.js — together they free every stale installation.
 */
(function () {
  try {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations()
        .then(function (regs) { regs.forEach(function (r) { r.unregister().catch(function () {}); }); })
        .catch(function () {});
    }
    if (window.caches && caches.keys) {
      caches.keys()
        .then(function (keys) { keys.forEach(function (k) { caches.delete(k).catch(function () {}); }); })
        .catch(function () {});
    }
  } catch (e) { /* cleanup is best-effort */ }
})();
