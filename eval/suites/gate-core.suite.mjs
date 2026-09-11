/**
 * AQUA Eval — candidate gate: does a claim-bearing segment reach the extractor?
 * Blueprint E6/PR-2
 *
 * WHY A SEPARATE SUITE OVER THE SAME DATASET
 * ------------------------------------------
 * `extraction-core.v1` already labels 200 segments, 160 carrying claims and 40
 * not. `extraction-core` asks whether the extractor gets a claim RIGHT. This
 * suite asks the prior question — whether the segment ARRIVES. Same cases,
 * different question, and conflating them hid the more important number:
 *
 *   extraction recall was reported at 0.613, and the gate's recall was ALSO
 *   0.613, because the gate was the thing failing. No extractor change could
 *   have moved that figure.
 *
 * RECALL AND PRECISION MEAN DIFFERENT THINGS HERE
 * -----------------------------------------------
 *   recall     claims that reach the extractor. A miss is PERMANENT — no
 *              later stage can recover a segment that was never sent. This is
 *              the quality metric and it is the ceiling on E6.
 *   precision  the bill. A false admit costs one extraction call and nothing
 *              else. Reported as cost, gated so it cannot quietly collapse.
 *
 * They are reported separately and never averaged, for the same reason
 * capture-core keeps capture and retrievability apart.
 *
 * ⚠️ THESE NUMBERS ARE IN-SAMPLE. The cue signals in `candidateGate.js` were
 * designed by reading the segments this dataset missed. That is legitimate —
 * the misses are the specification — but it means the reported recall is
 * fitted and a fresh corpus should be expected to score lower. The
 * out-of-sample check lives in the module's test suite against capture-core,
 * whose turns were written earlier and were not consulted while tuning.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gateSegment } from '../../src/brain/understanding/candidateGate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/extraction-core.v1.json'), 'utf8'));

const ratio = (a, b) => (b ? a / b : 0);

export default {
  id: 'gate-core',
  title: 'candidate gate — does a claim-bearing segment reach the extractor',
  about: [
    'Runs the production candidate gate over the 200 labelled segments in extraction-core.v1',
    '(160 claim-bearing, 40 not) and asks only whether each segment is ADMITTED — not whether the',
    'extractor then gets it right. Gate recall is a hard ceiling on E6: a rejected segment reaches',
    'no extractor at all. Recall is the quality metric, precision is the extraction bill, and the',
    'two are reported separately. The cue signals were tuned by reading this dataset\'s misses, so',
    'these figures are IN-SAMPLE; the out-of-sample check runs against capture-core in the unit tests.',
  ].join('\n'),

  cases: DS.cases,

  async run(testCase) {
    const g = gateSegment(testCase.text);
    return { status: 'ok', actual: { admit: g.admit, reason: g.reason } };
  },

  score(testCase, actual) {
    const shouldAdmit = (testCase.claims ?? []).length > 0;
    return {
      correct: actual.admit === shouldAdmit,
      cat: testCase.cat,
      shouldAdmit,
      admitted: actual.admit,
      reason: actual.reason,
    };
  },

  metrics(scored) {
    const tp = scored.filter(s => s.shouldAdmit && s.admitted).length;
    const fp = scored.filter(s => !s.shouldAdmit && s.admitted).length;
    const fn = scored.filter(s => s.shouldAdmit && !s.admitted).length;

    // Recall per category — where a fix earns or loses, and the reason the
    // third-person cues exist at all.
    const byCat = {};
    for (const s of scored.filter(x => x.shouldAdmit)) {
      byCat[s.cat] ??= { n: 0, in: 0 };
      byCat[s.cat].n++;
      if (s.admitted) byCat[s.cat].in++;
    }

    // Which signal admitted what. A gate resting entirely on one signal is
    // fragile in a way the aggregate numbers hide.
    const bySignal = {};
    for (const s of scored.filter(x => x.admitted)) {
      bySignal[s.reason] = (bySignal[s.reason] ?? 0) + 1;
    }

    return {
      gate_recall:    ratio(tp, tp + fn),
      gate_precision: ratio(tp, tp + fp),
      n_admitted:            tp + fp,
      n_claim_bearing:       tp + fn,
      n_claims_never_sent:   fn,
      n_false_admits:        fp,
      ...Object.fromEntries(Object.entries(byCat).sort()
        .map(([cat, v]) => [`recall_${cat}`, ratio(v.in, v.n)])),
      ...Object.fromEntries(Object.entries(bySignal).sort()
        .map(([sig, n]) => [`n_via_${sig.replace(/[:-]/g, '_')}`, n])),
    };
  },
};
