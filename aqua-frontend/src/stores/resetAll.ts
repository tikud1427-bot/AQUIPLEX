import { useArtifactsStore } from './artifactsStore';
import { useAttachmentStore } from './attachmentStore';
import { useChatStore } from './chatStore';
import { useConversationStore } from './conversationStore';
import { useMindStore } from './mindStore';
import { useSettingsStore } from './settingsStore';
import { useUiStore } from './uiStore';
import { useUploadStore } from './uploadStore';
import { useWalletStore } from './walletStore';
import { useWelcomeStore } from './welcomeStore';

/**
 * Every store that holds data belonging to the signed-in account, and must be
 * emptied the moment the authenticated identity changes.
 *
 * WHY A REGISTRY AND NOT A reset() ON EACH STORE
 * ----------------------------------------------
 * A per-store reset() is nine methods that each have to be remembered, kept in
 * step with the store's own shape, and called from one place that also has to
 * be remembered. zustand exposes getInitialState(), so the store already knows
 * its own empty shape — the only thing missing was a list of stores, and a
 * hand-maintained list of what to be complete over is not completeness.
 *
 * So src/test/sessionIsolation.test.ts READS src/stores/ and asserts, in both
 * directions, that this registry names every store there except the session
 * store itself. A new store is uncovered for exactly as long as it takes to run
 * the tests.
 *
 * useSessionStore is the one exclusion, and it is structural rather than a
 * judgement call: it is the store DRIVING the reset, and blanking its own phase
 * mid-sign-out would lose the in-progress guard.
 */
export const RESETTABLE_STORES = {
  useArtifactsStore,
  useAttachmentStore,
  useChatStore,
  useConversationStore,
  useMindStore,
  useSettingsStore,
  useUiStore,
  useUploadStore,
  useWalletStore,
  useWelcomeStore,
} as const;

/** The store excluded from the registry above, named so the test can check it. */
export const RESET_EXEMPT_STORES = ['useSessionStore'] as const;

/**
 * Return every store to the state it had before this account touched it.
 *
 * IN-FLIGHT WORK IS CANCELLED FIRST. Emptying the state does not stop a stream
 * that is already running: chatStore holds an AbortController, and a response
 * that resolves after the identity changed would write the previous account's
 * tokens into the next account's UI. Rather than naming chatStore here — which
 * would be another hand-maintained fact — every state value is checked for an
 * AbortController, so a new store that holds one is covered on the day it lands.
 *
 * setState(..., true) REPLACES rather than merges. That matters: a merge would
 * leave any key the initial state does not mention exactly where it was.
 * getInitialState() includes the store's actions, so replacing restores those
 * too and the store stays usable.
 */
export function resetAllStores(): void {
  for (const store of Object.values(RESETTABLE_STORES)) {
    const current = store.getState() as unknown as Record<string, unknown>;

    for (const value of Object.values(current)) {
      if (value instanceof AbortController) {
        try { value.abort(); } catch { /* already settled */ }
      }
    }

    const initial = store.getInitialState() as unknown as Record<string, unknown>;
    (store.setState as (s: unknown, replace: true) => void)({ ...initial }, true);
  }
}
