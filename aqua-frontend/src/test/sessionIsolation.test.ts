import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cross-account data isolation.
 *
 * This is the half of the feature that is a SECURITY BOUNDARY rather than a UI
 * transition. The failure it guards is silent by construction: User B signs in,
 * the shell paints, and User A's conversations are still on screen. Nothing
 * throws, nothing logs, the build is green.
 *
 * Two kinds of check live here, and the second kind is the one that keeps
 * working after everyone forgets this file exists:
 *
 *   BEHAVIOURAL   seed every store with User A, sign out, assert it is gone
 *   STRUCTURAL    read the source tree and assert the reset registry, the
 *                 login route and the service-worker config still agree with
 *                 what the behavioural half assumes
 *
 * A completeness check with a hand-maintained list is not a completeness check,
 * so nothing below names a file it did not find on disk.
 */

const SRC = path.resolve(__dirname, '..');

const getAccountStatus = vi.fn();
const logoutSession = vi.fn();
const clearPersistedAppData = vi.fn();

vi.mock('@/api/account', () => ({
  getAccountStatus: (...a: unknown[]) => getAccountStatus(...a),
  logoutSession: (...a: unknown[]) => logoutSession(...a),
  clearPersistedAppData: (...a: unknown[]) => clearPersistedAppData(...a),
}));

const { useSessionStore, sessionNavigation } = await import('@/stores/sessionStore');
const { RESETTABLE_STORES, RESET_EXEMPT_STORES, resetAllStores } = await import('@/stores/resetAll');
const { useChatStore } = await import('@/stores/chatStore');
const { useConversationStore } = await import('@/stores/conversationStore');
const { useMindStore } = await import('@/stores/mindStore');
const { useUploadStore } = await import('@/stores/uploadStore');
const { useArtifactsStore } = await import('@/stores/artifactsStore');
const { useSettingsStore } = await import('@/stores/settingsStore');
const { useWalletStore } = await import('@/stores/walletStore');
const { useAttachmentStore } = await import('@/stores/attachmentStore');

const initialSession = useSessionStore.getInitialState();

/** Everything a signed-in account accumulates, as User A would leave it. */
function seedUserA() {
  useConversationStore.setState({
    items: [{ id: 'a1', title: "User A's private thread", updatedAt: 1, createdAt: 1 }],
  } as never);
  useChatStore.setState({
    messages: [{ id: 'm1', role: 'user', content: "User A's secret" }],
    conversationId: 'conv-a',
  } as never);
  useMindStore.setState({
    model: { summary: "What AQUA understands about User A" },
    learnings: [{ id: 'l1', ts: 1, kind: 'new', text: "User A's belief" }],
    hasLoadedOnce: true,
  } as never);
  useUploadStore.setState({
    workspaceId: 'ws-a',
    projectName: "User A's project",
    overview: { files: 3 },
  } as never);
  useArtifactsStore.setState({
    items: [{ id: 'art-a', title: "User A's artifact" }],
    loadedOnce: true,
  } as never);
  useSettingsStore.setState({ developerMode: true, fontSize: 'lg' } as never);
  useWalletStore.setState({ wallet: { balance: 9999 }, loaded: true } as never);
  useAttachmentStore.setState({ items: [{ localId: 'f1', name: 'user-a.pdf' }] } as never);

  /* A key the store's OWN initial shape does not contain. zustand's setState
     merges, so state can accumulate keys no reset that also merges will ever
     remove — the leak that survives a "reset" and is invisible to any fixture
     built only from keys the store already declares. */
  useChatStore.setState({ leakedFromUserA: "User A's stray key" } as never);

  localStorage.setItem('aqua-conversation-overlay', JSON.stringify({ state: { titles: { a1: 'A' } } }));
  sessionStorage.setItem('aqua-understanding-dismissed', '1');
}

/** Every value reachable in the store, flattened, as a searchable string. */
function allStoreText(): string {
  return Object.values(RESETTABLE_STORES)
    .map((s) => JSON.stringify(s.getState(), (_k, v) => (typeof v === 'function' ? undefined : v)))
    .join('\n');
}

