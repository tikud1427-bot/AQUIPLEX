/**
 * ACIB v3 reviewer-only evaluation mode (2026-11-12). Used by answer-eval, answer-judge and
 * answer-analyze when given --v3-dataset-file (or --dataset-file for the analysis).
 *
 * The independent evaluation set lives OUTSIDE the repository, held by the reviewer. This mode
 * refuses unless ALL hold:
 *   · AQUA_V3_REVIEWER_MODE=yes (an explicit, per-terminal switch for the reviewer);
 *   · a v3 freeze record exists (scripts/acib-v3-freeze.mjs) and the dataset file's sha256 equals
 *     the record's eval sha256 — the frozen file, byte for byte;
 *   · the dataset file is outside the repository (links resolved);
 *   · --results-dir is given and outside the repository: per-item answers, judgements and review
 *     queues never land where implementation authors work;
 *   · --reviewer names the reviewer recorded in the freeze record.
 * The freeze record is the canonical eval/datasets/acib.v3.FREEZE.json. AQUA_V3_FREEZE_FILE may point
 * elsewhere ONLY to validate this machinery: such runs are marked "VALIDATION ONLY — non-canonical
 * freeze record" and the analysis never labels them independent.
 * Who sits at the keyboard cannot be verified by code; the process (AQUA_ACIB_V3_DECLARATIONS.md) does that.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './acibV3Governance.mjs';
import { insideRepo, realLocation } from '../answer/evalRun.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CANONICAL_FREEZE = path.resolve(HERE, '../datasets/acib.v3.FREEZE.json');

export class ReviewerModeRefused extends Error {
  constructor(reasons) { super(`reviewer mode refused:\n  - ${reasons.join('\n  - ')}`); this.name = 'ReviewerModeRefused'; this.reasons = reasons; }
}

export function resolveReviewerDataset({ datasetFile, resultsDir, reviewer, env = process.env, freezeFile = null }) {
  const r = [];
  const fz = path.resolve(freezeFile ?? env.AQUA_V3_FREEZE_FILE ?? CANONICAL_FREEZE);
  const canonical = fz === CANONICAL_FREEZE;
  if (env.AQUA_V3_REVIEWER_MODE !== 'yes') r.push('reviewer mode needs AQUA_V3_REVIEWER_MODE=yes (set by the reviewer, for this terminal only)');
  if (!datasetFile || !existsSync(datasetFile)) r.push('--v3-dataset-file <path to the frozen evaluation set, outside the repository> is required');
  else if (insideRepo(datasetFile)) r.push('the v3 evaluation set must stay outside the repository');
  if (!resultsDir) r.push('--results-dir <directory outside the repository> is required: per-item results never land in the repository');
  else if (!existsSync(resultsDir) || !statSync(resultsDir).isDirectory()) r.push('--results-dir must be an existing directory');
  else if (insideRepo(resultsDir)) r.push('--results-dir must be outside the repository');
  let record = null;
  if (!existsSync(fz)) r.push('no ACIB v3 freeze record: freeze the dataset first (scripts/acib-v3-freeze.mjs)');
  else {
    record = JSON.parse(readFileSync(fz, 'utf8'));
    if (record?.version !== 'acib-3') r.push('the freeze record is not an ACIB v3 record');
    if (!reviewer || String(reviewer).trim().toLowerCase() !== String(record?.reviewer?.name ?? '').trim().toLowerCase()) r.push('--reviewer must name the reviewer recorded in the freeze record');
  }
  let RAW = null;
  if (!r.length) {
    RAW = readFileSync(datasetFile, 'utf8');
    if (sha256(RAW) !== record.eval.sha256) r.push('the dataset file does not match the frozen sha256 (changed, or not the frozen file)');
  }
  if (r.length) throw new ReviewerModeRefused(r);
  return {
    RAW, DS: JSON.parse(RAW), record, govSha256: record.eval.sha256, resultsDir: realLocation(resultsDir), canonical,
    banner: canonical ? 'ACIB v3 REVIEWER MODE (frozen independent set)' : 'VALIDATION ONLY — non-canonical freeze record; results are NOT an independent evaluation',
  };
}
