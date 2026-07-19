/**
 * Evidence Store — Phase 2 sharing/persistence/graph-edge tests.
 *
 * The performance rule (share evidence, avoid duplication) and the Evidence
 * Graph edge interfaces (fact↔evidence↔file) that later reasoning traverses.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-evstore-'));
process.env.AQUA_DATA_DIR = TMP;

const store = await import('../evidenceStore.js');
const { createEvidence, createFact } = await import('../evidence.js');

const ev = (over = {}) => createEvidence({ sourceFileId: 'uko1', sourceFileName: 'a.pdf', sourceType: 'document', extractionMethod: 'structural', location: { page: 5 }, ...over });

beforeEach(() => store._resetEvidenceStoreForTests());

test('SHARING: identical-checksum evidence is stored once; both facts reference the same id', () => {
  const e1 = store.saveEvidence('o', ev({ snippet: 'same' }));
  const e2 = store.saveEvidence('o', ev({ snippet: 'same' }));   // identical locator
  assert.equal(e1.id, e2.id, 'dedup returns the existing object');
  assert.equal(store.getEvidenceStats('o').evidence, 1, 'one evidence record for two saves');

  const f1 = store.saveFact('o', createFact({ statement: 'A', evidence: [e1] }));
  const f2 = store.saveFact('o', createFact({ statement: 'B', evidence: [e2] }));
  assert.deepEqual(store.factsForEvidence('o', e1.id).map(f => f.id).sort(), [f1.id, f2.id].sort(),
    'shared evidence fans out to both facts');
  assert.equal(store.getEvidenceStats('o').sharedEvidence, 1);
});

test('GRAPH EDGES: evidenceForFact / factsForEvidence / evidenceForFile / factsForFile all resolve', () => {
  const e = store.saveEvidence('o', ev());
  const f = store.saveFact('o', createFact({ statement: 'grounded', evidence: [e] }), { sourceFileId: 'uko1' });

  assert.deepEqual(store.evidenceForFact('o', f.id).map(x => x.id), [e.id]);
  assert.deepEqual(store.factsForEvidence('o', e.id).map(x => x.id), [f.id]);
  assert.deepEqual(store.evidenceForFile('o', 'uko1').map(x => x.id), [e.id]);
  assert.deepEqual(store.factsForFile('o', 'uko1').map(x => x.id), [f.id]);
});

test('owner isolation: one owner never sees another owner’s facts or evidence', () => {
  const e = store.saveEvidence('alice', ev());
  store.saveFact('alice', createFact({ statement: 'secret', evidence: [e] }));
  assert.equal(store.getEvidenceStats('bob').facts, 0);
  assert.deepEqual(store.listFacts('bob'), []);
});

test('CASCADE DELETE: removing a file drops its facts + evidence and cleans the ref graph', () => {
  const e = store.saveEvidence('o', ev());
  const f = store.saveFact('o', createFact({ statement: 'x', evidence: [e] }), { sourceFileId: 'uko1' });
  assert.equal(store.getEvidenceStats('o').facts, 1);

  store.removeFile('o', 'uko1');
  assert.equal(store.getFact('o', f.id), null);
  assert.equal(store.getEvidence('o', e.id), null);
  assert.deepEqual(store.factsForEvidence('o', e.id), [], 'no dangling refs');
  assert.equal(store.getEvidenceStats('o').files, 0);
});

test('broken reference is kept on the fact (claim not rewritten) but earns no edge', () => {
  const f = store.saveFact('o', createFact({ statement: 'cites a ghost', evidence: ['nonexistent-id'] }), { sourceFileId: 'uko1' });
  assert.deepEqual(f.evidence, ['nonexistent-id'], 'fact still records what it claimed to cite');
  assert.deepEqual(store.evidenceForFact('o', f.id), [], 'but hydration finds nothing — validator will flag it');
});

test('PERSISTENCE: a fresh import from the same AQUA_DATA_DIR restores facts + evidence + sharing', async () => {
  const e = store.saveEvidence('o', ev());
  store.saveFact('o', createFact({ statement: 'durable', evidence: [e] }), { sourceFileId: 'uko1' });
  await new Promise(r => setTimeout(r, 700)); // let the debounced writer flush

  const fresh = await import(`../evidenceStore.js?fresh=${Date.now()}`);
  assert.equal(fresh.getEvidenceStats('o').facts, 1, 'facts survive reload');
  assert.equal(fresh.evidenceForFile('o', 'uko1').length, 1, 'file edges survive');
});
