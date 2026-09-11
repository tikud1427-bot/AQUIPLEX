/**
 * AQUA Eval — extraction dataset integrity
 * Blueprint E2/PR-2
 *
 * The dataset is the measuring stick. If it drifts, every number downstream
 * drifts with it silently — a metric that improved because three hard cases
 * were quietly deleted is worse than no metric.
 *
 * So the dataset is pinned the way the parser fixtures were in E1/PR-1: the
 * shape is asserted, the category counts are asserted, and the categories that
 * exist to be HARD are asserted to still be hard.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateDataset, census, validateClaim, DatasetError,
  PREDICATES, POLARITIES, MODALITIES, CATEGORIES,
} from '../datasets/schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/extraction-core.v1.json'), 'utf8'));
const claims = DS.cases.flatMap(c => c.claims);

// ── Shape ────────────────────────────────────────────────────────────────────

describe('extraction dataset — shape', () => {
  test('validates against its own schema', () => {
    assert.equal(validateDataset(DS), true);
  });

  test('is exactly 200 cases, as the blueprint specifies', () => {
    assert.equal(DS.cases.length, 200);
  });

  test('the category census is pinned', () => {
    // Pinned so a rebalance is a decision someone makes and a reviewer sees,
    // not a drift that quietly changes what every downstream number means.
    assert.deepEqual(census(DS), {
      identity: 40, people: 20, negation: 20, modality: 25,
      temporal: 25, decision: 15, task: 15, negative: 40,
    });
  });

  test('every case id is unique and well formed', () => {
    const ids = DS.cases.map(c => c.id);
    assert.equal(new Set(ids).size, 200);
    for (const id of ids) assert.match(id, /^[a-z]+-\d{3}$/);
  });

  test('no sentence appears twice', () => {
    const texts = DS.cases.map(c => c.text.trim().toLowerCase());
    assert.equal(new Set(texts).size, 200, 'a duplicated sentence double-counts in every metric');
  });
});

// ── The categories that exist to be hard ─────────────────────────────────────

describe('extraction dataset — the hard categories are actually hard', () => {
  test('negatives carry no claims — this is what makes precision measurable', () => {
    const negatives = DS.cases.filter(c => c.cat === 'negative');
    assert.equal(negatives.length, 40);
    assert.equal(negatives.every(c => c.claims.length === 0), true);
    // 20% of the dataset. An extractor that fires on everything gets perfect
    // recall and is useless; this project has shipped that failure twice.
    assert.ok(negatives.length / DS.cases.length >= 0.15);
  });

  test('negation is represented in enough volume to score', () => {
    const negated = claims.filter(c => c.polarity === 'negated');
    assert.ok(negated.length >= 20, `only ${negated.length} negated claims — too few to be a metric`);
  });

  test('every non-fact modality is represented', () => {
    const seen = new Set(claims.map(c => c.modality));
    for (const m of MODALITIES) {
      assert.ok(seen.has(m), `modality "${m}" is absent — it cannot be measured`);
    }
    for (const m of ['intent', 'hypothetical', 'question', 'quote']) {
      assert.ok(claims.filter(c => c.modality === m).length >= 5, `too few ${m} claims`);
    }
  });

  test('relative time is represented, not just absolute dates', () => {
    // The current engine handles absolute dates only. Relative expressions are
    // the half it cannot do, so they have to be here or the gap is invisible.
    const timed = claims.filter(c => c.time);
    const relative = timed.filter(c => c.time.kind === 'relative');
    assert.ok(timed.length >= 30, `only ${timed.length} timed claims`);
    assert.ok(relative.length >= 15, `only ${relative.length} relative-time claims`);
  });

  test('decisions and tasks are present — both absent from the engine today', () => {
    assert.ok(claims.filter(c => ['decided', 'rejected'].includes(c.p)).length >= 15);
    assert.ok(claims.filter(c => ['task_owner', 'has_status', 'blocks'].includes(c.p)).length >= 15);
  });

  test('first-person and third-person subjects are both well represented', () => {
    const self = claims.filter(c => c.s === 'SELF').length;
    assert.ok(self >= 60, 'too few first-person claims');
    assert.ok(claims.length - self >= 50, 'too few third-person claims');
  });
});

// ── Vocabulary ───────────────────────────────────────────────────────────────

describe('extraction dataset — controlled vocabulary', () => {
  test('every predicate used is in the registry', () => {
    for (const c of claims) assert.ok(PREDICATES.includes(c.p), `unregistered predicate ${c.p}`);
  });

  test('no predicate is used only once — a one-off is unscoreable', () => {
    const counts = {};
    for (const c of claims) counts[c.p] = (counts[c.p] ?? 0) + 1;
    const singletons = Object.entries(counts).filter(([, n]) => n === 1).map(([p]) => p);
    assert.deepEqual(singletons, [], 'predicates with one example cannot produce a meaningful per-predicate score');
  });

  test('polarity and modality only take known values', () => {
    for (const c of claims) {
      assert.ok(POLARITIES.includes(c.polarity));
      assert.ok(MODALITIES.includes(c.modality));
    }
  });

  test('every category in the registry is used', () => {
    const used = new Set(DS.cases.map(c => c.cat));
    for (const cat of CATEGORIES) assert.ok(used.has(cat), `category "${cat}" declared but unused`);
  });
});

// ── Honesty ──────────────────────────────────────────────────────────────────

describe('extraction dataset — states its own limitations', () => {
  test('it says out loud that it is synthetic', () => {
    const text = DS.limitations.join(' ').toLowerCase();
    assert.match(text, /synthetic/);
    assert.match(text, /not sampled from real transcripts/);
  });

  test('it names CORRECTIONS-LIVE as its replacement', () => {
    // A synthetic benchmark defended past its usefulness is how a project
    // measures itself into a corner. The successor is named in the file.
    assert.match(DS.limitations.join(' '), /CORRECTIONS-LIVE/);
  });

  test('it admits single-annotator and single-sentence scope', () => {
    const text = DS.limitations.join(' ').toLowerCase();
    assert.match(text, /one annotator/);
    assert.match(text, /coreference/);
  });
});

// ── `blocks` direction — the blocker is always the subject ──────────────────
//
// 🔴 negation-019 HAD THIS BACKWARDS.
//
// "The launch is not blocked by design." labelled {s: launch, p: blocks,
// o: design} — literally "launch blocks design", the opposite of the
// sentence. `task-003` ("Priya is blocked on the design tokens" → {s: design
// tokens, p: blocks, o: Priya}) and `task-013` ("Dev is stuck on the worker
// memory cap" → {s: worker memory cap, p: blocks, o: Dev}) both put the
// BLOCKER as subject for the identical passive construction. Only
// negation-019 disagreed with its own dataset's convention — not a model
// defect, a mislabel, found by cross-checking the other two `blocks` cases
// rather than by re-reading this one in isolation.
//
// This does not move `detection_negation` (that metric only asks whether
// anything was emitted, not whether it is right), which is why it survived
// three shadow runs unnoticed. It does move `subject_recall` /
// `object_accuracy` / `overall_strict_accuracy`, which is why it is worth
// pinning so it cannot drift back the next time someone "simplifies" this
// case.
describe('extraction dataset — `blocks` names the blocker as subject, not the blockee', () => {
  const blocksClaims = () => DS.cases
    .filter(c => c.claims.some(cl => cl.p === 'blocks'))
    .map(c => ({ id: c.id, text: c.text, claim: c.claims.find(cl => cl.p === 'blocks') }));

  test('every `blocks` case in the dataset exists (guards the cases below against deletion)', () => {
    const ids = blocksClaims().map(r => r.id);
    assert.deepEqual(ids.sort(), ['negation-019', 'task-003', 'task-013']);
  });

  test('negation-019 keeps "design" as the blocker (subject), "launch" as the blocked (object)', () => {
    const c = blocksClaims().find(r => r.id === 'negation-019').claim;
    assert.equal(c.s, 'design', 'subject must be the blocker — see task-003/task-013 for the convention');
    assert.equal(c.o, 'launch');
  });

  test('task-003 and task-013 already had this right — pinned so the convention is visible in one place', () => {
    const t3 = blocksClaims().find(r => r.id === 'task-003').claim;
    const t13 = blocksClaims().find(r => r.id === 'task-013').claim;
    assert.equal(t3.s, 'design tokens');
    assert.equal(t3.o, 'Priya');
    assert.equal(t13.s, 'worker memory cap');
    assert.equal(t13.o, 'Dev');
  });
});

// ── The validator bites ──────────────────────────────────────────────────────

describe('extraction dataset — the validator refuses bad labels', () => {
  test('a subject that is not in the sentence is refused', () => {
    assert.throws(() => validateClaim('x-001',
      { s: 'Zebedee', p: 'works_at', o: 'Aquiplex', polarity: 'asserted', modality: 'fact' },
      'Priya works at Aquiplex.'), DatasetError);
  });

  test('SELF without a first-person marker is refused', () => {
    // This caught four of my own mislabels while the dataset was being written.
    assert.throws(() => validateClaim('x-002',
      { s: 'SELF', p: 'uses', o: 'Redis', polarity: 'asserted', modality: 'fact' },
      'The README says the project uses Redis.'), /first-person/);
  });

  test('an unregistered predicate is refused', () => {
    assert.throws(() => validateClaim('x-003',
      { s: 'SELF', p: 'vibes_with', o: 'Redis', polarity: 'asserted', modality: 'fact' },
      'I vibes_with Redis'), /unknown predicate/);
  });

  test('a negative case carrying claims is refused', () => {
    assert.throws(() => validateDataset({
      ...DS,
      cases: [{ id: 'negative-999', cat: 'negative', text: 'hello there', claims: [
        { s: 'SELF', p: 'uses', o: 'x', polarity: 'asserted', modality: 'fact' }] }],
    }), /must carry no claims/);
  });

  test('a dated claim with no expression is refused', () => {
    assert.throws(() => validateClaim('x-004',
      { s: 'SELF', p: 'uses', o: 'Go', polarity: 'asserted', modality: 'fact', time: { kind: 'relative' } },
      'I use Go'), /must record the expression/);
  });
});

// ── The validator refuses an UNMEASURABLE dataset ────────────────────────────
//
// Distinct from every test above, which asks whether a case is well formed.
// These ask whether the SET can be scored. A dataset can be flawless case by
// case and still turn a metric into 0/0 — that is the defect the E6 smoke slice
// shipped, and reading it as 0.0 is what made it invisible.

describe('extraction dataset — a class-incomplete dataset is refused', () => {
  const without = cat => ({ ...DS, cases: DS.cases.filter(c => c.cat !== cat) });

  test('dropping the negation cases is refused, not scored as 0.0', () => {
    // THE ORIGINAL DEFECT, reproduced. Every surviving case is valid; the file
    // parses; only the denominator is gone.
    assert.throws(() => validateDataset(without('negation')),
      /no cases in category "negation"/);
  });

  test('dropping the negatives is refused — precision would be unmeasurable', () => {
    assert.throws(() => validateDataset(without('negative')),
      /no cases in category "negative"/);
  });

  test('EVERY declared category is load-bearing, not just the two we remembered', () => {
    // A hand-maintained list of "the categories that matter" is the same
    // failure one level up. The rule is derived from CATEGORIES, so a category
    // added tomorrow is covered without an edit here.
    for (const cat of CATEGORIES) {
      assert.throws(() => validateDataset(without(cat)),
        new RegExp(`no cases in category "${cat}"`),
        `dropping "${cat}" was accepted — the completeness rule does not cover it`);
    }
  });

  test('the error names the consequence, not just the rule', () => {
    // "invalid dataset" sends someone to the schema. Naming 0/0 sends them to
    // the metric that is about to lie to them.
    assert.throws(() => validateDataset(without('temporal')), /0\/0/);
  });

  test('the intact dataset still validates — the rule is not merely strict', () => {
    assert.equal(validateDataset(DS), true);
  });
});
