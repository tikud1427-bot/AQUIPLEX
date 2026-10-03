#!/usr/bin/env node
/**
 * E10 reconciliation report — READ-ONLY.
 *
 *   DATABASE_URL=postgres://… node aqua/scripts/e10-reconcile.mjs [--data-dir DIR] [--owner ID] [--json]
 *
 * Reads the legacy `.aqua-evidence.json` and the canonical `aqua_claims` /
 * `aqua_sources` tables and prints how many conversation turns each lane holds.
 * Opens the JSON file for reading only and issues SELECTs only (a test pins
 * both). It does not start the engine, so it cannot trigger an ingest.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reconcileTurns, totalReconciliation, verdict } from '../src/core/worldModel/turnReconciliation.js';
import { errorText } from '../src/core/errorText.js';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const asJson = args.includes('--json');
const dataDir = flag('--data-dir') ?? process.env.AQUA_DATA_DIR ?? path.join(os.homedir(), '.aquiplex');
const onlyOwner = flag('--owner');

function readLegacy(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = raw?.data ?? raw;                          // wrapStore({schema, data}) or bare
  const out = new Map();
  for (const [owner, b] of Object.entries(data ?? {})) {
    if (onlyOwner && owner !== onlyOwner) continue;
    out.set(owner, Object.values(b?.facts ?? {}));
  }
  return out;
}

// A claim reaches its source through its evidence (aqua_claim_evidence ->
// aqua_evidence.source_id); there is no source_id on aqua_claims itself. DISTINCT,
// because a claim with several evidence rows from one source is still ONE claim.
export const CLAIMS_BY_SOURCE_SQL = `
  SELECT s.source_id, count(DISTINCT ce.claim_id)::int AS n
    FROM aqua_sources s
    LEFT JOIN aqua_evidence e        ON e.source_id = s.source_id AND e.owner_id = s.owner_id
    LEFT JOIN aqua_claim_evidence ce ON ce.evidence_id = e.evidence_id AND ce.owner_id = s.owner_id
   WHERE s.owner_id = $1 AND s.kind = 'conversation'
   GROUP BY s.source_id`;

async function main() {
  const file = path.join(dataDir, '.aqua-evidence.json');
  if (!fs.existsSync(file)) { console.error(`no legacy store at ${file} (use --data-dir)`); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set — cannot read canonical claims'); process.exit(2); }

  const legacy = readLegacy(file);
  const { getPool } = await import('../src/core/db/pool.js');
  const pool = await getPool();
  const reports = [];
  for (const [owner, facts] of legacy) {
    const { rows } = await pool.query(CLAIMS_BY_SOURCE_SQL, [owner]);
    reports.push(reconcileTurns(owner, facts, new Map(rows.map(r => [r.source_id, r.n]))));
  }
  await pool.end();

  const total = totalReconciliation(reports);
  if (asJson) { console.log(JSON.stringify({ total, verdict: verdict(total), owners: reports }, null, 2)); return; }
  console.log(`\nE10 RECONCILIATION  ·  ${total.owners} owner(s)  ·  data dir ${dataDir}\n`);
  console.log(`  legacy store     ${total.legacy.turns} turn(s) · ${total.legacy.facts} fact(s)  (${total.legacy.unjoinable} unjoinable, not conversation turns)`);
  console.log(`  canonical        ${total.canonical.turns} turn(s) with claims`);
  console.log(`  in BOTH          ${total.both.turns} turn(s)  (${total.both.legacyFacts} legacy facts ↔ ${total.both.claims} claims)`);
  console.log(`  legacy ONLY      ${total.legacyOnly.turns} turn(s)  (${total.legacyOnly.facts} facts)`);
  console.log(`  canonical ONLY   ${total.canonicalOnly.turns} turn(s)  (${total.canonicalOnly.claims} claims)\n`);
  console.log(`  ${verdict(total)}\n`);
}

main().catch(err => { console.error(`reconcile failed: ${errorText(err)}`); process.exit(1); });
