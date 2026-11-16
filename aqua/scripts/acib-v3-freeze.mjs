/**
 * Freeze ACIB v3 (Sprint 6 tooling, extended 2026-11-12; NOT run — no v3 dataset exists yet).
 *
 *   node scripts/acib-v3-freeze.mjs --manifest <manifest.json> --scorer eval/answer/answerGraderV3.mjs
 *                                   --analysis-spec ../AQUA_ACIB_V3_ANALYSIS_SPEC.md [--dry-run]
 *
 *   --dry-run   run EVERY check and print what would be frozen; write nothing (freeze validation).
 *
 * Refuses unless:
 *   · the manifest declares ≥2 eval authors (each with the verbatim author declaration and a date),
 *     none of them implementation authors; ≥1 development author who is not an eval author; and a
 *     reviewer sign-off (name, date, the verbatim reviewer declaration) by someone who is neither an
 *     implementation author nor a development author;
 *   · the founder's confirmation of the success criteria is recorded;
 *   · the analysis specification's sha256 equals manifest.analysisSpecSha256 (pre-registration);
 *   · the v3 grader is given (frozen with the data);
 *   · the eval set is stored OUTSIDE the repository;
 *   · both sets pass the dataset checks (174 / 62, category balance, reachable annotations,
 *     honest paraphrase flags, language-mismatch / indirect-reference / answerability annotations);
 *   · no v3 freeze exists yet (never overwritten).
 * Writes eval/datasets/acib.v3.FREEZE.json (hashes and declarations; the eval path is withheld).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, validateDataset, assertOutsideRepo, freezeRecord, sha256 } from '../eval/governance/acibV3Governance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '..');
const REPO = path.join(AQUA, '..');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const fail = msg => { console.error(`acib-v3-freeze: REFUSED — ${msg}`); process.exit(2); };

const DRY = args.includes('--dry-run');
const manifestPath = opt('--manifest');
if (!manifestPath) fail('--manifest is required');
const out = path.join(AQUA, 'eval/datasets/acib.v3.FREEZE.json');
if (existsSync(out) && !DRY) fail('acib.v3 is already frozen; a change is a new version');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const m = validateManifest(manifest);
if (!m.ok) fail(`manifest:\n  - ${m.errors.join('\n  - ')}`);
try { assertOutsideRepo(manifest.evalPath, REPO); } catch (e) { fail(e.message); }
const evalText = readFileSync(manifest.evalPath, 'utf8');
const devText = readFileSync(manifest.devPath, 'utf8');
for (const [role, text] of [['eval', evalText], ['dev', devText]]) {
  const v = validateDataset(JSON.parse(text), { role });
  if (!v.ok) fail(`${role} set:\n  - ${v.errors.slice(0, 40).join('\n  - ')}${v.errors.length > 40 ? `\n  … ${v.errors.length - 40} more` : ''}`);
}
// Development and evaluation sets must not share scenarios.
{
  const ev = JSON.parse(evalText).scenarios, dv = JSON.parse(devText).scenarios;
  const ids = new Set(dv.map(s => s.id)), qs = new Set(dv.map(s => s.question.trim().toLowerCase()));
  const shared = ev.filter(s => ids.has(s.id) || qs.has(s.question.trim().toLowerCase())).map(s => s.id);
  if (shared.length) fail(`the development set shares scenarios (id or question) with the evaluation set: ${shared.slice(0, 10).join(', ')}`);
  // D-3: each set's filler is controlled by that set's own authors, and the two libraries are separate.
  const E = JSON.parse(evalText), Dv = JSON.parse(devText);
  const nm = s => String(s ?? '').trim().toLowerCase();
  const evalAuthors = new Set((manifest.evalAuthors ?? []).map(a => nm(a.name)));
  const devAuthors = new Set((manifest.devAuthors ?? []).map(a => nm(a?.name ?? a)));
  const notEval = (E.fillerMetadata?.authors ?? []).filter(a => !evalAuthors.has(nm(a)));
  if (notEval.length) fail(`evaluation filler must be authored by the evaluation authors: ${notEval.join(', ')} is not one`);
  const notDev = (Dv.fillerMetadata?.authors ?? []).filter(a => !devAuthors.has(nm(a)));
  if (notDev.length) fail(`development filler must be authored by the development authors: ${notDev.join(', ')} is not one`);
  const evFill = new Set((E.filler ?? []).map(nm));
  const sharedFill = (Dv.filler ?? []).filter(t => evFill.has(nm(t)));
  if (sharedFill.length) fail(`the development and evaluation filler libraries share ${sharedFill.length} message(s); development authors must use separate material`);
}
// The grader and the pre-registered analysis specification are frozen WITH the data.
const scorerPath = opt('--scorer');
if (!scorerPath || !existsSync(scorerPath)) fail('--scorer <v3 grader file> is required (frozen with the data)');
const specPath = opt('--analysis-spec');
if (!specPath || !existsSync(specPath)) fail('--analysis-spec <AQUA_ACIB_V3_ANALYSIS_SPEC.md> is required (pre-registration)');
const specText = readFileSync(specPath, 'utf8');
if (sha256(specText) !== manifest.analysisSpecSha256) fail('the analysis specification does not match manifest.analysisSpecSha256 (it changed after it was pre-registered)');
const record = freezeRecord({ manifest, evalText, devText, scorerText: readFileSync(scorerPath, 'utf8'), analysisSpecText: specText });
if (DRY) {
  console.log(`acib-v3 DRY RUN — every check passed; NOTHING written. Would freeze: eval ${record.eval.sha256.slice(0, 12)}… (${record.eval.count}), dev ${record.dev.sha256.slice(0, 12)}… (${record.dev.count}), grader ${record.scorer.sha256.slice(0, 12)}…, analysis spec ${record.analysisSpec.sha256.slice(0, 12)}…; reviewer ${record.reviewer.name}`);
  process.exit(0);
}
writeFileSync(out, `${JSON.stringify(record, null, 1)}\n`);
console.log(`acib-v3 frozen: eval ${record.eval.sha256.slice(0, 12)}… (${record.eval.count}), dev ${record.dev.sha256.slice(0, 12)}… (${record.dev.count}); reviewer ${record.reviewer.name}`);
