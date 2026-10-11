/**
 * The World-Model Lift (live) instrument, tested without a provider.
 * An experiment whose scoring is wrong produces a confident wrong answer to
 * the one question the blueprint cares most about (Part 14), so the pure half
 * is held to the same standard as product code.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../lift/liftCore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../lift/world-model-lift-live.v1.json'), 'utf8'));

describe('dataset', () => {
  test('preregistered: every question is answerable XOR expect-unknown, ids unique', () => {
    const ids = new Set();
    for (const p of DS.personas) {
      assert.ok(p.history.length >= 10, `${p.id}: history too short to need a memory`);
      for (const q of p.questions) {
        assert.ok(!ids.has(q.id), `duplicate ${q.id}`); ids.add(q.id);
        if (q.expectUnknown) assert.ok(!(q.required ?? []).length, `${q.id}: unknown with required facts`);
        else assert.ok((q.required ?? []).length >= 1, `${q.id}: answerable with no required fact`);
      }
    }
    assert.equal(ids.size, 60);
    assert.deepEqual(DS.corrections, [], 'a correction was added — re-run every earlier result and document it');
  });
  test('every category the brief requires is represented', () => {
    const cats = new Set(DS.personas.flatMap(p => p.questions.map(q => q.cat)));
    for (const c of ['current_fact', 'state_change', 'correction', 'negation', 'relational', 'decision', 're_explanation', 'unknown', 'preference']) {
      assert.ok(cats.has(c), `missing category ${c}`);
    }
  });
});

describe('memory baseline (BM25)', () => {
  const H = ['I work at Nummo.', 'Can you explain recursion?', 'My manager is Ravi.', 'I moved from Nummo to Freightline.'];
  test('returns matching turns in CHRONOLOGICAL order with turn numbers', () => {
    const r = L.bm25Retrieve(H, 'Where does Ravi work and where is Nummo?', 8);
    assert.deepEqual(r.map(t => t.turn), [1, 3, 4]);
    assert.match(L.formatTurns(r), /^\[turn 1\] I work at Nummo\./);
  });
  test('k binds and a query sharing no term retrieves nothing', () => {
    assert.equal(L.bm25Retrieve(H, 'nummo', 1).length, 1);
    assert.deepEqual(L.bm25Retrieve(H, 'zebra', 8), []);
  });
});

describe('one prompt template for every condition', () => {
  test('only the context block differs', () => {
    const a = L.buildAnswerPrompt('Q?', '');
    const b = L.buildAnswerPrompt('Q?', '[turn 1] x');
    assert.equal(a.user, b.user);
    assert.ok(a.system.startsWith(L.ANSWER_SYSTEM) && b.system.startsWith(L.ANSWER_SYSTEM));
    assert.match(a.system, /nothing is stored/);
    assert.match(b.system, /<<<\n\[turn 1\] x\n>>>/);
  });
});

describe('judge parsing is strict', () => {
  const q = { required: ['a', 'b'], forbidden: ['c'] };
  const good = '```json\n{"required":[true,false],"forbidden":[false],"saysUnknown":false,"fabricated":false,"askedForKnownInfo":false,"notes":"x"}\n```';
  test('accepts the asked-for shape, with or without a fence', () => {
    const j = L.parseJudgement(good, q);
    assert.deepEqual(j.required, [true, false]);
  });
  test('rejects a wrong arity or a non-boolean — never guesses', () => {
    assert.throws(() => L.parseJudgement('{"required":[true],"forbidden":[false],"saysUnknown":false,"fabricated":false,"askedForKnownInfo":false}', q));
    assert.throws(() => L.parseJudgement('{"required":[true,"yes"],"forbidden":[false],"saysUnknown":false,"fabricated":false,"askedForKnownInfo":false}', q));
    assert.throws(() => L.parseJudgement('no json here', q));
  });
});

describe('grading', () => {
  const j = (o) => ({ required: [], forbidden: [], saysUnknown: false, fabricated: false, askedForKnownInfo: false, ...o });
  test('strict: all required, no forbidden, no fabrication', () => {
    const q = { required: ['a', 'b'], forbidden: ['c'] };
    assert.equal(L.gradeAnswer(q, j({ required: [true, true], forbidden: [false] })).correct, true);
    assert.equal(L.gradeAnswer(q, j({ required: [true, false], forbidden: [false] })).correct, false);
    assert.equal(L.gradeAnswer(q, j({ required: [true, true], forbidden: [true] })).correct, false, 'stale fact accepted');
    assert.equal(L.gradeAnswer(q, j({ required: [true, true], forbidden: [false], fabricated: true })).correct, false);
  });
  test('unknown: honest only if it says so and invents nothing', () => {
    const q = { expectUnknown: true, forbidden: ['rate is 600'] };
    assert.equal(L.gradeAnswer(q, j({ forbidden: [false], saysUnknown: true })).correct, true);
    assert.equal(L.gradeAnswer(q, j({ forbidden: [false], saysUnknown: true, fabricated: true })).correct, false);
    assert.equal(L.gradeAnswer(q, j({ forbidden: [true], saysUnknown: true })).correct, false);
  });
});

describe('metrics and the paired test', () => {
  test('a condition that is never right scores 0, not n/a', () => {
    const rows = [{ cat: 'x', expectUnknown: false, hasForbidden: false,
      grade: { correct: false, requiredRecall: 0, stale: false, fabricated: false, unknownHonest: null, askedForKnownInfo: false, personalized: false } }];
    const m = L.conditionMetrics(rows);
    assert.equal(m.correctness, 0);
    assert.equal(m.unknown_honesty, null, 'no unknown questions → n/a, not 0');
  });
  test('sign test: 10 wins / 0 losses is significant, 3/2 is not', () => {
    const a = Array(10).fill(true), b = Array(10).fill(false);
    assert.ok(L.pairedComparison(a, b).sign_test_p < 0.01);
    const r = L.pairedComparison([1, 1, 1, 0, 0, 1].map(Boolean), [0, 0, 0, 1, 1, 1].map(Boolean));
    assert.deepEqual([r.wins, r.losses, r.ties], [3, 2, 1]);
    assert.ok(r.sign_test_p > 0.5);
  });
});

describe('question-clustered comparison (primary Lift statistic, 2026-10-06)', () => {
  const row = (id, a, b) => ({ id, conditions: { worldModel: { grade: { correct: a, fabricated: false } }, memory: { grade: { correct: b, fabricated: false } } } });

  test('repeats of one question count once — three identical wins are ONE question', () => {
    const rows = [row('q1', true, false), row('q1', true, false), row('q1', true, false)];
    const c = L.clusteredComparison(rows, 'worldModel', 'memory');
    assert.equal(c.questions, 1);
    assert.equal(c.wins, 1);
    assert.equal(c.meanDiff, 1);
  });

  test('partial repeats give fractional per-question means', () => {
    const rows = [row('q1', true, false), row('q1', false, false), row('q2', false, true), row('q2', false, true)];
    const c = L.clusteredComparison(rows, 'worldModel', 'memory');
    assert.equal(c.questions, 2);
    assert.equal(c.meanDiff, -0.25);   // (0.5 + -1) / 2
    assert.deepEqual([c.wins, c.losses, c.ties], [1, 1, 0]);
  });

  test('the bootstrap CI is seeded (reproducible) and brackets the mean', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`q${i}`, i % 3 !== 0, i % 2 === 0));
    const a = L.clusteredComparison(rows, 'worldModel', 'memory');
    const b = L.clusteredComparison(rows, 'worldModel', 'memory');
    assert.deepEqual(a.ci95, b.ci95);
    assert.ok(a.ci95[0] <= a.meanDiff && a.meanDiff <= a.ci95[1]);
  });

  test('ungraded rows are excluded, never counted as wrong', () => {
    const rows = [row('q1', true, false), { id: 'q2', conditions: { worldModel: { grade: null }, memory: { grade: { correct: true } } } }];
    assert.equal(L.clusteredComparison(rows, 'worldModel', 'memory').questions, 1);
  });

  test('a custom pick compares another outcome (fabrication)', () => {
    const rows = [{ id: 'q1', conditions: { worldModel: { grade: { correct: true, fabricated: true } }, memory: { grade: { correct: true, fabricated: false } } } }];
    assert.equal(L.clusteredComparison(rows, 'worldModel', 'memory', g => g.fabricated).meanDiff, 1);
  });
});
