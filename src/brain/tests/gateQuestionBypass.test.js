/**
 * Candidate gate — the question guard sits BELOW filter 1, and that is a
 * deliberate, priced trade rather than an oversight.
 *
 * HOW THIS WAS FOUND
 * ------------------
 * `gate-core.v1` reported the same movement on every run for three sessions:
 *
 *     gate_precision   0.9034 → 0.9086
 *     n_false_admits   17 → 16
 *
 * An unexplained IMPROVEMENT, which is the easiest kind of drift to leave
 * alone. Tracing it found the route counts had moved far more than the
 * headline did:
 *
 *     n_via_cue_proper_noun     45 → 29
 *     n_via_declarative_intent  61 → 57
 *     n_via_entity_extractor    70 → 89
 *
 * Twenty segments changed route. The cause is the third-person subject fix in
 * `conversationEntities.js` — tier 2 previously required a copula, so people
 * who DO things ("Sam finished the billing refactor", "Karan owns the deploy
 * checklist", "The team chose React over Vue") were invisible to it and fell
 * through to the proper-noun cue. They now resolve at filter 1.
 *
 * 🔴 WHAT THE HEADLINE HID
 * ------------------------
 * A better entity extractor drove more traffic through a route that SKIPS the
 * question guard. `gateSegment` runs:
 *
 *     FILTER 1  entity-extractor      ← admits
 *     FILTER 2  declarative-intent
 *               isRequestOrQuestion   ← REJECT, never reached
 *     CUE       proper-noun, temporal, negation, definite-subject
 *
 * So a question containing a recognisable entity is admitted before the guard
 * that exists to reject questions ever runs. Three segments arrive this way,
 * and all three are generic knowledge requests carrying no claim about the
 * user's world. Net precision still ROSE, because the same widening removed
 * false admits elsewhere — which is precisely how a new failure mode hides
 * inside an improving aggregate.
 *
 * WHY IT IS NOT FIXED BY REORDERING — MEASURED, NOT ASSUMED
 * ---------------------------------------------------------
 * Moving the guard above filter 1 was implemented and run:
 *
 *     gate_recall       0.99375 → 0.95625
 *     n_claims_never_sent     1 → 7
 *     recall_modality      0.96 → 0.72
 *     n_false_admits         16 → 14   (the 3 above, minus 1 elsewhere)
 *
 * It kills seven claim-bearing segments, all interrogative in FORM but
 * asserting about the user's world: "Are we still using Groq?", "Do I still
 * report to Priya?", "Could Aquiplex be based in Pune instead?". The suite's
 * own framing prices this — recall is a HARD CEILING on E6 because a rejected
 * segment reaches no extractor at all, while precision is the extraction bill.
 * Trading six claim-bearing modality segments for three cheap ones is the
 * wrong direction, so the order stays and the cost is recorded instead.
 *
 * WHAT THIS TEST IS FOR
 * ---------------------
 * The population is priced at THREE. If the entity extractor widens again, or
 * a new route lands above the guard, this number grows silently inside a
 * precision figure that may still look fine. This makes it say so.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gateSegment } from '../understanding/candidateGate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../../../eval/datasets/extraction-core.v1.json'), 'utf8'));

const claimBearing = c => (c.claims?.length ?? 0) > 0;
const admitsVia = reason => DS.cases.filter(c => {
  const r = gateSegment(c.text, {});
  return r.admit && r.reason === reason;
});

describe('candidate gate — the question bypass, priced and pinned', () => {
  test('exactly three non-claim segments are admitted by the entity extractor', () => {
    const leak = admitsVia('entity-extractor').filter(c => !claimBearing(c));
    assert.equal(leak.length, 3,
      `entity-extractor question bypass moved: ${leak.map(c => c.text).join(' | ')}`);
  });

  test('all three are questions or requests, not statements', () => {
    // If a DECLARATIVE non-claim ever joins this set, the cause is different
    // and the analysis above does not cover it.
    const leak = admitsVia('entity-extractor').filter(c => !claimBearing(c));
    for (const c of leak) {
      assert.match(c.text, /^(what|how|why|when|where|who|explain|describe|list|show)\b|\?\s*$/i,
        `not question-shaped: "${c.text}"`);
    }
  });

  test('the guard still catches questions with NO entity', () => {
    // The bypass is specific to filter 1. The guard itself works.
    const rejected = DS.cases.filter(c => gateSegment(c.text, {}).reason === 'question-or-request');
    assert.ok(rejected.length >= 10, `only ${rejected.length} segments reach the question guard`);
  });

  test('the SIX claim-bearing questions the guard would kill are still admitted', () => {
    // The reason the order is not changed. Each is interrogative in form and
    // asserts about the user's world, and each survives only because filter 1
    // resolves an entity in it before the guard runs.
    //
    // SIX, NOT SEVEN, AND THE SEVENTH IS THE POINT. The dataset holds seven
    // claim-bearing question-shaped segments. "If we hired two more engineers,
    // could we ship sooner?" names no entity, so filter 1 does not fire, the
    // guard is reached, and it is REJECTED — that segment IS the gate's single
    // `n_claims_never_sent` and the whole of its recall gap. The bypass this
    // file documents is also the only thing holding recall at 0.99375.
    const questions = DS.cases.filter(c => claimBearing(c) && /\?\s*$/.test(c.text));
    const survivors = questions.filter(c => gateSegment(c.text, {}).admit);
    assert.equal(questions.length, 7);
    assert.equal(survivors.length, 6,
      'the guard may have moved above filter 1, or filter 1 stopped resolving these entities');
    const missed = questions.filter(c => !gateSegment(c.text, {}).admit);
    assert.match(missed[0].text, /two more engineers/,
      `the never-sent claim changed identity: "${missed[0].text}"`);
  });

  test('third-person doers resolve at filter 1, which is the fix that caused all this', () => {
    // Tier 2 once required a copula, so these were invisible to the entity
    // extractor. Pinning a few keeps the improvement from silently reverting.
    for (const text of [
      'Sam finished the billing refactor.',
      'Karan owns the deploy checklist.',
      'The team chose React over Vue.',
    ]) {
      const r = gateSegment(text, {});
      assert.equal(r.reason, 'entity-extractor', `"${text}" no longer resolves an entity`);
    }
  });
});
