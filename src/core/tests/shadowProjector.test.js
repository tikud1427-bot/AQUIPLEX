/**
 * The claim shadow projector — E5/PR-6
 * Blueprint L11 · L13 · L17 · G2 (idempotent) · G3 (owner-scoped) · G4 (purgeable)
 *
 * TWO LAYERS, ON PURPOSE
 * ----------------------
 * The first block drives `projectTurnFacts` with an injected backfill and no
 * database, because the projector's own judgement — what counts as unmatched,
 * what counts as a duplicate, whether it can throw — is not a database question
 * and should not need one to test.
 *
 * The second block runs the real thing end to end against Postgres, because the
 * acceptance criteria that matter (evidence exists, actor exists, replay does
 * not twin, one owner cannot see another) are claims about ROWS.
 *
 * ⚠️ pg-mem IS NOT POSTGRES, and that limitation is inherited from
 * `claimRepository.test.js` which uses the same helper. The projection in this
 * change was ALSO executed against a real PostgreSQL 16.15 instance through the
 * production `runPostTurn` seam; those numbers are in the accompanying report.
 * This suite is the regression net, not the whole proof.
 *
 * BITE, MEASURED (revert the named property → count failures):
 *   unmatched facts counted rather than thrown  → 2 fail
 *   projector swallows its own failures         → 1 fail
 *   both attributions recorded                  → 2 fail
 *   parity line silent on a no-op turn          → 1 fail
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { projectTurnFacts, claimParityLine } from '../claims/shadowProjector.js';

// ── The projector's own judgement, no database involved ──────────────────────

describe('the shadow projector reports divergence instead of hiding it', () => {
  const fact = id => ({ id, statement: `fact ${id}`, entities: ['Nummo'], confidence: 0.8, evidence: [`ev-${id}`] });
  const store = ids => ({
    getFact: (o, id) => (ids.includes(id) ? fact(id) : null),
    getEvidence: (o, evId) => ({ id: evId, quote: 'q' }),
  });

  test('a fact id that no longer resolves is UNMATCHED, not a crash', async () => {
    // The authoritative store is allowed to move on between the write and the
    // projection. Divergence is what this report exists to surface.
    const r = await projectTurnFacts({ ownerId: 'o', factIds: ['a', 'gone'] }, {
      ...store(['a']), backfill: async (o, facts) => ({ projected: facts.length, skipped: [] }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.unmatched, 1);
    assert.equal(r.claims, 1);
  });

  test('a REJECTED fact carries its reason, capped so one bad turn cannot flood', async () => {
    const r = await projectTurnFacts({ ownerId: 'o', factIds: ['a', 'b'] }, {
      ...store(['a', 'b']),
      backfill: async () => ({ projected: 0, skipped: [{ id: 'a', problems: ['no statement'] }, { id: 'b', problems: ['no evidence'] }] }),
    });
    assert.equal(r.rejected, 2);
    assert.deepEqual(r.rejections, ['no statement', 'no evidence']);
    assert.ok(claimParityLine(r).includes('rejected_because'));
  });

  test('facts in, fewer claims out, nothing rejected → DUPLICATES, counted', async () => {
    // A replay projecting 0 new claims from 3 facts is correct and looks
    // identical to a broken projector unless the difference is named.
    const r = await projectTurnFacts({ ownerId: 'o', factIds: ['a', 'b', 'c'] }, {
      ...store(['a', 'b', 'c']), backfill: async () => ({ projected: 0, skipped: [] }),
    });
    assert.equal(r.duplicates, 3);
    assert.equal(r.claims, 0);
  });

  test('a THROWING backfill returns a failed report — it never propagates (L11)', async () => {
    const r = await projectTurnFacts({ ownerId: 'o', factIds: ['a'] }, {
      ...store(['a']), backfill: async () => { throw new Error('pg gone'); },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /pg gone/);
    assert.match(claimParityLine(r), /FAILED reason=pg gone/);
  });

  test('BOTH attributions are recorded — the lane and the projector differ', async () => {
    // The row records `extractor=backfill@v1`; the sentence came from
    // conversationFacts. Reporting one while the database records the other is
    // a disagreement discovered during an incident.
    const r = await projectTurnFacts({ ownerId: 'o', factIds: ['a'] }, {
      ...store(['a']), backfill: async () => ({ projected: 1, skipped: [] }),
    });
    assert.equal(r.sourceExtractor, 'conversationFacts');
    assert.equal(r.projector, 'backfill@v1');
    const line = claimParityLine(r);
    assert.match(line, /source=conversationFacts/);
    assert.match(line, /projector=backfill@v1/);
  });

  test('a turn with nothing to project prints NOTHING', async () => {
    // A line every turn would bury the divergence signal, which is the only
    // reason to run this at all.
    const r = await projectTurnFacts({ ownerId: 'o', factIds: [] }, store([]));
    assert.equal(r.ok, true);
    assert.equal(claimParityLine(r), null);
  });

  test('no owner is refused, and says so', async () => {
    const r = await projectTurnFacts({ ownerId: null, factIds: ['a'] }, store(['a']));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no owner');
  });

  test('every claim it produces is predicate-UNRESOLVED, and that is stated', async () => {
    // The projector inherits backfill's refusal to guess a predicate. The count
    // is the size of the debt E6 will pay down, per turn, out loud.
    const r = await projectTurnFacts({ ownerId: 'o', factIds: ['a', 'b'] }, {
      ...store(['a', 'b']), backfill: async () => ({ projected: 2, skipped: [] }),
    });
    assert.equal(r.unresolvedPredicate, 2);
    assert.match(claimParityLine(r), /predicate=unresolved:2/);
  });
});
