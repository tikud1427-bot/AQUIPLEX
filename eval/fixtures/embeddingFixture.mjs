/**
 * AQUA Eval — the dense-retrieval fixture, replayed offline.
 *
 * Vectors generated once against a real provider by
 * `scripts/build-embedding-fixture.mjs`, committed, and read back here. That
 * makes the dense lane measurable with no key, no network, and — because the
 * same vectors are replayed every run — no variance at all, unlike the E6
 * shadow harness where two identical runs differed by 16 points.
 *
 * KEYED BY RETRIEVAL IDENTITY. Fact vectors are keyed by evidence-store fact id
 * and query vectors by query id, the same identities the retrieval pool uses.
 * The long-term-memory embedding path keys by LTM fact key (`workplace`,
 * `cofounder`) while the Context Engine looks up by evidence-store id — that is
 * blueprint §10's "embedding key ≠ retrieval identity", found in E7/PR-1, and
 * it is the reason this file states its keyspace instead of assuming one.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'retrieval-core.embeddings.v1.json');
const DATASET = path.join(HERE, '../datasets/retrieval-core.v1.json');

// Keyed by dataset name, because there is more than one corpus now:
// `retrieval-small.v1` is the second calibration point for the dense margin
// floor, which was swept at 60 facts and is not scale-free.
const cache = new Map();
let cached;

/**
 * Recompute the corpus fingerprint exactly as the generator does.
 *
 * A fixture whose hash no longer matches the dataset describes text that has
 * since changed. Scoring against it would produce confident similarity numbers
 * for statements nobody wrote — which is worse than having no fixture, because
 * it looks like a result.
 */
function corpusHashOf(ds) {
  const facts = ds.corpus.map(f => ({ id: f.id, text: f.statement }));
  const queries = ds.queries.map(q => ({ id: q.id, text: q.q }));
  return createHash('sha256').update(JSON.stringify([facts, queries])).digest('hex').slice(0, 16);
}

/**
 * Load the fixture, or return null when it is absent.
 *
 * ABSENT IS FINE AND MUST STAY FINE. The fixture needs one run against a real
 * provider to exist, so every consumer has to work without it — the dense lane
 * simply contributes nothing, exactly as it does today. STALE, by contrast, is
 * refused loudly: silence about absence is honest, silence about staleness is a
 * wrong answer wearing a right one's clothes.
 *
 * @returns {{facts:Map<string,number[]>, queries:Map<string,number[]>, dim:number, model:string}|null}
 */
export function loadEmbeddingFixture({ dataset = null, name = null } = {}) {
  // `name` selects a corpus; omitted, it is retrieval-core and the original
  // single-fixture behaviour is unchanged.
  if (name) return loadNamed(name);
  if (cached !== undefined) return cached;
  if (!existsSync(FIXTURE)) { cached = null; return cached; }

  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const ds = dataset ?? JSON.parse(readFileSync(DATASET, 'utf8'));
  const expected = corpusHashOf(ds);
  if (raw.corpusHash !== expected) {
    throw new Error(
      `Embedding fixture is STALE: corpus hash ${expected}, fixture ${raw.corpusHash}. ` +
      'The dataset changed after the vectors were generated. Regenerate with ' +
      'node --env-file=../.env scripts/build-embedding-fixture.mjs',
    );
  }

  cached = {
    facts: new Map(Object.entries(raw.facts ?? {})),
    queries: new Map(Object.entries(raw.queries ?? {})),
    dim: raw.dim ?? 0,
    model: raw.model ?? 'unknown',
  };
  return cached;
}

/**
 * Load a named corpus's fixture, with the same absent/stale contract.
 *
 * Absent is fine and returns null; stale throws. Both matter more here than for
 * the default corpus, because a second calibration point only means anything if
 * its vectors describe the text they were generated from.
 */
function loadNamed(name) {
  if (cache.has(name)) return cache.get(name);
  const base = name.replace(/\.v\d+$/, '');
  const fx = path.join(HERE, `${base}.embeddings.v1.json`);
  const dsPath = path.join(HERE, `../datasets/${name}.json`);
  if (!existsSync(fx) || !existsSync(dsPath)) { cache.set(name, null); return null; }

  const raw = JSON.parse(readFileSync(fx, 'utf8'));
  const expected = corpusHashOf(JSON.parse(readFileSync(dsPath, 'utf8')));
  if (raw.corpusHash !== expected) {
    throw new Error(
      `Embedding fixture for ${name} is STALE: corpus hash ${expected}, fixture ${raw.corpusHash}. ` +
      `Regenerate with node --env-file=../.env scripts/build-embedding-fixture.mjs --dataset ${name}`,
    );
  }
  const out = {
    facts: new Map(Object.entries(raw.facts ?? {})),
    queries: new Map(Object.entries(raw.queries ?? {})),
    dim: raw.dim ?? 0,
    model: raw.model ?? 'unknown',
  };
  cache.set(name, out);
  return out;
}

/** Test seam — the module memoises, and a test that changes a fixture needs to reset it. */
export function __resetFixtureCache() { cached = undefined; cache.clear(); }

/** Cosine similarity. Returns 0 for any shape mismatch rather than throwing. */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/**
 * Similarity of every corpus fact to one query, as the retrieval scorer wants it.
 *
 * Returns `Map<factId, cosine>` — keyed by evidence-store fact id, which is
 * what `semanticId` carries. Null when there is no fixture, so a caller can
 * tell "no vectors" from "similarity zero"; conflating those is how the LTM
 * path went unnoticed for so long.
 */
export function factSimilarities(queryId, fixture = loadEmbeddingFixture()) {
  if (!fixture) return null;
  const qv = fixture.queries.get(queryId);
  if (!qv) return null;
  const out = new Map();
  for (const [factId, fv] of fixture.facts) out.set(factId, cosine(qv, fv));
  return out;
}
