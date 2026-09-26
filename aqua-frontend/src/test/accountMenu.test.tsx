import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * The account control, the menu, and the logout lifecycle.
 *
 * These assert BEHAVIOUR and STRUCTURE, not geometry — jsdom has no layout
 * engine, so it can prove the popover is anchored to its trigger and cannot
 * prove it lands in the right place on screen. Placement is e2e/.
 *
 * The bug this feature closes was total: a signed-in user had no way out of
 * their account. Every check below is a property that, if it flips back, brings
 * either that trap or a cross-account leak back with it.
 */

const getAccountStatus = vi.fn();
const logoutSession = vi.fn();
const clearPersistedAppData = vi.fn();

vi.mock('@/api/account', () => ({
  getAccountStatus: (...a: unknown[]) => getAccountStatus(...a),
  logoutSession: (...a: unknown[]) => logoutSession(...a),
  clearPersistedAppData: (...a: unknown[]) => clearPersistedAppData(...a),
}));

const { AccountMenu } = await import('@/components/sidebar/AccountMenu');
const { displayNameFromEmail, initialsFromEmail } = await import('@/lib/identity');
const { useSessionStore, sessionNavigation } = await import('@/stores/sessionStore');
const { useConversationStore } = await import('@/stores/conversationStore');

const USER_A = { email: 'chhanda.prabal.das@example.com', authMethod: 'password' as const, reauthFresh: false };
const USER_B = { email: 'priya@example.com', authMethod: 'google' as const, reauthFresh: false };

let go: ReturnType<typeof vi.fn>;
const initialSession = useSessionStore.getInitialState();

function renderMenu(props: { collapsed?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <AccountMenu {...props} />
    </TooltipProvider>,
  );
}

/** Open the menu the way a keyboard user does — which is also the way that
 *  works in jsdom, where there are no real pointer events. */
function openMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: /^Account:/ }), { key: 'Enter' });
  return screen.findByRole('menu');
}

beforeEach(() => {
  useSessionStore.setState({ ...initialSession }, true);
  go = vi.fn();
  sessionNavigation.go = go;
  getAccountStatus.mockReset().mockResolvedValue({ kind: 'authenticated', account: USER_A });
  logoutSession.mockReset().mockResolvedValue({ ok: true });
  clearPersistedAppData.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Test 1 — the control exists at all ───────────────────────────────────────

describe('the account control', () => {
  it('shows the authenticated user, not a placeholder', async () => {
    await act(async () => { await useSessionStore.getState().load(); });
    renderMenu();

    expect(screen.getByRole('button', { name: `Account: ${USER_A.email}` })).toBeTruthy();
    expect(screen.getByText('Chhanda Prabal Das')).toBeTruthy();
    expect(screen.getByText(USER_A.email)).toBeTruthy();
  });

  it('shows NO identity while the session is still resolving', () => {
    // The flicker bug: rendering a name before the server has answered means
    // rendering the PREVIOUS name after a switch.
    renderMenu();
    expect(screen.getByTestId('account-loading')).toBeTruthy();
    expect(screen.queryByText(USER_A.email)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Account:/ })).toBeNull();
  });

  it('offers a way back in when the session has expired', async () => {
    // Test 13. GET /api/account 401s → getAccountStatus() resolves 'unauthenticated'.
    getAccountStatus.mockResolvedValue({ kind: 'unauthenticated' });
    await act(async () => { await useSessionStore.getState().load(); });
    renderMenu();

    const signIn = screen.getByRole('button', { name: /sign in/i });
    fireEvent.click(signIn);
    expect(go).toHaveBeenCalledWith('/login');
  });

  it('derives name and initials from the email, hard-coding nothing', () => {
    expect(displayNameFromEmail('chhanda.prabal.das@example.com')).toBe('Chhanda Prabal Das');
    expect(displayNameFromEmail('priya@example.com')).toBe('Priya');
    expect(initialsFromEmail('chhanda.prabal.das@example.com')).toBe('CP');
    expect(initialsFromEmail('priya@example.com')).toBe('P');
    expect(initialsFromEmail('a_b@example.com')).toBe('AB');
  });
});

// ── Tests 2, 10, 11 — the menu ───────────────────────────────────────────────

