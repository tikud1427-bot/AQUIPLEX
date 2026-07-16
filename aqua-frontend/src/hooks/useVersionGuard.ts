import { useEffect } from 'react';
import { useUiStore } from '@/stores/uiStore';

/**
 * P0 (cache) — deploy detection + stale-bundle self-healing.
 *
 * Problem this solves: after a deploy, an open tab keeps running the OLD
 * bundle. Its lazy imports point at hashed chunk files the new deploy
 * deleted, so parts of the UI (menus, panels) silently fail until the user
 * clears their cache. Two independent recovery paths:
 *
 *   1. PROACTIVE — poll /aqua/build.json (no-store) on an interval and on
 *      tab focus. The server reads the build id stamped into the CURRENT
 *      dist/index.html; the app compares against its own baked-in
 *      __BUILD_ID__. Mismatch → toast + hard reload.
 *
 *   2. REACTIVE — Vite fires `vite:preloadError` when a dynamic import's
 *      chunk 404s (the classic stale-deploy signature). Reload immediately;
 *      the fresh shell fetches matching chunks.
 *
 * Loop safety: a sessionStorage marker keyed by the id we reloaded FOR
 * guarantees at most one automatic reload per new build per tab.
 */

const POLL_MS = 5 * 60 * 1000;
const RELOAD_MARK = 'aqua-reloaded-for';

function reloadOnceFor(reason: string) {
  try {
    if (sessionStorage.getItem(RELOAD_MARK) === reason) return; // already tried
    sessionStorage.setItem(RELOAD_MARK, reason);
  } catch {
    /* private mode — still reload, just without the loop guard */
  }
  window.location.reload();
}

async function checkBuild(toast: (v: 'info', t: string, d?: string) => unknown) {
  try {
    const res = await fetch('/aqua/build.json', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return; // logged out / server hiccup — never reload on uncertainty
    const { buildId } = (await res.json()) as { buildId?: string };
    if (!buildId || buildId === 'unbuilt' || buildId === 'unstamped') return;
    if (buildId !== __BUILD_ID__) {
      toast('info', 'AQUA was updated', 'Reloading to the newest version…');
      window.setTimeout(() => reloadOnceFor(buildId), 1200);
    }
  } catch {
    /* offline — poller will try again */
  }
}

export function useVersionGuard() {
  const toast = useUiStore((s) => s.toast);

  useEffect(() => {
    // Reactive path — stale chunk import failed (deploy raced this tab).
    const onPreloadError = (e: Event) => {
      e.preventDefault?.(); // suppress Vite's rethrow; we're handling it
      reloadOnceFor(`chunk-${__BUILD_ID__}`);
    };
    window.addEventListener('vite:preloadError', onPreloadError);

    // Proactive path — poll + focus/visibility checks.
    const onFocus = () => { if (document.visibilityState === 'visible') void checkBuild(toast); };
    const interval = window.setInterval(() => void checkBuild(toast), POLL_MS);
    window.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    void checkBuild(toast); // once on mount — catches "tab restored after deploy"

    return () => {
      window.removeEventListener('vite:preloadError', onPreloadError);
      window.clearInterval(interval);
      window.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [toast]);
}
