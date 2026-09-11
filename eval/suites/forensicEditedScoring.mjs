/**
 * AQUA Eval — the `edited_number` scorer, shared by both lanes that grade it.
 *
 * WHY IT WAS EXTRACTED
 * --------------------
 * `forensic-edited` grades `_looksEditedForTests(a, b)` — the pairwise
 * PREDICATE — and says so in its own title: "the textual half". The other half
 * is the loop in `forensicReport` that decides which pairs are ever COMPARED,
 * and nothing graded it. A grouping change could halve the findings and every
 * metric in that baseline would sit still.
 *
 * `forensic-report` closes that. Copying the arithmetic would have produced two
 * scorers that drift, and the drift would land exactly where it does most
 * damage: the two numbers exist to be COMPARED, and a comparison between two
 * scorers is not a comparison between two lanes.
 *
 * Same precedent, same reason as `retrievalScoring.mjs`: one definition, two
 * callers, only the engine under test changes.
 *
 * Pure. No I/O, no imports, no engine knowledge.
 */

/** Grade one labelled pair. `fired` is whatever the lane observed. */
export function scorePair(testCase, fired) {
  const shouldFire = testCase.label === 'edited';
  return { correct: fired === shouldFire, cat: testCase.cat, shouldFire, fired };
}

/**
 * Precision and recall, reported SEPARATELY and never averaged.
 *
 * The set is deliberately weighted toward ordinary pairs, so a single accuracy
 * figure would flatter a rule that flags everything — which is the behaviour
 * originally under investigation. Counts carry an `n_` prefix because the
 * reporter renders any value in [0,1] as a percentage, and one false positive
 * printed as "100.0%" is a number that will be misquoted.
 */
export function aggregatePairs(scored) {
  const ratio = (a, b) => (b ? a / b : 0);
  const tp = scored.filter(s => s.shouldFire && s.fired).length;
  const fp = scored.filter(s => !s.shouldFire && s.fired).length;
  const fn = scored.filter(s => s.shouldFire && !s.fired).length;

  const byCat = {};
  for (const s of scored.filter(x => !x.shouldFire)) {
    byCat[s.cat] ??= { n: 0, fired: 0 };
    byCat[s.cat].n++;
    if (s.fired) byCat[s.cat].fired++;
  }

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    n_true_positives: tp,
    n_false_positives: fp,
    n_false_negatives: fn,
    ...Object.fromEntries(Object.entries(byCat).sort()
      .map(([cat, v]) => [`false_fire_${cat.replace(/-/g, '_')}`, ratio(v.fired, v.n)])),
    n_edited_pairs: scored.filter(s => s.shouldFire).length,
    n_ordinary_pairs: scored.filter(s => !s.shouldFire).length,
  };
}
