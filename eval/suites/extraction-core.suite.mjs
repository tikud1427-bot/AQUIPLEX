/**
 * AQUA Eval — extraction quality, graded
 * Blueprint E2/PR-3
 *
 * The first answer this project has ever had to **"is it right?"**
 *
 * FOUR LEVELS, BECAUSE ONE NUMBER WOULD BE USELESS
 * ------------------------------------------------
 * The dataset labels full claims — subject, predicate, object, polarity,
 * modality, time. The current extractor emits verbatim sentences plus an
 * entity list. Scored as a single pass/fail it reports near zero, and a
 * near-zero baseline says nothing about WHERE the gap is while making any
 * replacement look miraculous.
 *
 * So it is graded, and the shape of the drop-off is the finding:
 *
 *   detection   a sentence carrying a claim produced SOMETHING
 *   subject     the claim's subject was recognised as an entity
 *   predicate   the relation was captured
 *   fidelity    polarity + modality + time were captured
 *
 * PRECISION IS SCORED SEPARATELY, ON THE NEGATIVES
 * ------------------------------------------------
 * 40 cases carry no claims. An extractor that fires on everything gets perfect
 * detection recall and is worthless. This project has shipped that failure
 * twice, so silence on a negative is scored as its own metric rather than
 * folded into an average that hides it.
 *
 * WHAT "CORRECT" MEANS FOR THE RUNNER
 * -----------------------------------
 * `correct` is the STRICTEST level — a positive case is correct only if
 * detection, subject, predicate and fidelity all hold; a negative is correct
 * if nothing was emitted. Overall accuracy will therefore read very low, and
 * that is the honest headline. The per-level metrics are where the diagnosis
 * lives.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractWithCurrentEngine, surfacesOf } from '../adapters/currentExtractor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/extraction-core.v1.json'), 'utf8'));

/** Did the extractor recognise this claim's subject as an entity? */
function subjectFound(claim, surfaces) {
  if (claim.s === 'SELF') return surfaces.has('__self__');
  return surfaces.has(claim.s.toLowerCase());
}

export default {
  id: 'extraction-core',
  title: 'extraction quality — current engine vs claim labels',
  about: [
    'Drives the production conversation-extraction lane (extractConversationEntities →',
    'resolveEntities → buildConversationFacts) over 200 labelled sentences and grades it at',
    'four levels: detection, subject, predicate, fidelity. Precision is measured separately',
    'on 40 negative cases. This is the baseline E6 has to beat; the shape of the drop-off',
    'across the four levels is the diagnosis, not the single accuracy figure.',
  ].join('\n'),

  cases: DS.cases,

  async run(testCase) {
    const result = extractWithCurrentEngine(testCase.text);
    return { status: 'ok', actual: { ...result, surfaces: [...surfacesOf(result)] } };
  },

  score(testCase, actual) {
    const emitted = actual.facts.length > 0;
    const surfaces = new Set(actual.surfaces);

    // ── negatives: the only right answer is silence ─────────────────────────
    if (testCase.cat === 'negative') {
      return { correct: !emitted, kind: 'negative', emitted, cat: testCase.cat };
    }

    // ── positives: four levels ──────────────────────────────────────────────
    const claims = testCase.claims;
    const subjectHits = claims.filter(c => subjectFound(c, surfaces)).length;

    // The lane emits a verbatim statement and an entity list. There is no
    // predicate field and no polarity/modality/time field anywhere in the
    // output, so these are structurally unreachable rather than merely wrong.
    // Computed from the output shape rather than hardcoded, so the day E6
    // starts emitting them this begins scoring without a code change.
    const predicateHits = claims.filter(c =>
      actual.facts.some(f => typeof f.predicate === 'string' && f.predicate === c.p)).length;
    const fidelityHits = claims.filter(c =>
      actual.facts.some(f =>
        f.polarity === c.polarity &&
        f.modality === c.modality &&
        (c.time ? Boolean(f.time || f.validFrom || f.validTo) : true))).length;

    return {
      correct: emitted && subjectHits === claims.length
               && predicateHits === claims.length && fidelityHits === claims.length,
      kind: 'positive',
      cat: testCase.cat,
      emitted,
      claims: claims.length,
      subjectHits,
      predicateHits,
      fidelityHits,
    };
  },

  metrics(scored) {
    const pos = scored.filter(s => s.kind === 'positive');
    const neg = scored.filter(s => s.kind === 'negative');
    const claims = pos.reduce((n, s) => n + s.claims, 0);
    const ratio = (a, b) => (b ? a / b : 0);

    const byCat = {};
    for (const s of pos) {
      byCat[s.cat] ??= { n: 0, detected: 0 };
      byCat[s.cat].n++;
      if (s.emitted) byCat[s.cat].detected++;
    }

    return {
      // headline — strictest, all four levels
      overall_strict_accuracy: ratio(scored.filter(s => s.correct).length, scored.length),

      // the four levels
      detection_recall: ratio(pos.filter(s => s.emitted).length, pos.length),
      subject_recall: ratio(pos.reduce((n, s) => n + s.subjectHits, 0), claims),
      predicate_accuracy: ratio(pos.reduce((n, s) => n + s.predicateHits, 0), claims),
      fidelity_accuracy: ratio(pos.reduce((n, s) => n + s.fidelityHits, 0), claims),

      // precision, kept separate so it cannot hide inside an average
      silence_on_negatives: ratio(neg.filter(s => !s.emitted).length, neg.length),
      false_positives: neg.filter(s => s.emitted).length,

      // per-category detection — where the misses actually are
      ...Object.fromEntries(Object.entries(byCat).sort()
        .map(([cat, v]) => [`detection_${cat}`, ratio(v.detected, v.n)])),

      // ── Denominators, so a 0/0 is distinguishable from a measured 0.0 ──
      //
      // `ratio()` returns 0 when the denominator is 0, which is right for a
      // metric but wrong for a DECISION. The E6 promotion gate read
      // `detection_negation: 0` on a slice containing no negation cases and
      // returned DO NOT PROMOTE. Publishing the counts alongside the rates
      // lets a caller tell "scored zero" from "was never asked".
      ...Object.fromEntries(Object.entries(byCat).sort()
        .map(([cat, v]) => [`n_cases_${cat}`, v.n])),

      positives: pos.length,
      negatives: neg.length,
      labelled_claims: claims,
    };
  },
};
