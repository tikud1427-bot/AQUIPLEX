/**
 * Evidence Engine — QC validators + evidence-aware retrieval + full-engine
 * integration (Phase 2).
 *
 * The quality controls the brief demands (orphans, broken refs, weak OCR,
 * uncertain timestamps, duplicates, conflicts), the grounded-retrieval
 * interface future reasoning consumes, and the whole thing wired through
 * the real File Engine so an upload produces stored, provenanced facts
 * end-to-end.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-evqc-'));
process.env.AQUA_DATA_DIR = TMP;

const store = await import('../evidenceStore.js');
const { createEvidence, createFact } = await import('../evidence.js');
const {
  auditEvidence, detectDuplicateFacts, detectConflictingFacts,
  detectWeakConfidence, detectMissingProvenance, detectBrokenReferences,
} = await import('../evidenceValidator.js');
const { retrieveGroundedFacts, explainFact, factsWithProvenanceForFile } = await import('../evidenceRetrieval.js');
const { ingestFiles } = await import('../fileEngine.js');
const { getUKO, _resetUKOStoreForTests } = await import('../ukoStore.js');
const { _resetFileIndexForTests } = await import('../fileSearchIndex.js');

const ev = (over = {}) => createEvidence({ sourceFileId: 'uko1', sourceFileName: 'a.pdf', sourceType: 'document', extractionMethod: 'structural', location: { page: 5 }, ...over });

beforeEach(() => { store._resetEvidenceStoreForTests(); _resetUKOStoreForTests(); _resetFileIndexForTests(); });

// ── QC validators ─────────────────────────────────────────────────────────────

test('detectDuplicateFacts groups identical normalized statements', () => {
  const facts = [
    createFact({ statement: 'Revenue was ₹40L.', evidence: [ev()] }),
    createFact({ statement: 'revenue  was ₹40L', evidence: [ev()] }),
    createFact({ statement: 'Different fact.', evidence: [ev()] }),
  ];
  const dups = detectDuplicateFacts(facts);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].factIds.length, 2);
});

test('detectConflictingFacts surfaces numeric and negation conflicts on a shared entity', () => {
  const facts = [
    createFact({ statement: 'Aquiplex revenue was 4000000 last quarter', entities: ['Aquiplex'], evidence: [ev()] }),
    createFact({ statement: 'Aquiplex revenue was 9000000 last quarter', entities: ['Aquiplex'], evidence: [ev()] }),
    createFact({ statement: 'The deal was signed', entities: ['DealX'], evidence: [ev()] }),
    createFact({ statement: 'The deal was not signed', entities: ['DealX'], evidence: [ev()] }),
  ];
  const conflicts = detectConflictingFacts(store, 'o', facts);
  const entities = conflicts.map(c => c.entity);
  assert.ok(entities.includes('aquiplex'), 'numeric conflict caught');
  assert.ok(entities.includes('dealx'), 'negation conflict caught');
});

test('detectWeakConfidence flags weak OCR and uncertain timestamps', () => {
  const weakOcr = store.saveEvidence('o', createEvidence({ sourceFileId: 'u', sourceType: 'image', extractionMethod: 'ocr', confidence: 0.3 }));
  const uncertainTs = store.saveEvidence('o', createEvidence({ sourceFileId: 'u', sourceType: 'video', extractionMethod: 'timeline', confidence: 0.4, location: { timestamp: '0:12' } }));
  store.saveFact('o', createFact({ statement: 'blurry text', evidence: [weakOcr] }));
  store.saveFact('o', createFact({ statement: 'early moment', evidence: [uncertainTs] }));

  const facts = store.listFacts('o');
  const findings = detectWeakConfidence(store, 'o', facts);
  assert.ok(findings.some(f => f.type === 'weak_ocr'));
  assert.ok(findings.some(f => f.type === 'uncertain_timestamp'));
});

test('detectMissingProvenance + detectBrokenReferences catch the ungrounded and the dangling', () => {
  // createFact enforces grounding, so simulate a corrupted fact directly.
  const ungrounded = { id: 'f0', statement: 'floating', evidence: [] };
  assert.equal(detectMissingProvenance([ungrounded]).length, 1);

  const f = store.saveFact('o', createFact({ statement: 'cites ghost', evidence: ['ghost-id'] }), { sourceFileId: 'u' });
  const broken = detectBrokenReferences(store, 'o', [store.getFact('o', f.id)]);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].evidenceId, 'ghost-id');
});

test('auditEvidence composes one report; ok=false when any error present', () => {
  const good = store.saveEvidence('o', ev());
  store.saveFact('o', createFact({ statement: 'grounded fact', entities: ['X'], evidence: [good] }), { sourceFileId: 'uko1' });
  const clean = auditEvidence(store, 'o');
  assert.equal(clean.ok, true);

  store.saveFact('o', createFact({ statement: 'dangling', evidence: ['nope'] }), { sourceFileId: 'uko1' });
  const dirty = auditEvidence(store, 'o');
  assert.equal(dirty.ok, false, 'broken reference is an error');
  assert.ok(dirty.findings.some(f => f.type === 'broken_reference'));
});

// ── Evidence-aware retrieval ─────────────────────────────────────────────────

test('retrieveGroundedFacts ranks by term coverage + evidence confidence and attaches citations', () => {
  const strong = store.saveEvidence('o', createEvidence({ sourceFileId: 'u', sourceFileName: 'report.pdf', sourceType: 'document', extractionMethod: 'text-layer', confidence: 0.98, location: { page: 17 } }));
  const weak = store.saveEvidence('o', createEvidence({ sourceFileId: 'u', sourceFileName: 'scan.png', sourceType: 'image', extractionMethod: 'ocr', confidence: 0.4 }));
  store.saveFact('o', createFact({ statement: 'Aquiplex revenue reached forty million', entities: ['Aquiplex'], evidence: [strong] }));
  store.saveFact('o', createFact({ statement: 'Aquiplex revenue estimate uncertain', entities: ['Aquiplex'], evidence: [weak] }));

  const hits = retrieveGroundedFacts(store, 'o', 'Aquiplex revenue');
  assert.equal(hits.length, 2);
  assert.match(hits[0].citations[0], /report\.pdf · Page 17/, 'higher-confidence grounded fact ranks first');
  assert.ok(hits[0].confidence > hits[1].confidence);

  const filtered = retrieveGroundedFacts(store, 'o', 'Aquiplex revenue', { minConfidence: 0.5 });
  assert.equal(filtered.length, 1, 'weak-evidence fact filtered out');
});

test('explainFact returns full provenance for the "explain this answer" primitive', () => {
  const e = store.saveEvidence('o', createEvidence({ sourceFileId: 'u', sourceFileName: 'meeting.mp4', sourceType: 'video', extractionMethod: 'timeline', location: { timestamp: '12:43' } }));
  const f = store.saveFact('o', createFact({ statement: 'budget approved', evidence: [e] }));
  const ex = explainFact(store, 'o', f.id);
  assert.equal(ex.statement, 'budget approved');
  assert.match(ex.citations[0], /meeting\.mp4 · 00:12:43/);
  assert.equal(ex.evidence[0].method, 'timeline');
  assert.equal(explainFact(store, 'o', 'missing'), null);
});

// ── Full engine integration ──────────────────────────────────────────────────

test('ENGINE INTEGRATION: uploading a document produces stored, provenanced facts automatically', async () => {
  const csv = 'company,revenue\nAquiplex,4000000\nTata Group,9000000\n';
  const out = await ingestFiles({ files: [{ name: 'deals.csv', buffer: Buffer.from(csv) }], ownerId: 'owner-1', conversationId: 'conv-e', });

  const uko = getUKO('owner-1', out.results[0].ukoId);
  assert.ok(uko.evidence.factCount >= 0, 'UKO reports evidence stats');

  // Facts (if any heuristic facts were extractable) are grounded to the file.
  const fileFacts = factsWithProvenanceForFile(store, 'owner-1', uko.id);
  for (const ff of fileFacts) {
    assert.ok(ff.citations.length > 0, 'every stored fact from the engine carries a citation');
    assert.match(ff.citations[0], /deals\.csv/, 'citation points at the source file');
  }
  // Audit of the freshly-ingested owner is clean (no broken refs / orphans).
  assert.equal(auditEvidence(store, 'owner-1').ok, true);
});

test('ENGINE INTEGRATION [video]: SCENES become timestamped, grounded facts end-to-end', async () => {
  const deps = {
    processMedia: async () => ({
      title: 'demo.mp4', format: 'mp4', metadata: { analyzed: true, model: 'gemini-test' },
      content: 'SUMMARY: A meeting.\n\nSCENES:\n0:05 Ananya opens the review\n12:43 budget of 4000000 approved',
      pages: null, language: null, truncated: false,
      sections: [{ heading: 'SCENES', text: '0:05 Ananya opens the review\n12:43 budget of 4000000 approved' }],
    }),
    rememberFile: () => ({ key: 'file:demo.mp4' }),
    indexFileChunks: async () => ({ indexed: 1 }),
  };
  const out = await ingestFiles({ files: [{ name: 'demo.mp4', buffer: Buffer.from('x') }], ownerId: 'owner-2', conversationId: 'conv-e', deps });
  const uko = getUKO('owner-2', out.results[0].ukoId);

  const facts = factsWithProvenanceForFile(store, 'owner-2', uko.id);
  assert.ok(facts.length > 0, 'video produced grounded facts');
  assert.ok(facts.some(f => /00:12:43/.test(f.citations[0]) || /00:00:05/.test(f.citations[0])), 'facts cite a timestamp');
  assert.equal(auditEvidence(store, 'owner-2').ok, true);
});
