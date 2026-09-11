/**
 * AQUA Eval — contradiction detection
 * Blueprint: the eval FINDING-1 said had to exist first
 *
 * FINDING-1 measured 73,500 `contradicts` edges from 300 facts, nearly all of
 * them false: the detector reported *"numeric disagreement about VendorCo"*
 * between `Item 0 … value 1000` and `Item 1 … value 1001` — different items,
 * different values, both true at once.
 *
 * It was deliberately not fixed, because changing a contradiction detector
 * changes what AQUA believes and there was **no way to tell whether a fix
 * removed the false positives without removing the true ones**. This is that
 * way.
 *
 * PRECISION IS THE HEADLINE, NOT ACCURACY
 * ---------------------------------------
 * The dataset is deliberately unbalanced — 38 independent pairs to 15 genuine
 * contradictions — because the measured failure is over-firing. A single
 * accuracy figure over an unbalanced set would let a detector that says
 * "contradiction" to everything look respectable, which is precisely the
 * behaviour under investigation.
 *
 * So precision and recall are reported separately and never averaged into one
 * number. F1 is derived and shown, but the two components are what a fix has
 * to move in the right direction TOGETHER: dropping recall to buy precision is
 * not a fix, it is a different bug.
 *
 * WHAT THIS MEASURES, AND WHAT IT CANNOT
 * --------------------------------------
 * The real detector gates on cross-FILE provenance before it ever calls the
 * textual predicate. A pair of statements cannot express provenance, so this
 * measures the TEXTUAL predicate only — `conflictKind(a, b)`.
 *
 * That is the right scope: the file gate is a policy question, and the false
 * positives in FINDING-1 all passed the file gate legitimately (they really
 * were in different files). The text is where the error is.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _conflictKindForTests } from '../../src/reasoning/relationshipEngine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/contradiction-core.v1.json'), 'utf8'));

export default {
  id: 'contradiction-core',
  title: 'contradiction detection — precision on unrelated values',
  about: [
    'Runs the textual conflict predicate over 53 labelled statement pairs: 15 genuine',
    'contradictions and 38 independent pairs, 22 of them the per-item-table shape that',
    'FINDING-1 measured firing 73,500 times on 300 facts. Precision and recall are reported',
    'SEPARATELY — the dataset is deliberately unbalanced, so a single accuracy figure would',
    'flatter a detector that fires on everything, which is the behaviour under investigation.',
  ].join('\n'),

  cases: DS.cases,

  async run(testCase) {
    const kind = _conflictKindForTests(testCase.a, testCase.b);
    return { status: 'ok', actual: { fired: kind !== null, kind } };
  },

  score(testCase, actual) {
    const shouldFire = testCase.label === 'contradiction';
    return {
      correct: actual.fired === shouldFire,
      cat: testCase.cat,
      shouldFire,
      fired: actual.fired,
      kind: actual.kind,
    };
  },

  metrics(scored) {
    const ratio = (a, b) => (b ? a / b : 0);
    const tp = scored.filter(s => s.shouldFire && s.fired).length;
    const fp = scored.filter(s => !s.shouldFire && s.fired).length;
    const fn = scored.filter(s => s.shouldFire && !s.fired).length;
    const tn = scored.filter(s => !s.shouldFire && !s.fired).length;

    const precision = ratio(tp, tp + fp);
    const recall = ratio(tp, tp + fn);

    const byCat = {};
    for (const s of scored.filter(x => !x.shouldFire)) {
      byCat[s.cat] ??= { n: 0, fired: 0 };
      byCat[s.cat].n++;
      if (s.fired) byCat[s.cat].fired++;
    }

    return {
      // Reported separately, always. Buying precision by dropping recall is
      // not a fix, it is a different bug.
      precision,
      recall,
      f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,

      true_positives: tp,
      false_positives: fp,
      false_negatives: fn,
      true_negatives: tn,

      // False-positive RATE per independent category — where the over-firing
      // actually lives.
      ...Object.fromEntries(Object.entries(byCat).sort()
        .map(([cat, v]) => [`false_fire_${cat.replace(/-/g, '_')}`, ratio(v.fired, v.n)])),

      genuine_pairs: scored.filter(s => s.shouldFire).length,
      independent_pairs: scored.filter(s => !s.shouldFire).length,
    };
  },
};
