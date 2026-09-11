/**
 * AQUA Eval — retrieval quality
 * Blueprint E2/PR-5
 *
 * WHAT IS MEASURED, AND WHY EACH ONE
 * ----------------------------------
 *   recall@k        did the right fact come back at all, within k?
 *   MRR             how far down was it?
 *   nDCG@k          graded — relevant (2) beats acceptable (1) beats noise (0)
 *   top1_kind       is the top hit the KIND of thing asked for? A "where"
 *                   question answered with a churn number is wrong even when
 *                   the fact is about the right person
 *   noise_rate      lines returned for queries that should return NOTHING
 *   unknown_honesty the share of unanswerable queries answered with silence
 *
 * NOISE AND HONESTY ARE NOT FOLDED INTO AN AVERAGE
 * ------------------------------------------------
 * An engine that returns everything scores perfect recall. Averaging silence
 * into a single figure hides exactly the failure this dataset was built from:
 * seven of nine noise lines in the rollout harness came from one query that
 * merely contained the word "you". They are reported separately, always.
 *
 * ONE WORLD, SEEDED ONCE
 * ----------------------
 * The corpus is built into a real world model before the first query and left
 * alone. Re-seeding per query would measure a cold store 200 times and would
 * not resemble any real owner.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedWorld, retrieveWithCurrentEngine } from '../adapters/currentRetrieval.mjs';
// One scorer, two lanes. `context-core` grades the Context Engine on this same
// dataset, and a copied scorer would make the two numbers incomparable in
// exactly the dimension they exist to isolate.
import { K, kindMap, scoreQuery, aggregate } from './retrievalScoring.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/retrieval-core.v1.json'), 'utf8'));
const OWNER = 'user:eval-retrieval';

const KIND_OF = kindMap(DS.corpus);

let seeded = false;

export default {
  id: 'retrieval-core',
  title: 'retrieval quality — current engine vs relevance labels',
  about: [
    'Seeds a 60-fact world with the same node and edge shapes conversationIngest writes,',
    'then asks 200 labelled queries through pic/core retrieveKnowledge — the exact facade',
    'the chat spine calls. Reports recall@8, MRR, nDCG@8, top-1 answer KIND, and — kept',
    'deliberately separate from every average — the noise rate and unknown-honesty on the',
    '32 queries whose only correct answer is silence.',
  ].join('\n'),

  cases: DS.queries,

  async run(testCase) {
    if (!seeded) { await seedWorld(OWNER, DS.corpus); seeded = true; }
    const r = await retrieveWithCurrentEngine(OWNER, testCase.q, { limit: K });
    return { status: 'ok', actual: { ranked: r.ranked } };
  },

  score(testCase, actual) {
    return scoreQuery(testCase, actual.ranked, KIND_OF);
  },

  metrics(scored) {
    return aggregate(scored);
  },
};
