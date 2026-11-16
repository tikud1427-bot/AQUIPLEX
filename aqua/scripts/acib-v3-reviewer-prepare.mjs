/**
 * ACIB v3 reviewer build helper — for the APPOINTED reviewer, after the freeze. OFFLINE: no provider
 * request, no credentials read, the freeze record and the evaluation file are never written.
 *
 *   node scripts/acib-v3-reviewer-prepare.mjs --manifest <frozen manifest> --eval-file <evaluation set, outside the repo>
 *        --results-dir <new or empty directory, outside the repo> --reviewer "<recorded reviewer>"
 *        [--analysis-spec ../AQUA_ACIB_V3_ANALYSIS_SPEC.md] [--dry-run]
 *
 * Verifies the frozen package (see eval/governance/reviewerPrepare.mjs) and, without --dry-run,
 * creates the results directory with prepared.json (hashes and names only) and README.txt.
 * AQUA_V3_FREEZE_FILE may point to a non-canonical record for VALIDATION ONLY (never independent).
 * Exit: 0 every check passed · 2 refused (each failed check listed).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareReviewer, ReviewerPrepareRefused } from '../eval/governance/reviewerPrepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dryRun = args.includes('--dry-run');
try {
  const r = prepareReviewer({
    manifestFile: opt('--manifest'), evalFile: opt('--eval-file'), resultsDir: opt('--results-dir'), reviewer: opt('--reviewer'),
    specFile: opt('--analysis-spec', path.join(REPO, 'AQUA_ACIB_V3_ANALYSIS_SPEC.md')), freezeFile: process.env.AQUA_V3_FREEZE_FILE ?? null, dryRun,
  });
  console.log(r.banner);
  for (const c of r.checks) console.log(`  ✓ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`provider-config syntheticDatasets entry: ${r.prepared.providerConfigDatasetHash}`);
  console.log(dryRun ? `DRY RUN — nothing written. Would create: ${r.planned.join(', ')}` : `prepared: ${r.writes.join(', ')}`);
} catch (err) {
  if (err instanceof ReviewerPrepareRefused) {
    console.error('acib-v3-reviewer-prepare: REFUSED');
    for (const c of err.checks) console.error(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail && !c.ok ? ` — ${c.detail}` : ''}`);
    process.exit(2);
  }
  throw err;
}
