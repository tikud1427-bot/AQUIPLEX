import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { getPool, isConfigured, closePool, bootLine } from '../src/core/db/pool.js';
import { enqueue } from '../src/core/jobs/jobQueue.js';
import { modelSignature } from '../src/embeddings/embeddingModel.js';

dotenv.config({ path: new URL('../../.env', import.meta.url) });

const BACKFILL = process.argv.includes('--backfill');

function hash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

async function main() {
  console.log(bootLine());
  if (!isConfigured()) throw new Error('DATABASE_URL is not configured');

  const p = await getPool();

  const required = [
    ['aqua_claims', 'SELECT 1 FROM aqua_claims LIMIT 1'],
    ['aqua_embeddings', 'SELECT 1 FROM aqua_embeddings LIMIT 1'],
    ['aqua_claim_retrieval_bridge', 'SELECT 1 FROM aqua_claim_retrieval_bridge LIMIT 1'],
  ];

  for (const [name, sql] of required) {
    try {
      await p.query(sql);
    } catch (err) {
      throw new Error(`E7 substrate missing: ${name} ? ${err.message}`);
    }
  }

  const { rows: counts } = await p.query(`
    SELECT
      (SELECT count(*)::int FROM aqua_claims
        WHERE state IN ('active','trusted')) AS live_claims,
      (SELECT count(*)::int FROM aqua_embeddings e
        JOIN aqua_claims c
          ON c.claim_id=e.target_id AND c.owner_id=e.owner_id
        WHERE e.target_kind='claim'
          AND c.state IN ('active','trusted')) AS live_embeddings,
      (SELECT count(*)::int FROM aqua_claim_retrieval_bridge) AS bridge_rows
  `);

  const c = counts[0];

  const { rows: models } = await p.query(`
    SELECT model_signature, count(*)::int AS n
      FROM aqua_embeddings
     WHERE target_kind='claim'
     GROUP BY model_signature
     ORDER BY n DESC
  `);

  console.log(`[E7] live claims=${c.live_claims} embeddings=${c.live_embeddings} bridge=${c.bridge_rows}`);
  console.log(`[E7] embedding models=${models.map(r => `${r.model_signature}:${r.n}`).join(', ') || 'none'}`);
  console.log(`[E7] configured model=${modelSignature()}`);

  if (!BACKFILL) {
    console.log('[E7] doctor complete (read-only). Use --backfill to queue missing embeddings.');
    return;
  }

  const { rows: claims } = await p.query(`
    SELECT c.owner_id, c.claim_id, c.statement_text
      FROM aqua_claims c
     WHERE c.state IN ('active','trusted')
       AND c.statement_text IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM aqua_embeddings e
          WHERE e.owner_id=c.owner_id
            AND e.target_kind='claim'
            AND e.target_id=c.claim_id
            AND e.model_signature=$1
       )
     ORDER BY c.owner_id, c.claim_id
  `, [modelSignature()]);

  let queued = 0;
  let existing = 0;

  for (const claim of claims) {
    const key = `e7:claim-embedding:backfill:${claim.claim_id}:${modelSignature()}`;

    const r = await enqueue({
      ownerId: claim.owner_id,
      kind: 'claim.embedding.v1',
      payload: {
        ownerId: claim.owner_id,
        claimId: claim.claim_id,
        statementText: String(claim.statement_text),
        contentHash: hash(claim.statement_text),
        source: 'e7-backfill',
      },
      idempotencyKey: key,
      priority: 40,
    });

    if (r.created) queued += 1;
    else existing += 1;
  }

  console.log(`[E7] backfill candidates=${claims.length} queued=${queued} alreadyQueued=${existing}`);
  console.log('[E7] Start the durable worker to materialize the queued vectors.');
}

main()
  .catch(err => {
    console.error(`\n? E7 doctor failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
