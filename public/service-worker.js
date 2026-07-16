/**
 * AQUIPLEX Service Worker — PERMANENT KILL-SWITCH (P0 cache fix)
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous worker at this URL cached EVERYTHING cache-first ("aquiplex-v2")
 * with no activate cleanup and no update handling. Registration code was later
 * removed from the app, but installed workers live in browsers forever — so
 * users kept getting a stale app shell that referenced deleted hashed chunks
 * after every deploy ("three-dot menu disappears until cache clear").
 *
 * This replacement, served at the SAME url with Cache-Control: no-cache, is
 * picked up by every existing installation on its next update check. It:
 *   1. skipWaiting()            — takes over immediately, no tab-close needed
 *   2. deletes ALL CacheStorage — every stale shell/chunk/page gone
 *   3. clients.claim()          — controls open tabs right away
 *   4. unregister()             — removes itself; browser returns to plain
 *                                 network + HTTP caching (which index.js now
 *                                 configures correctly)
 *   5. reloads open tabs once   — they immediately fetch the fresh build
 *
 * There is NO fetch handler: from the moment this activates, zero requests
 * are intercepted. KEEP THIS FILE DEPLOYED at /service-worker.js permanently
 * so stragglers who haven't visited in months still get cleaned up.
 */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (e) {
        /* cache cleanup is best-effort */
      }
      try {
        await self.clients.claim();
      } catch (e) {}
      try {
        await self.registration.unregister();
      } catch (e) {}
      // Reload every open tab exactly once so it refetches from the network.
      // The worker is already unregistered, so the reload cannot loop.
      try {
        const clientList = await self.clients.matchAll({ type: "window" });
        for (const client of clientList) {
          if ("navigate" in client) client.navigate(client.url).catch(() => {});
        }
      } catch (e) {}
    })()
  );
});
