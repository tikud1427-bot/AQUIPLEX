/**
 * UUS — the write seam for file understanding.
 *
 * `fileBridge.js` is pure and decides WHAT a file implies. This decides
 * whether to write it, and is the only part that touches a store.
 *
 * THREE PROPERTIES, ALL DELIBERATE
 * --------------------------------
 * DEFERRED. Runs on setImmediate, after the upload response is already on its
 * way. A user waiting on an upload should never wait on belief-writing, and
 * the post-turn pipeline already established this pattern — same `defer`
 * shape as `runPostTurn`.
 *
 * FAIL-OPEN. Every path is wrapped. A file that produces no beliefs is a
 * mildly worse understanding card; a file that throws is a failed upload. The
 * asymmetry is not close.
 *
 * ONE WRITER. Signals go through `observeSignals`, goals through `trackGoals`.
 * Nothing here mutates a belief directly. That is what keeps confidence,
 * evidence, contradiction handling and the correction path identical no matter
 * where a belief came from — the property that makes "correct my
 * understanding" work on a fact AQUA read in a README.
 */
import { getMind } from '../mind/mindStore.js';
import { observeSignals } from '../mind/beliefEngine.js';
import { trackGoals } from '../mind/goalTracker.js';
import { getUKO } from '../files/ukoStore.js';
import { readUko } from './fileBridge.js';
import { uusEnabled } from './flags.js';

const REAL_DEPS = { getMind, observeSignals, trackGoals, getUKO, defer: setImmediate };

/**
 * Learn from files that were just ingested.
 *
 * @param {object} args
 * @param {string} args.ownerId
 * @param {string[]} args.ukoIds     ids returned by ingestFiles
 * @param {object} [args.deps]       injectable for tests
 * @returns {{ ok, skipped?, files?, beliefs?, goals? }} synchronous summary;
 *          the write itself is deferred
 */
export function observeIngest({ ownerId, ukoIds = [], deps = {} } = {}) {
  const d = { ...REAL_DEPS, ...deps };
  if (!uusEnabled()) return { ok: false, skipped: 'disabled' };
  if (!ownerId || !ukoIds.length) return { ok: false, skipped: 'nothing-to-read' };

  d.defer(() => {
    try {
      const mind = d.getMind(ownerId);
      if (!mind) return;

      let beliefs = 0;
      let goals = 0;

      for (const ukoId of ukoIds) {
        let uko;
        try { uko = d.getUKO(ownerId, ukoId); } catch { continue; }
        if (!uko) continue;

        const { signals, goalTitles } = readUko(uko);

        if (signals.length) {
          try { beliefs += (d.observeSignals(mind, signals) ?? []).length; }
          catch { /* one bad file must not stop the rest */ }
        }

        for (const title of goalTitles) {
          // Routed through trackGoals as a `goal` fact rather than written
          // directly: goal identity, fuzzy matching against existing goals and
          // confidence all live there, and a second path would create
          // duplicates that look like the user set the same goal twice.
          try {
            const touched = d.trackGoals(mind, { extractedFacts: [{ key: 'goal', value: title }] });
            goals += (touched ?? []).length;
          } catch { /* same */ }
        }
      }

      if (beliefs || goals) {
        console.log(`[UUS] Learned from files owner=${ownerId} files=${ukoIds.length} beliefs=${beliefs} goals=${goals}`);
      }
    } catch (err) {
      console.warn(`[UUS] file learning failed (non-fatal): ${err?.message ?? err}`);
    }
  });

  return { ok: true, files: ukoIds.length };
}

export const _internals = { REAL_DEPS };
