import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';

// P0 (cache) — retire any legacy service worker + its caches. A worker
// registered by an old build intercepts every request cache-first and keeps
// serving deleted chunks after deploys. Idempotent; clean browsers no-op.
// Pairs with the kill-switch worker at /service-worker.js and the same
// cleanup on the EJS pages (public/js/sw-cleanup.js).
try {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister().catch(() => {})))
      .catch(() => {});
  }
  if ('caches' in window) {
    caches.keys()
      .then((keys) => keys.forEach((k) => void caches.delete(k)))
      .catch(() => {});
  }
} catch {
  /* cleanup is best-effort */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
