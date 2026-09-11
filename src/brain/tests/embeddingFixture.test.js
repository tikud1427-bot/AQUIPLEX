/**
 * The dense-retrieval fixture — absent, present, and stale.
 *
 * WHY A FIXTURE AT ALL
 * --------------------
 * `recall_category` has sat at 0.4688 across every session, the worst honest
 * metric on both retrieval lanes, and its failures are semantic rather than
 * lexical — "educational background" → "I studied physics before this". That
 * needs a dense lane; a dense lane needs vectors; vectors need a provider the
 * analysis sandbox cannot reach. Eight sessions of "blocked on embeddings".
 *
 * Vectors are STATIC DATA. Sixty fixed facts and two hundred fixed queries,
 * embedded once against a real provider and committed, make the dense lane
 * measurable offline forever — and with zero run-to-run variance, unlike the
 * E6 shadow harness where two identical runs differed by 16 points.
 *
 * KEYED BY RETRIEVAL IDENTITY, WHICH IS THE WHOLE POINT. E7/PR-1 found the
 * existing embedding path keys vectors by long-term-memory fact key while
 * retrieval identifies facts by evidence-store id — blueprint §10's "embedding
 * key ≠ retrieval identity". These tests pin the keyspace so the new lane
 * cannot inherit it.
 *
 * BITE, MEASURED (revert the named change → count failures):
 *   staleness guard on corpusHash          → 2 fail
 *   absent fixture returns null, not throw → 2 fail
 *   generator refuses a partial write      → 1 fail
 *   generator refuses with no provider     → 1 fail
 */
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { loadEmbeddingFixture, __resetFixtureCache, cosine, factSimilarities }
  from '../../../eval/fixtures/embeddingFixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const FIXTURE = path.join(ROOT, 'eval/fixtures/retrieval-core.embeddings.v1.json');
const GENERATOR = readFileSync(path.join(ROOT, 'scripts/build-embedding-fixture.mjs'), 'utf8');
const DS = JSON.parse(readFileSync(path.join(ROOT, 'eval/datasets/retrieval-core.v1.json'), 'utf8'));

/** The generator's fingerprint, recomputed independently so the two must agree. */
function corpusHash() {
  const facts = DS.corpus.map(f => ({ id: f.id, text: f.statement }));
  const queries = DS.queries.map(q => ({ id: q.id, text: q.q }));
  return createHash('sha256').update(JSON.stringify([facts, queries])).digest('hex').slice(0, 16);
}

function writeFixture(over = {}) {
  // Three facts and three queries at 4 dimensions — enough to exercise the
  // load/stale/keyspace contracts without another megabyte in memory.
  dirty = true;
  const facts = Object.fromEntries(DS.corpus.slice(0, 3).map((f, i) => [f.id, [i, 1, 0, 0]]));
  const queries = Object.fromEntries(DS.queries.slice(0, 3).map((q, i) => [q.id, [i, 1, 0, 0]]));
  writeFileSync(FIXTURE, JSON.stringify({
    corpusHash: corpusHash(), model: 'test', dim: 4, facts, queries, ...over,
  }));
  __resetFixtureCache();
}

/**
 * 🔴 THIS SUITE USED TO DELETE THE COMMITTED FIXTURE.
 *
 * The original `afterEach` was `rmSync(FIXTURE)` unconditionally, written when
 * no fixture existed and every case created its own. The moment a real one was
 * committed — 260 vectors, dim 768, one paid provider run — a plain `npm test`
 * destroyed it. Caught by diffing the tarball against the upload, not by any
 * test, because the deletion left every assertion passing.
 *
 * The real file is now saved and restored byte-for-byte. A test that mutates a
 * committed artifact has to put it back.
 */
const HAD_FIXTURE = existsSync(FIXTURE);
const ORIGINAL = HAD_FIXTURE ? readFileSync(FIXTURE) : null;

/**
 * ⚠️ RESTORED ONCE, NOT PER TEST, AND THAT IS A MEMORY CONSTRAINT NOT A STYLE
 * CHOICE. The committed core fixture is 2.5 MB; rewriting it after every case
 * meant ~27 multi-megabyte writes plus a reparse each, and the test process was
 * SIGKILLed by the OOM killer — not a heap limit, since 3 GB did not help.
 *
 * 🔴 TWO ATTEMPTS TO MAKE THIS CHEAPER BOTH BROKE IT, AND IT RESTORES EVERY
 * TIME NOW. Dropping the restore let a 3-fact scratch fixture leak forward and
 * a later case read 3 where it expected 60. Restoring only when a `dirty` flag
 * was set missed a path and left the committed file at 180 bytes — 2.5 MB of
 * paid vectors, gone, and the only thing that noticed was a byte-comparison
 * test added after the FIRST time this happened.
 *
 * The memory pressure was real: the OOM killer took the process at 3 GB. It is
 * addressed by keeping the scratch fixtures tiny (3 facts, 4 dimensions) rather
 * than by restoring less often. An artifact that costs a provider run does not
 * get protected on a best-effort basis.
 */
