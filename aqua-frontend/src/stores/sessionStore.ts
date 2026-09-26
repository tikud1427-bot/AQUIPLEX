import { create } from 'zustand';
import {
  clearPersistedAppData,
  getAccountStatus,
  logoutSession,
  type AccountInfo,
} from '@/api/account';
import { APP_PATH, LOGIN_PATH, loginWithReturn } from '@/api/routes';
import { resetAllStores } from './resetAll';

/**
 * Who is signed in, and the two ways to stop being them.
 *
 * DELIBERATELY NOT PERSISTED. Every other store in this directory that survives
 * a reload does so through zustand's persist middleware; this one must not.
 * An identity read from localStorage is an identity that can be stale, and a
 * stale identity rendered in the sidebar is the exact failure this feature
 * exists to prevent. The signed-in user is whatever GET /api/account says on
 * this page load, and nothing else.
 */

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

/** What, if anything, is currently tearing the session down. */
export type SessionPhase = 'idle' | 'signing-out' | 'switching';

/** Why we are ending the session — it decides where the browser lands. */
export type SignOutIntent = 'logout' | 'switch';

/**
 * The one full-page navigation in this store, behind an indirection so tests
 * can observe it. jsdom does not implement navigation, and a test that cannot
 * see where logout sent the user cannot prove logout sent them anywhere.
 */
export const sessionNavigation = {
  go(url: string) {
    // replace(), not assign(): the authenticated app must not be one Back
    // button away from a signed-out user.
    window.location.replace(url);
  },
};

interface SessionState {
  status: SessionStatus;
  account: AccountInfo | null;
  phase: SessionPhase;
  /** Last logout failure, already a human sentence. Never a stack trace. */
  error: string | null;
  /**
   * Set when the last account check could not get an authoritative answer
   * (network failure, timeout, 403/5xx) — as opposed to a real 401. Distinct
   * from `error`: this is never a reason to sign anyone out, only to show a
   * "couldn't check" state and offer retry. Cleared the moment a check
   * resolves either way.
   */
  connectionError: string | null;
  /** A GET /api/account is in flight. */
  fetching: boolean;

  load: () => Promise<void>;
  signOut: (intent?: SignOutIntent) => Promise<void>;
  dismissError: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  status: 'loading',
  account: null,
  phase: 'idle',
  error: null,
  connectionError: null,
  fetching: false,

  /**
   * Resolve the current identity. Starts at 'loading' and only ever moves to
   * 'unauthenticated' on an AUTHORITATIVE answer (a real 401), so the account
   * control renders a placeholder rather than guessing at a name it does not
   * have yet — and a flaky connection never gets mistaken for a logout.
   *
   * Callable again as a retry: a prior indeterminate result does not block a
   * fresh attempt (only `fetching` does, to collapse StrictMode's double
   * mount into one request).
   */
  load: async () => {
    if (get().fetching) return; // React StrictMode double-mounts; one call is enough
    set({ fetching: true });

    const result = await getAccountStatus();

    if (result.kind === 'authenticated') {
      set({ fetching: false, account: result.account, status: 'authenticated', connectionError: null });
      return;
    }

    if (result.kind === 'unauthenticated') {
      set({ fetching: false, account: null, status: 'unauthenticated', connectionError: null });
      return;
    }

    // Indeterminate: the server never said "logged out". If we already knew
    // this session was authenticated, keep that — do not let a network blip
    // overwrite a known-good identity. Otherwise stay in 'loading' (not
    // 'unauthenticated') so the UI shows "couldn't check" rather than a
    // false sign-in prompt.
    const wasAuthenticated = get().status === 'authenticated';
    set({
      fetching: false,
      status: wasAuthenticated ? 'authenticated' : 'loading',
      connectionError: result.message,
    });
  },

  /**
   * End the session, then leave.
   *
   * ORDER IS THE SECURITY PROPERTY, not a detail:
   *
   *   1. server first   — nothing is claimed until the session is really gone
   *   2. in-memory next — cancels in-flight streams, empties every store
   *   3. on-disk next   — the persisted overlay, settings and UI keys
   *   4. navigate last  — a hard navigation, which also tears down module scope
   *
   * Doing 2 and 3 before 1 would leave a user with a live session and no data
   * on a failed request. Doing 4 before 2 would rely on the browser to do the
   * isolation for us, and would leave the previous account's conversations on
   * screen for as long as the navigation takes.
   */
  signOut: async (intent: SignOutIntent = 'logout') => {
    // Duplicate-submit guard. Not cosmetic: a second POST arriving after the
    // first destroyed the session is fine on its own, but a second teardown
    // racing the first navigation is not.
    if (get().phase !== 'idle') return;

    set({ phase: intent === 'switch' ? 'switching' : 'signing-out', error: null });

    const result = await logoutSession();

    if (!result.ok) {
      // Do NOT pretend. The session may still be live, so the user stays where
      // they are, with a sentence they can act on and a UI that still works.
      set({
        phase: 'idle',
        error: result.message ?? "We couldn't sign you out. Please try again.",
      });
      return;
    }

    resetAllStores();
    set({ status: 'unauthenticated', account: null });
    clearPersistedAppData();

    sessionNavigation.go(intent === 'switch' ? loginWithReturn(APP_PATH) : LOGIN_PATH);
  },

  dismissError: () => set({ error: null }),
}));
