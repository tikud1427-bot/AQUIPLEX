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
  freeDailyMax?: number;
  freeResetAt?: string | null;
  freeLowThreshold?: number;
  isUnlimited?: boolean;
  [key: string]: unknown;
}

/**
 * Normalized for the UI. Every number comes from the server's wallet summary —
 * the client never computes an allowance of its own, so what it shows is what
 * the next request will be charged against.
 */
export interface WalletView {
  total: number;
  unlimited: boolean;
  free: number;
  paid: number;
  /** Today's free allowance (server policy). null on an older backend. */
  freeDailyMax: number | null;
  /** When today's free allowance resets (ISO). */
  freeResetAt: string | null;
  /** At or below this many free credits the user is "running low". */
  lowThreshold: number;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Pure — exported for tests. */
export function toWalletView(w: WalletSummary): WalletView {
  const free = num(w.freeCredits);
  const paid = num(w.paidCredits);
  const total =
    typeof w.total === 'number' ? w.total :
    typeof w.totalCredits === 'number' ? w.totalCredits :
    free + paid;
  const freeDailyMax = typeof w.freeDailyMax === 'number' && Number.isFinite(w.freeDailyMax) ? w.freeDailyMax : null;
  return {
    total: Number.isFinite(total) ? total : 0,
    unlimited: !!w.isUnlimited,
    free,
    paid,
    freeDailyMax,
    freeResetAt: typeof w.freeResetAt === 'string' ? w.freeResetAt : null,
    lowThreshold: num(w.freeLowThreshold, 15),
  };
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
    return toWalletView(w);
  } catch {
    return null; // offline — never block the app on billing
  }
}

/** Where "View credit packs" goes from inside Aqua: back here after purchase. */
export const CREDIT_PACKS_URL = '/pricing?next=/aqua';