beforeEach(() => {
  useSessionStore.setState({ ...initialSession }, true);
  sessionNavigation.go = vi.fn();
  getAccountStatus.mockReset().mockResolvedValue({
    kind: 'authenticated',
    account: { email: 'chhanda@example.com', authMethod: 'password', reauthFresh: false },
  });
  logoutSession.mockReset().mockResolvedValue({ ok: true });
  clearPersistedAppData.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => { vi.restoreAllMocks(); });

// ── Tests 8 and 9 — nothing of the previous account survives ─────────────────

describe('signing out empties every store that held account data', () => {
  it('leaves no trace of the previous user anywhere in client state', async () => {
    seedUserA();
    expect(allStoreText()).toContain('User A');

    await useSessionStore.getState().signOut('switch');

    const remaining = allStoreText();
    expect(remaining).not.toContain('User A');
    expect(remaining).not.toContain('conv-a');
    expect(remaining).not.toContain('ws-a');
  });

  it('restores each store to its OWN initial state, not to an empty object', async () => {
    // A reset that wipes the actions along with the data leaves a store that
    // cannot be used by the next account — a different, equally broken outcome.
    seedUserA();
    await useSessionStore.getState().signOut();

    for (const [name, store] of Object.entries(RESETTABLE_STORES)) {
      const state = store.getState() as unknown as Record<string, unknown>;
      const initial = store.getInitialState() as unknown as Record<string, unknown>;
      // Exactly the initial keys: no key lost, and no key SURVIVING. A reset
      // that merges passes the first half and fails the second.
      expect(Object.keys(state).sort(), `${name} did not return to its initial shape`)
        .toEqual(Object.keys(initial).sort());
      const actions = Object.entries(initial).filter(([, v]) => typeof v === 'function');
      for (const [key] of actions) {
        expect(typeof state[key], `${name}.${key} is no longer callable`).toBe('function');
      }
    }
  });

  it('cancels work that is still in flight', async () => {
    // A stream that resolves after the identity changed writes the previous
    // account's tokens into the next account's UI.
    const controller = new AbortController();
    useChatStore.setState({ generating: true, abortController: controller } as never);

    await useSessionStore.getState().signOut();

    expect(controller.signal.aborted).toBe(true);
  });

  it('clears the persisted keys as well as the in-memory ones', async () => {
    seedUserA();
    await useSessionStore.getState().signOut();
    expect(clearPersistedAppData).toHaveBeenCalledTimes(1);
  });

  it('drops the identity itself', async () => {
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().status).toBe('authenticated');

    await useSessionStore.getState().signOut();

    expect(useSessionStore.getState().account).toBeNull();
    expect(useSessionStore.getState().status).toBe('unauthenticated');
  });

  it('keeps everything when the server logout FAILED', async () => {
    // The inverse property, and the one that proves the teardown is gated on
    // the server rather than fired optimistically. A user who is still signed
    // in must still have their data.
    seedUserA();
    logoutSession.mockResolvedValue({ ok: false, message: 'nope' });

    await useSessionStore.getState().signOut();

    expect(allStoreText()).toContain('User A');
    expect(clearPersistedAppData).not.toHaveBeenCalled();
  });
});

// ── Structural completeness ──────────────────────────────────────────────────

