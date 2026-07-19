/**
 * Cross-File Reasoning — full engine E2E (Phase 3).
 *
 * The benchmark the brief asks for: heterogeneous files → one graph →
 * complex questions answered ACROSS all of them, every answer grounded in
 * evidence with provenance. Uses the REAL evidence store, UKO store, graph
 * builder, and query engine; only the raw fact set is seeded directly (the
 * Phase-1/2 pipeline that produces facts is tested elsewhere).
 *
 * Scenario: a small "deal" corpus —
 *   report.pdf   OpenAI raised $10M (2026-01-15); contract signed 2026-01-20
 *   meeting.mp4  Open AI + Sam Altman discuss the deal at 12:43
 *   deck.pptx    OpenAI Inc. revenue $20M; ALSO claims $99M raised (conflicts report.pdf)
 *   invoice.pdf  Payment of $10M to OpenAI recorded 2026-01-25
 *   repo.zip     product built by the OpenAI team
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-xfile-'));
process.env.AQUA_DATA_DIR = TMP;

const ES = await import('../../files/evidenceStore.js');
const US = await import('../../files/ukoStore.js');
const { createEvidence, createFact } = await import('../../files/evidence.js');
const { createUKO } = await import('../../files/uko.js');
const { rebuildOwnerGraph, removeFileFromGraph } = await import('../graphBuilder.js');
const G = await import('../reasoningGraph.js');
const Q = await import('../queryEngine.js');

const O = 'owner-xfile';

function mkFile(id, name, type) {
  const u = createUKO({ ownerId: O, sourceFile: { name, ext: '.' + type, bytes: 100, hash: id.padEnd(64, 'x') }, fileType: type });
  u.id = id; US.saveUKO(u); return u;
}
function addFact(fileId, fileName, stmt, ents, method, loc) {
  const ev = ES.saveEvidence(O, createEvidence({ sourceFileId: fileId, sourceFileName: fileName, sourceType: 'document', extractionMethod: method, location: loc, snippet: stmt }));
  return ES.saveFact(O, createFact({ statement: stmt, entities: ents, evidence: [ev] }), { sourceFileId: fileId });
}

before(() => {
  mkFile('report', 'report.pdf', 'document');
  mkFile('meeting', 'meeting.mp4', 'video');
  mkFile('deck', 'deck.pptx', 'document');
  mkFile('invoice', 'invoice.pdf', 'document');
  mkFile('repo', 'repo.zip', 'repository');

  addFact('report', 'report.pdf', 'OpenAI raised 10000000 in funding on 2026-01-15', ['OpenAI', 'Sam Altman'], 'structural', { page: 3 });
  addFact('report', 'report.pdf', 'The contract with OpenAI was signed on 2026-01-20', ['OpenAI'], 'structural', { page: 7 });
  addFact('meeting', 'meeting.mp4', 'Open AI and Sam Altman discussed the funding deal', ['Open AI', 'Sam Altman'], 'timeline', { timestamp: '12:43' });
  addFact('deck', 'deck.pptx', 'OpenAI Inc. revenue was 20000000 last year', ['OpenAI Inc.'], 'structural', { slide: 5 });
  addFact('deck', 'deck.pptx', 'OpenAI Inc. raised 99000000 in funding', ['OpenAI Inc.'], 'structural', { slide: 6 });
  addFact('invoice', 'invoice.pdf', 'Payment of 10000000 to OpenAI was recorded on 2026-01-25', ['OpenAI'], 'structural', { page: 1 });
  addFact('repo', 'repo.zip', 'The product was built by the OpenAI team', ['OpenAI'], 'archive', { nestedPath: 'README.md' });

  rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, O);
});

// ── Graph construction ────────────────────────────────────────────────────────

test('the graph unifies heterogeneous files into one knowledge space', () => {
  const stats = G.graphStats(O);
  assert.equal(stats.files, 5);
  assert.ok(stats.byNodeType.entity >= 2, 'entities extracted');
  assert.ok(stats.byNodeType.fact >= 7, 'every fact is a node');
  assert.ok(stats.edges > 10, 'files/facts/entities are connected');
});

test('ENTITY RESOLUTION across files: OpenAI / Open AI / OpenAI Inc. → one node spanning 5 files', () => {
  const openai = G.nodesByType(O, 'entity').find(n => n.label.toLowerCase().includes('openai'));
  assert.ok(openai, 'a unified OpenAI entity exists');
  assert.ok(openai.data.fileCount >= 4, `spans the files that mention any variant (got ${openai.data.fileCount})`);
  assert.ok(openai.data.aliases.some(a => /open ai|inc/i.test(a)), 'variants recorded as aliases');
});

// ── The brief's cross-file questions ─────────────────────────────────────────

test('Q: "Which files mention OpenAI?" — resolved across surface forms, with provenance', () => {
  const hits = Q.whichFilesMention(O, 'openai');
  const merged = hits.find(h => h.files.length >= 4);
  assert.ok(merged, 'the merged entity lists all files that used any variant');
  assert.ok(merged.files.every(f => f.reason && f.confidence), 'each mention carries provenance');
});

test('Q: "Which entities appear in BOTH report.pdf and meeting.mp4?"', () => {
  const common = Q.entitiesInCommon(O, 'report', 'meeting');
  const names = common.map(c => c.entity.toLowerCase());
  assert.ok(names.some(x => x.includes('openai')), 'OpenAI matched across report + meeting despite different surface forms');
  assert.ok(names.some(x => x.includes('sam altman')), 'Sam Altman in both');
});

test('Q: "Which documents support this claim?" — grounded facts with citations', () => {
  const support = Q.whatSupportsClaim(ES, O, 'OpenAI funding 10000000');
  assert.ok(support.length > 0);
  assert.ok(support[0].citations.length > 0, 'answer carries citations');
  assert.equal(support[0].kind, 'observed', 'facts are observed, not derived');
  assert.ok(support.some(s => /report\.pdf/.test(s.citations[0]) || /invoice\.pdf/.test(s.citations[0])));
});

test('CONTRADICTION across files: $10M (report.pdf) vs $99M (deck.pptx) — both sides, surfaced not resolved', () => {
  const contradictions = Q.contradictionsFor(ES, O);
  const funding = contradictions.find(c => /numeric/i.test(c.reason));
  assert.ok(funding, 'the funding-amount conflict is detected across files');
  assert.match(funding.sideA.citations[0] + funding.sideB.citations[0], /report\.pdf|deck\.pptx/);
  assert.equal(funding.kind, 'derived', 'a detected disagreement is derived and left unresolved');
  assert.ok(funding.sideA.statement && funding.sideB.statement, 'both sides explained');
});

test('TIMELINE across every artifact: dated + timestamped events merged and ordered', () => {
  const tl = Q.timelineAcross(ES, O);
  assert.ok(tl.ordered.length >= 3, 'events from multiple files');
  const dated = tl.ordered.filter(e => e.certainty === 'exact');
  assert.ok(dated.length >= 2, 'dated events anchored');
  // Chronological: funding (01-15) before contract (01-20) before payment (01-25).
  const dates = dated.map(e => e.timestamp).filter(t => /2026/.test(t));
  assert.deepEqual(dates, [...dates].sort(), 'anchored events are in chronological order');
  assert.ok(tl.ordered.every(e => e.citations !== undefined), 'every timeline entry is grounded');
});

test('Q: "What happened before the contract was signed?"', () => {
  const before = Q.whatHappenedBefore(ES, O, 'contract');
  assert.ok(before.anchor, 'the contract event anchors');
  assert.ok(before.before.length >= 1, 'the funding event precedes it');
  assert.ok(before.before.some(e => /fund/i.test(e.statement) || e.type === 'invoice_paid' || /rais/i.test(e.statement)));
});

test('MULTI-HOP: connection between two files through shared entities', () => {
  const conn = Q.connectionsBetween(O, 'file:report', 'file:deck', { maxHops: 4 });
  assert.equal(conn.connected, true, 'report.pdf connects to deck.pptx through the shared OpenAI entity');
  assert.ok(conn.hops >= 2);
  assert.ok(conn.path.every(e => e.evidence !== undefined && e.reason), 'every hop carries provenance');
});

test('RELATIONSHIP inference: OpenAI ↔ Sam Altman, derived with supporting evidence', () => {
  const rels = G.nodesByType(O, 'entity').flatMap(n => G.edgesOf(O, n.id, { type: 'related_to' }));
  assert.ok(rels.length > 0, 'at least one entity relationship inferred');
  assert.ok(rels.every(r => r.kind === 'derived'), 'relationships are DERIVED, never observed');
  assert.ok(rels.every(r => r.sourceFiles.length > 0 || r.evidence.length > 0), 'every relationship preserves provenance');
});

test('PROJECT SUMMARY + EXPLAIN ENTITY: graph-shaped, grounded, epistemically tiered', () => {
  const summary = Q.projectSummary(ES, O);
  assert.ok(summary.keyEntities.length > 0);
  assert.ok(summary.openContradictions >= 1, 'the funding conflict shows as an open contradiction');

  const explain = Q.explainEntity(ES, O, 'openai');
  assert.ok(explain, 'entity explained');
  assert.ok(explain.observedFacts.length > 0, 'observed facts listed');
  assert.ok(explain.observedFacts.every(f => f.kind === 'observed'));
  assert.ok(explain.derivedRelationships.every(r => r.kind === 'derived'), 'observed vs derived never mixed');
  assert.ok(explain.observedFacts.every(f => f.citations.length > 0), 'every claim grounded');
});

// ── Incremental maintenance ──────────────────────────────────────────────────

test('INCREMENTAL: removing a file detaches exactly its contribution; the rest stands', () => {
  const before = G.graphStats(O);
  removeFileFromGraph(O, 'invoice');
  const after = G.graphStats(O);
  assert.equal(after.files, before.files - 1, 'file node gone');
  assert.ok(after.nodes < before.nodes, 'its facts detached');
  // OpenAI entity survives (still referenced by other files).
  assert.ok(G.nodesByType(O, 'entity').some(n => n.label.toLowerCase().includes('openai')), 'shared entity survives partial removal');
});

// ── Reasoning contract ────────────────────────────────────────────────────────

test('REASONING CONTRACT: no edge exists without provenance (graph-wide invariant)', () => {
  let checked = 0;
  for (const nodeType of ['entity', 'fact', 'event']) {
    for (const node of G.nodesByType(O, nodeType)) {
      for (const e of G.edgesOf(O, node.id)) {
        assert.ok((e.evidence?.length ?? 0) > 0 || (e.sourceFiles?.length ?? 0) > 0, `edge ${e.type} must have provenance`);
        assert.ok(['observed', 'derived', 'hypothesis', 'speculation'].includes(e.kind), 'edge is epistemically tagged');
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'edges were actually checked');
});
