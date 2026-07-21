/**
 * Forensic Engine — File Intelligence 2.0.
 *
 * Corpus with deliberate integrity problems, mixed media:
 *   report_v1 / report_v2   same name, different hash  → revised_document
 *   copyA / copyB           different names, SAME hash → duplicate_content
 *   scan.pdf                document with OCR evidence → scanned_document
 *   deck vs invoice         same sentence, numbers differ → edited_number
 *   future fact             dated 2031 → future_dated_content
 *   bundle.zip              evidence 3 levels deep → deep_nesting
 * Plus the FI-2 typed-entity patterns (phone/ip/hash/legal/chemical/…).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-forensic-'));
process.env.AQUA_DATA_DIR = TMP;

const ES = await import('../evidenceStore.js');
const US = await import('../ukoStore.js');
const { createEvidence, createFact } = await import('../evidence.js');
const { createUKO } = await import('../uko.js');
const { forensicReport, fileForensics } = await import('../forensicEngine.js');
const { extractEntities } = await import('../extractors.js');

const O = 'owner-forensic';
const NOW = Date.parse('2026-07-21T00:00:00Z');

function mkFile(id, name, type, { hash = null, createdAt = NOW - 1000 } = {}) {
  const u = createUKO({ ownerId: O, sourceFile: { name, ext: path.extname(name), bytes: 100, hash: (hash ?? id).padEnd(64, 'x') }, fileType: type });
  u.id = id; u.createdAt = createdAt; US.saveUKO(u); return u;
}
function addFact(fileId, fileName, stmt, ents, method, loc, conf = null) {
  const ev = ES.saveEvidence(O, createEvidence({ sourceFileId: fileId, sourceFileName: fileName, sourceType: 'document', extractionMethod: method, location: loc, snippet: stmt, confidence: conf }));
  return ES.saveFact(O, createFact({ statement: stmt, entities: ents, evidence: [ev] }), { sourceFileId: fileId });
}

const deps = { ukoStore: US, evidenceStore: ES };
let report;

before(() => {
  mkFile('r1', 'report.pdf', 'document', { hash: 'hash-old', createdAt: NOW - 5000 });
  mkFile('r2', 'report.pdf', 'document', { hash: 'hash-new', createdAt: NOW - 1000 });
  mkFile('ca', 'copyA.pdf', 'document', { hash: 'same-bytes' });
  mkFile('cb', 'copyB.pdf', 'document', { hash: 'same-bytes' });
  mkFile('scan', 'scan.pdf', 'document');
  mkFile('deck', 'deck.pptx', 'document');
  mkFile('inv', 'invoice.pdf', 'document');
  mkFile('zip', 'bundle.zip', 'repository');

  addFact('scan', 'scan.pdf', 'Total due for Vantor amounts to 4500 rupees', ['Vantor'], 'ocr', { page: 1 });
  addFact('deck', 'deck.pptx', 'Vantor Systems reported revenue of 20000000 for the year', ['Vantor Systems'], 'structural', { slide: 4 });
  addFact('inv',  'invoice.pdf', 'Vantor Systems reported revenue of 35000000 for the year', ['Vantor Systems'], 'structural', { page: 2 });
  addFact('r2',   'report.pdf', 'The audit of Vantor concluded on 2031-04-01', ['Vantor'], 'structural', { page: 9 });
  addFact('zip',  'bundle.zip', 'Backup ledger stored for Vantor Systems archive', ['Vantor Systems'], 'archive', { nestedPath: 'inner/deep/ledger.csv' });

  report = forensicReport(deps, O, { now: NOW });
});

const find = (type) => report.findings.filter(f => f.type === type);

test('revised_document: same name, different hash, versions ordered', () => {
  const [f] = find('revised_document');
  assert.ok(f, 'revision detected');
  assert.equal(f.versions.length, 2);
  assert.ok(f.versions[0].at < f.versions[1].at, 'chronological');
});

test('duplicate_content: same hash under two names', () => {
  const [f] = find('duplicate_content');
  assert.ok(f);
  assert.deepEqual([...f.files].sort(), ['copyA.pdf', 'copyB.pdf']);
});

test('scanned_document: OCR-method evidence on a document', () => {
  const [f] = find('scanned_document');
  assert.ok(f);
  assert.equal(f.files[0], 'scan.pdf');
});

test('edited_number: same sentence, different numbers, different files — cited both sides', () => {
  const [f] = find('edited_number');
  assert.ok(f, 'doctored-figure signature detected');
  assert.equal(f.severity, 'alert');
  assert.ok(f.statements.some(s => s.includes('20000000')) && f.statements.some(s => s.includes('35000000')));
  assert.ok(f.citations.flat().some(c => c.includes('Slide 4')));
});

test('future_dated_content: 2031 date flagged with citation', () => {
  const [f] = find('future_dated_content');
  assert.ok(f);
  assert.equal(f.date, '2031-04-01');
  assert.ok(f.citations[0].includes('report.pdf'));
});

test('deep_nesting: evidence ≥2 archive levels down', () => {
  const [f] = find('deep_nesting');
  assert.ok(f);
  assert.ok(f.citation.includes('inner/deep/ledger.csv'));
});

test('report shape: severity-sorted, counted, derived', () => {
  assert.equal(report.kind, 'derived');
  assert.ok(report.counts.total >= 6);
  const ranks = report.findings.map(f => ({ alert: 3, warning: 2, info: 1 }[f.severity]));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), 'alerts first');
});

test('fileForensics: per-file dossier carries hash, methods, dates, own findings', () => {
  const d = fileForensics(deps, O, 'r2', { now: NOW });
  assert.equal(d.file, 'report.pdf');
  assert.ok(d.hash.startsWith('hash-new'));
  assert.equal(d.extractionMethods.structural, 1);
  assert.ok(d.datesFound.includes('2031-04-01'));
  assert.ok(d.findings.some(f => f.type === 'revised_document'));
  assert.equal(fileForensics(deps, O, 'nope'), null);
});

test('FI-2 entity patterns: phone/ip/mac/hash/coordinate/legal/chemical/medical all typed', () => {
  const text = 'Contact +1 (415) 555-0142 from 10.0.0.7 (aa:bb:cc:dd:ee:ff). '
    + 'Checksum 5f4dcc3b5aa765d61d8327deb882cf99 at 12.9716, 77.5946. '
    + 'See Kesavananda v. State and §21(1) plus Section 66 of the Information Technology Act. '
    + 'CAS 64-17-5 and C2H6O compound; ICD diagnosis code J45.909 for the patient.';
  const types = new Set(extractEntities(text).map(e => e.type));
  for (const t of ['phone', 'ip', 'mac', 'hash', 'coordinate', 'legal_cite', 'chemical', 'medical_code']) {
    assert.ok(types.has(t), `type ${t} extracted`);
  }
});