describe('the account menu', () => {
  beforeEach(async () => {
    await act(async () => { await useSessionStore.getState().load(); });
  });

  it('opens on the account control and offers exactly the account actions', async () => {
    renderMenu();
    const menu = await openMenu();

    expect(screen.getByRole('menuitem', { name: /switch account/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /log out/i })).toBeTruthy();
    // Settings is a separate sidebar entry with a different job; duplicating
    // it here was explicitly out of scope.
    expect(screen.queryByRole('menuitem', { name: /settings/i })).toBeNull();
    // The current account is stated inside the menu, not only on the trigger.
    expect(menu.textContent).toContain(USER_A.email);
  });

  it('marks the trigger as a real menu button', async () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: /^Account:/ });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await openMenu();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes when the user clicks outside it', async () => {
    renderMenu();
    await openMenu();

    fireEvent.pointerDown(document.body, { bubbles: true });
    fireEvent.mouseDown(document.body, { bubbles: true });
    fireEvent.focusOut(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('closes on Escape', async () => {
    renderMenu();
    const menu = await openMenu();

    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('is reachable in the collapsed rail too', async () => {
    renderMenu({ collapsed: true });
    expect(screen.getByRole('button', { name: `Account: ${USER_A.email}` })).toBeTruthy();
  });
});

// ── Tests 3, 4, 6, 12 — logging out and switching ────────────────────────────

describe('log out', () => {
  beforeEach(async () => {
    await act(async () => { await useSessionStore.getState().load(); });
  });

  it('calls the existing server logout, then clears the device, then leaves', async () => {
    // Test 3 + Test 4. Order is the security property: a teardown that runs
    // before the server confirms would strand a signed-in user with no data.
    const order: string[] = [];
    logoutSession.mockImplementation(async () => { order.push('server'); return { ok: true }; });
    clearPersistedAppData.mockImplementation(() => { order.push('storage'); });
    go = vi.fn(() => { order.push('navigate'); });
    sessionNavigation.go = go;

    renderMenu();
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /log out/i }));

    await waitFor(() => expect(go).toHaveBeenCalled());
    expect(order).toEqual(['server', 'storage', 'navigate']);
    expect(go).toHaveBeenCalledWith('/login');
  });

  it('sends "switch account" to the login screen with a return to AQUA', async () => {
    // Test 6. Same session teardown — switching accounts is not a lighter
    // operation than logging out, it is logging out plus a destination.
    renderMenu();
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /switch account/i }));

    await waitFor(() => expect(go).toHaveBeenCalled());
    expect(logoutSession).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith('/login?next=%2Faqua');
  });

  /* Test 12 is TWO independent defences and needs two tests.
     A single DOM test cannot tell them apart: with the menu items disabled the
     second click never reaches the store, so removing the store's guard changes
     nothing observable — and with the store's guard in place, un-disabling the
     items changes nothing either. Each mutation is invisible while the other
     defence stands, so each gets a test that can only see one of them. */

  it('the store refuses a second sign-out while one is in flight', async () => {
    let release!: () => void;
    logoutSession.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ ok: true }); }),
    );

    // Straight at the store, past the DOM entirely: this is the guard that has
    // to hold when a keyboard repeat, a double-tap or a second surface fires
    // twice before the first request has come back.
    const first = useSessionStore.getState().signOut('logout');
    const second = useSessionStore.getState().signOut('logout');
    const third = useSessionStore.getState().signOut('switch');

    await act(async () => { release(); await Promise.all([first, second, third]); });

    expect(logoutSession).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledTimes(1);
    // The intent of the FIRST call wins — a later 'switch' must not redirect a
    // logout that was already under way.
    expect(go).toHaveBeenCalledWith('/login');
  });

  it('disables the menu items while a sign-out is in flight', async () => {
    logoutSession.mockImplementation(() => new Promise(() => {})); // never settles

    renderMenu();
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /log out/i }));

    const inProgress = await screen.findByRole('menuitem', { name: /signing out/i });
    expect(inProgress.getAttribute('data-disabled')).not.toBeNull();
    expect(inProgress.getAttribute('aria-disabled')).toBe('true');

    const switcher = screen.getByRole('menuitem', { name: /switch account/i });
    expect(switcher.getAttribute('aria-disabled')).toBe('true');
  });

  it('reports a failure instead of pretending, and leaves the UI usable', async () => {
    logoutSession.mockResolvedValue({ ok: false, message: 'Server unavailable. Try again.' });

    renderMenu();
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /log out/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Server unavailable');
    // Not navigated: the session may still be live, so claiming otherwise
    // would be the worst possible lie to tell here.
    expect(go).not.toHaveBeenCalled();
    expect(clearPersistedAppData).not.toHaveBeenCalled();
    // Still signed in, still able to retry.
    expect(useSessionStore.getState().status).toBe('authenticated');
    expect(useSessionStore.getState().phase).toBe('idle');

    logoutSession.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('menuitem', { name: /log out/i }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('/login'));
  });

  it('never renders a technical failure verbatim', async () => {
    logoutSession.mockResolvedValue({ ok: false });
    renderMenu();
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /log out/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/at .*\(.*:\d+:\d+\)|Error:|TypeError/);
    expect((alert.textContent ?? '').length).toBeGreaterThan(0);
  });
});

// ── Test 7 — the new identity, and only the new identity ─────────────────────

describe('after switching accounts', () => {
  it('shows the new user and nothing of the previous one', async () => {
    getAccountStatus.mockResolvedValue({ kind: 'authenticated', account: USER_A });
    await act(async () => { await useSessionStore.getState().load(); });

    // Whatever User A had loaded (Test 8's subject, checked in depth in
    // sessionIsolation.test.ts) must not survive the switch.
    act(() => {
      useConversationStore.setState({
        items: [{ id: 'a1', title: "User A's private thread", updatedAt: 1, createdAt: 1 }],
      } as never);
    });

    await act(async () => { await useSessionStore.getState().signOut('switch'); });

    // A real switch is a full page load; this is the state the next document
    // would be built from.
    expect(useConversationStore.getState().items).toEqual([]);
    expect(useSessionStore.getState().account).toBeNull();

    // …and the reloaded app resolves User B.
    getAccountStatus.mockResolvedValue({ kind: 'authenticated', account: USER_B });
    useSessionStore.setState({ ...initialSession }, true);
    await act(async () => { await useSessionStore.getState().load(); });

    renderMenu();
    expect(screen.getByRole('button', { name: `Account: ${USER_B.email}` })).toBeTruthy();
    expect(screen.getByText('Priya')).toBeTruthy();
    expect(screen.queryByText(USER_A.email)).toBeNull();
    expect(screen.queryByText('Chhanda Prabal Das')).toBeNull();
  });
});
