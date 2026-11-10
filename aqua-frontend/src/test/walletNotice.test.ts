import { describe, expect, it } from 'vitest';
import { toWalletView } from '@/api/billing';
import { shouldShowLowNotice } from '@/stores/walletStore';

const base = { freeCredits: 15, paidCredits: 0, totalCredits: 15, freeDailyMax: 75, freeResetAt: '2026-11-10T18:30:00.000Z', freeLowThreshold: 15 };

describe('wallet view mirrors the server', () => {
  it('carries the free/paid split and the server allowance', () => {
    const w = toWalletView(base);
    expect(w).toMatchObject({ total: 15, free: 15, paid: 0, freeDailyMax: 75, lowThreshold: 15, unlimited: false });
  });
  it('an older backend without freeDailyMax shows no invented allowance', () => {
    expect(toWalletView({ freeCredits: 3, paidCredits: 1 }).freeDailyMax).toBeNull();
  });
});

describe('low-allowance notice', () => {
  const w = toWalletView(base);
  it('shows once per allowance day at the low line', () => {
    expect(shouldShowLowNotice(w, null)).toBe(true);
    expect(shouldShowLowNotice(w, base.freeResetAt)).toBe(false);
    expect(shouldShowLowNotice(w, '2026-11-09T18:30:00.000Z')).toBe(true);
  });
  it('stays quiet above the line, at zero, with purchased credits, or unlimited', () => {
    expect(shouldShowLowNotice(toWalletView({ ...base, freeCredits: 40 }), null)).toBe(false);
    expect(shouldShowLowNotice(toWalletView({ ...base, freeCredits: 0 }), null)).toBe(false);
    expect(shouldShowLowNotice(toWalletView({ ...base, paidCredits: 500 }), null)).toBe(false);
    expect(shouldShowLowNotice(toWalletView({ ...base, isUnlimited: true }), null)).toBe(false);
  });
});