let dirty = false;
const restore = () => {
  if (HAD_FIXTURE) writeFileSync(FIXTURE, ORIGINAL);
  else rmSync(FIXTURE, { force: true });
  __resetFixtureCache();
};

afterEach(() => { restore(); dirty = false; });
after(restore);

describe('absent is fine — the fixture is optional by design', () => {
  test('no fixture returns null rather than throwing', () => {
    // It takes one provider run to exist, so every consumer must work without
    // it. The dense lane contributes nothing, exactly as today.
    dirty = true;
    rmSync(FIXTURE, { force: true });
    __resetFixtureCache();
    assert.equal(loadEmbeddingFixture(), null);
  });

  test('similarity with no fixture is null, NOT an empty map', () => {
    // "No vectors" and "similarity zero" must stay distinguishable. Conflating
    // them is precisely how the long-term-memory keyspace defect went unseen —
    // every lookup missed and every miss looked like a legitimate low score.
    dirty = true;
    rmSync(FIXTURE, { force: true });
    __resetFixtureCache();
    assert.equal(factSimilarities('q001'), null);
  });
});

describe('stale is refused, loudly', () => {
  test('a fixture whose corpus hash has moved throws', () => {
    // Vectors describe text. If the dataset changed after they were generated,
    // scoring against them yields confident numbers for statements nobody
    // wrote — worse than no fixture, because it looks like a result.
    writeFixture({ corpusHash: 'deadbeefdeadbeef' });
    assert.throws(() => loadEmbeddingFixture(), /STALE/);
  });

  test('the error names how to regenerate', () => {
    writeFixture({ corpusHash: 'deadbeefdeadbeef' });
    assert.throws(() => loadEmbeddingFixture(), /build-embedding-fixture\.mjs/);
  });

  test('a matching hash loads', () => {
    writeFixture();
    const f = loadEmbeddingFixture();
    assert.equal(f.dim, 4);
    assert.equal(f.facts.size, 3);
  });
});

describe('the keyspace is the retrieval identity', () => {
  test('facts are keyed by evidence-store fact id, queries by query id', () => {
    writeFixture();
    const f = loadEmbeddingFixture();
    assert.ok(f.facts.has(DS.corpus[0].id), `expected ${DS.corpus[0].id} among fact keys`);
    assert.ok(f.queries.has(DS.queries[0].id), `expected ${DS.queries[0].id} among query keys`);
  });

  test('the generator embeds the STATEMENT, not a "key: value" rendering', () => {
    // The long-term-memory path embeds `factText()` → "workplace: Nummo". The
    // retrieval pool ranks statements. Embedding the wrong text is the same
    // class of defect as keying it wrongly.
    assert.match(GENERATOR, /id: f\.id, text: f\.statement/);
    assert.ok(!/factText/.test(GENERATOR), 'the generator must not reuse the LTM text shape');
  });

  test('similarities come back keyed by fact id', () => {
    writeFixture();
    const sims = factSimilarities(DS.queries[0].id);
    assert.ok(sims instanceof Map);
    for (const k of sims.keys()) assert.match(k, /^f\d+$/, `unexpected key shape: ${k}`);
  });
});

describe('the generator refuses to produce a misleading fixture', () => {
  test('no provider → writes nothing', () => {
    // A fixture of nulls scores 0 similarity on every pair, which reads as
    // "dense retrieval does not help" rather than "nothing was embedded" —
    // the same trap e6-shadow.mjs guards at its own entry point.
    assert.match(GENERATOR, /Embeddings are not enabled/);
    assert.match(GENERATOR, /process\.exit\(1\)/);
  });

  test('a partial embed → writes nothing', () => {
    // Partial is worse than absent: a fact with no vector silently scores 0
    // against every query and is indistinguishable from a semantic miss.
    assert.match(GENERATOR, /NOT writing a partial fixture/);
  });

  test('--dry-run makes no provider calls', () => {
    assert.match(GENERATOR, /--dry-run — no provider calls made/);
  });
});

describe('cosine', () => {
  test('identical, orthogonal, and mismatched shapes', () => {
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([1, 0], [1, 0, 0]), 0, 'a shape mismatch must score 0, not throw');
    assert.equal(cosine(null, [1]), 0);
  });
});

