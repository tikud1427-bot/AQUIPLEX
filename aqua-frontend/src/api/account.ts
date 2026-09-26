/**
 * Platform account surface — account details + permanent deletion.
 *
 * NOTE: like billing.ts, these routes live at /api/account on the PLATFORM,
 * not under the AQUA engine's /api/aqua base — hence plain fetch with
 * same-origin cookies instead of the shared apiClient.
 */

export type AuthMethod = 'password' | 'google';

export interface AccountInfo {
  email: string;
  /** How this account must reauthenticate before deletion. */
  authMethod: AuthMethod;
  /** True when a Google reauthentication is already on the session and still valid. */
  reauthFresh: boolean;
  createdAt?: string;
}

export interface DeleteAccountResult {
  ok: boolean;
  /** Machine-readable failure code (PASSWORD_INCORRECT, REAUTH_REQUIRED, …). */
  error?: string;
  /** Human sentence, safe to render directly. */
  message?: string;
  authMethod?: AuthMethod;
}

const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };

/**
 * The three, and only three, things GET /api/account can mean.
 *
 * 'unauthenticated' is an AUTHORITATIVE answer from the server: the session is
 * genuinely gone (401), or the server explicitly says there is no account. It
 * is the only kind that may ever cause a signed-in user to be treated as
 * signed out.
 *
 * 'indeterminate' is everything else that isn't a clean 200 with an account:
 * a network failure, a timeout, a 403/5xx, an unreachable backend. The server
 * did not say "you are logged out" — it said nothing, or something else
 * failed — so the caller must not treat this as a logout. A flaky connection
 * must never look identical to an expired session.
 */
export type AccountResult =
  | { kind: 'authenticated'; account: AccountInfo }
  | { kind: 'unauthenticated' }
  | { kind: 'indeterminate'; message: string };

export async function getAccountStatus(): Promise<AccountResult> {
  let res: Response;
  try {
    res = await fetch('/api/account', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    // fetch() itself threw: offline, DNS/TLS failure, or the request never
    // reached a server at all. The server said nothing — not "logged out".
    return {
      kind: 'indeterminate',
      message: "Couldn't reach the server. Check your connection and try again.",
    };
  }

  // The only authoritative "you are not signed in" answer.
  if (res.status === 401) return { kind: 'unauthenticated' };

  if (!res.ok) {
    // 403, 5xx, or anything else: the server answered but did not say the
    // session is invalid. Treating this as a logout would turn a backend
    // hiccup into every open tab silently signing itself out.
    return { kind: 'indeterminate', message: `Server error (HTTP ${res.status}). Please try again.` };
  }

  try {
    const body = (await res.json()) as { success?: boolean; account?: AccountInfo };
    return body?.account
      ? { kind: 'authenticated', account: body.account }
      : { kind: 'unauthenticated' };
  } catch {
    // 200 with an unparsable body is a server bug, not proof of logout.
    return { kind: 'indeterminate', message: 'Unexpected response from the server.' };
  }
}

/**
 * Convenience wrapper for call sites that only ever run while already
 * authenticated and can tolerate collapsing a transient failure into "no
 * update available" (e.g. refreshing account details in a settings pane).
 *
 * Do NOT use this to decide whether to sign someone out — that decision must
 * go through getAccountStatus() and distinguish 'unauthenticated' from
 * 'indeterminate'. See sessionStore.ts.
 */
export async function getAccount(): Promise<AccountInfo | null> {
  const result = await getAccountStatus();
  return result.kind === 'authenticated' ? result.account : null;
}

/**
 * Permanently delete the signed-in account.
 * @param password required for password accounts; ignored for Google accounts
 *                 (they must complete startGoogleReauth() first).
 */
export async function deleteAccount(password?: string): Promise<DeleteAccountResult> {
  try {
    const res = await fetch('/api/account/delete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: jsonHeaders,
      body: JSON.stringify(password ? { password } : {}),
    });

    let body: Partial<DeleteAccountResult> & { success?: boolean } = {};
    try {
      body = await res.json();
    } catch {
      /* empty body — fall through to the status-based message below */
    }

    if (res.ok && body?.success) return { ok: true };

    return {
      ok: false,
      error: body?.error ?? `HTTP_${res.status}`,
      message:
        body?.message ??
        "We couldn't delete your account just now. Please try again, or email support@aquiplex.ai.",
      authMethod: body?.authMethod,
    };
  } catch {
    return {
      ok: false,
      error: 'NETWORK',
      message: "Couldn't reach the server. Check your connection and try again.",
    };
  }
}

