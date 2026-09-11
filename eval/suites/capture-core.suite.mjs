/**
 * AQUA Eval — capture quality: does a conversation become retrievable
 * world-model state?
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The post-PR-1 re-audit measured the Context Engine selecting 100% of its
 * candidate pool at every session length tested — 3/3, 9/9, 18/18, nothing
 * ever dropped, budget at 31% of its ceiling. Ranking cannot be the
 * bottleneck when nothing competes. What it also measured: 8 turns produced 4
 * world-model facts, and 4 of 7 flagship personal questions returned zero from
 * the world model while the older memory lane held the answer.
 *
 * That is a capture number and there was no instrument for it.
 * `extraction-core.v1` grades one sentence against labels; `retrieval-core.v1`
 * grades the reader against a hand-seeded world. Neither runs a conversation
 * through the production path and asks what survived.
 *
 * TWO DIMENSIONS. NEVER ONE SCORE.
 * --------------------------------
 *   CAPTURE         did the intended fact reach the world model at all?
 *   RETRIEVABILITY  of the facts that WERE captured, does the production
 *                   reader surface them for the question they answer?
 *
 * Retrievability is scored over CAPTURED cases only. Scoring it over all
 * cases would make it a function of capture and quietly re-average the two —
 * a capture collapse would then hide behind clean retrieval of the little
 * that survived. The cross-term is reported separately as
 * `captured_but_unreachable`, which is its own bug class: written, and lost.
 *
 * WHAT A FAILURE HERE IS NOT
 * --------------------------
 * A low capture rate is not a claim that any particular fix is right. This
 * suite deliberately has no opinion about whether the answer is E6's LLM
 * extractor, a wider regex, or a gating change. It states the number the
 * replacement must beat. Per L14 that number has to exist before the
 * capability ships, and per L16 it has to be measured rather than asserted.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingestConversation, askProduction, factTexts, containsAll } from '../adapters/currentCapture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/capture-core.v1.json'), 'utf8'));

const ratio = (a, b) => (b ? a / b : 0);

export default {
  id: 'capture-core',
  title: 'capture — does a conversation become retrievable world-model state',
  about: [
    'Runs 23 short conversations (34 turns) through the PRODUCTION turn path — memoryObserve,',
    'addMessage, runPostTurn with default deps, then the real drainJobs — and asks the production',
    'reader, pic/core.js retrieveKnowledge. Capture and retrievability are separate metrics and are',
    'never combined; retrievability is measured only over captured cases, so a capture collapse',
    'cannot hide behind clean retrieval of the survivors. n_captured_but_unreachable is its own count.',
    'Three cases queue their post-turn jobs before draining (the `concurrency` category, with a',
    'same-turns control) because concurrent ingest loses writes; every other case drains per turn,',
    'which is what a human-paced conversation actually does.',
  ].join('\n'),

  cases: DS.cases,

  async run(testCase) {
    // Per-case owner. Cases share a process and every store is a module-level
    // singleton, so a shared owner would let case N read case N-1's world and
    // report capture that never happened in this case.
    const ownerId = `user:cap-${testCase.id}`;
    const conversationId = `c-cap-${testCase.id}`;

    const { facts, drained } = await ingestConversation(ownerId, conversationId, testCase.turns, { batch: testCase.batch === true });

    if (drained.timedOut) {
      // COULD NOT RUN. An incomplete drain means deferred ingest may still be
      // in flight, so a low capture reading here would measure the harness.
      return { status: 'skipped', reason: `post-turn drain timed out (outstanding=${JSON.stringify(drained.outstanding)})` };
    }

    const texts = factTexts(facts);
    const captured = testCase.expect_facts.map(tokens => containsAll(texts, tokens));

    // Retrieval is asked unconditionally so the raw observation is recorded,
    // but score() only counts it where capture succeeded.
    const asked = await askProduction(ownerId, testCase.ask);
    const wantLower = testCase.want.map(w => w.toLowerCase());
    const anyLine = asked.lines.some(l => wantLower.every(w => l.toLowerCase().includes(w)));
    const top1 = asked.lines.length > 0 && wantLower.every(w => asked.lines[0].toLowerCase().includes(w));

    return {
      status: 'ok',
      actual: {
        factCount: facts.length,
        turnCount: testCase.turns.length,
        captured,
        retrieved: anyLine,
        top1,
        lines: asked.lines.length,
      },
    };
  },

  score(testCase, actual) {
    const expected = testCase.expect_facts.length;
    const got = actual.captured.filter(Boolean).length;
    const fullyCaptured = got === expected;

    return {
      // `correct` is the runner's headline field. Capture is the primary
      // dimension, so it owns that slot; retrievability is reported in its own
      // metrics and is NOT folded in here.
      correct: fullyCaptured,
      cat: testCase.cat,
      expectedFacts: expected,
      capturedFacts: got,
      fullyCaptured,
      partiallyCaptured: got > 0 && got < expected,
      retrieved: actual.retrieved,
      top1: actual.top1,
      factCount: actual.factCount,
      turnCount: actual.turnCount,
    };
  },

  metrics(scored) {
    const n = scored.length;
    const fully = scored.filter(s => s.fullyCaptured);
    const partial = scored.filter(s => s.partiallyCaptured);

    // ── Dimension A — capture ────────────────────────────────────────────────
    const expectedTotal = scored.reduce((a, s) => a + s.expectedFacts, 0);
    const capturedTotal = scored.reduce((a, s) => a + s.capturedFacts, 0);

    // ── Dimension B — retrievability, over CAPTURED cases only ───────────────
    // The denominator is the whole point. Over all cases this would be a
    // capture metric wearing a retrieval name.
    const retrievable = fully.filter(s => s.retrieved);
    const top1Hits = fully.filter(s => s.top1);

    const byCat = {};
    for (const s of scored) {
      byCat[s.cat] ??= { n: 0, fully: 0 };
      byCat[s.cat].n++;
      if (s.fullyCaptured) byCat[s.cat].fully++;
    }

    const turns = scored.reduce((a, s) => a + s.turnCount, 0);
    const facts = scored.reduce((a, s) => a + s.factCount, 0);

    // COUNTS CARRY AN `n_` PREFIX ON PURPOSE. The reporter renders any value
    // in [0,1] as a percentage (report.mjs:88), so a count of 1 printed as
    // "1.0000 (100.0%)" and the first run of this suite showed
    // `captured_but_unreachable 100.0%` for a single unreachable case. A
    // baseline that can be misread that badly is a baseline that will be
    // misquoted. The prefix makes the kind unambiguous at the call site and in
    // the report.
    return {
      // A — capture
      capture_rate:            ratio(fully.length, n),
      capture_fact_rate:       ratio(capturedTotal, expectedTotal),
      n_cases_fully_captured:    fully.length,
      n_cases_partially_captured: partial.length,
      n_cases_not_captured:      n - fully.length - partial.length,
      n_expected_facts:          expectedTotal,
      n_captured_facts:          capturedTotal,

      // B — retrievability (denominator = captured cases)
      retrievability_rate:     ratio(retrievable.length, fully.length),
      retrieval_top1_rate:     ratio(top1Hits.length, fully.length),
      n_captured_cases:          fully.length,
      n_captured_but_unreachable: fully.length - retrievable.length,

      // Volume — context for both, not a quality score
      n_total_turns:             turns,
      n_world_model_facts:       facts,
      facts_per_turn:          ratio(facts, turns),

      // Per-category capture. Categories are where a fix earns or loses.
      ...Object.fromEntries(Object.entries(byCat).sort()
        .map(([cat, v]) => [`capture_${cat}`, ratio(v.fully, v.n)])),
    };
  },
};