describe('the committed fixture survives the suite that tests it', () => {
  test('it is still on disk, with its real shape', () => {
    // The regression that prompted this: an unconditional rmSync in afterEach
    // deleted 260 vectors from a paid provider run, silently, on every npm test.
    assert.ok(HAD_FIXTURE, 'no fixture committed — run scripts/build-embedding-fixture.mjs');
    const f = loadEmbeddingFixture();
    assert.equal(f.facts.size, 60);
    assert.equal(f.queries.size, 200);
    assert.equal(f.dim, 768);
  });

  test('its bytes are unchanged by this suite', () => {
    assert.deepEqual(readFileSync(FIXTURE), ORIGINAL);
  });
});

// ── The dense lane refuses to extrapolate its own threshold ──────────────────

describe('the margin floor is calibrated at one corpus size, and bounded there', () => {
  /**
   * `DENSE_MARGIN_FLOOR` was swept against a 60-fact world. The margin is not
   * scale-free — measured directly on the fixture, answerable p10 climbs
   * 0.037 → 0.092 and the median 0.079 → 0.191 as the corpus grows 15 → 60,
   * while silence p90 sits near 0.10 throughout. Three scale-free candidates
   * (z, IQR-normalised, median-normalised) all separated WORSE than the raw
   * margin at every size, so there is no normalisation to substitute.
   *
   * Dense is purely ADDITIVE: a missed opportunity costs nothing, a false fire
   * costs honesty. Declining below the calibration point is the cheap side of
   * that bet.
   */
  const SRC = readFileSync(path.join(ROOT, 'src/pic/retrievalIntelligence.js'), 'utf8');

  test('the lane declines below the size it was calibrated at', () => {
    assert.match(SRC, /const DENSE_MIN_CORPUS = 60;/,
      'the minimum corpus bound is gone — the floor would be extrapolated');
    assert.match(SRC, /rawSemantic\.size < DENSE_MIN_CORPUS/);
  });

  test('the bound is AT the calibration point, never below it', () => {
    const min = Number(SRC.match(/const DENSE_MIN_CORPUS = (\d+);/)?.[1]);
    const corpusSize = JSON.parse(
      readFileSync(path.join(ROOT, 'eval/datasets/retrieval-core.v1.json'), 'utf8')).corpus.length;
    assert.equal(min, corpusSize,
      `bound ${min} does not match the ${corpusSize}-fact corpus the floor was swept on — ` +
      'lowering it is a claim that needs its own labelled corpus');
  });

  test('the floor itself is unchanged at the swept value', () => {
    assert.match(SRC, /const DENSE_MARGIN_FLOOR = 0\.15;/,
      'the margin floor moved — re-run the sweep and update the baseline note');
  });
});

// ── A second corpus, because one calibration point settles nothing ───────────

describe('retrieval-small.v1 — the second calibration point', () => {
  const SMALL = JSON.parse(readFileSync(path.join(ROOT, 'eval/datasets/retrieval-small.v1.json'), 'utf8'));

  test('every label points at a fact that exists', () => {
    const ids = new Set(SMALL.corpus.map(f => f.id));
    const dangling = [];
    for (const q of SMALL.queries) {
      for (const k of ['relevant', 'acceptable']) {
        for (const i of q[k] ?? []) if (!ids.has(i)) dangling.push(`${q.id}.${k}→${i}`);
      }
    }
    assert.deepEqual(dangling, []);
  });

  test('it is genuinely SMALL and genuinely different in size', () => {
    // The whole reason it exists: the margin statistic is not scale-free, and
    // a second point at the same size would prove nothing.
    const core = JSON.parse(readFileSync(path.join(ROOT, 'eval/datasets/retrieval-core.v1.json'), 'utf8'));
    assert.ok(SMALL.corpus.length < core.corpus.length / 2,
      `${SMALL.corpus.length} facts is not a second SIZE against core's ${core.corpus.length}`);
  });

  test('it carries the same category taxonomy, so the two are comparable', () => {
    // A corpus with different categories would measure a different thing and
    // the floor could not be compared across them.
    const core = JSON.parse(readFileSync(path.join(ROOT, 'eval/datasets/retrieval-core.v1.json'), 'utf8'));
    const cats = s => new Set(s.queries.map(q => q.cat));
    assert.deepEqual([...cats(SMALL)].sort(), [...cats(core)].sort());
  });

  test('it has silence queries — the half the floor exists to protect', () => {
    const silence = SMALL.queries.filter(q => !(q.relevant?.length));
    assert.ok(silence.length >= 10, `only ${silence.length} silence queries`);
  });

  test('every fact is reachable by at least one query', () => {
    // An unreachable fact is dead weight that shifts the margin median without
    // ever being an answer — it would bias the calibration it exists to serve.
    const used = new Set(SMALL.queries.flatMap(q => q.relevant ?? []));
    const orphans = SMALL.corpus.map(f => f.id).filter(i => !used.has(i));
    assert.deepEqual(orphans, []);
  });

  test('the limitations name the authorship risk plainly', () => {
    // This corpus was written by the same process that tunes the threshold it
    // validates. That cannot be fully mitigated, so it has to be stated.
    assert.match(SMALL.limitations.join(' '), /AUTHORED BY THE SAME PROCESS/);
  });

  test('its fixture loads, keyed by this corpus\'s own ids', () => {
    // Was an absence assertion until the vectors were generated. Now it pins
    // the real shape — 20 facts, 62 queries, same 768 dims as core.
    __resetFixtureCache();
    const f = loadEmbeddingFixture({ name: 'retrieval-small.v1' });
    if (!f) return;   // optional by design; absence is not a failure
    assert.equal(f.facts.size, SMALL.corpus.length);
    assert.equal(f.queries.size, SMALL.queries.length);
    assert.ok(f.facts.has('s01'));
    assert.ok(f.queries.has('t001'));
  });

  test('its staleness guard is wired to its OWN dataset hash', () => {
    // `loadNamed` reads the dataset from disk by name and ignores a passed-in
    // one — the first version of this test assumed otherwise and asserted a
    // throw that never came. What matters is that the guard exists per corpus,
    // so a fixture cannot be scored against text it was not generated from.
    const LOADER = readFileSync(path.join(ROOT, 'eval/fixtures/embeddingFixture.mjs'), 'utf8');
    const named = LOADER.slice(LOADER.indexOf('function loadNamed'));
    assert.match(named, /is STALE/);
    assert.match(named, /--dataset \$\{name\}/, 'the error must name how to regenerate THIS corpus');
  });
});

