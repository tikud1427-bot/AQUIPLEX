/**
 * Research Intelligence + Causal Query — File Intelligence 2.0.
 *
 * Three-"paper" corpus:
 *   paperA.pdf  Zinc improves recovery time by 30 percent  (finding)
 *               Dosage may reduce side effects              (hypothesis, hedged)
 *               The trial with Medix was approved on 2026-02-01
 *   paperB.pdf  Zinc improves recovery time by 30 percent  (agrees with A)
 *               Medix raised 5000000 in funding on 2026-01-10
 *   paperC.pdf  Zinc improves recovery time by 12 percent  (numeric conflict)
 *               The product launched on 2026-03-05 following the Medix funding
 * Consensus = the 30% claim (A+B). Contested = 30 vs 12. Cause of the
 * launch = the funding (shared entity + "following" cue + precedes it).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-research-'));
process.env.AQUA_DATA_DIR = TMP;

const ES = await import('../../files/evidenceStore.js');
const US = await import('../../files/ukoStore.js');
const { createEvidence, createFact } = await import('../../files/evidence.js');
const { createUKO } = await import('../../files/uko.js');
const { rebuildOwnerGraph } = await import('../graphBuilder.js');
const R = await import('../researchEngine.js');
const Q = await import('../queryEngine.js');

const O = 'owner-research';
const deps = { evidenceStore: ES, ukoStore: US, queryEngine: Q };

function mkFile(id, name) {
  const u = createUKO({ ownerId: O, sourceFile: { name, ext: '.pdf', bytes: 100, hash: id.padEnd(64, 'x') }, fileType: 'document' });
  u.id = id; u.topics = [{ topic: 'Zinc trial', weight: 1 }]; US.saveUKO(u); return u;
}
function addFact(fileId, fileName, stmt, ents, loc) {
  const ev = ES.saveEvidence(O, createEvidence({ sourceFileId: fileId, sourceFileName: fileName, sourceType: 'document', extractionMethod: 'structural', location: loc, snippet: stmt }));
  return ES.saveFact(O, createFact({ statement: stmt, entities: ents, evidence: [ev] }), { sourceFileId: fileId });
}

before(() => {
  mkFile('pa', 'paperA.pdf');
  mkFile('pb', 'paperB.pdf');
  mkFile('pc', 'paperC.pdf');
  mkFile('px', 'notes.pdf');   // zero facts → unmined

  addFact('pa', 'paperA.pdf', 'Zinc improves recovery time by 30 percent', ['Zinc'], { page: 2 });
  addFact('pa', 'paperA.pdf', 'Dosage may reduce side effects in patients', ['Zinc'], { page: 3 });
  addFact('pa', 'paperA.pdf', 'The trial with Medix was approved on 2026-02-01', ['Medix', 'Zinc'], { page: 5 });
  addFact('pb', 'paperB.pdf', 'Zinc improves recovery time by 30 percent', ['Zinc'], { page: 1 });
  addFact('pb', 'paperB.pdf', 'Medix raised 5000000 in funding on 2026-01-10', ['Medix'], { page: 4 });
  addFact('pc', 'paperC.pdf', 'Zinc improves recovery time by 12 percent', ['Zinc'], { page: 2 });
  addFact('pc', 'paperC.pdf', 'The product launched on 2026-03-05 following the Medix funding round', ['Medix'], { page: 6 });

  rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, O);
});

test('consensusReport: corroborated vs contested vs single-source, cited', () => {
  const r = R.consensusReport(deps, O);
  const contested = r.contested.map(x => x.statement).join(' ');
  assert.ok(/30 percent|12 percent/.test(contested), 'conflicting zinc claims land in contested');
  const single = r.singleSource.map(x => x.statement).join(' ');
  assert.ok(single.includes('funding'), 'one-file claims are single-source');
  assert.ok([...r.consensus, ...r.contested, ...r.singleSource].every(x => x.citations.length), 'every row cited');
  assert.equal(r.totals.claims, r.totals.consensus + r.totals.contested + r.totals.singleSource);
});

test('compareFiles: shared entities, agreement, disagreement, uniques — dual-cited', () => {
  const c = R.compareFiles(deps, O, 'pa', 'pb');
  assert.ok(c.sharedEntities.some(e => e.entity.toLowerCase().includes('zinc')));
  assert.equal(c.agreements.length, 1);
  assert.ok(c.agreements[0].citations['paperA.pdf'][0].includes('Page 2'));
  assert.ok(c.agreements[0].citations['paperB.pdf'][0].includes('Page 1'));
  const c2 = R.compareFiles(deps, O, 'pa', 'pc');
  assert.ok(c2.disagreements.length >= 1, 'numeric conflict surfaces as disagreement');
  assert.ok(c2.uniqueToA.length >= 1 && c2.uniqueToB.length >= 1);
  assert.equal(R.compareFiles(deps, O, 'pa', 'missing'), null);
});

test('hypothesisCandidates: hedged vs asserted split', () => {
  const h = R.hypothesisCandidates(deps, O);
  assert.ok(h.hypotheses.some(x => x.statement.includes('may reduce')), 'hedged claim → hypothesis');
  assert.ok(h.findings.some(x => x.statement.includes('improves recovery')), 'asserted claim → finding');
  assert.ok(h.hypotheses[0].hedged);
});

test('researchGaps: unmined files, open disputes, anchoring ratio', () => {
  const g = R.researchGaps(deps, O);
  assert.ok(g.unminedFiles.some(f => f.file === 'notes.pdf'));
  assert.ok(g.openDisputes.length >= 1);
  assert.ok(g.timelineAnchoring.anchored >= 1);
  assert.equal(g.kind, 'derived');
});

test('literatureOverview: one cited row per file with claim + conflict counts', () => {
  const rows = R.literatureOverview(deps, O);
  const pc = rows.find(r => r.file === 'paperC.pdf');
  assert.equal(pc.claims, 2);
  assert.ok(pc.contestedClaims >= 1);
  assert.ok(pc.keyEntities.length >= 1);
  assert.ok(rows.find(r => r.file === 'notes.pdf').claims === 0);
});

test('whatCausedThis: funding ranked as cause of the launch (shared entity + cue + precedence)', () => {
  const c = Q.whatCausedThis(ES, O, 'product launched');
  assert.ok(c.effect.statement.includes('launched'));
  assert.ok(c.causes.length >= 1);
  assert.ok(c.causes[0].event.includes('funding'), 'funding is top cause');
  assert.ok(c.causes[0].cueMatch, '"following the Medix funding" cue matched');
  assert.ok(c.causes[0].citations.length >= 1);
  assert.equal(c.kind, 'derived');
  assert.ok(Q.whatCausedThis(ES, O, 'nonexistent effect').note);
});