/**
 * Send a Google-signed-up user through a fresh OAuth round trip. This is a
 * full-page navigation (an OAuth consent screen can't run in an XHR); the
 * platform returns the browser to `returnTo` with ?deleteReauth=ok, and the
 * Account tab reopens itself and continues.
 */
export function startGoogleReauth(returnTo = '/aqua?settings=account'): void {
  window.location.href = `/auth/google/reauth?next=${encodeURIComponent(returnTo)}`;
}

export interface LogoutResult {
  ok: boolean;
  /** Human sentence, safe to render directly. */
  message?: string;
}

/**
 * End the current session on the SERVER.
 *
 * This is the platform's own mechanism — POST /api/account/logout runs the same
 * req.session.destroy() + clearCookie that GET /logout and the deletion route
 * already run (services/account/sessionLogout.service.js). It is a JSON call
 * rather than a navigation to /logout because the caller has to know whether
 * the session actually died before it claims the user is signed out, and has to
 * tear down client state BEFORE the page goes away.
 *
 * A missing or already-expired session is a SUCCESS: the desired end state is
 * "not signed in", and it is already true. Only a server that could not destroy
 * a live session, or an unreachable server, is a failure.
 */
export async function logoutSession(): Promise<LogoutResult> {
  try {
    const res = await fetch('/api/account/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: jsonHeaders,
      cache: 'no-store',
    });

    if (res.ok) return { ok: true };

    let body: { message?: string } = {};
    try { body = await res.json(); } catch { /* empty body */ }

    return {
      ok: false,
      message: body.message ?? "We couldn't sign you out just now. Please try again.",
    };
  } catch {
    return {
      ok: false,
      message: "Couldn't reach the server. Check your connection and try again.",
    };
  }
}

/**
 * Every localStorage/sessionStorage key the AQUA SPA itself writes.
 *
 * aquiplex.com is a shared origin — the billing/bundles page
 * (views/bundles.ejs) writes its own `aqua_goal` / `aqua_bundle_cache` keys
 * there, and a plain "starts with aqua" prefix match would sweep those up
 * too. So this is an explicit allowlist, not a prefix: it must name every key
 * any Aqua module writes, one line per module below, kept in sync by hand.
 * If you add a new persisted store or sessionStorage marker to the SPA, add
 * its key here or logout will silently leave it behind.
 */
const AQUA_LOCAL_STORAGE_KEYS = [
  'aqua-ui',                 // stores/uiStore.ts
  'aqua-settings',           // stores/settingsStore.ts
  'aqua-conversation-overlay', // stores/conversationStore.ts
] as const;

const AQUA_SESSION_STORAGE_KEYS = [
  'aqua-reloaded-for',            // hooks/useVersionGuard.ts
  'aqua-boundary-reloaded',       // components/feedback/ErrorBoundary.tsx
  'aqua.understanding.dismissed', // hooks/useUnderstandingGate.ts
] as const;

/**
 * Remove everything about the signed-in account that this device wrote to
 * disk — and ONLY that. THIS IS THE WHOLE TEARDOWN FOR A LOGOUT, deliberately
 * scoped to Aqua-owned keys: aquiplex.com hosts other platform features on
 * the same origin (e.g. the bundles/billing page), and logging out of Aqua
 * must not erase their unrelated local state.
 *
 * The service worker caches hashed static assets and Google Fonts only —
 * there is no runtimeCaching rule for /api, so no response containing user
 * data is ever stored there. src/test/sessionIsolation.test.ts asserts that
 * against vite.config.ts, so if an API caching rule is ever added, that test
 * fails and whoever adds it has to extend this function.
 *
 * Best-effort throughout: a browser that blocks storage must never block the
 * redirect to /login.
 */
export function clearPersistedAppData(): void {
  for (const key of AQUA_LOCAL_STORAGE_KEYS) {
    try { localStorage.removeItem(key); } catch { /* storage disabled */ }
  }
  for (const key of AQUA_SESSION_STORAGE_KEYS) {
    try { sessionStorage.removeItem(key); } catch { /* storage disabled */ }
  }
}

/**
 * Everything clearPersistedAppData() does, plus the PWA's cached shell and its
 * service worker.
 *
 * The extra two steps exist for ACCOUNT DELETION, where the account is gone and
 * leaving an installed app pointing at it is wrong. They are not part of logout:
 * unregistering the worker throws away the precached shell and makes the next
 * sign-in slower for no isolation benefit.
 */
export async function clearLocalAppData(): Promise<void> {
  clearPersistedAppData();

  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* cache API unavailable */ }

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch { /* SW unavailable */ }
}