// ── The calibration answer, from two real corpora ────────────────────────────

describe('dense separability is a function of corpus size, measured at two', () => {
  /**
   * The question `retrieval-small.v1` was built to settle. Answer: small
   * corpora cannot be separated, so `DENSE_MIN_CORPUS` stays.
   *
   *                  answerable p10 / median     silence median / p90
   *   N=60 core           0.092 / 0.191              0.084 / 0.105
   *   N=20 small          0.092 / 0.206              0.169 / 0.265
   *
   * Answerable is FLAT across sizes. Silence is what moves, and at 20 facts an
   * unanswerable query's best match stands further above the median than a
   * typical answerable one does. Five statistics were tried — top−median,
   * top−p75, top−p90, top−2nd, top/median — and none separates at N=20
   * (answerable p25 minus silence p90 runs −0.098 to −0.306).
   *
   * Swept on the real small corpus, every floor that buys recall buys noise:
   *   lexical 0.6304 r@8 / 17 noise · 0.15 → 0.6957 / 49 · 0.20 → 0.6522 / 27
   *   · 0.27 → 0.6304 / 21 · 0.32 → 0.6304 / 17 (free, and worthless)
   *
   * An earlier version of this reasoning came from SUBSAMPLING the large corpus
   * and had the direction BACKWARDS. Subsampling deletes the answers while the
   * queries keep asking for them, so it describes a deletion rather than a
   * small store. That is why the second corpus had to be authored, not simulated.
   *
   * These assertions read RECORDED figures rather than recomputing 260 × 768
   * dimensional cosines — the first version did, and the test process was
   * SIGKILLed for memory. The gate protects the code; this protects the
   * conclusion drawn from it, which is the part that gets forgotten.
   */
  const SRC = readFileSync(path.join(ROOT, 'src/pic/retrievalIntelligence.js'), 'utf8');

  test('the bound is present and set at the size that separates', () => {
    assert.match(SRC, /const DENSE_MIN_CORPUS = 60;/);
    assert.match(SRC, /const DENSE_MARGIN_FLOOR = 0\.15;/);
  });

  test('the corrected two-corpus finding stays attached to the constant', () => {
    // The previous comment asserted the opposite direction from subsampled
    // data. If it comes back, so does the wrong bound.
    assert.match(SRC, /ANSWERABLE IS FLAT/,
      'the two-corpus finding is gone from the code that depends on it');
    assert.match(SRC, /HAD THE REASON BACKWARDS/,
      'the correction is what stops the confounded reasoning being re-derived');
  });

  test('the small corpus is registered as a calibration point, not a benchmark', () => {
    const SMALL = JSON.parse(readFileSync(path.join(ROOT, 'eval/datasets/retrieval-small.v1.json'), 'utf8'));
    assert.match(SMALL.limitations.join(' '), /calibration corpus, NOT a quality benchmark/i);
    // And it must NOT be gated as a quality suite — a 20-fact world has no
    // resolution, and its lexical baseline (r@8 0.6304, honesty 0.3750) would
    // read as a catastrophe rather than as a small store.
    assert.equal(existsSync(path.join(ROOT, 'eval/suites/retrieval-small.suite.mjs')), false,
      'retrieval-small is a calibration corpus; gating it as quality misreads its numbers');
  });
});
