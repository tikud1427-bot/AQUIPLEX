/**
 * Evidence Engine — Evidence + Fact schema tests (Phase 2).
 *
 * The trust layer's core contracts: universal Evidence locators across
 * every modality, the fact-must-be-grounded invariant, citation
 * formatting (the Citation Engine's canonical text form), confidence that
 * is never invented, and checksum-based identity that powers sharing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEvidence, createFact, validateEvidence, validateFact,
  formatCitation, formatTimestamp, evidenceChecksum, defaultConfidenceFor,
  normalizeStatement, EXTRACTION_METHODS,
} from '../evidence.js';

// ── Evidence ──────────────────────────────────────────────────────────────────

test('createEvidence births a universal locator: every location field present, method confidence prior applied', () => {
  const ev = createEvidence({ sourceFileId: 'uko1', sourceType: 'document', extractionMethod: 'structural', location: { page: 17, table: 3 } });
  assert.equal(ev.location.page, 17);
  assert.equal(ev.location.table, 3);
  assert.equal(ev.location.timestamp, null, 'unused fields default null, not undefined');
  assert.equal(ev.confidence, defaultConfidenceFor('structural'));
  assert.ok(ev.checksum.length >= 16);
  assert.equal(validateEvidence(ev).valid, true);
});

test('createEvidence rejects unknown method and missing source', () => {
  assert.throws(() => createEvidence({ sourceFileId: 'x', sourceType: 'doc', extractionMethod: 'telepathy' }), /unknown extractionMethod/);
  assert.throws(() => createEvidence({ sourceType: 'doc', extractionMethod: 'ocr' }), /sourceFileId required/);
});

test('confidence is clamped and never invented (explicit overrides prior)', () => {
  assert.equal(createEvidence({ sourceFileId: 'x', sourceType: 'image', extractionMethod: 'ocr', confidence: 1.7 }).confidence, 1);
  assert.equal(createEvidence({ sourceFileId: 'x', sourceType: 'image', extractionMethod: 'ocr', confidence: -3 }).confidence, 0);
  assert.equal(createEvidence({ sourceFileId: 'x', sourceType: 'image', extractionMethod: 'ocr', confidence: 0.42 }).confidence, 0.42);
});

test('every extraction method has a confidence prior', () => {
  for (const m of EXTRACTION_METHODS) assert.equal(typeof defaultConfidenceFor(m), 'number');
});

// ── Citation Engine ───────────────────────────────────────────────────────────

test('formatCitation renders the canonical forms from the brief', () => {
  const pdf = createEvidence({ sourceFileId: 'u', sourceFileName: 'Financial_Report.pdf', sourceType: 'document', extractionMethod: 'structural', location: { page: 17, table: 3, cell: 'Row 8' } });
  assert.equal(formatCitation(pdf), 'Financial_Report.pdf · Page 17 · Table 3 · Cell Row 8');

  const vid = createEvidence({ sourceFileId: 'u', sourceFileName: 'meeting.mp4', sourceType: 'video', extractionMethod: 'timeline', location: { timestamp: '12:43' } });
  assert.equal(formatCitation(vid), 'meeting.mp4 · 00:12:43');

  const code = createEvidence({ sourceFileId: 'u', sourceFileName: 'router.js', sourceType: 'source', extractionMethod: 'code', location: { lineRange: [42, 67] } });
  assert.equal(formatCitation(code), 'router.js · L42–L67');

  const nested = createEvidence({ sourceFileId: 'u', sourceFileName: 'repo.zip', sourceType: 'repository', extractionMethod: 'archive', location: { nestedPath: 'src/app.js', lineRange: [5, 5] } });
  assert.equal(formatCitation(nested), 'repo.zip · src/app.js · L5');
});

test('formatTimestamp handles seconds and colon strings', () => {
  assert.equal(formatTimestamp(763), '00:12:43');
  assert.equal(formatTimestamp('12:43'), '00:12:43');
  assert.equal(formatTimestamp('1:02:03'), '01:02:03');
});

// ── Checksum / dedup identity ─────────────────────────────────────────────────

test('checksum is stable for identical locators and differs for different ones (sharing basis)', () => {
  const a = createEvidence({ sourceFileId: 'u', sourceType: 'document', extractionMethod: 'structural', location: { page: 5 }, snippet: 'revenue rose' });
  const b = createEvidence({ sourceFileId: 'u', sourceType: 'document', extractionMethod: 'structural', location: { page: 5 }, snippet: 'revenue rose' });
  const c = createEvidence({ sourceFileId: 'u', sourceType: 'document', extractionMethod: 'structural', location: { page: 6 }, snippet: 'revenue rose' });
  assert.equal(a.checksum, b.checksum, 'same source+method+location+snippet → same identity');
  assert.notEqual(a.checksum, c.checksum, 'different page → different identity');
});

// ── Fact ──────────────────────────────────────────────────────────────────────

test('createFact grounds a statement in evidence; confidence defaults to best evidence', () => {
  const e1 = createEvidence({ sourceFileId: 'u', sourceType: 'document', extractionMethod: 'ocr', confidence: 0.6 });
  const e2 = createEvidence({ sourceFileId: 'u', sourceType: 'document', extractionMethod: 'structural', confidence: 0.95 });
  const fact = createFact({ statement: 'Revenue was ₹40,00,000.', entities: ['Aquiplex'], evidence: [e1, e2] });
  assert.deepEqual(fact.evidence, [e1.id, e2.id], 'fact stores evidence IDs, not copies');
  assert.equal(fact.confidence, 0.95, 'best support wins — never fabricated');
  assert.equal(fact.normalizedRepresentation, 'revenue was ₹40,00,000');
  assert.equal(validateFact(fact).valid, true);
});

test('THE CARDINAL INVARIANT: a fact with no evidence fails validation', () => {
  const fact = createFact({ statement: 'Unsupported claim.', evidence: [] });
  const { valid, problems } = validateFact(fact);
  assert.equal(valid, false);
  assert.ok(problems.some(p => p.includes('no evidence')), 'every fact must be grounded');
});

test('normalizeStatement collapses whitespace + strips terminal punctuation', () => {
  assert.equal(normalizeStatement('The  Deal   closed.'), 'the deal closed');
  assert.equal(normalizeStatement('Paid ₹40L!!!'), 'paid ₹40l');
});
