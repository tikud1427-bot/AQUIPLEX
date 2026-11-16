#!/usr/bin/env node
/**
 * Artifact storage audit + object-store migration plan (scalability Phase 4A).
 *
 *   node aqua/scripts/artifact-storage-audit.mjs --root <copy of the artifacts dir>
 *        [--history <.aqua-history.json copy>]   artifacts whose conversation is gone
 *        [--deleted <owner ids file>]             artifacts of deleted accounts
 *        [--plan-out <file.json>]                 the per-object upload plan (key, size, sha256)
 *        [--no-verify-bytes]                      skip re-hashing every file
 *
 * READ-ONLY. Run it on a COPY of the production directory; nothing is
 * uploaded and no object store is contacted (Google Cloud Storage is not
 * activated — AQUIPLEX_ARTIFACT_STORAGE_AUDIT.md). stdout = JSON report.
 */
import fs from 'node:fs';

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const has = n => process.argv.includes(n);
const fail = (m, c = 2) => { console.error(`✗ ${m}`); process.exit(c); };

const root = arg('--root') ?? fail('--root <artifacts directory copy> is required');
if (!fs.existsSync(root)) fail(`${root} does not exist`);
const { auditArtifactRoot } = await import('../src/artifacts/artifactAudit.js');
let conversationIds = null;
if (arg('--history')) {
  const doc = JSON.parse(fs.readFileSync(arg('--history'), 'utf8'));
  conversationIds = new Set(Object.keys(doc.__aqua && 'data' in doc ? doc.data : doc));
}
const deletedOwners = arg('--deleted') ? new Set(fs.readFileSync(arg('--deleted'), 'utf8').split(/\s+/).filter(Boolean)) : null;
const report = auditArtifactRoot(root, { conversationIds, deletedOwners, verifyBytes: !has('--no-verify-bytes') });
if (arg('--plan-out')) {
  if (fs.existsSync(arg('--plan-out')) && !has('--force')) fail(`${arg('--plan-out')} exists (use --force)`);
  fs.writeFileSync(arg('--plan-out'), JSON.stringify(report.plan, null, 1));
}
const { plan, ...summary } = report;
summary.plan = { objects: plan.length, bytes: plan.reduce((s, o) => s + o.size, 0), written: arg('--plan-out') ?? null };
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(report.clean ? 0 : 1);
