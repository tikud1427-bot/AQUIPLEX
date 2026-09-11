/**
 * AQUA Eval — contradiction PAIR SELECTION
 * Blueprint: the prerequisite FIX-4 named
 *
 * FIX-4 measured `detectCrossFileContradictions` doing O(N²) work to produce
 * O(N) output, and deliberately did not fix it:
 *
 *   *"the repair is bucketing pairs by subject before comparing them, which
 *   changes WHICH PAIRS ARE EVER CONSIDERED. The contradiction eval measures
 *   the predicate, not the pair-selection strategy — a bucketing bug would
 *   silently stop finding real contradictions and score identically."*
 *
 * This is the eval that closes that gap. `contradiction-core.v1` scores the
 * PREDICATE on isolated pairs; this scores SELECTION over a whole corpus.
 *
 * WHY A CORPUS AND NOT MORE PAIRS
 * -------------------------------
 * A pair-level test hands the detector both statements. It can never notice a
 * strategy that never brings those two statements together — which is exactly
 * the failure mode of any bucketing, sharding or indexing optimisation.
 *
 * So the input is 56 facts across four files with five genuine contradictions
 * planted in them, and the question is whether the detector finds them at all.
 *
 * COST IS A METRIC HERE, ON PURPOSE
 * ---------------------------------
 * `comparisons_examined` is counted, not timed — a fact about the algorithm
 * rather than about the machine, which is the lesson FIX-4 paid for three
 * times over. It is reported alongside recall so the two cannot be traded
 * silently: a bucketing change that halves the comparisons and loses a real
 * contradiction is a regression, and one number would hide that.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ES from '../../src/files/evidenceStore.js';
import * as US from '../../src/files/ukoStore.js';
import * as G from '../../src/reasoning/reasoningGraph.js';
import { createEvidence, createFact } from '../../src/files/evidence.js';
import { createUKO } from '../../src/files/uko.js';
import { resolveEntities } from '../../src/reasoning/entityResolver.js';
import {
  detectCrossFileContradictions,
  _comparisonCountForTests, _resetComparisonCountForTests,
} from '../../src/reasoning/relationshipEngine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/contradiction-corpus.v1.json'), 'utf8'));

/**
 * Build the corpus once and run the detector once.
 *
 * The whole dataset is ONE case, because pair selection is a property of the
 * corpus. Splitting it into 56 cases would measure the predicate again.
 */
let cached = null;

function runCorpus() {
  if (cached) return cached;
  const owner = `eval-contradiction-corpus-${Date.now()}`;
  // Purge all three singleton stores — FIX-3's lesson, and this suite writes
  // into every one of them.
  ES.purgeOwner?.(owner); US.purgeOwner?.(owner); G.purgeOwner?.(owner);

  const byFile = new Map();
  for (const f of DS.facts) {
    if (!byFile.has(f.file)) {
      const u = createUKO({
        ownerId: owner,
        sourceFile: { name: f.file, ext: '.pdf', bytes: 1, hash: f.file.padEnd(64, 'x') },
        fileType: 'document',
      });
      u.id = f.file;
      US.saveUKO(u);
      byFile.set(f.file, u.id);
    }
    const ev = ES.saveEvidence(owner, createEvidence({
      sourceFileId: f.file, sourceFileName: f.file, sourceType: 'document',
      extractionMethod: 'structural', location: { page: 1 }, snippet: f.statement,
    }));
    ES.saveFact(owner, createFact({ statement: f.statement, entities: f.entities, evidence: [ev] }),
      { sourceFileId: f.file, id: f.id });
  }

  const stored = ES.listFacts(owner, { limit: 100000 });
  // Map statement text back to the dataset id — `saveFact` assigns its own.
  const idOf = new Map(DS.facts.map(f => [f.statement, f.id]));
  const datasetId = new Map(stored.map(s => [s.id, idOf.get(s.statement) ?? null]));

  const mentions = stored.flatMap(s => (s.entities ?? []).map(v => ({
    value: v, type: 'name', fileId: 'x', fileName: 'x',
    factId: s.id, evidenceId: (s.evidence ?? [])[0],
  })));
  const { entities } = resolveEntities(mentions);

  _resetComparisonCountForTests();
  const found = detectCrossFileContradictions(entities, stored, ES, owner);
  const comparisons = _comparisonCountForTests();

  const foundPairs = new Set();
  for (const c of found ?? []) {
    // The emitted shape is { id, entity, type, factIds, statements, ... }.
    // My first version read `factA`/`from` — invented field names — and scored
    // recall 0 while the detector was working fine. Probed the real object
    // before believing the number, which is the only reason this reads 100%
    // instead of a false finding.
    const [x, y] = c.factIds ?? [];
    const a = datasetId.get(String(x ?? '').replace(/^fact:/, ''));
    const b = datasetId.get(String(y ?? '').replace(/^fact:/, ''));
    if (a && b) foundPairs.add([a, b].sort().join('|'));
  }

  ES.purgeOwner?.(owner); US.purgeOwner?.(owner); G.purgeOwner?.(owner);
  cached = { foundPairs, comparisons, factCount: stored.length, emitted: (found ?? []).length };
  return cached;
}

export default {
  id: 'contradiction-corpus',
  title: 'contradiction pair selection — over a whole corpus',
  about: [
    'Builds 56 facts across four files with five genuine contradictions planted in them,',
    'runs the detector once, and asks whether it FOUND them — not whether it judges a pair',
    'correctly, which contradiction-core.v1 already measures. Reports comparisons examined',
    'alongside recall, counted rather than timed, so a bucketing change that halves the work',
    'and loses a real contradiction cannot look like an improvement.',
  ].join('\n'),

  cases: [{ id: 'corpus', kind: 'corpus' }],

  async run() {
    const r = runCorpus();
    return { status: 'ok', actual: r };
  },

  score(_testCase, actual) {
    const expected = DS.expectedPairs.map(p => [...p].sort().join('|'));
    const hit = expected.filter(k => actual.foundPairs.has(k));
    return {
      correct: hit.length === expected.length && actual.emitted === expected.length,
      hit: hit.length,
      expected: expected.length,
      emitted: actual.emitted,
      comparisons: actual.comparisons,
      factCount: actual.factCount,
    };
  },

  metrics(scored) {
    const s = scored[0] ?? {};
    const n = s.factCount ?? 0;
    const allPairs = (n * (n - 1)) / 2;
    return {
      // Did it FIND the planted contradictions? This is what a bucketing bug
      // breaks, and what a pair-level eval cannot see.
      selection_recall: s.expected ? s.hit / s.expected : 0,
      found_pairs: s.hit ?? 0,
      expected_pairs: s.expected ?? 0,

      // Did it emit anything it should not? The 40-row ledger is here to make
      // this meaningful.
      spurious_emitted: Math.max(0, (s.emitted ?? 0) - (s.hit ?? 0)),

      // Cost, COUNTED not timed. Reported next to recall so the two cannot be
      // traded silently.
      comparisons_examined: s.comparisons ?? 0,
      comparisons_per_fact: n ? (s.comparisons ?? 0) / n : 0,
      // 1.0 means every possible pair was examined — the O(N²) signature.
      fraction_of_all_pairs: allPairs ? (s.comparisons ?? 0) / allPairs : 0,

      fact_count: n,
    };
  },
};
