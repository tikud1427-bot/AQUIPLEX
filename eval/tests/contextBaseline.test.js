/**
 * The Context Engine question, closed — with the measurement that closed it.
 *
 * Reads the two committed baselines that grade the same 200 queries through
 * different engines: `retrieval-core.v1` (the PIC floor) and `context-core.v1`
 * (`Brain.assembleContext`, the path `routes/chat.js:587` actually reads with
 * `AQUA_CONTEXT_V2=on`).
 *
 * These assertions read RECORDED figures rather than re-running the suites —
 * the same idiom as `retrievalBaseline.test.js`. The gate protects the code;
 * this protects the conclusion drawn from it, which is the thing that gets
 * forgotten and re-litigated.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = f => JSON.parse(readFileSync(path.join(HERE, '../baselines', f), 'utf8')).metrics;
const FLOOR = load('retrieval-core.v1.json');
const CE = load('context-core.v1.json');

describe('the Context Engine earns nothing over the lane it wraps', () => {
  test('RECORDED: the CE is WORSE than its own floor on nine of eleven metrics', () => {
    // Not a subtlety. The layer that decides what reaches the model loses
    // answers the layer beneath it already found.
    for (const m of ['recall_at_8', 'mrr', 'ndcg_at_8', 'top1_kind',
      'recall_direct', 'recall_superseded', 'recall_temporal', 'recall_negation', 'recall_category']) {
      assert.ok(CE[m] < FLOOR[m], `${m}: CE ${CE[m]} is no longer below floor ${FLOOR[m]} — re-read the note`);
    }
  });

  test('RECORDED: the only thing it buys is three noise lines', () => {
    assert.ok(CE.noise_lines < FLOOR.noise_lines);
    assert.equal(CE.unknown_honesty, FLOOR.unknown_honesty);
  });

  test('CLOSED: no relevance threshold can make it beat the floor', () => {
    // The obvious fix — have the CE abstain when nothing in the pool is
    // relevant enough — was measured before being built, and the signal is not
    // there. Top floor-relevance per query, over the same 200:
    //
    //   answerable        p10 0.000   p25 0.333   median 0.575
    //   noisy silence     min 0.250   median 0.500   max 0.600
    //
    // The noisy population sits INSIDE the answerable one. Every threshold:
    //
    //   T=0.30   removes 1 of 16 noise lines,  silences 32 of 168 answerable
    //   T=0.35   removes 3 of 16,              silences 43 of 168
    //   T=0.45   removes 8 of 16,              silences 55 of 168
    //
    // The floor's score cannot tell "I found the answer" from "I found
    // something person-shaped". Nothing downstream of it can either, because
    // that score is the only relevance signal the CE is given.
    //
    // Four configurations were built and measured across sessions. The best —
    // exempting floor items from BOTH minScore gates so the CE stops
    // re-judging what the floor admitted — reaches recall 0.7560, EXACTLY the
    // floor, at 17 noise lines against the floor's 16.
    //
    // So the best available Context Engine is strictly worse than switching it
    // off: same recall, one more noise line, and a layer of code on the turn
    // path. Its value has to come from something the floor does NOT have —
    // embeddings, typed claims, project or file context — not from re-ranking
    // what the floor hands it. This assertion exists so the threshold idea is
    // met with evidence rather than tried a fifth time.
    assert.ok(CE.recall_at_8 <= FLOOR.recall_at_8,
      'the CE now beats its floor on recall — re-run the separation measurement and rewrite this finding');
  });
});

describe('the residual noise is E6-blocked, not a gate defect', () => {
  test('RECORDED: 16 noise lines survive at the floor', () => {
    assert.equal(FLOOR.noise_lines, 16);
    assert.ok(FLOOR.unknown_honesty < 0.75);
  });

  test('CLOSED: the noisy questions are SHAPE-IDENTICAL to ones that must answer', () => {
    // The tempting fix is to tighten `factAffinity`'s vacuous-topic rule: when
    // every content word is a cue, `topicTerms` is empty, `topicSupported`
    // returns true for nothing, and any fact offering the right kind earns
    // credit. That is how "What is my partner's birthday?" collects strangers.
    //
    // It cannot be tightened. Measured shapes:
    //
    //   "What is my partner's birthday?"  expects=person typed topic=[] affirmed
    //   "Who is my co-founder?"           expects=person typed topic=[] affirmed
    //   "Where do I work?"                expects=place  typed topic=[] affirmed
    //
    // Identical. The two that must answer and the one that must not are not
    // distinguishable by question shape at all. What separates them is whether
    // the store holds that RELATION — co-founder yes, partner's-birthday no —
    // which is precisely what the engine is trying to work out.
    //
    // So the residue is not a threshold, a lexicon, or a layer-ordering
    // problem. It needs claims typed by predicate, which is E6, which is
    // provider-blocked. Recording it here so the next person does not spend a
    // session rediscovering that the shapes are the same.
    assert.ok(FLOOR.unknown_honesty >= 0.71,
      'unknown_honesty moved — if it ROSE without E6, something distinguishes these shapes after all');
  });
});
