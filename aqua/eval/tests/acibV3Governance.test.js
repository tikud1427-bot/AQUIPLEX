/**
 * Sprint 6 — ACIB v3 governance tooling. Synthetic manifests and datasets only:
 * no v3 dataset exists, nothing is frozen, and the freeze file is never written here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateManifest, validateDataset, assertOutsideRepo, PLAN, AUTHOR_DECLARATION, REVIEWER_DECLARATION } from '../governance/acibV3Governance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
const REPO = path.join(AQUA, '..');
// Synthetic names only (no person is appointed); declarations verbatim (2026-11-12 governance).
const GOOD = {
  version: 'acib-3',
  evalAuthors: [{ name: 'Author One', role: 'contractor', declaration: AUTHOR_DECLARATION, declaredAt: '2026-11-12' }, { name: 'Author Two', role: 'contractor', declaration: AUTHOR_DECLARATION, declaredAt: '2026-11-12' }],
  devAuthors: [{ name: 'Dev Author' }],
  implementationAuthors: ['Engine Author'], founder: { name: 'Fixture Founder' }, priorResultsExposed: ['Fixture Founder'],
  reviewer: { name: 'Fixture Reviewer R', signedAt: '2026-11-12', statement: REVIEWER_DECLARATION },
  evalPath: path.join(os.tmpdir(), 'acib.v3.eval.json'), devPath: 'acib.v3.dev.json', successCriteriaConfirmedBy: 'Founder',
  analysisSpecSha256: 'a'.repeat(64),
};

test('a complete, independent manifest passes', () => assert.deepEqual(validateManifest(GOOD), { ok: true, errors: [] }));

test('an eval author who is also an implementation author is refused', () => {
  const r = validateManifest({ ...GOOD, evalAuthors: [{ name: 'Author One' }, { name: 'engine author' }] });
  assert.equal(r.ok, false); assert.match(r.errors.join(), /must not be implementation authors: engine author/);
});
test('one author, a missing sign-off, a self-reviewing implementer, or unconfirmed criteria are refused', () => {
  assert.match(validateManifest({ ...GOOD, evalAuthors: [{ name: 'Solo' }] }).errors.join(), /at least two/);
  assert.match(validateManifest({ ...GOOD, reviewer: { name: 'Fixture Reviewer R' } }).errors.join(), /sign-off required/);
  assert.match(validateManifest({ ...GOOD, reviewer: { ...GOOD.reviewer, name: 'Engine Author' } }).errors.join(), /reviewer must not be an implementation author/);
  assert.match(validateManifest({ ...GOOD, successCriteriaConfirmedBy: undefined }).errors.join(), /successCriteriaConfirmedBy/);
});

test('the evaluation set must live outside the repository', () => {
  assert.throws(() => assertOutsideRepo(path.join(REPO, 'aqua/eval/datasets/acib.v3.eval.json'), REPO), /must not be stored inside/);
  assert.doesNotThrow(() => assertOutsideRepo(path.join(os.tmpdir(), 'x.json'), REPO));
});

test('dataset checks: counts, balance, answerability, reachable annotations, honest paraphrase flags', () => {
  const s = (id, over = {}) => ({ id, category: 'personal', answerability: 'answerable', authors: ['Author One'], question: 'What do I earn?',
    history: [{ text: 'I make 42k a year.' }], needs: [{ id: 'pay', required: true, match: ['42k'], evidence: ['make 42k'], paraphrase: true }], ...over });
  const v = validateDataset({ scenarios: [s('a'), s('a'), s('b', { answerability: 'maybe' }), s('c', { needs: [{ id: 'x', match: ['zzz'], evidence: ['zzz'] }] }), s('d', { question: 'What do I make?' })] }, { role: 'dev' });
  const e = v.errors.join('\n');
  assert.match(e, /dev: 5 scenarios, plan says 62/);
  assert.match(e, /duplicate id a/);
  assert.match(e, /b: answerability/);
  assert.match(e, /c\/x: evidence pattern matches no source text/);
  assert.match(e, /d\/pay: marked paraphrase but shares "make"/);
  assert.match(e, /category semantic-mismatch has 0, plan says 8/);
});

test('the plan is the one documented: 174 eval / 62 dev, including language-mismatch and indirect-reference (D-P2-3)', () => {
  assert.equal(PLAN.evalCount, 174); assert.equal(PLAN.devCount, 62);
  assert.equal(Object.values(PLAN.categories).reduce((a, [e]) => a + e, 0), 174);
  assert.equal(Object.values(PLAN.categories).reduce((a, [, d]) => a + d, 0), 62);
  assert.deepEqual(PLAN.categories['language-mismatch'], [12, 4]); assert.deepEqual(PLAN.categories['indirect-reference'], [12, 4]);
});

test('the freeze CLI refuses (exit 2) without a valid manifest and writes nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acib-v3-gov-'));
  const bad = path.join(tmp, 'manifest.json');
  fs.writeFileSync(bad, JSON.stringify({ ...GOOD, evalAuthors: [{ name: 'Engine Author' }, { name: 'X' }] }));
  const r = spawnSync(process.execPath, [path.join(AQUA, 'scripts/acib-v3-freeze.mjs'), '--manifest', bad], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /REFUSED/);
  assert.equal(fs.existsSync(path.join(AQUA, 'eval/datasets/acib.v3.FREEZE.json')), false);
});
