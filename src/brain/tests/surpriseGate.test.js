/**
 * E6/PR-3 — the surprise gate.
 *
 * Real embeddings cannot run in the analysis sandbox, but almost nothing here
 * needs them: `embeddingProvider.js` exposes `__setEmbedderForTests`, so the
 * vectors can be dictated exactly and the gate's DECISIONS tested without a
 * provider. What genuinely needs real embeddings is the surprise
 * DISTRIBUTION, and that lives in `scripts/surprise-distribution.mjs` for
 * Ananya to run.
 *
 * The two properties worth more than the rest:
 *
 *   1. it FAILS OPEN. A cost optimisation must never become a data-loss path
 *      because a provider was down.
 *   2. it never suppresses a CHANGE. The segment most worth keeping looks
 *      exactly like the one already on file — that is what makes it an update.
 *
 * Run: node --test src/brain/tests/surpriseGate.test.js
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  surpriseGate, centroidOf, hasChangeCue, DEFAULT_THRESHOLD,
} from '../understanding/surpriseGate.js';
import { __setEmbedderForTests, __clearEmbedderForTests } from '../../embeddings/embeddingProvider.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const dataset = rel => JSON.parse(readFileSync(path.join(ROOT, 'eval/datasets', rel), 'utf8'));

/** Dictate the vector for a text. Anything unlisted embeds to null. */
const embedderFor = map => async texts => texts.map(t => map[t] ?? null);

afterEach(() => __clearEmbedderForTests());

describe('surprise gate — the default is a true no-op', () => {
  test('DEFAULT_THRESHOLD is 0, so nothing is suppressed until a threshold is measured', async () => {
    assert.equal(DEFAULT_THRESHOLD, 0,
      'a non-zero default would be a threshold invented before the distribution was measured');
  });

  test('an EXACT restatement is still admitted at the default threshold', async () => {
    // surprise === 0 exactly. `>=` rather than `>` is what makes the default a
    // true no-op instead of one that quietly drops perfect duplicates.
    const v = [1, 0, 0];
    __setEmbedderForTests(embedderFor({ 'I work at Nummo and it is great.': v }));
    const g = await surpriseGate('I work at Nummo and it is great.', v);
    assert.equal(g.admit, true, 'admitted at threshold 0');
    assert.equal(g.reason, 'surprising');
    assert.ok(Math.abs(g.surprise) < 1e-9, `surprise ${g.surprise} should be ~0`);
  });
});

describe('surprise gate — FAILS OPEN on every infrastructure failure', () => {
  const centroid = [1, 0, 0];

  test('no provider configured → admit', async () => {
    // No test embedder set and no key in this environment.
    const g = await surpriseGate('Some ordinary statement about work.', centroid, { threshold: 0.9 });
    assert.equal(g.admit, true);
    assert.equal(g.reason, 'embeddings-unavailable');
  });

  test('provider returns null for this text → admit', async () => {
    __setEmbedderForTests(embedderFor({}));   // enabled, but every text embeds to null
    const g = await surpriseGate('Some ordinary statement about work.', centroid, { threshold: 0.9 });
    assert.equal(g.admit, true);
    assert.equal(g.reason, 'no-vector');
  });

  test('a brand-new owner with no centroid → admit', async () => {
    __setEmbedderForTests(embedderFor({ 'Some ordinary statement about work.': [1, 0, 0] }));
    for (const empty of [null, undefined, []]) {
      const g = await surpriseGate('Some ordinary statement about work.', empty, { threshold: 0.9 });
      assert.equal(g.admit, true, `centroid ${JSON.stringify(empty)}`);
      assert.equal(g.reason, 'no-centroid');
    }
  });

  test('a degenerate vector cannot be read as "redundant"', async () => {
    // cosineSim returns 0 for a zero vector, which makes surprise 1 — the
    // admit direction. Asserted rather than relied on: the arithmetic
    // happening to point the safe way is not the same as a guarantee.
    __setEmbedderForTests(embedderFor({ 'Some ordinary statement about work.': [0, 0, 0] }));
    const g = await surpriseGate('Some ordinary statement about work.', centroid, { threshold: 0.9 });
    assert.equal(g.admit, true, 'a zero vector must never suppress a segment');
  });
});

