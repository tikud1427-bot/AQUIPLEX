#!/usr/bin/env node
/**
 * AQUA — generate the dense-retrieval fixture for `retrieval-core.v1`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `recall_category` has sat at 0.4688 across every session — the worst honest
 * metric on both retrieval lanes. Its failures are semantic, not lexical:
 * "educational background" → "I studied physics before this", "go-to-market
 * metric" → "we measure success by weekly active teams". No lexicon reaches
 * those without being fitted to this dataset, which `questionShape.js`'s own
 * header forbids. It needs a dense lane.
 *
 * A dense lane needs vectors, vectors need a provider, and the analysis sandbox
 * cannot reach one. That has blocked this work for eight sessions.
 *
 * VECTORS ARE STATIC DATA, AND THAT IS THE WAY OUT.
 * The corpus is 60 fixed facts and 200 fixed queries. Embed them ONCE, commit
 * the result, and dense retrieval becomes measurable offline forever — no key,
 * no network, no per-run cost, and no variance, because the same vectors are
 * replayed every time. Unlike `e6-shadow.mjs`, which needs a live provider on
 * every run, this is paid once.
 *
 * KEYED BY EVIDENCE-STORE FACT ID, WHICH IS THE POINT.
 * E7/PR-1 found that the existing embedding path keys vectors by LONG-TERM
 * MEMORY fact key (`workplace`, `cofounder`) while retrieval identifies facts
 * by evidence-store id — blueprint §10's "embedding key ≠ retrieval identity".
 * This fixture keys on `f001`-style corpus ids, the same identity the retrieval
 * pool uses, so the lane built on it cannot inherit that defect.
 *
 * USAGE
 *   node scripts/build-embedding-fixture.mjs                    # needs GEMINI_API_KEY
 *   node scripts/build-embedding-fixture.mjs --dataset retrieval-small.v1
 *   node scripts/build-embedding-fixture.mjs --out <path>
 *   node scripts/build-embedding-fixture.mjs --dry-run          # cost, no calls
 *
 * The output is committed. Re-run only when the corpus or the model changes —
 * both are recorded in the fixture header so a stale one is detectable.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// Any labelled retrieval dataset. `retrieval-small.v1` exists as a SECOND
// calibration point: the dense margin floor was swept at 60 facts and the
// statistic is not scale-free, so one corpus cannot settle the threshold.
const DEFAULT_DATASET = 'retrieval-core.v1';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? true) : dflt;
};
const dryRun = args.includes('--dry-run');
const which = String(flag('--dataset', DEFAULT_DATASET)).replace(/\.json$/, '');
const datasetPath = path.join(ROOT, `eval/datasets/${which}.json`);
const outPath = path.resolve(process.cwd(),
  flag('--out', path.join(ROOT, `eval/fixtures/${which.replace(/\.v\d+$/, '')}.embeddings.v1.json`)));

const DS = JSON.parse(readFileSync(datasetPath, 'utf8'));
console.log(`dataset: ${which}`);

/**
 * What gets embedded, and under which id.
 *
 * Facts embed their STATEMENT — the text retrieval ranks — not a "key: value"
 * rendering. Queries embed verbatim. Both are keyed exactly as the retrieval
 * path identifies them, so a lookup can never miss the way the LTM path did.
 */
const factItems = DS.corpus.map(f => ({ id: f.id, text: f.statement }));
const queryItems = DS.queries.map(q => ({ id: q.id, text: q.q }));
const total = factItems.length + queryItems.length;

// The corpus fingerprint. A fixture whose corpus hash no longer matches the
// dataset is STALE, and the consumer refuses it rather than scoring against
// vectors for text that has since changed.
const corpusHash = createHash('sha256')
  .update(JSON.stringify([factItems, queryItems]))
  .digest('hex')
  .slice(0, 16);

console.log(`corpus: ${factItems.length} facts + ${queryItems.length} queries = ${total} embeddings`);
console.log(`corpus hash: ${corpusHash}`);

if (dryRun) {
  console.log('\n--dry-run — no provider calls made.');
  console.log(`would write: ${outPath}`);
  process.exit(0);
}

const { embed, isEmbeddingEnabled } = await import('../src/embeddings/embeddingProvider.js');

if (!isEmbeddingEnabled()) {
  // Same refusal as e6-shadow: a run with no transport produces nulls, and a
  // fixture full of nulls would score 0 similarity everywhere — which reads as
  // "dense retrieval does not help" rather than "nothing was embedded".
  console.error('\n✗ Embeddings are not enabled — no key, or AQUA_EMBEDDINGS is off.');
  console.error('  Nothing was written. A fixture of nulls scores 0 similarity on every');
  console.error('  pair, which is indistinguishable from a dense lane that does not work.');
  console.error('\n  node --env-file=../.env scripts/build-embedding-fixture.mjs');
  process.exit(1);
}

const model = process.env.AQUA_EMBED_MODEL ?? 'default';
console.log(`model: ${model}\nembedding…`);

async function embedAll(items, label) {
  const vecs = await embed(items.map(i => i.text));
  const out = {};
  let nulls = 0;
  items.forEach((it, i) => {
    if (Array.isArray(vecs[i])) out[it.id] = vecs[i];
    else nulls++;
  });
  console.log(`  ${label}: ${Object.keys(out).length}/${items.length}` + (nulls ? `  (${nulls} FAILED)` : ''));
  return { out, nulls };
}

const facts = await embedAll(factItems, 'facts');
const queries = await embedAll(queryItems, 'queries');
const nulls = facts.nulls + queries.nulls;

// Partial is worse than nothing here: a fact with no vector silently scores 0
// against every query and looks like a dense-retrieval miss.
if (nulls > 0) {
  console.error(`\n✗ ${nulls} of ${total} embeddings failed — NOT writing a partial fixture.`);
  console.error('  A missing vector scores 0 similarity and is indistinguishable from a');
  console.error('  genuine semantic miss. Re-run when the provider is healthy.');
  process.exit(1);
}

const dim = facts.out[factItems[0].id]?.length ?? 0;
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
  about: [
    'Dense-retrieval fixture for retrieval-core.v1. Vectors are STATIC DATA:',
    'generated once against a real provider, committed, and replayed offline so',
    'the dense lane is measurable with no key, no network and no run-to-run',
    'variance. Keyed by evidence-store fact id and query id — the same identity',
    'the retrieval pool uses, which is the defect blueprint §10 names and',
    'E7/PR-1 found in the long-term-memory embedding path.',
    '',
    'Regenerate ONLY when the corpus or the model changes:',
    '  node --env-file=../.env scripts/build-embedding-fixture.mjs',
  ].join('\n'),
  corpusHash,
  model,
  dim,
  generatedAt: new Date().toISOString(),
  counts: { facts: Object.keys(facts.out).length, queries: Object.keys(queries.out).length },
  facts: facts.out,
  queries: queries.out,
}, null, 0));

console.log(`\n✓ ${total} vectors, dim ${dim}`);
console.log(`→ ${outPath}`);
