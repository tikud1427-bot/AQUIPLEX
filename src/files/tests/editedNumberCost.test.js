/**
 * `edited_number` — the superlinear stage of the FI-2 pass, pinned by COUNT.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `fileIntelligence2.e2e.test.js` pinned the whole FI-2 pass with a timing
 * ratio and named its own successor: the contradiction stage "is pinned
 * EXACTLY by a comparison counter in contradictionCost.test.js. This assertion
 * covers the rest of the pass, where no counter exists yet, and should be
 * replaced by one when the next superlinear stage is identified."
 *
 * It has been identified. Timing each stage separately at 600 and 1200 facts:
 *
 *     rebuildGraph  1.19×      consensus   1.19×
 *     forensics     4.60×      gaps        1.74×
 *                              whatCaused  1.61×
 *
 * Everything but `getForensics` is flat. Inside it, the `edited_number` rule
 * groups statements by `maskNumbers` — which collapses sentences differing
 * only in their digits into ONE key — and then compares that group every-pair.
 * Rows of the same table, the exact shape the rule exists to catch, all land
 * in one bucket.
 *
 * WHY A COUNT AND NOT A CLOCK
 * ---------------------------
 * The timing pin it replaces was measured nine times across sample counts and
 * did not converge — 2.08–2.90×, with `samples: 3` reading LOWER than
 * `samples: 1` and `samples: 5` reading higher. Its 2.4 threshold sat inside
 * that spread, so it flaked roughly one run in six and could not distinguish a
 * regression from a busy CPU. It was measuring GC, not growth.
 *
 * A comparison count is exact, reproducible, and load-independent. Same
 * conclusion `relationshipEngine.js` reached for the contradiction pass, and
 * the instrument AQUA_INDEXED_NOT_SCAN.md argues for throughout.
 *
 * ✅ THE QUADRATIC IS NOW FIXED, AND THIS FILE ASKED FOR THAT.
 * ----------------------------------------------------------
 * The previous version pinned quadratic growth and ended with a test titled
 * "INVERTS when someone buckets it — re-pin against the new counts and rename
 * this test". That happened; this is the re-pin.
 *
 * The fix buckets by "all numeric slots but one". Since the rule fires only
 * when EXACTLY ONE slot differs, two statements qualify iff they collide on
 * such a key — so every removed comparison was a guaranteed non-match and
 * every surviving one is a genuine candidate. An exact transform, not a
 * heuristic:
 *
 *              comparisons      before        after
 *     150 facts                 11,175        1,875
 *     300 facts                 44,850        3,750
 *     600 facts                179,700        7,500
 *    1200 facts                719,400       15,000
 *
 * Quadratic → linear, 24× fewer at 600 facts, and `forensicReport` over that
 * corpus went from ~105ms to 16ms.
 *
 * BEHAVIOUR WAS VERIFIED BY SNAPSHOT, NOT BY ARGUMENT. `forensic-edited.v1`
 * grades `_looksEditedForTests(a, b)` — the pairwise PREDICATE — and never runs
 * this loop, so that gate is blind to a grouping change and its unchanged
 * numbers prove nothing here. The findings `forensicReport` actually emits over
 * the labelled pair corpus were captured before and after and are IDENTICAL
 * (17 findings, same statements), with comparisons falling 233 → 82.
 *
 * ⚠️ WHAT THE COST TESTS ABOVE CANNOT SEE, AND WHY THE CAPACITY BLOCK EXISTS.
 * The FI-2 corpus writes 25 distinct statements into six files, so its largest
 * slot bucket holds six. Injecting a plausible "perf fix" that truncates
 * buckets at eight was invisible to every metric in `forensic-report.v1` AND to
 * the counts above — nothing in either corpus has a bucket that big. A cap is
 * the most likely way this optimisation gets broken later, so it needs a corpus
 * that can feel one.
 *
 * WHY THE RESIDUAL IS NOT ZERO. The FI-2 workload writes the same 25 statements
 * into all six files, and identical statements collide on every slot key. Those
 * pairs are skipped by the rule's own identical-representation check. They are
 * NOT deduped before bucketing, deliberately: three facts where two are
 * identical and the third differs in one slot legitimately produce TWO
 * findings today, and collapsing the duplicates would silently drop one.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), 'aqua-editnum-'));

const ES = await import('../evidenceStore.js');
const US = await import('../ukoStore.js');
const { createEvidence, createFact } = await import('../evidence.js');
const { createUKO } = await import('../uko.js');
const {
  forensicReport, _editedNumberComparisonsForTests, _resetEditedNumberComparisonsForTests,
} = await import('../forensicEngine.js');

/**
 * The FI-2 perf workload, verbatim in shape: six files, statements that differ
 * only in their numbers. Reproduced rather than imported so this pin does not
 * silently change meaning when that harness is edited.
 */
function mkFile(ownerId, id) {
  const u = createUKO({
    ownerId,
    sourceFile: { name: `${id}.pdf`, ext: '.pdf', bytes: 1, hash: id.padEnd(64, 'x') },
    fileType: 'document',
  });
  u.id = id;
  US.saveUKO(u);
  return u;
}

function addOne(ownerId, u, statement, page) {
  const ev = ES.saveEvidence(ownerId, createEvidence({
    sourceFileId: u.id, sourceFileName: u.sourceFile.name, sourceType: 'document',
    extractionMethod: 'structural', location: { page }, snippet: statement,
  }));
  ES.saveFact(ownerId, createFact({ statement, entities: ['VendorCo'], evidence: [ev] }), { sourceFileId: u.id });
}

