import { create } from 'zustand';
import { getWallet, type WalletView } from '@/api/billing';

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
    })();
    return inFlight;
  },
}));

/** Imperative handle for non-React callers (chatStore after a turn/402). */
export function refreshWallet() {
  void useWalletStore.getState().refresh();
}
