import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPersistedAppData, getAccountStatus } from '@/api/account';

/**
 * The real @/api/account implementation, deliberately NOT mocked — every
 * other test file mocks this module so it can control what "the session"
 * looks like; this file exists to test the module itself.
 */

const USER_A = { email: 'chhanda@example.com', authMethod: 'password' as const, reauthFresh: false };

describe('getAccountStatus distinguishes real logout from a flaky connection', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reports authenticated on a 200 with an account', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, account: USER_A }),
    }) as unknown as typeof fetch;

    expect(await getAccountStatus()).toEqual({ kind: 'authenticated', account: USER_A });
  });

  it('reports unauthenticated on a real 401 — the only status that means logged out', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;

    expect(await getAccountStatus()).toEqual({ kind: 'unauthenticated' });
  });

  it('reports unauthenticated on a 200 with no account in the body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false }),
    }) as unknown as typeof fetch;

    expect(await getAccountStatus()).toEqual({ kind: 'unauthenticated' });
  });

  it('reports indeterminate — NOT unauthenticated — on a 500', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;

    const result = await getAccountStatus();
    expect(result.kind).toBe('indeterminate');
  });

  it('reports indeterminate — NOT unauthenticated — on a 403', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;

    const result = await getAccountStatus();
    expect(result.kind).toBe('indeterminate');
  });

  it('reports indeterminate — NOT unauthenticated — when fetch itself throws (offline/DNS/TLS)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    const result = await getAccountStatus();
    expect(result.kind).toBe('indeterminate');
  });

  it('reports indeterminate on an unparsable 200 body rather than assuming logout', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }) as unknown as typeof fetch;

    const result = await getAccountStatus();
    expect(result.kind).toBe('indeterminate');
  });
});

describe('clearPersistedAppData scopes to Aqua-owned keys only', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('removes every key an Aqua module writes', () => {
    localStorage.setItem('aqua-ui', '{}');
    localStorage.setItem('aqua-settings', '{}');
    localStorage.setItem('aqua-conversation-overlay', '{}');
    sessionStorage.setItem('aqua-reloaded-for', 'x');
    sessionStorage.setItem('aqua-boundary-reloaded', '1');
    sessionStorage.setItem('aqua.understanding.dismissed', '1');

    clearPersistedAppData();

    expect(localStorage.getItem('aqua-ui')).toBeNull();
    expect(localStorage.getItem('aqua-settings')).toBeNull();
    expect(localStorage.getItem('aqua-conversation-overlay')).toBeNull();
    expect(sessionStorage.getItem('aqua-reloaded-for')).toBeNull();
    expect(sessionStorage.getItem('aqua-boundary-reloaded')).toBeNull();
    expect(sessionStorage.getItem('aqua.understanding.dismissed')).toBeNull();
  });

  it('leaves unrelated platform storage on the same origin untouched', () => {
    // views/bundles.ejs — a different page on the same aquiplex.com origin —
    // writes these. A prefix match on "aqua" would wrongly sweep them up.
    localStorage.setItem('aqua_goal', 'keep-me');
    localStorage.setItem('aqua_bundle_cache', 'keep-me-too');
    sessionStorage.setItem('some_other_platform_marker', 'keep-me-three');

    clearPersistedAppData();

    expect(localStorage.getItem('aqua_goal')).toBe('keep-me');
    expect(localStorage.getItem('aqua_bundle_cache')).toBe('keep-me-too');
    expect(sessionStorage.getItem('some_other_platform_marker')).toBe('keep-me-three');
  });

  it('does not throw when storage is unavailable (private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => clearPersistedAppData()).not.toThrow();
    spy.mockRestore();
  });
});
