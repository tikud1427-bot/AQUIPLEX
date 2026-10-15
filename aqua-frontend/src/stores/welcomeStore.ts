import { create } from 'zustand';
import { fetchWelcome, type Welcome } from '@/api/welcome';

/* ────────────────────────────────────────────────────────────────────────
   Welcome store — the home screen's one line about this person's world.

   Refreshed when the opening screen mounts and when the window regains
   focus: the server re-reads the current world on every request, so a
   change (a goal finished, a blocker resolved) shows up the next time the
   screen is opened. The previous line stays on screen while a refresh is in
   flight, and is replaced only when the server's `messageId` differs —
   unchanged world, unchanged line, no flicker.

   The in-flight request is an AbortController in state, so resetAllStores
   cancels it on sign-out and a slow response for User A can never land in
   User B's session.
   ──────────────────────────────────────────────────────────────────────── */

interface WelcomeState {
  welcome: Welcome | null;
  failed: boolean;
  inflight: AbortController | null;
  refresh: (opts: { history: boolean }) => Promise<void>;
}

export const useWelcomeStore = create<WelcomeState>((set, get) => ({
  welcome: null,
  failed: false,
  inflight: null,

  refresh: async ({ history }) => {
    get().inflight?.abort();
    const ctrl = new AbortController();
    set({ inflight: ctrl });
    try {
      const next = await fetchWelcome({ history, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      const prev = get().welcome;
      set({ welcome: prev?.messageId === next.messageId ? prev : next, failed: false, inflight: null });
    } catch {
      if (ctrl.signal.aborted) return;
      set({ failed: true, inflight: null });
    }
  },
}));
