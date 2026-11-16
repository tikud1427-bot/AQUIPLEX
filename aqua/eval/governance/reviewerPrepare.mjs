/**
 * ACIB v3 reviewer build helper (2026-11-12). For the APPOINTED reviewer, after the freeze, before any
 * run: verifies the frozen package end to end and prepares the external results directory.
 * It never reads credentials, never sends a request, never writes or modifies the freeze record or
 * the evaluation file, and never moves the dataset into the repository.
 *
 * Checks (all must pass):
 *   1. freeze record present (canonical eval/datasets/acib.v3.FREEZE.json; any other path is
 *      VALIDATION ONLY and can never produce an independent result);
 *   2. manifest valid: ≥2 independent authors with verbatim, dated, non-future declarations; reviewer
 *      sign-off; no placeholder identities; founder / exposed persons / implementers barred;
 *   3. manifest ↔ freeze record consistent: reviewer, authors, declaration dates, spec hash; the
 *      record says the spec was verified at freeze;
 *   4. analysis specification: sha256 of the file equals the pre-registered hash;
 *   5. --reviewer equals the recorded reviewer;
 *   6. evaluation file: outside the repository; sha256 equals the frozen eval hash (byte-for-byte);
 *      NOT the development set (hash or path); passes the dataset checks for role 'eval';
 *   7. results directory: outside the repository; absent or empty (results never mix);
 *   8. the evaluation file is re-hashed after all checks: unchanged.
 * Dry run: every check; nothing written.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256, validateManifest, validateDataset } from './acibV3Governance.mjs';
import { CANONICAL_FREEZE } from './reviewerMode.mjs';
import { insideRepo, realLocation } from '../answer/evalRun.mjs';

export class ReviewerPrepareRefused extends Error {
  constructor(reasons, checks) { super(`reviewer preparation refused:\n  - ${reasons.join('\n  - ')}`); this.name = 'ReviewerPrepareRefused'; this.reasons = reasons; this.checks = checks; }
}
const norm = s => String(s ?? '').trim().toLowerCase();

export function prepareReviewer({ manifestFile, evalFile, resultsDir, reviewer, specFile, freezeFile = null, dryRun = true, now = Date.now() }) {
  const checks = [];
  const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
  const fz = path.resolve(freezeFile ?? CANONICAL_FREEZE);
  const canonical = fz === path.resolve(CANONICAL_FREEZE);

  // 1. Freeze record
  let record = null;
  if (check('freeze record present', existsSync(fz), canonical ? 'canonical' : 'NON-CANONICAL (validation only)')) record = JSON.parse(readFileSync(fz, 'utf8'));
  if (record) check('freeze record is ACIB v3', record.version === 'acib-3');

  // 2. Manifest
  let manifest = null;
  if (check('manifest present', manifestFile && existsSync(manifestFile))) {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const v = validateManifest(manifest);
    check('manifest valid (independence, verbatim dated declarations, no placeholders, no future dates)', v.ok, v.errors.join('; '));
  }

  // 3. Manifest ↔ record
  if (record && manifest) {
    check('reviewer matches the freeze record', norm(manifest.reviewer?.name) === norm(record.reviewer?.name));
    check('reviewer sign-off date matches', manifest.reviewer?.signedAt === record.reviewer?.signedAt);
    const ma = (manifest.evalAuthors ?? []).map(a => `${norm(a.name)}|${a.declaredAt}`).sort().join(',');
    const ra = (record.evalAuthors ?? []).map(a => `${norm(a.name)}|${a.declaredAt}`).sort().join(',');
    check('evaluation authors and declaration dates match the freeze record', ma === ra && ma.length > 0);
    check('analysis-spec hash matches the freeze record', manifest.analysisSpecSha256 === record.analysisSpec?.sha256);
    check('the freeze verified the analysis spec', record.analysisSpec?.verified === true);
    check('the freeze recorded the v3 grader', !!record.scorer?.sha256);
  }

  // 4. Analysis specification
  if (check('analysis spec file present', specFile && existsSync(specFile)) && manifest) check('analysis spec unchanged since pre-registration', sha256(readFileSync(specFile, 'utf8')) === manifest.analysisSpecSha256);

  // 5. Reviewer identity
  check('--reviewer is the recorded reviewer', !!reviewer && !!record && norm(reviewer) === norm(record.reviewer?.name));

  // 6. Evaluation file
  let before = null;
  if (check('evaluation file present', evalFile && existsSync(evalFile))) {
    check('evaluation file outside the repository', !insideRepo(evalFile));
    const raw = readFileSync(evalFile);
    before = sha256(raw.toString('utf8'));
    if (record) {
      check('evaluation file is the frozen evaluation set (sha256)', before === record.eval?.sha256, `sha256 ${before.slice(0, 12)}…`);
      check('evaluation file is NOT the development set', before !== record.dev?.sha256 && !(manifest?.devPath && path.resolve(manifest.devPath) === path.resolve(evalFile)));
    }
    let ds = null; try { ds = JSON.parse(raw.toString('utf8')); } catch { /* reported below */ }
    const v = ds ? validateDataset(ds, { role: 'eval' }) : { ok: false, errors: ['not valid JSON'] };
    check('evaluation file passes the role-eval dataset checks', v.ok, v.errors.slice(0, 5).join('; '));
  }

  // 7. Results directory
  if (check('results directory given', !!resultsDir)) {
    check('results directory outside the repository', !insideRepo(resultsDir));
    const exists = existsSync(resultsDir);
    check('results directory absent or empty (results never mix)', !exists || (statSync(resultsDir).isDirectory() && readdirSync(resultsDir).length === 0));
  }

  // 8. Byte-for-byte integrity after all checks
  if (before) check('evaluation file unchanged after the checks', sha256(readFileSync(evalFile, 'utf8')) === before);

  const failed = checks.filter(c => !c.ok);
  if (failed.length) throw new ReviewerPrepareRefused(failed.map(c => `${c.name}${c.detail ? ` (${c.detail})` : ''}`), checks);

  const banner = canonical ? 'ACIB v3 REVIEWER PREPARATION — canonical freeze record' : 'VALIDATION ONLY — non-canonical freeze record; can never produce an independent result';
  const prepared = {
    preparedAt: new Date(now).toISOString(), validationOnly: !canonical, independentEligible: canonical,
    reviewer: record.reviewer.name, evalSha256: record.eval.sha256, devSha256: record.dev.sha256,
    // The provider config's syntheticDatasets entry: identical to the freeze hash (both CRLF-normalised sha256).
    providerConfigDatasetHash: record.eval.sha256,
    analysisSpecSha256: record.analysisSpec.sha256, graderSha256: record.scorer.sha256, freezeRecordSha256: sha256(readFileSync(fz, 'utf8')),
    note: 'Contains hashes and names only — no dataset content, no credentials.',
  };
  const writes = [path.join(resultsDir, 'prepared.json'), path.join(resultsDir, 'README.txt')];
  if (!dryRun) {
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(writes[0], `${JSON.stringify(prepared, null, 1)}\n`);
    writeFileSync(writes[1], [
      banner, '',
      'This directory holds ACIB v3 per-item results (answers, judgements, review queues, analyses).',
      'Keep it OUTSIDE the code repository. Do not share items with the engineering team until the run is complete.',
      `Frozen evaluation set sha256: ${record.eval.sha256}`,
      'Live runs require separate founder approval (D-P2-7 / C-6) and a same-day productionUsageCheck.', '',
    ].join('\n'));
  }
  return { ok: true, canonical, banner, checks, prepared, writes: dryRun ? [] : writes.map(realLocation), planned: writes, dryRun };
}
