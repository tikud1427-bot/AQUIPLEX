import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';

// PWA (2026-07) — AQUA's service worker (vite-plugin-pwa, registerType:
// 'autoUpdate') is now a deliberate install target, not the legacy
// cache-first bug this file used to nuke on every load. Registration +
// update-on-deploy is handled by the plugin's injected register script
// (see vite.config.ts); nothing extra needed here. Precaching is scoped to
// static build assets only (see workbox.globPatterns) — API/auth/chat
// endpoints are never cached — so this can't reintroduce the old
// stale-shell-after-deploy problem. The root platform's separate
// EJS-side kill-switch (public/js/sw-cleanup.js, /service-worker.js) is
// unrelated to this app and untouched.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
