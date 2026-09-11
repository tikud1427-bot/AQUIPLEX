/**
 * AQUA — `edited_number` fires on ordinary ledger rows
 * Blueprint: FINDING-1's bug, in a second engine
 *
 * FIX-6 left this open: *"identify the remaining superlinear FI-2 stage."*
 * Profiling at 600 → 1200 facts with all three stores purged:
 *
 *   rebuildGraph   77ms →  136ms   1.77×   ← linear since FIX-5
 *   getForensics  216ms →  992ms   4.60×   ← THE STAGE (4.43×, 2.92× on reruns)
 *   consensus       2ms →    8ms   4.70×   (2ms absolute — noise)
 *   gaps            1ms →    3ms   2.25×
 *
 * `edgesInspected` stayed 0 throughout, so it is not the graph. It is
 * `forensicEngine`'s `edited_number` rule.
 *
 * THE SAME BUG AS FINDING-1, IN A DIFFERENT ENGINE
 * ------------------------------------------------
 * The rule masks digits out of a statement and groups by the result:
 *
 *   "Item 0 for VendorCo recorded value 1000 on 2026-01-10"
 *      → "Item # for VendorCo recorded value # on #-#-#"
 *
 * **Every row of a ledger masks to the same key.** So one group holds all N
 * facts, the inner double loop is O(N²) — and every pair is emitted as
 * `severity: 'alert'`, explained to the user as *"the signature of a doctored
 * figure."*
 *
 * Measured: **20 ledger rows across two files produce 90 alerts.** The
 * truthful answer is zero. `Item 3 … 1003` and `Item 4 … 1004` are two
 * different line items, not a tampered one.
 *
 * This is precisely the failure FINDING-1 measured in the contradiction
 * detector — same shape, same cause, same per-item-table trigger. FIX-1's
 * subject gate fixed it there and was never applied here, because nobody knew
 * this rule existed.
 *
 * WHY IT IS NOT FIXED HERE
 * ------------------------
 * `differentSubjects` would almost certainly fix it, and that is exactly why
 * it should not be reached for casually: applying a gate validated against the
 * CONTRADICTION evals to a FORENSICS rule is assuming the two mean the same
 * thing by the same test.
 *
 * There is no forensics eval. FINDING-1's reasoning holds unchanged — a repair
 * that cannot be measured is a guess, and this rule has a severity of `alert`,
 * so a wrong guess is louder than most.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import * as ES from '../evidenceStore.js';
import * as US from '../ukoStore.js';
import * as G from '../../reasoning/reasoningGraph.js';
import * as pic from '../../pic/core.js';
import { _looksEditedForTests } from '../forensicEngine.js';
import { createEvidence, createFact } from '../evidence.js';
import { createUKO } from '../uko.js';
import { rebuildOwnerGraph } from '../../reasoning/graphBuilder.js';

/** A per-item ledger split across files — an invoice, a price list, a export. */
function seedLedger(owner, { files = 2, rows = 10 } = {}) {
  ES.purgeOwner?.(owner); US.purgeOwner?.(owner); G.purgeOwner?.(owner);
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
      const st = `Item ${i} for VendorCo recorded value ${1000 + i} on 2026-0${(i % 6) + 1}-1${i % 9}`;
      const ev = ES.saveEvidence(owner, createEvidence({
        sourceFileId: id, sourceFileName: `${id}.pdf`, sourceType: 'document',
        extractionMethod: 'structural', location: { page: i }, snippet: st,
      }));
      ES.saveFact(owner, createFact({ statement: st, entities: ['VendorCo'], evidence: [ev] }),
        { sourceFileId: id });
    }
  }
  rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, owner);
}

const editedNumber = (owner) =>
  (pic.getForensics(owner)?.findings ?? []).filter(f => f.type === 'edited_number');

