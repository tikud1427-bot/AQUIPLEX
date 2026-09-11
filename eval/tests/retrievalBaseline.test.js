/**
 * AQUA Eval — retrieval baseline
 * Blueprint E2/PR-5
 *
 * Same two jobs as the extraction baseline, for the same reasons:
 *
 *   1. The baseline REPRODUCES. If it drifts, retrieval behaviour changed.
 *   2. The scorer and the SEEDED WORLD are FAIR. A retrieval benchmark can be
 *      unfair in two places rather than one — a badly built world scores the
 *      seeder, not the engine. Both are asserted against synthetic perfect
 *      input.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import suite from '../suites/retrieval-core.suite.mjs';
import { seedWorld, retrieveWithCurrentEngine } from '../adapters/currentRetrieval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/retrieval-core.v1.json'), 'utf8'));
const BASELINE = JSON.parse(readFileSync(path.join(HERE, '../baselines/retrieval-core.v1.json'), 'utf8'));
const OWNER = 'user:eval-retrieval-test';
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

before(async () => { await seedWorld(OWNER, DS.corpus); });

// ── The world is real ────────────────────────────────────────────────────────

describe('retrieval baseline — the seeded world is not a stub', () => {
  test('a verbatim query finds its fact', async () => {
    const r = await retrieveWithCurrentEngine(OWNER, 'Who is our head of design?');
    assert.ok(r.ranked.includes('f006'), `expected f006, got ${JSON.stringify(r.ranked)}`);
  });

  test('the self node is recognised — otherwise lane 2b is dark', async () => {
    // Seeded as `data.isSelf` first, which is NOT the marker the engine looks
    // for (`data.entityType === 'self'`). Lane 2b stayed dark and the whole
    // baseline was understated until the predicate was read rather than
    // assumed. This test is what stops that recurring silently.
    const r = await retrieveWithCurrentEngine(OWNER, 'What is my job?');
    assert.ok(r.ranked.length > 0, 'a first-person query returned nothing — the self anchor is not firing');
  });

  test('about edges exist — Lane 3 hops across them', async () => {
    const r = await retrieveWithCurrentEngine(OWNER, 'Tell me about Nummo.');
    assert.ok(r.ranked.length > 0, 'no graph reach — the about edges were not seeded');
  });
});

// ── The scorer is fair ───────────────────────────────────────────────────────

describe('retrieval baseline — the scorer is not accidentally harsh', () => {
  const q = DS.queries.find(x => x.cat === 'multi');

  test('PERFECT ranking scores 1.0 on every rank metric', () => {
    const perfect = { ranked: [...q.relevant, ...q.acceptable] };
    const s = suite.score(q, perfect);
    assert.equal(s.correct, true, 'perfect ranking marked wrong — the scorer is harsh');
    assert.equal(s.rr, 1);
    assert.ok(near(s.ndcg, 1), `nDCG ${s.ndcg} on a perfect ranking`);
    assert.equal(s.recalled, q.relevant.length);
  });

  test('nDCG rewards relevant above acceptable', () => {
    const good = suite.score(q, { ranked: [...q.relevant, ...q.acceptable] });
    const swapped = suite.score(q, { ranked: [...q.acceptable, ...q.relevant] });
    assert.ok(good.ndcg > swapped.ndcg, 'grading is not distinguishing relevant from acceptable');
  });

  test('silence on a silence-expecting query is correct; anything else is not', () => {
    const s = DS.queries.find(x => x.relevant.length === 0);
    assert.equal(suite.score(s, { ranked: [] }).correct, true);
    assert.equal(suite.score(s, { ranked: ['f001'] }).correct, false);
  });

  test('noise and honesty are reported separately, never averaged in', () => {
    const m = suite.metrics([
      { silence: false, cat: 'direct', hit: true, correct: true, rr: 1, ndcg: 1, recalled: 1, relevantTotal: 1, kindOk: true, returned: 1 },
      { silence: true, cat: 'unknown', correct: false, returned: 8 },
    ]);
    assert.equal(m.recall_at_8, 1, 'a noisy silence query dragged down recall');
    assert.equal(m.unknown_honesty, 0);
    assert.equal(m.noise_lines, 8);
    assert.equal(m.noisy_queries, 1);
  });
});

// ── The baseline reproduces ──────────────────────────────────────────────────

describe('retrieval baseline — reproduces the committed figures', () => {
  test('the baseline records the conditions that produced it', () => {
    assert.equal(BASELINE.caseCount, 200);
    assert.equal(BASELINE.coverage.complete, true);
    assert.ok(BASELINE.suiteFingerprint);
    assert.match(BASELINE.note, /retrieveKnowledge/);
  });

  test('every headline figure is present and in range', () => {
    for (const key of ['recall_at_8', 'mrr', 'ndcg_at_8', 'top1_correct', 'top1_kind', 'unknown_honesty']) {
      const v = BASELINE.metrics[key];
      assert.equal(typeof v, 'number', `${key} missing`);
      assert.ok(v >= 0 && v <= 1, `${key} out of range: ${v}`);
    }
  });
});

// ── What the baseline says ───────────────────────────────────────────────────

describe('retrieval baseline — the findings, pinned', () => {
  const m = BASELINE.metrics;

  test('verbatim retrieval is strong — the lane does what it was built for', () => {
    assert.ok(m.recall_direct > 0.9, `direct recall ${m.recall_direct}`);
  });

  // ── The five findings, and what closed them ────────────────────────────────
  //
  // These were RECORDED DEFECTS. They are now FIXED, and the assertions have
  // been inverted deliberately: a test that pins a defect protects the defect
  // once the defect is gone. The historical figures stay in the comments and in
  // BASELINE.md so the movement is auditable, but the gate must guard the new
  // number or it is guarding nothing.
  //
  // All five had ONE root cause. Lane 2b anchored on the owner for any
  // first-person question and lane 3 hopped every `about` edge scoring each
  // `confidence * 0.5 + 0.05` — an expression in which the query does not
  // appear. Four different questions returned byte-identical output. The fix
  // is `src/pic/questionShape.js` plus the relevance gate in
  // `retrievalIntelligence.js`; see `src/pic/tests/relevanceGate.test.js`.

  test('CLOSED: currency — the current employer outranks the superseded one', () => {
    // WAS 0.20. f003 says Intercom and is superseded by f001; the engine had no
    // notion of currency, so the outdated fact ranked and the current one did
    // not. Supersession is now conditional on the question's tense: a
    // superseded fact is withheld from a present-tense question and ADMITTED to
    // a question about the past, because L5 says nothing is deleted and a
    // reader that can never see a superseded claim has deleted it at read time.
    assert.ok(m.recall_superseded >= 0.6, `superseded recall ${m.recall_superseded} — regression against 0.60`);
  });

  test('CLOSED: negation is reached by a CLAIM-ATTRIBUTE lane, not a dense one', () => {
    // WAS 0.20, then 0.30, now 0.80.
    //
    // THIS TEST FIRED AS DESIGNED AND ITS PREMISE WAS WRONG. It asserted
    // `recall_negation < 0.6` with the message "negation solved without a dense
    // lane — verify this is real, not fitted", on the reasoning that "What did
    // we turn down?" and "We rejected the Bangalore relocation" share no
    // vocabulary, so only a dense lane could bridge them and any surface fix
    // would be a synonym table fitted to this corpus.
    //
    // A THIRD OPTION EXISTED: retrieve on the claim's POLARITY instead of on
    // its words. The question's negation was already parsed and the store
    // already knew which facts were negated; no lane connected them, because
    // every lane proposed candidates either lexically or by graph adjacency.
    // Lane 5 (`retrievalIntelligence.js`) is that connection. It is not a
    // synonym table and does not know this corpus.
    //
    // THE ANTI-FITTING EVIDENCE THE OLD ASSERTION ASKED FOR:
    //   · noise_lines and unknown_honesty did NOT move. A lane fitted to the
    //     labels buys recall with noise; this one bought none.
    //   · The two remaining misses (q128, q135) both need "chose Postgres over
    //     Mongo", where negation attaches to the OBJECT. Deliberately not
    //     fixed — that genuinely needs E6 typed claims, and adding `over` as a
    //     cue would have moved this number dishonestly.
    //   · `blocked` and `lost` were considered for the cue list and excluded on
    //     a general-English test, not a scoreboard test. `blocked` would have
    //     flipped "Priya is blocked on the design tokens" to negated and
    //     demoted the affirmative question that asks for it.
    //
    // The ceiling below is kept, pointed at the two object-level cases: if
    // negation reaches 1.0 without E6 landing, something WAS fitted.
    assert.ok(m.recall_negation >= 0.8, `negation recall ${m.recall_negation} — regression against 0.80`);
    assert.ok(m.recall_negation < 1, 'object-level negation solved without E6 typed claims — verify this is real, not fitted');
  });

  test('NARROWED: the category/instance gap is bridged but not closed', () => {
    // WAS 0.406 against direct 0.964 — a 55-point gap. The kind signal now
    // bridges "What is my job?" to "I run product at Nummo" with zero lexical
    // overlap. What remains is genuine vocabulary distance, same cause as the
    // negation ceiling above.
    assert.ok(m.recall_category >= 0.46, `category recall ${m.recall_category} — regression against 0.469`);
    assert.ok(m.recall_direct - m.recall_category > 0.2, 'gap closed — verify the dense lane landed rather than the labels drifting');
  });

  test('CLOSED: unanswerable queries mostly get silence', () => {
    // WAS 0.344 honesty and 131 noise lines across 21 of 32 silence-expecting
    // queries — every one of them first-person. The self-anchor fired on any
    // "my"/"I" question and returned eight owner facts whether or not they
    // answered it. It has a relevance gate now, and a sufficiency check: a
    // typed question whose TOPIC noun is unknown ("who is my dentist") is not
    // answered on kind alone. Unknown stays unknown.
    assert.ok(m.unknown_honesty >= 0.70, `unknown honesty ${m.unknown_honesty} — regression against 0.719`);
    assert.ok(m.noise_lines <= 20, `noise lines ${m.noise_lines} — regression against 16`);
  });

  test('IMPROVED: the top hit is the right KIND more often than not', () => {
    // WAS 0.429 — and the reason was that the top hit was the SAME FACT for
    // every first-person question. Kind is now a graded signal that reads the
    // world model first and its own surface patterns second.
    assert.ok(m.top1_kind > 0.5, `top1_kind ${m.top1_kind} — regression against 0.548`);
  });

  test('the honesty metrics are still reported SEPARATELY from the averages', () => {
    // The averages cover 168 answerable queries; the 32 silence queries are
    // scored on their own. Folding them together would let a noisier engine
    // buy a better headline by answering more often — which is the exact
    // failure this suite exists to catch.
    assert.equal(m.answerable_queries + m.silence_queries, 200);
    assert.ok(typeof m.noise_lines === 'number' && typeof m.unknown_honesty === 'number');
  });
});
