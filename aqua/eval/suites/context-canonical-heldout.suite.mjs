/**
 * AQUA Eval — canonical World Model read on the HELD-OUT set (2026-10-17).
 *
 * `context-canonical` grades the production canonical read on retrieval-core.v1,
 * which has been tuned against for weeks — development data. This suite asks
 * the same read (eval/adapters/canonicalContextRetrieval.mjs, world `heldout`)
 * the 82 questions of retrieval-heldout.v1: one founder's evolving company
 * state, written before the canonical relevance-gate change and frozen
 * (datasets/retrieval-heldout.v1.FROZEN.sha256) before its first run.
 *
 * Do NOT tune against its per-query results. If a change is motivated by one of
 * these questions, the set is spent and a new one must be written.
 *
 * Extra metric over context-canonical: `stale_leaks` — current questions that
 * received a value the user has since changed or corrected (lower is better).
 * `top1_kind` is not reported: the shared kindMap is written for the dev corpus.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedCanonicalWorld, retrieveCanonical, canonicalAvailable } from '../adapters/canonicalContextRetrieval.mjs';
import { K, scoreQuery, aggregate } from './retrievalScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '../datasets/retrieval-heldout.v1.json');
const RAW = readFileSync(FILE);
const FROZEN = readFileSync(path.join(HERE, '../datasets/retrieval-heldout.v1.FROZEN.sha256'), 'utf8').split(/\s+/)[0];
const DS = JSON.parse(RAW.toString('utf8'));
const NO_KINDS = new Map();

let world = null;

export default {
  id: 'context-canonical-heldout',
  title: 'Context Engine retrieval — canonical World Model read, held-out founder world',
  about: [
    'Seeds retrieval-heldout.v1 (46 statements) through the production understanding path with',
    'recorded E6 outputs, then asks Brain.assembleContextAsync exactly as chat does.',
    'Frozen dataset; held out from tuning.',
  ].join('\n'),
  requires: ['postgres'],
  available: async () => {
    const sha = createHash('sha256').update(RAW).digest('hex');
    if (sha !== FROZEN) return { ok: false, reason: `retrieval-heldout.v1.json changed since it was frozen (${sha.slice(0, 12)} ≠ ${FROZEN.slice(0, 12)})` };
    return canonicalAvailable('heldout');
  },

  cases: DS.queries,

  async run(testCase) {
    if (!world) world = await seedCanonicalWorld(DS.corpus, { world: 'heldout' });
    const r = await retrieveCanonical(testCase.q, { limit: K, world: 'heldout' });
    return { status: 'ok', actual: { ranked: r.ranked } };
  },

  score(testCase, actual) {
    return scoreQuery(testCase, actual.ranked, NO_KINDS);
  },

  metrics(scored) {
    const { top1_kind: _unused, ...rest } = aggregate(scored);
    return {
      ...rest,
      canonical_coverage: world ? Math.round(world.coverage * 10000) / 10000 : 0,
    };
  },
};