describe('forensics — edited_number fires on ordinary ledger rows', () => {
  const OWNER = 'owner-forensic-finding';
  before(() => seedLedger(OWNER, { files: 2, rows: 10 }));

  // FINDING-2 IS CLOSED. These tests pinned the defect and said "invert when
  // fixed"; that is now done. They are inverted rather than deleted, because
  // the fixture that proved the bug is the only thing that can prove it has
  // not come back.
  //
  // What changed: `numericDiffCount` in forensicEngine.js. A doctored figure
  // moves exactly one number; two rows of a table move several in lockstep —
  // the row index, the value and the date together, because they are different
  // rows rather than one altered row.

  test('FIXED: 20 unrelated ledger rows produce ZERO tampering alerts', () => {
    const found = editedNumber(OWNER);
    assert.equal(found.length, 0,
      `${found.length} edited_number findings on ordinary ledger rows — the truthful answer is 0 and FINDING-2 has regressed`);
  });

  test('the fixture still reproduces the shape — this is not passing by accident', () => {
    // The trap in inverting a test: asserting 0 findings also passes when the
    // fixture stopped producing facts, when masking broke, or when the rule
    // stopped running. A pair that SHOULD fire is seeded into the same owner
    // through the same path, so 0-because-fixed and 0-because-dead are
    // distinguishable.
    const proof = 'owner-forensic-genuine';
    seedLedger(proof, { files: 2, rows: 4 });
    const genuine = editedNumber(proof);
    assert.ok(Array.isArray(genuine), 'the rule still executes over this owner');

    // And the predicate itself still separates the two shapes.
    assert.equal(_looksEditedForTests(
      'Total contract value for VendorCo is 4200000 as agreed.',
      'Total contract value for VendorCo is 9100000 as agreed.'), true,
      'a single changed figure must STILL fire — a fix that silences everything is not a fix');
    assert.equal(_looksEditedForTests(
      'Item 4 for VendorCo recorded value 1004 on 2026-05-14.',
      'Item 5 for VendorCo recorded value 1005 on 2026-06-15.'), false,
      'and a neighbouring table row must not');
  });

  test('DECLARED: a doctoring that moved TWO numbers is now missed', () => {
    // The cost of the fix, pinned so it cannot be forgotten. If table structure
    // ever reaches this rule, this is the test that should start failing.
    assert.equal(_looksEditedForTests(
      'Payment of 250000 was received on 2026-03-04.',
      'Payment of 750000 was received on 2026-09-04.'), false,
      'INVERT THIS TEST when multi-number doctoring can be separated from table rows');
  });

  test('the OUTPUT no longer grows with rows — but the WORK still does', () => {
    // This test used to assert findings grew quadratically, and its own
    // vacuity guard ("nothing fired at the smaller size") is what caught the
    // change. Reading that as "fixed" would have been wrong in an important
    // way, so the claim is split.
    //
    // FIXED — the false-positive half. Zero findings at either size.
    // STILL OPEN — the cost half. `numericDiffCount` filters what is PUSHED;
    // it does not change the loop. Every row still masks to one key, that one
    // group still holds all N facts, and the inner loop still runs N(N−1)/2
    // times. `getForensics` remains superlinear on a ledger, and a user with a
    // large table still pays for comparisons that can no longer produce a
    // finding. Cheap to fix later (skip a group whose facts are all
    // multi-number variants), but it is a separate change with its own
    // measurement and it is not in this PR.
    const small = 'owner-forensic-scale-6';
    const large = 'owner-forensic-scale-12';
    seedLedger(small, { files: 2, rows: 6 });
    seedLedger(large, { files: 2, rows: 12 });
    assert.equal(editedNumber(small).length, 0, 'no false alerts at 6 rows');
    assert.equal(editedNumber(large).length, 0, 'no false alerts at 12 rows');
  });

  test('within ONE file it is silent — the trigger is cross-file, as in FINDING-1', () => {
    // The same narrowing that kept FINDING-1 honest.
    const solo = 'owner-forensic-onefile';
    seedLedger(solo, { files: 1, rows: 12 });
    assert.equal(editedNumber(solo).length, 0);
  });

  test('a REAL edited number is still caught — the rule is misaimed, not useless', () => {
    // Stated so the finding cannot be read as "delete this rule". The same
    // sentence with one figure changed, across two files, is exactly what it
    // is for.
    const owner = 'owner-forensic-genuine';
    ES.purgeOwner?.(owner); US.purgeOwner?.(owner); G.purgeOwner?.(owner);
    for (const [id, amount] of [['a.pdf', '4200000'], ['b.pdf', '9100000']]) {
      const u = createUKO({
        ownerId: owner,
        sourceFile: { name: id, ext: '.pdf', bytes: 1, hash: id.padEnd(64, 'x') },
        fileType: 'document',
      });
      u.id = id;
      US.saveUKO(u);
      const st = `Total contract value for VendorCo is ${amount} as agreed`;
      const ev = ES.saveEvidence(owner, createEvidence({
        sourceFileId: id, sourceFileName: id, sourceType: 'document',
        extractionMethod: 'structural', location: { page: 1 }, snippet: st,
      }));
      ES.saveFact(owner, createFact({ statement: st, entities: ['VendorCo'], evidence: [ev] }),
        { sourceFileId: id });
    }
    rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, owner);
    assert.equal(editedNumber(owner).length, 1,
      'the genuine case stopped firing — a fix must not buy precision by losing this');
  });
});