describe('the reset registry is complete by construction', () => {
  const storeFiles = fs
    .readdirSync(path.join(SRC, 'stores'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  const declared = storeFiles.flatMap((f) => {
    const src = fs.readFileSync(path.join(SRC, 'stores', f), 'utf8');
    return [...src.matchAll(/export const (use\w*Store)\b/g)].map((m) => m[1]);
  });

  it('found the stores by reading the directory, not by being told', () => {
    // Guards the guard: a regex that silently matches nothing would make every
    // assertion below vacuously true.
    expect(declared.length).toBeGreaterThanOrEqual(9);
    expect(declared).toContain('useChatStore');
    expect(declared).toContain('useSessionStore');
  });

  it('names every store on disk exactly once, minus the documented exemption', () => {
    const covered = [...Object.keys(RESETTABLE_STORES), ...RESET_EXEMPT_STORES].sort();
    expect(covered).toEqual([...declared].sort());
  });

  it('names nothing that does not exist', () => {
    for (const name of Object.keys(RESETTABLE_STORES)) {
      expect(declared, `${name} is registered but no longer exists`).toContain(name);
    }
  });

  it('the exemption is the session store and nothing else', () => {
    // The one store that must NOT be reset is the one driving the reset. Any
    // other name appearing here is a store quietly opting out of isolation.
    expect([...RESET_EXEMPT_STORES]).toEqual(['useSessionStore']);
  });

  it('resetAllStores is idempotent', () => {
    resetAllStores();
    const once = allStoreText();
    resetAllStores();
    expect(allStoreText()).toEqual(once);
  });
});

// ── Test 5 — the authenticated surface after logout ──────────────────────────

describe('the authenticated surface is unreachable once the session is gone', () => {
  const clientSrc = fs.readFileSync(path.join(SRC, 'api', 'client.ts'), 'utf8');
  const routesSrc = fs.readFileSync(path.join(SRC, 'api', 'routes.ts'), 'utf8');

  it('every 401 from the engine sends the browser to the login page, preserving where it was', () => {
    // The SPA has no client-side route guard by design — /aqua's shell is
    // served ungated so the PWA manifest is readable. What actually protects
    // the app is requireLogin on /api/aqua/* server-side plus this interceptor,
    // so once the session is destroyed the first gated call ejects the user.
    // It must land them back where they were (loginWithReturn), not strip
    // their current route — see routes.ts's `?next=`.
    expect(clientSrc).toMatch(/status === 401/);
    expect(clientSrc).toMatch(/loginWithReturn/);
    expect(clientSrc).toMatch(/window\.location\.replace/);
    expect(routesSrc).toMatch(/LOGIN_PATH = '\/login'/);
  });

  it('uses replace(), not href, so a signed-out user cannot Back into a dead page', () => {
    expect(clientSrc).not.toMatch(/window\.location\.href\s*=/);
  });

  it('the interceptor does not let the caller continue after a 401', () => {
    // Returning a rejected promise here would let a component render its own
    // error state — and keep the previous account's shell on screen — while
    // the navigation is still pending.
    expect(clientSrc).toMatch(/return new Promise\(\(\) => \{\}\)/);
  });

  it('logout and the 401 interceptor agree on where the login page is', () => {
    // Two literals for one route will drift; both now read the same constant.
    const sessionSrc = fs.readFileSync(path.join(SRC, 'stores', 'sessionStore.ts'), 'utf8');
    expect(sessionSrc).toMatch(/LOGIN_PATH/);
    expect(sessionSrc).not.toMatch(/['"]\/login['"]/);
    expect(clientSrc).not.toMatch(/['"]\/login['"]/);
  });
});

// ── The false-logout bug: network/5xx must never look like a 401 ────────────

describe('a session check that cannot get an authoritative answer is not a logout', () => {
  it('keeps a known-authenticated session when the next check is indeterminate', async () => {
    await useSessionStore.getState().load(); // authenticated, from the top-level mock
    expect(useSessionStore.getState().status).toBe('authenticated');

    getAccountStatus.mockResolvedValue({ kind: 'indeterminate', message: 'offline' });
    await useSessionStore.getState().load();

    expect(useSessionStore.getState().status).toBe('authenticated');
    expect(useSessionStore.getState().account).not.toBeNull();
    expect(useSessionStore.getState().connectionError).toBe('offline');
  });

  it('does not claim "unauthenticated" on a first indeterminate check either', async () => {
    getAccountStatus.mockResolvedValue({ kind: 'indeterminate', message: 'timed out' });
    await useSessionStore.getState().load();

    // Neither a false "signed in" nor a false "signed out" — stays 'loading'
    // so the UI shows a retry state instead of bouncing to /login.
    expect(useSessionStore.getState().status).toBe('loading');
    expect(useSessionStore.getState().connectionError).toBe('timed out');
  });

  it('only an authoritative 401 (unauthenticated) actually signs the user out', async () => {
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().status).toBe('authenticated');

    getAccountStatus.mockResolvedValue({ kind: 'unauthenticated' });
    await useSessionStore.getState().load();

    expect(useSessionStore.getState().status).toBe('unauthenticated');
    expect(useSessionStore.getState().account).toBeNull();
  });

  it('clears connectionError once a check resolves authoritatively', async () => {
    getAccountStatus.mockResolvedValue({ kind: 'indeterminate', message: 'offline' });
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().connectionError).toBe('offline');

    getAccountStatus.mockResolvedValue({ kind: 'unauthenticated' });
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().connectionError).toBeNull();
  });
});



// ── The assumption the narrow teardown rests on ──────────────────────────────

describe('the service worker holds no account data', () => {
  it('caches no /api response at runtime', () => {
    // clearPersistedAppData() deliberately does NOT unregister the service
    // worker or purge its caches, because those hold hashed static assets and
    // Google Fonts only. The moment a runtimeCaching rule matches /api, that
    // stops being true and logout starts leaking responses between accounts.
    const vite = fs.readFileSync(path.resolve(SRC, '..', 'vite.config.ts'), 'utf8');
    const block = vite.slice(vite.indexOf('runtimeCaching'));
    const patterns = [...block.matchAll(/urlPattern:\s*([^\n]+)/g)].map((m) => m[1]);

    expect(patterns.length).toBeGreaterThan(0); // the block was actually found
    for (const p of patterns) {
      expect(p, `runtimeCaching now matches an API path: ${p}`).not.toMatch(/\/api/);
    }
  });
});
