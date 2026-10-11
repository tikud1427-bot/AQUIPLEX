#!/usr/bin/env node
/**
 * E10 store-unification migration — operator CLI.
 *
 *   DATABASE_URL=… node aqua/scripts/e10-migrate.mjs                       # DRY RUN (default), all owners
 *   … --owner user:abc                                                      # one owner
 *   … --apply --run-id 2026-10-05a                                          # backfill what canonical lacks
 *   … --status --run-id 2026-10-05a                                         # per-owner audit rows
 *   … --rollback --run-id 2026-10-05a [--owner …]                           # archive that run's claims
 *   … --legacy-writes-since 2026-10-05T00:00:00Z                            # is the legacy lane still writing?
 *   … --data-dir DIR                                                        # legacy store location
 *
 * The legacy store is opened READ-ONLY. Nothing here flips a read flag, stops
 * the legacy lane, or deletes legacy data (Blueprint §10.2: those are separate,
 * evidence-gated deployment steps). Every write carries actor import:e10:<run>.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const has = n => args.includes(n);
const dataDir = flag('--data-dir') ?? process.env.AQUA_DATA_DIR ?? path.join(os.homedir(), '.aquiplex');
const onlyOwner = flag('--owner');
const runId = flag('--run-id') ?? `dry-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
const operator = process.env.USER ?? process.env.USERNAME ?? 'operator';

function readLegacy(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = raw?.data ?? raw;
  const out = new Map();
  for (const [owner, b] of Object.entries(data ?? {})) {
    if (onlyOwner && owner !== onlyOwner) continue;
    out.set(owner, {
      facts: Object.values(b?.facts ?? {}),
      evidenceById: new Map(Object.entries(b?.evidence ?? {})),
    });
  }
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(2); }
  if (has('--apply') && !flag('--run-id')) {
    console.error('--apply requires an explicit --run-id (it names the run for audit, resume and rollback)');
    process.exit(2);
  }
  const M = await import('../src/core/worldModel/e10Migration.js');
  const { closePool } = await import('../src/core/db/pool.js');

  if (has('--status')) {
    console.table((await M.runStatus(runId)).map(r => ({ owner: r.owner_id, mode: r.mode, status: r.status,
      backfilled: r.result?.backfilled ?? null, parity: r.result?.parity?.ok ?? null, error: r.error })));
    await closePool(); return;
  }

  const file = path.join(dataDir, '.aqua-evidence.json');
  if (!fs.existsSync(file)) { console.error(`no legacy store at ${file} (use --data-dir)`); process.exit(2); }
  const legacy = readLegacy(file);

  if (has('--legacy-writes-since')) {
    const since = Date.parse(flag('--legacy-writes-since'));
    for (const [owner, { facts }] of legacy) {
      const r = M.legacyWritesSince(facts, since);
      if (r.count) console.log(`${owner}: ${r.count} legacy fact(s) written since ${r.since} — the legacy lane is still live`);
    }
    await closePool(); return;
  }

  if (has('--rollback')) {
    for (const owner of legacy.keys()) console.log(JSON.stringify(await M.rollbackOwner({ ownerId: owner, runId, operator })));
    await closePool(); return;
  }

  const mode = has('--apply') ? 'apply' : 'dry-run';
  let failures = 0;
  for (const [owner, { facts, evidenceById }] of legacy) {
    try {
      const r = await M.migrateOwner({ ownerId: owner, runId, mode, facts, evidenceById, operator });
      console.log(JSON.stringify(r));
      if (r.parity && !r.parity.ok && mode === 'apply') failures++;
    } catch (err) {
      failures++;
      console.error(`${owner}: FAILED — ${err?.message ?? err} (recorded; re-run resumes)`);
    }
  }
  console.log(`\nE10 ${mode} · run ${runId} · ${legacy.size} owner(s) · ${failures} with problems`);
  await closePool();
  if (failures) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