describe('surprise gate — a CHANGE is never redundant', () => {
  test('a superseding statement is exempt BEFORE any vector is computed', async () => {
    // The vector is deliberately identical to the centroid: surprise 0, the
    // most suppressible score possible. It must still be admitted, and it must
    // be admitted without spending an embedding call.
    let called = 0;
    __setEmbedderForTests(async texts => { called++; return texts.map(() => [1, 0, 0]); });
    const g = await surpriseGate('Growth is no longer the priority — retention is.', [1, 0, 0], { threshold: 0.9 });
    assert.equal(g.admit, true);
    assert.equal(g.reason, 'change-cue');
    assert.equal(called, 0, 'a change cue decides on its own — embedding first would only cost money to reach the same answer');
  });

  test('EVERY supersession turn in capture-core is exempt', async () => {
    // These are the two cases the retrieval baseline already scores at 20%.
    // Suppressing them at ingest would put that failure somewhere nothing
    // downstream could reach it.
    const supersede = dataset('capture-core.v1.json').cases.filter(c => c.cat === 'supersession');
    assert.ok(supersede.length >= 2, 'the fixture stopped finding supersession cases');
    for (const c of supersede) {
      const update = c.turns[c.turns.length - 1];
      assert.equal(hasChangeCue(update), true, `not exempt: ${JSON.stringify(update)}`);
    }
  });

  test('EVERY negation case in extraction-core is exempt', async () => {
    // 20/20. The first draft managed 13/20 with its own contraction list and
    // missed "I'm not the CTO", "We haven't decided on pricing" and "I dislike
    // neither option" — which is why this now shares candidateGate's regex
    // instead of keeping a second opinion about what "negative" means.
    const neg = dataset('extraction-core.v1.json').cases.filter(c => c.cat === 'negation');
    const missed = neg.filter(c => !hasChangeCue(c.text)).map(c => c.text);
    assert.deepEqual(missed, [], `${missed.length} negation cases are suppressible`);
  });

  test('THE GATE ITSELF admits every supersession turn under a punishing threshold', async () => {
    // The corpus tests above check `hasChangeCue` in isolation. That is not the
    // same claim: the exemption could exist and the gate could fail to consult
    // it. Measured — deleting the exemption from the gate failed only ONE test
    // before this one was added, which is thin cover for the property the whole
    // module is built around.
    //
    // Every segment is given a vector IDENTICAL to the centroid (surprise 0,
    // maximally suppressible) and a threshold of 0.99. Nothing but the
    // exemption can save them.
    const centroid = [1, 0, 0];
    __setEmbedderForTests(async texts => texts.map(() => [1, 0, 0]));

    const updates = dataset('capture-core.v1.json').cases
      .filter(c => c.cat === 'supersession')
      .map(c => c.turns[c.turns.length - 1]);
    assert.ok(updates.length >= 2, 'the fixture stopped finding supersession cases');

    for (const u of updates) {
      const g = await surpriseGate(u, centroid, { threshold: 0.99 });
      assert.equal(g.admit, true, `the gate suppressed an update: ${JSON.stringify(u)}`);
      assert.equal(g.reason, 'change-cue');
    }

    // And the control: a restatement under the same conditions IS suppressed,
    // so the test above is not passing because the gate admits everything.
    const control = await surpriseGate('I work at Nummo in Bangalore.', centroid, { threshold: 0.99 });
    assert.equal(control.admit, false, 'the gate must still be capable of suppressing');
  });

  test('a plain restatement is NOT exempt — the exemption has to cost something', () => {
    // An exemption that fires on everything is not an exemption. If these were
    // exempt the gate could never suppress anything and would be theatre.
    for (const t of [
      'I work at Nummo.',
      'My co-founder is Dev.',
      'Our biggest problem is churn.',
      'I run product at Nummo in Bangalore.',
    ]) {
      assert.equal(hasChangeCue(t), false, `${JSON.stringify(t)} should be suppressible`);
    }
  });
});

describe('surprise gate — suppression works when it is asked to', () => {
  test('a redundant segment IS suppressed above the threshold', async () => {
    // Proves the gate is capable of saying no. Without this the fail-open
    // tests above would pass on a gate that admits unconditionally.
    __setEmbedderForTests(embedderFor({ 'The team ships on a weekly cadence.': [1, 0, 0] }));
    const g = await surpriseGate('The team ships on a weekly cadence.', [1, 0, 0], { threshold: 0.1 });
    assert.equal(g.admit, false);
    assert.equal(g.reason, 'redundant');
  });

  test('an orthogonal segment is admitted at the same threshold', async () => {
    __setEmbedderForTests(embedderFor({ 'The team ships on a weekly cadence.': [0, 1, 0] }));
    const g = await surpriseGate('The team ships on a weekly cadence.', [1, 0, 0], { threshold: 0.1 });
    assert.equal(g.admit, true);
    assert.equal(g.reason, 'surprising');
    assert.ok(Math.abs(g.surprise - 1) < 1e-9);
  });

  test('a pre-computed vector is used instead of calling the provider', async () => {
    let called = 0;
    __setEmbedderForTests(async texts => { called++; return texts.map(() => [1, 0, 0]); });
    const g = await surpriseGate('The team ships on a weekly cadence.', [1, 0, 0], { threshold: 0.1, vector: [0, 1, 0] });
    assert.equal(g.admit, true, 'the supplied vector decided it');
    assert.equal(called, 0, 'batching upstream must not be defeated by a re-embed here');
  });
});

describe('centroidOf', () => {
  test('averages the usable vectors', () => {
    assert.deepEqual(centroidOf([[0, 0], [2, 4]]), [1, 2]);
  });

  test('nulls are SKIPPED, not counted as zero vectors', () => {
    // Counting a failed embedding as [0,0] would drag the centroid toward the
    // origin and make everything afterwards look surprising — fail-open, but
    // for a reason nobody could debug from the outside.
    assert.deepEqual(centroidOf([[2, 4], null, undefined]), [2, 4]);
  });

  test('nothing usable → null, which the gate reads as "admit"', () => {
    for (const input of [[], [null], [[]], undefined]) {
      assert.equal(centroidOf(input), null, `${JSON.stringify(input)}`);
    }
  });

  test('a dimension mismatch does not silently corrupt the centroid', () => {
    // Two embedding models in one store. Averaging across them yields a vector
    // meaningless in both spaces, so the minority dimension is dropped rather
    // than mixed in.
    assert.deepEqual(centroidOf([[1, 1], [3, 3], [9, 9, 9]]), [2, 2]);
  });
});
