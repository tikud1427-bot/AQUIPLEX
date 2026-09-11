/**
 * AQUA Eval — contradiction pair selection
 * Blueprint: the prerequisite FIX-4 named
 *
 * FIX-4 declined to bucket the O(N²) pass because *"a bucketing bug would
 * silently stop finding real contradictions and score identically"* on the
 * pair-level eval. This suite is what makes that failure visible.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSuite } from '../core/runner.mjs';
import suite from '../suites/contradiction-corpus.suite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(path.join(HERE, '../baselines/contradiction-corpus.v1.json'), 'utf8'));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/contradiction-corpus.v1.json'), 'utf8'));

// ── The dataset ──────────────────────────────────────────────────────────────

describe('selection eval — the corpus', () => {
  test('it is a CORPUS, not a pair list', () => {
    // A pair-level test hands the detector both statements, so it can never
    // notice a strategy that never brings those two together — which is
    // exactly what bucketing, sharding or indexing changes.
    assert.ok(DS.facts.length > 40);
    assert.equal(suite.cases.length, 1, 'the corpus was split into cases — that measures the predicate again');
  });

  test('the genuine pairs are planted across DIFFERENT files', () => {
    // The detector gates on cross-file provenance before it compares anything.
    // A same-file pair would be untestable here and is out of scope.
    const fileOf = new Map(DS.facts.map(f => [f.id, f.file]));
    for (const [a, b] of DS.expectedPairs) {
      assert.notEqual(fileOf.get(a), fileOf.get(b), `${a}/${b} share a file`);
    }
  });

  test('the ledger decoys are large enough to make precision mean something', () => {
    // 40 per-item rows: the shape FINDING-1 measured firing 73,500 times. If a
    // bucketing change reintroduced false positives, this is what catches it.
    const ledger = DS.facts.filter(f => f.file.startsWith('ledger'));
    assert.ok(ledger.length >= 40, `${ledger.length} ledger rows`);
  });

  test('it states what it cannot measure', () => {
    const text = DS.limitations.join(' ');
    assert.match(text, /SELECTION, not predicate quality/);
    assert.match(text, /contradiction-core\.v1 does that/);
  });
});

// ── The baseline ─────────────────────────────────────────────────────────────

describe('selection eval — the baseline', () => {
  test('every planted contradiction is currently found', async () => {
    const { result } = await runSuite(suite);
    assert.equal(result.metrics.selection_recall, 1);
    assert.equal(result.metrics.found_pairs, DS.expectedPairs.length);
  });

  test('nothing spurious is emitted — FIX-1 and FIX-2 hold at corpus scale', async () => {
    const { result } = await runSuite(suite);
    assert.equal(result.metrics.spurious_emitted, 0);
  });

  test('CLOSED: subject bucketing halved the pairs examined', async () => {
    // Was 1104 comparisons / 71.7% of every possible pair, asserted as an
    // inverting pin. Bucketing took it to 561 / 36.4% with recall unchanged —
    // and the assertion inverted exactly as designed.
    const { result } = await runSuite(suite);
    assert.ok(result.metrics.fraction_of_all_pairs < 0.5,
      `examining ${(result.metrics.fraction_of_all_pairs * 100).toFixed(1)}% of pairs — ` +
      'the bucketing regressed');
    assert.equal(result.metrics.selection_recall, 1,
      'cost went down and recall went with it — that is a regression, not a fix');
  });

  test('recall and cost are separate metrics, never combined', async () => {
    // A bucketing change that halves the work and loses a real contradiction
    // is a regression. One number would hide that; two cannot.
    const { result } = await runSuite(suite);
    assert.ok('selection_recall' in result.metrics);
    assert.ok('comparisons_examined' in result.metrics);
    assert.ok(!('efficiency' in result.metrics), 'a combined score would let recall be traded for speed');
  });

  test('cost is COUNTED, not timed', () => {
    // FIX-4 paid for this lesson three times: a lower bound on a timing ratio
    // flakes under load, and a comparison count does not.
    const src = readFileSync(path.join(HERE, '../suites/contradiction-corpus.suite.mjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.match(src, /_comparisonCountForTests/);
    // Only `performance.now` indicates a TIMING measurement. `Date.now()`
    // appears in the owner-id generator and is not a stopwatch — the SIXTH
    // time a content check here has matched something innocent that merely
    // looked like the thing it bans.
    assert.ok(!/performance\.now/.test(src), 'the suite times something — count it instead');
  });

  test('the baseline records what a fix must do', () => {
    assert.match(BASELINE.note, /selection_recall at 1\.0/);
    assert.match(BASELINE.note, /cannot be traded silently/);
    assert.equal(BASELINE.coverage.complete, true);
  });
});

// ── The failure it exists to catch ───────────────────────────────────────────

describe('selection eval — it would catch a bucketing bug', () => {
  test('a strategy that examines FEWER pairs but misses one scores worse', () => {
    // Scored directly rather than argued: this is the exact outcome FIX-4 said
    // the pair-level eval could not distinguish from a real improvement.
    const good = suite.metrics([{ hit: 5, expected: 5, emitted: 5, comparisons: 200, factCount: 56 }]);
    const bad = suite.metrics([{ hit: 4, expected: 5, emitted: 4, comparisons: 200, factCount: 56 }]);
    assert.equal(good.selection_recall, 1);
    assert.ok(bad.selection_recall < 1,
      'losing a genuine contradiction did not lower the score — the eval cannot see the bug it exists for');
    assert.equal(good.comparisons_examined, bad.comparisons_examined,
      'the two differ only in recall, which is the point of the comparison');
  });

  test('an ALL-KEYLESS corpus still gets compared — the global bucket', async () => {
    // 🔴 Found by measuring bite: removing `candidateGroups.push(global)`
    // failed ZERO tests, because `[...bucket, ...global]` already pairs global
    // facts against each other WHENEVER at least one bucket exists — and the
    // corpus always has one.
    //
    // It is not dead. With no keyed facts at all, `buckets` is empty,
    // `candidateGroups` is empty, and nothing is compared: total recall loss.
    // The FIX-2 lesson again — "bites nothing" can mean "untested edge case"
    // rather than "dead code".
    const ES = await import('../../src/files/evidenceStore.js');
    const US = await import('../../src/files/ukoStore.js');
    const G = await import('../../src/reasoning/reasoningGraph.js');
    const { createEvidence, createFact } = await import('../../src/files/evidence.js');
    const { createUKO } = await import('../../src/files/uko.js');
    const { resolveEntities } = await import('../../src/reasoning/entityResolver.js');
    const { detectCrossFileContradictions } = await import('../../src/reasoning/relationshipEngine.js');

    const owner = `eval-keyless-${Date.now()}`;
    const purge = () => { ES.purgeOwner?.(owner); US.purgeOwner?.(owner); G.purgeOwner?.(owner); };
    purge();
    // Two statements with NO series index anywhere — nothing lands in a bucket.
    for (const [file, stmt] of [
      ['a.pdf', 'The Acme audit passed.'],
      ['b.pdf', 'The Acme audit failed.'],
    ]) {
      const u = createUKO({
        ownerId: owner,
        sourceFile: { name: file, ext: '.pdf', bytes: 1, hash: file.padEnd(64, 'x') },
        fileType: 'document',
      });
      u.id = file;
      US.saveUKO(u);
      const ev = ES.saveEvidence(owner, createEvidence({
        sourceFileId: file, sourceFileName: file, sourceType: 'document',
        extractionMethod: 'structural', location: { page: 1 }, snippet: stmt,
      }));
      ES.saveFact(owner, createFact({ statement: stmt, entities: ['Acme'], evidence: [ev] }),
        { sourceFileId: file });
    }
    const facts = ES.listFacts(owner, { limit: 1000 });
    const mentions = facts.flatMap(f => (f.entities ?? []).map(v => ({
      value: v, type: 'name', fileId: 'x', fileName: 'x',
      factId: f.id, evidenceId: (f.evidence ?? [])[0],
    })));
    const { entities } = resolveEntities(mentions);
    const found = detectCrossFileContradictions(entities, facts, ES, owner);
    purge();
    assert.equal(found.length, 1,
      'a corpus with no series indices found nothing — the global bucket was dropped');
  });

  test('emitting extra pairs shows up as spurious, not as recall', () => {
    const m = suite.metrics([{ hit: 5, expected: 5, emitted: 9, comparisons: 200, factCount: 56 }]);
    assert.equal(m.selection_recall, 1);
    assert.equal(m.spurious_emitted, 4);
  });
});