function seed(ownerId, factCount) {
  const perFile = Math.ceil(factCount / 6);
  for (let f = 0; f < 6; f++) {
    const u = mkFile(ownerId, `bulk${f}`);
    for (let i = 0; i < perFile; i++) {
      addOne(ownerId, u, `Item ${i} for VendorCo recorded value ${1000 + i} on 2026-0${(i % 6) + 1}-1${i % 9}`, i);
    }
  }
}

function comparisonsAt(factCount) {
  const owner = `owner-editnum-${factCount}`;
  ES.purgeOwner?.(owner);
  US.purgeOwner?.(owner);
  seed(owner, factCount);
  _resetEditedNumberComparisonsForTests();
  forensicReport({ ukoStore: US, evidenceStore: ES }, owner);
  const n = _editedNumberComparisonsForTests();
  ES.purgeOwner?.(owner);
  US.purgeOwner?.(owner);
  return n;
}

describe('edited_number — cost is counted, not timed', () => {
  let small, large;
  before(() => { small = comparisonsAt(150); large = comparisonsAt(300); });

  test('the seam is wired — comparisons are actually counted', () => {
    // The failure this catches is the counter being bypassed by a refactor,
    // which would otherwise make every assertion below trivially pass.
    assert.ok(small > 0, 'no comparisons counted — the counter is not on the live path');
  });

  test('the count is EXACTLY reproducible across runs', () => {
    // The property the clock could never offer. If this ever varies, the pin
    // has become an estimate again and the numbers below mean nothing.
    assert.equal(comparisonsAt(150), small);
    assert.equal(comparisonsAt(300), large);
  });

  test('the rule is LINEAR in fact count', () => {
    // Doubling the corpus doubles the work. Before bucketing this read ~4×.
    const ratio = large / small;
    assert.ok(ratio > 1.8 && ratio < 2.2,
      `edited_number scaled ${ratio.toFixed(2)}× for a 2× input — expected ~2× (${small} → ${large})`);
  });

  test('the absolute cost is pinned at both sizes', () => {
    // A ratio alone cannot catch a change that scales both ends together —
    // the quadratic version also had a stable ratio, at 4×.
    assert.equal(small, 1875, `comparisons at 150 facts moved: ${small}`);
    assert.equal(large, 3750, `comparisons at 300 facts moved: ${large}`);
  });

  test('the quadratic cannot come back unnoticed', () => {
    // n(n−1)/2 at 300 facts is 44,850. Anything approaching that means the
    // slot bucketing was removed or bypassed.
    assert.ok(large < 10000,
      `edited_number is quadratic again (${small} → ${large}, n(n-1)/2 would be 44850)`);
  });
});

/**
 * One bucket, deliberately large.
 *
 * N statements identical except a single numeric slot all collide on the same
 * slot key, so the bucket holds all N and every pair is a genuine candidate.
 * This is the shape that distinguishes "bucketed" from "bucketed and then
 * truncated" — the second is a silent recall loss dressed as an optimisation,
 * and it is the failure mode nothing else in the repo can currently observe.
 *
 * The comparison count is the instrument. No new counter was added: a cap
 * changes N(N−1)/2 into something far smaller, which the existing counter
 * already reports exactly. A second counter would be more surface for the same
 * information.
 */
function oneBucketComparisons(n) {
  const owner = `owner-editnum-cap-${n}`;
  ES.purgeOwner?.(owner);
  US.purgeOwner?.(owner);
  const a = mkFile(owner, 'capA');
  const b = mkFile(owner, 'capB');
  for (let i = 0; i < n; i++) {
    // Alternating files, because a same-file pair is a table and the rule
    // declines to accuse it — the comparison still happens, the finding does not.
    addOne(owner, i % 2 ? b : a, `Total contract value for VendorCo is ${4200000 + i * 1000} as agreed.`, i);
  }
  _resetEditedNumberComparisonsForTests();
  forensicReport({ ukoStore: US, evidenceStore: ES }, owner);
  const c = _editedNumberComparisonsForTests();
  ES.purgeOwner?.(owner);
  US.purgeOwner?.(owner);
  return c;
}

describe('edited_number — a large bucket is traversed WHOLE', () => {
  test('every pair in a 40-member bucket is examined', () => {
    // 780 = 40·39/2. Any truncation lands far below this.
    assert.equal(oneBucketComparisons(40), 780);
  });

  test('the bucket is not silently capped', () => {
    // The specific regression: `if (group.length > K) group.length = K`, added
    // to "make forensics fast", which drops accusations nobody asked to lose.
    // Checked across sizes so a cap at any plausible K is caught rather than
    // one lucky threshold.
    for (const n of [10, 20, 40]) {
      assert.equal(oneBucketComparisons(n), (n * (n - 1)) / 2,
        `bucket of ${n} was truncated — comparisons fell below n(n-1)/2`);
    }
  });

  test('growth here is QUADRATIC, and that is correct', () => {
    // Not a contradiction of the linearity pinned above. That measures a corpus
    // of DISTINCT statements, where bucketing removes guaranteed non-matches.
    // This measures one bucket of genuine candidates, where every comparison
    // produces a finding — inherent output size, not waste. Bucketing bounds
    // the work to the answer; it cannot make the answer smaller.
    const r = oneBucketComparisons(40) / oneBucketComparisons(20);
    assert.ok(r > 3.5 && r < 4.5, `expected ~4x on a single bucket, got ${r.toFixed(2)}x`);
  });
});
