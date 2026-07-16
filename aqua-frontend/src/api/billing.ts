/**
 * Platform billing surface (P1 — freemium experience).
 * NOTE: these routes live at /api/billing on the PLATFORM, not under the
 * AQUA engine's /api/aqua base — hence plain fetch with same-origin cookies
 * instead of the shared apiClient.
 */

export interface WalletSummary {
  freeCredits?: number;
  paidCredits?: number;
  total?: number;
  totalCredits?: number;
  isUnlimited?: boolean;
  [key: string]: unknown;
}

/** Normalized for the UI: one number + one flag, whatever the backend shape. */
export interface WalletView {
  total: number;
  unlimited: boolean;
}

export async function getWallet(): Promise<WalletView | null> {
  try {
    const res = await fetch('/api/billing/wallet', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null; // logged out / older backend — chip just hides
    const body = (await res.json()) as { success?: boolean; wallet?: WalletSummary };
    const w = body?.wallet;
    if (!w) return null;
    const total =
      typeof w.total === 'number' ? w.total :
      typeof w.totalCredits === 'number' ? w.totalCredits :
      (Number(w.freeCredits ?? 0) + Number(w.paidCredits ?? 0));
    return { total: Number.isFinite(total) ? total : 0, unlimited: !!w.isUnlimited };
  } catch {
    return null; // offline — never block the app on billing
  }
}
