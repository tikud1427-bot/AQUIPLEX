/**
 * AQUA Eval — Context Engine retrieval over the CANONICAL World Model.
 *
 * The read production serves when Postgres is configured and reachable. Same
 * 60-fact world, same 200 labelled queries, same scorer as `context-core`
 * (which measures the legacy read). The world reaches `aqua_claims` through the
 * production E10 migration. See eval/adapters/canonicalContextRetrieval.mjs for
 * the declared gaps (dense lane offline, E6 extraction graded elsewhere).
 *
 * Requires Postgres. Without one the gate reports this suite as NOT RUN — never
 * as passed — and with AQUA_GATE_REQUIRE_DB=1 (CI) a missing database fails.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedCanonicalWorld, retrieveCanonical, canonicalAvailable } from '../adapters/canonicalContextRetrieval.mjs';
import { K, kindMap, scoreQuery, aggregate } from './retrievalScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/retrieval-core.v1.json'), 'utf8'));
const KIND_OF = kindMap(DS.corpus);

let world = null;

export default {
  id: 'context-canonical',
  title: 'Context Engine retrieval — canonical World Model read (production with Postgres)',
  about: [
    'Seeds the retrieval-core world, moves it into aqua_claims with the production E10',
    'migration, and asks Brain.assembleContextAsync with the read mode chat serves',
    '(resolveReadMode → canonicalOnly). Scored by the shared retrieval scorer.',
  ].join('\n'),
  requires: ['postgres'],
  available: canonicalAvailable,

  cases: DS.queries,

  async run(testCase) {
    if (!world) world = await seedCanonicalWorld(DS.corpus);
    const r = await retrieveCanonical(testCase.q, { limit: K });
    return { status: 'ok', actual: { ranked: r.ranked } };
  },

  score(testCase, actual) {
    return scoreQuery(testCase, actual.ranked, KIND_OF);
  },

  metrics(scored) {
    return {
      ...aggregate(scored),
      // Share of the corpus the production backfill projected into claims.
      canonical_coverage: world ? Math.round(world.coverage * 10000) / 10000 : 0,
    };
  },
};
