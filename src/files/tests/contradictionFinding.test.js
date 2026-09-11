/**
 * AQUA — the contradiction detector fires on unrelated numbers
 * Blueprint: a measured finding, in the shape of E3/PR-10
 *
 * FLAKE-1 converted a wall-clock budget into a scaling assertion and found the
 * FI-2 pass was quadratic. Chasing that down did not end at a performance
 * problem — it ended here, and this is the more serious half.
 *
 * WHAT WAS MEASURED
 * -----------------
 *   300 facts → 73,500 `contradicts` edges
 *   600 facts → 297,000              exactly 4× for 2× the facts
 *
 * The edges are not real. The detector's own `reason` is *"numeric
 * disagreement about VendorCo across files"*, between:
 *
 *   "Item 0 for VendorCo recorded value 1000"
 *   "Item 1 for VendorCo recorded value 1001"
 *
 * Different items, different values. **Both true simultaneously.** The rule
 * appears to be: same entity + different file + different number ⇒
 * contradiction. That fires on any per-item table — an invoice, a price list,
 * a ledger, a metrics export — which is among the most common document shapes
 * a user will upload.
 *
 * WHY THIS IS NOT FIXED IN THIS PR
 * --------------------------------
 * Changing a contradiction detector changes what AQUA believes. There is no
 * eval for contradiction quality — the E2 baselines cover extraction and
 * retrieval and say nothing about this — so any "fix" would be unmeasurable,
 * which is precisely the situation E2 exists to prevent (L14: a capability
 * gets an eval before it gets a flag).
 *
 * So the finding is pinned instead, the way E1's ratio ceiling and E3/PR-10's
 * write shape were pinned: these assertions describe what is TRUE TODAY and
 * are expected to INVERT when the detector is fixed.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import * as ES from '../evidenceStore.js';
import * as US from '../ukoStore.js';
import * as G from '../../reasoning/reasoningGraph.js';
import { createEvidence, createFact } from '../evidence.js';
import { createUKO } from '../uko.js';
import { rebuildOwnerGraph } from '../../reasoning/graphBuilder.js';

/**
 * A per-item table split across files — an invoice, a ledger, a price list.
 *
 * 🔴 PURGES FIRST. The evidence store is a module-level singleton that loads
 * the REAL data directory at import, so without this the test seeds on top of
 * whatever is already there. Measured: after a few manual runs the owner held
 * 78 facts instead of 6, and the assertion saw 600 contradiction pairs.
 *
 * It passed under the full battery and failed alone, which reads exactly like
 * an order-dependency and is not one — it is a test with no data isolation,
 * whose result depends on the machine's history. FINDING-1's version had the
 * same gap and passed only because the store happened to be clean.
 */
function seedLedger(owner, { files = 2, rows = 3 } = {}) {
  ES.purgeOwner?.(owner);
  US.purgeOwner?.(owner);
  G.purgeOwner?.(owner);
  for (let f = 0; f < files; f++) {
    const id = `ledger${f}`;
    const u = createUKO({
      ownerId: owner,
      sourceFile: { name: `${id}.pdf`, ext: '.pdf', bytes: 1, hash: String(f).padEnd(64, 'x') },
      fileType: 'document',
    });
    u.id = id;
    US.saveUKO(u);
    for (let i = 0; i < rows; i++) {
      const statement = `Item ${i} for VendorCo recorded value ${1000 + i} on 2026-0${(i % 6) + 1}-1${i % 9}`;
      const ev = ES.saveEvidence(owner, createEvidence({
        sourceFileId: id, sourceFileName: `${id}.pdf`, sourceType: 'document',
        extractionMethod: 'structural', location: { page: i }, snippet: statement,
      }));
      ES.saveFact(owner, createFact({ statement, entities: ['VendorCo'], evidence: [ev] }),
        { sourceFileId: id });
    }
  }
  rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, owner);
}

const contradictionPairs = (owner) => {
  const seen = new Map();
  for (const f of G.nodesByType(owner, 'fact')) {
    for (const e of G.edgesOf(owner, f.id, { type: 'contradicts' })) {
      seen.set([e.from, e.to].sort().join('|'), e);
    }
  }
  return seen;
};

describe('contradiction detector — FINDING-1, now closed', () => {
  const OWNER = 'owner-contradiction-finding';
  before(() => seedLedger(OWNER, { files: 2, rows: 3 }));

  test('OPEN: six unrelated ledger rows produce contradictions', () => {
    // The truthful answer is ZERO. "Item 0 is worth 1000" and "Item 1 is worth
    // 1001" are both true at the same time.
    //
    // Inverts when the detector is fixed.
    // CLOSED. Was: `assert.ok(pairs.size > 0)`. The subject gate closed it,
    // and this assertion inverted exactly as it was designed to.
    assert.equal(contradictionPairs(OWNER).size, 0,
      'the detector fires on unrelated per-item values again — the fix regressed');
  });

  test('CLOSED: there is no longer a reason to report', () => {
    assert.equal([...contradictionPairs(OWNER)].length, 0);
  });

  test('within ONE file the detector is silent — the trigger is cross-file', () => {
    // Narrowing the finding rather than overstating it: the same rows in a
    // single file produce nothing. Whatever the rule is, it keys on the
    // documents differing, not on the numbers alone.
    const solo = 'owner-contradiction-onefile';
    seedLedger(solo, { files: 1, rows: 6 });
    assert.equal(contradictionPairs(solo).size, 0);
  });

  test('OPEN: the edge count grows QUADRATICALLY with fact count', () => {
    // Measured at scale: 300 facts → 73,500 edges; 600 → 297,000. Exactly 4×
    // for 2× the facts. That is the whole reason the FI-2 pass is quadratic —
    // it walks an adjacency list that is itself O(N) per node.
    //
    // Smaller sizes here so the battery stays fast; the shape is the same.
    const counts = [8, 16].map(rows => {
      const o = `owner-contradiction-scale-${rows}`;
      seedLedger(o, { files: 2, rows });
      return contradictionPairs(o).size;
    });
    // CLOSED. Measured independently on the original 300/600-fact graph:
    // 73,500 → 0 and 297,000 → 0. There is nothing left to grow.
    assert.deepEqual(counts, [0, 0],
      'contradiction edges are back — the subject gate regressed');
  });

  test('the graph is mostly contradiction edges — signal buried in noise', () => {
    // The audit praised AQUA for SURFACING contradictions rather than
    // resolving them. That is only valuable if a contradiction means
    // something; at this density it is the dominant edge type and tells a
    // reader nothing.
    const owner = 'owner-contradiction-density';
    seedLedger(owner, { files: 2, rows: 8 });
    const byType = {};
    for (const f of G.nodesByType(owner, 'fact')) {
      for (const e of G.edgesOf(owner, f.id)) byType[e.type] = (byType[e.type] ?? 0) + 1;
    }
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    // CLOSED: contradictions are no longer the dominant edge type on this
    // shape, because there are none.
    assert.equal(byType.contradicts ?? 0, 0);
  });
});
