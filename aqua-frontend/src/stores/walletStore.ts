import { create } from 'zustand';
import { getWallet, CREDIT_PACKS_URL, type WalletView } from '@/api/billing';
import { useUiStore } from './uiStore';

/**
 * P1 (freemium) — remaining-quota visibility. Fetched lazily, refreshed after
 * every turn and on tab focus; hides itself entirely when billing is
 * unreachable (older backend / logged out) so it can never break chat.
 */
interface WalletState {
  wallet: WalletView | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

let inFlight: Promise<void> | null = null;
let lastFetch = 0;
const MIN_INTERVAL_MS = 4000; // a turn fires finish+focus together — one fetch is enough

const LOW_NOTICE_KEY = 'aqua-free-low-notice';

/**
 * Should the "running low" note show for this wallet? Pure — exported for tests.
 *
 * Once per allowance day (keyed by freeResetAt), only while the user is living
 * on the free allowance (no purchased credits — someone with a paid balance is
 * not about to be stopped), and only between "low" and empty: the empty case
 * has its own message on the turn that hits it.
 */
export function shouldShowLowNotice(w: WalletView | null, lastShownFor: string | null): boolean {
  if (!w || w.unlimited || w.paid > 0) return false;
  if (!(w.free > 0) || w.free > w.lowThreshold) return false;
  const day = w.freeResetAt ?? 'unknown';
  return lastShownFor !== day;
}

function readLastShown(): string | null {
  try { return localStorage.getItem(LOW_NOTICE_KEY); } catch { return null; }
}
function writeLastShown(day: string) {
  try { localStorage.setItem(LOW_NOTICE_KEY, day); } catch { /* per-viewer convenience only */ }
}

function maybeNotifyLow(w: WalletView | null) {
  if (!shouldShowLowNotice(w, readLastShown())) return;
  writeLastShown(w!.freeResetAt ?? 'unknown');
  const messages = Math.floor(w!.free / 5);
  useUiStore.getState().toast(
    'info',
    `${w!.free} free credits left today`,
    `About ${messages} message${messages === 1 ? '' : 's'}. Your free allowance resets at midnight IST — or add credits any time; purchased credits never expire.`,
    { label: 'View credit packs', onClick: () => { window.location.href = CREDIT_PACKS_URL; } },
  );
}

export const useWalletStore = create<WalletState>((set) => ({
  wallet: null,
  loaded: false,

  refresh: async () => {
    const now = Date.now();
    if (inFlight) return inFlight;
    if (now - lastFetch < MIN_INTERVAL_MS) return;
    lastFetch = now;
    inFlight = (async () => {
      const wallet = await getWallet();
      set({ wallet, loaded: true });
      inFlight = null;
      maybeNotifyLow(wallet);
    })();
    return inFlight;
  },
}));

/** Imperative handle for non-React callers (chatStore after a turn/402). */
export function refreshWallet() {
  void useWalletStore.getState().refresh();
}

/** After a 402 the balance is known to be stale — skip the throttle. */
export function refreshWalletNow() {
  lastFetch = 0;
  void useWalletStore.getState().refresh();
}
