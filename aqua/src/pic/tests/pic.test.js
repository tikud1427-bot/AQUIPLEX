/**
 * Persistent Intelligence Core — Regression Suite (Phase 4)
 *
 * Run: node --test src/pic/tests/pic.test.js   (aqua/ package)
 *
 * Covers the brief's success criteria over the REAL stores (evidence, UKO,
 * graph) with only the fact/evidence set seeded directly — same discipline
 * as the Phase-3 e2e:
 *
 *   lifecycle          state machine legality, touches, ingest derivation
 *   versioning         revision kinds, bounds, confidence trajectory
 *   reasoning feedback outcomes → per-fact boost, smoothing, band, window
 *   consolidation      dup merge (archive-not-delete), dispute caps,
 *                      corroboration, stale, promotion, IDEMPOTENCE
 *   retrieval          knowledge-first composition: lexical ∪ entity ∪
 *                      graph-connected ∪ timeline; lifecycle filtering;
 *                      feedback re-ranking; budget; retrieved touches
 *   health             every brief check + maintenance before/after
 *   facade             ingest sync, fail-open, kill switch, metrics
 *   scale              hundreds of facts — consolidation + retrieval stay
 *                      fast and bounded
 *   e2e                seed corpus → graph → PIC sync → retrieve → feedback
 *                      → consolidate → promote: one connected core
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-pic-'));
process.env.AQUA_DATA_DIR = TMP;

const ES = await import('../../files/evidenceStore.js');
const US = await import('../../files/ukoStore.js');
const G  = await import('../../reasoning/reasoningGraph.js');
const { rebuildOwnerGraph } = await import('../../reasoning/graphBuilder.js');
const { createEvidence, createFact } = await import('../../files/evidence.js');
const { createUKO } = await import('../../files/uko.js');

const LC   = await import('../knowledgeLifecycle.js');
const VS   = await import('../versionStore.js');
const FB   = await import('../reasoningFeedback.js');
const CE   = await import('../consolidationEngine.js');
const RI   = await import('../retrievalIntelligence.js');
const KH   = await import('../knowledgeHealth.js');
const PI   = await import('../projectIntelligence.js');
const PIC  = await import('../core.js');
const STORE = await import('../picStore.js');

const OWNER = 'user:pic-test';

const DEPS = {
  evidenceStore: ES, ukoStore: US, graph: G,
  queryEngine: await import('../../reasoning/queryEngine.js'),
  evidenceRetrieval: await import('../../files/evidenceRetrieval.js'),
  formatCitation: (await import('../../files/evidence.js')).formatCitation,
};

// ── Seeding helpers ───────────────────────────────────────────────────────────

const hash = (s) => (s + '0'.repeat(64)).slice(0, 64);

function seedUKO(name, fileType = 'document') {
  const uko = createUKO({
    ownerId: OWNER, conversationId: null,
    sourceFile: { name, ext: path.extname(name), bytes: 1000, hash: hash(name) },
    fileType, mimeType: null,
  });
  uko.processing.stages.push({ stage: 'parse', ok: true, durationMs: 1 });
  uko.processing.stages.push({ stage: 'enrich:facts', ok: true, durationMs: 1 });
  uko.processing.stages.push({ stage: 'enrich:evidence', ok: true, durationMs: 1 });
  US.saveUKO(uko);
  return uko;
}

function seedFact(uko, statement, entities, { confidence = 0.9, snippet = null, page = 1 } = {}) {
  const ev = ES.saveEvidence(OWNER, createEvidence({
    sourceFileId: uko.id, sourceFileName: uko.sourceFile.name,
    sourceType: uko.fileType, parser: 'test', extractionMethod: 'text-layer',
    location: { page }, snippet: snippet ?? statement,
  }));
  const fact = createFact({ statement, entities, evidence: [ev.id], confidence });
  ES.saveFact(OWNER, fact, { sourceFileId: uko.id });
  return { fact, ev };
}

function resetAll() {
  ES._resetEvidenceStoreForTests();
  US._resetUKOStoreForTests();
  G._resetGraphForTests();
  PIC._resetPICForTests();
  delete process.env.AQUA_PIC;
}

// ═══ 1. Knowledge Lifecycle ══════════════════════════════════════════════════

describe('knowledge lifecycle', () => {
  beforeEach(resetAll);

  test('forward transitions (skips included) are legal; regressions are not', () => {
    assert.equal(LC.canTransition('created', 'parsed'), true);
    assert.equal(LC.canTransition('created', 'enriched'), true);     // cache-hit skip
    assert.equal(LC.canTransition('parsed', 'created'), false);      // birth once
    assert.equal(LC.canTransition('reasoned', 'parsed'), false);     // no arbitrary regress
  });

  test('the living loop: retrieved/reasoned/versioned → updated → forward again', () => {
    for (const from of ['retrieved', 'reasoned', 'versioned', 'verified', 'linked']) {
      assert.equal(LC.canTransition(from, 'updated'), true, `${from} → updated`);
    }
    assert.equal(LC.canTransition('updated', 'versioned'), true);
  });

  test('archival is universal and reversible; retirement is terminal and two-step', () => {
    assert.equal(LC.canTransition('enriched', 'archived'), true);
    assert.equal(LC.canTransition('archived', 'updated'), true);     // revival
    assert.equal(LC.canTransition('archived', 'retired'), true);
    assert.equal(LC.canTransition('enriched', 'retired'), false);    // never one-step
    assert.equal(LC.canTransition('retired', 'updated'), false);     // terminal
  });

  test('transition records history; touch bumps counters without new records', () => {
    LC.transition(OWNER, 'fact:f1', 'parsed');
    LC.transition(OWNER, 'fact:f1', 'retrieved');
    const before = LC.getLifecycle(OWNER, 'fact:f1').transitions.length;
    LC.transition(OWNER, 'fact:f1', 'retrieved');   // touch
    const rec = LC.getLifecycle(OWNER, 'fact:f1');
    assert.equal(rec.transitions.length, before);
    assert.equal(rec.meta.retrievals, 2);
    assert.equal(rec.state, 'retrieved');
  });

  test('illegal transitions are refused, never thrown', () => {
    LC.transition(OWNER, 'fact:f2', 'archived');
    LC.transition(OWNER, 'fact:f2', 'retired');
    const out = LC.transition(OWNER, 'fact:f2', 'updated');
    assert.equal(out.ok, false);
    assert.match(out.refused, /retired/);
  });

  test('ingestStatesFor derives the path a UKO actually walked', () => {
    const uko = seedUKO('walk.pdf');
    assert.deepEqual(LC.ingestStatesFor(uko), ['created', 'parsed', 'enriched', 'verified']);
    const bare = createUKO({ ownerId: OWNER, sourceFile: { name: 'x', hash: hash('x') }, fileType: 'document' });
    assert.deepEqual(LC.ingestStatesFor(bare), ['created']);
  });
});

// ═══ 2. Versioning ═══════════════════════════════════════════════════════════

describe('knowledge versioning', () => {
  beforeEach(resetAll);

  test('revisions record kind + compact delta; unknown kinds refused', () => {
    const r = VS.recordRevision(OWNER, 'fact:v1', { kind: 'confidence', before: 0.5, after: 0.7, reason: 'corroborated' });
    assert.equal(r.rev, 1);
    assert.equal(VS.recordRevision(OWNER, 'fact:v1', { kind: 'nope' }), null);
    assert.equal(VS.getHistory(OWNER, 'fact:v1').length, 1);
  });

  test('history is bounded; oldest revisions roll off, rev numbers keep climbing', () => {
    for (let i = 0; i < 30; i++) {
      VS.recordRevision(OWNER, 'fact:v2', { kind: 'confidence', before: i, after: i + 1 });
    }
    const hist = VS.getHistory(OWNER, 'fact:v2');
    assert.equal(hist.length, STORE.MAX_REVISIONS_PER_SUBJ);
    assert.equal(hist[hist.length - 1].rev, 30);
  });

  test('confidence trajectory filters + shapes', () => {
    VS.recordRevision(OWNER, 'fact:v3', { kind: 'confidence', before: 0.5, after: 0.8, reason: 'x' });
    VS.recordRevision(OWNER, 'fact:v3', { kind: 'state', before: {}, after: {} });
    const traj = VS.confidenceTrajectory(OWNER, 'fact:v3');
    assert.equal(traj.length, 1);
    assert.deepEqual([traj[0].from, traj[0].to], [0.5, 0.8]);
  });
});

// ═══ 3. Reasoning Feedback ═══════════════════════════════════════════════════

describe('reasoning feedback', () => {
  beforeEach(resetAll);

  test('outcomes fold into per-fact signals; boost stays in band', () => {
    for (let i = 0; i < 5; i++) FB.recordReasoningSession(OWNER, { outcome: 'verified', usedFacts: ['fA'] });
    const good = FB.reasoningBoost(OWNER, 'fA');
    assert.ok(good > 0 && good <= FB._feedbackBand.BOOST_MAX);

    for (let i = 0; i < 5; i++) FB.recordReasoningSession(OWNER, { outcome: 'corrected', usedFacts: ['fB'] });
    const bad = FB.reasoningBoost(OWNER, 'fB');
    assert.ok(bad < 0 && bad >= FB._feedbackBand.BOOST_MIN);
  });

  test('smoothing: one review never dominates', () => {
    FB.recordReasoningSession(OWNER, { outcome: 'failed', usedFacts: ['fC'] });
    assert.ok(Math.abs(FB.reasoningBoost(OWNER, 'fC')) < 0.05);
  });

  test('unknown outcomes refused; unknown facts neutral', () => {
    assert.equal(FB.recordReasoningSession(OWNER, { outcome: 'meh', usedFacts: ['x'] }), null);
    assert.equal(FB.reasoningBoost(OWNER, 'never-seen'), 0);
  });

  test('stats aggregate by outcome', () => {
    FB.recordReasoningSession(OWNER, { outcome: 'verified', usedFacts: ['f1'] });
    FB.recordReasoningSession(OWNER, { outcome: 'unsupported', usedFacts: ['f1'] });
    const s = FB.feedbackStats(OWNER);
    assert.equal(s.sessions, 2);
    assert.deepEqual(s.byOutcome, { verified: 1, unsupported: 1 });
  });
});

// ═══ 4. Consolidation ════════════════════════════════════════════════════════

describe('consolidation engine', () => {
  beforeEach(resetAll);

  test('duplicate facts merge: survivor absorbs evidence, dupes archived (never deleted), versioned both sides', () => {
    const a = seedUKO('report.pdf');
    const b = seedUKO('deck.pptx', 'document');
    const { fact: f1 } = seedFact(a, 'Acme raised $10M in funding', ['Acme'], { confidence: 0.95, page: 2 });
    const { fact: f2 } = seedFact(b, 'Acme raised $10M in funding.', ['Acme'], { confidence: 0.7, page: 5 });

    const report = CE.consolidateOwner(DEPS, OWNER);
    assert.equal(report.duplicatesMerged, 1);

    const survivor = ES.getFact(OWNER, f1.id);
    const dupe     = ES.getFact(OWNER, f2.id);
    assert.equal(dupe.archived, true);
    assert.equal(dupe.supersededBy, f1.id);
    assert.equal(survivor.evidence.length, 2);                        // union
    assert.ok(ES.getFact(OWNER, f2.id));                              // never destroyed
    assert.equal(LC.getLifecycle(OWNER, `fact:${f2.id}`).state, 'archived');
    assert.ok(VS.getHistory(OWNER, `fact:${f2.id}`).some(r => r.kind === 'fact_supersession'));
    assert.ok(VS.getHistory(OWNER, `fact:${f1.id}`).some(r => r.after?.absorbed === f2.id));
  });

  test('idempotent: a second pass over consolidated knowledge is a no-op', () => {
    const a = seedUKO('r1.pdf'), b = seedUKO('r2.pdf');
    seedFact(a, 'The contract was signed', ['Contract']);
    seedFact(b, 'the contract was signed', ['Contract']);
    CE.consolidateOwner(DEPS, OWNER);
    const second = CE.consolidateOwner(DEPS, OWNER);
    assert.equal(second.duplicatesMerged, 0);
    assert.equal(second.confidenceAdjusted, 0);
  });

  test('corroboration across files raises confidence asymptotically + records trajectory', () => {
    const a = seedUKO('inv.pdf'), b = seedUKO('mail.eml');
    const { fact, ev } = seedFact(a, 'Payment of $10M was recorded to Acme', ['Acme'], { confidence: 0.6 });
    const ev2 = ES.saveEvidence(OWNER, createEvidence({
      sourceFileId: b.id, sourceFileName: b.sourceFile.name, sourceType: 'document',
      extractionMethod: 'text-layer', snippet: 'payment recorded', location: { page: 1 },
    }));
    ES.updateFact(OWNER, fact.id, { evidence: [ev.id, ev2.id] });

    CE.consolidateOwner(DEPS, OWNER);
    const after = ES.getFact(OWNER, fact.id);
    assert.ok(after.confidence > 0.6);
    assert.ok(after.confidence <= CE.CONF_CEIL);
    assert.equal(VS.confidenceTrajectory(OWNER, `fact:${fact.id}`).length, 1);
  });

  test('disputed facts (contradicts edge) are flagged and confidence-capped', () => {
    const a = seedUKO('a.pdf'), b = seedUKO('b.pdf');
    const { fact: fa } = seedFact(a, 'Acme Corporation raised $10M in Series A funding', ['Acme Corporation'], { confidence: 0.95 });
    const { fact: fb } = seedFact(b, 'Acme Corporation raised $99M in Series A funding', ['Acme Corporation'], { confidence: 0.95 });
    rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, OWNER);
    assert.ok(G.edgesOf(OWNER, `fact:${fa.id}`, { type: 'contradicts' }).length, 'precondition: contradiction detected');

    CE.consolidateOwner(DEPS, OWNER);
    for (const id of [fa.id, fb.id]) {
      const f = ES.getFact(OWNER, id);
      assert.equal(f.disputed, true);
      assert.ok(f.confidence <= CE.CONF_DISPUTE_CAP);
    }
  });

  test('stale detection keys on lifecycle touch; retrieval restores freshness', () => {
    const a = seedUKO('old.pdf');
    const { fact } = seedFact(a, 'Ancient unique statement kappa', ['Kappa']);
    const future = Date.now() + CE.STALE_MS + 1000;
    CE.consolidateOwner(DEPS, OWNER, { now: future });
    assert.equal(ES.getFact(OWNER, fact.id).stale, true);

    LC.transition(OWNER, `fact:${fact.id}`, 'retrieved');   // touched again — lastAt is now
    CE.consolidateOwner(DEPS, OWNER, { now: Date.now() + 1000 });
    assert.equal(ES.getFact(OWNER, fact.id).stale, false);
  });

  test('promotion: multi-evidence + repeatedly retrieved + undisputed ⇒ trusted + verified', () => {
    const a = seedUKO('t1.pdf'), b = seedUKO('t2.pdf');
    const { fact, ev } = seedFact(a, 'Zeta shipped version 2.0', ['Zeta'], { confidence: 0.8 });
    const ev2 = ES.saveEvidence(OWNER, createEvidence({
      sourceFileId: b.id, sourceType: 'document', extractionMethod: 'text-layer',
      snippet: 'v2 shipped', location: { page: 3 },
    }));
    ES.updateFact(OWNER, fact.id, { evidence: [ev.id, ev2.id] });
    LC.transition(OWNER, `fact:${fact.id}`, 'retrieved');
    LC.transition(OWNER, `fact:${fact.id}`, 'retrieved');

    const report = CE.consolidateOwner(DEPS, OWNER);
    assert.equal(report.promoted, 1);
    const f = ES.getFact(OWNER, fact.id);
    assert.equal(f.trusted, true);
    assert.equal(LC.getLifecycle(OWNER, `fact:${fact.id}`).state, 'verified');
  });
});

// ═══ 5. Retrieval Intelligence ═══════════════════════════════════════════════

describe('retrieval intelligence', () => {
  beforeEach(resetAll);

  function corpus() {
    const report  = seedUKO('report.pdf');
    const meeting = seedUKO('meeting.mp4', 'video');
    const invoice = seedUKO('invoice.pdf');
    seedFact(report,  'OpenAI raised $10M in funding on 2026-01-15', ['OpenAI'], { confidence: 0.95 });
    seedFact(meeting, 'Open AI discussed the acquisition deal with Samko', ['Open AI', 'Samko'], { confidence: 0.75 });
    seedFact(invoice, 'Payment of $10M to OpenAI Inc. was recorded on 2026-01-25', ['OpenAI Inc.'], { confidence: 0.9 });
    rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, OWNER);
    return { report, meeting, invoice };
  }

  test('knowledge-first: facts carry provenance; entity lane resolves aliases to one canonical', () => {
    corpus();
    const out = RI.retrieveKnowledge(DEPS, OWNER, 'what happened with the OpenAI funding?');
    const facts = out.items.filter(i => i.kind === 'fact');
    assert.ok(facts.length >= 1);
    assert.ok(facts.every(f => f.citations.length >= 1), 'every fact cited');
    const entity = out.items.find(i => i.kind === 'entity');
    assert.ok(entity, 'entity lane fired');
    assert.ok(entity.files.length >= 2, 'canonical entity spans files');
    assert.ok(out.block.includes('CONNECTED KNOWLEDGE'));
  });

  test('graph lane surfaces connected facts the lexical lane missed', () => {
    corpus();
    // "acquisition" appears only in the meeting fact; querying OpenAI-only
    // terms still surfaces it through the entity's `about` edges.
    const out = RI.retrieveKnowledge(DEPS, OWNER, 'tell me about OpenAI');
    const viaGraph = out.items.filter(i => i.kind === 'fact' && String(i.via).startsWith('graph:'));
    assert.ok(viaGraph.length >= 1, `expected graph-connected facts, got via=${out.items.map(i => i.via)}`);
  });

  test('archived/superseded excluded; disputed downweighted below clean facts', () => {
    const a = seedUKO('a.pdf'), b = seedUKO('b.pdf');
    const { fact: dup1 } = seedFact(a, 'Beta metric is 42 units', ['Beta'], { confidence: 0.9 });
    seedFact(b, 'beta metric is 42 units', ['Beta'], { confidence: 0.5 });
    const { fact: disp } = seedFact(a, 'Beta valuation is 7 crore', ['Beta'], { confidence: 0.9 });
    const { fact: clean } = seedFact(b, 'Beta headquarters opened in Pune', ['Beta'], { confidence: 0.9 });
    rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, OWNER);
    ES.updateFact(OWNER, disp.id, { disputed: true });
    CE.consolidateOwner(DEPS, OWNER);   // merges the dup pair

    const out = RI.retrieveKnowledge(DEPS, OWNER, 'Beta metric valuation headquarters units crore Pune');
    const ids = out.items.filter(i => i.kind === 'fact').map(i => i.id);
    assert.ok(ids.includes(dup1.id));
    assert.equal(ids.filter(id => !ES.getFact(OWNER, id) || ES.getFact(OWNER, id).archived).length, 0, 'no archived facts served');
    const scoreOf = (id) => out.items.find(i => i.id === id)?.score ?? -1;
    assert.ok(scoreOf(clean.id) > scoreOf(disp.id), 'disputed ranks below clean');
    const dispItem = out.items.find(i => i.id === disp.id);
    if (dispItem) assert.equal(dispItem.disputed, true);
  });

  test('reasoning feedback re-ranks: repeatedly-corrected fact falls behind', () => {
    const a = seedUKO('x.pdf'), b = seedUKO('y.pdf');
    const { fact: fGood } = seedFact(a, 'Gamma launched the rocket program', ['Gamma'], { confidence: 0.8 });
    const { fact: fBad }  = seedFact(b, 'Gamma launched the rocket initiative', ['Gamma'], { confidence: 0.8 });
    for (let i = 0; i < 6; i++) FB.recordReasoningSession(OWNER, { outcome: 'corrected', usedFacts: [fBad.id] });
    for (let i = 0; i < 6; i++) FB.recordReasoningSession(OWNER, { outcome: 'verified',  usedFacts: [fGood.id] });

    const out = RI.retrieveKnowledge(DEPS, OWNER, 'Gamma rocket launched');
    const ids = out.items.filter(i => i.kind === 'fact').map(i => i.id);
    assert.ok(ids.indexOf(fGood.id) < ids.indexOf(fBad.id), 'verified fact outranks corrected fact');
    assert.ok(out.stats.reusedSignals >= 2);
  });

  test('temporal cue activates the timeline lane', () => {
    corpus();
    const out = RI.retrieveKnowledge(DEPS, OWNER, 'what happened first in the OpenAI timeline?');
    assert.ok(out.items.some(i => i.kind === 'event'));
    assert.ok(out.block.includes('Timeline'));
  });

  test('block respects the char budget hard cap', () => {
    corpus();
    const out = RI.retrieveKnowledge(DEPS, OWNER, 'OpenAI funding payment deal', { charBudget: 200 });
    assert.ok(out.block.length <= 200);
  });

  test('served facts get a retrieved lifecycle touch', () => {
    corpus();
    const out = RI.retrieveKnowledge(DEPS, OWNER, 'OpenAI funding');
    const first = out.items.find(i => i.kind === 'fact');
    const lc = LC.getLifecycle(OWNER, `fact:${first.id}`);
    assert.equal(lc.state, 'retrieved');
    assert.ok(lc.meta.retrievals >= 1);
  });

  test('empty query / unknown owner ⇒ empty, never throws', () => {
    assert.deepEqual(RI.retrieveKnowledge(DEPS, OWNER, '').items, []);
    assert.deepEqual(RI.retrieveKnowledge(DEPS, 'user:ghost', 'anything').items, []);
  });
});

// ═══ 6. Knowledge Health + Maintenance ═══════════════════════════════════════

describe('knowledge health', () => {
  beforeEach(resetAll);

  test('clean corpus reports healthy/attention; every brief check present', () => {
    const a = seedUKO('h1.pdf'), b = seedUKO('h2.pdf');
    seedFact(a, 'Delta opened an office', ['Delta']);
    seedFact(b, 'Delta hired 12 people', ['Delta']);
    rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, OWNER);
    const r = KH.healthReport(DEPS, OWNER);
    for (const k of ['duplicateEntityCandidates', 'brokenEvidence', 'orphanedKnowledge',
      'missingRelationships', 'staleKnowledge', 'conflictingFacts', 'lowConfidence',
      'unusedEmbeddings', 'invalidReferences', 'status']) {
      assert.ok(k in r, `missing check: ${k}`);
    }
    assert.equal(r.brokenEvidence.count, 0);
    assert.ok(['healthy', 'attention'].includes(r.status));
  });

  test('broken evidence + orphan facts detected ⇒ degraded', () => {
    const a = seedUKO('broken.pdf');
    const { fact } = seedFact(a, 'Epsilon signed the deal', ['Epsilon']);
    ES.updateFact(OWNER, fact.id, { evidence: ['ev-that-does-not-exist'] });
    const orphan = createFact({ statement: 'Orphan claim with no evidence', entities: ['Zed'], evidence: [] });
    ES.saveFact(OWNER, orphan, { sourceFileId: a.id });

    const r = KH.healthReport(DEPS, OWNER);
    assert.ok(r.brokenEvidence.count >= 1);
    assert.ok(r.orphanedKnowledge.factsWithoutEvidence >= 1);
    assert.equal(r.status, 'degraded');
  });

  test('duplicate-entity candidates + open contradictions counted', () => {
    const a = seedUKO('c1.pdf'), b = seedUKO('c2.pdf');
    seedFact(a, 'Acme Corporation raised $10M in Series A funding', ['Acme Corporation'], { confidence: 0.9 });
    seedFact(b, 'Acme Holdings raised $99M in Series A funding', ['Acme Holdings'], { confidence: 0.9 });
    rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, OWNER);
    const r = KH.healthReport(DEPS, OWNER);
    assert.ok(r.conflictingFacts + r.duplicateEntityCandidates >= 1);
  });

  test('runMaintenance: consolidates, re-measures, ledgers', () => {
    const a = seedUKO('m1.pdf'), b = seedUKO('m2.pdf');
    seedFact(a, 'Theta completed the merger', ['Theta']);
    seedFact(b, 'theta completed the merger', ['Theta']);
    const out = KH.runMaintenance(DEPS, OWNER);
    assert.equal(out.consolidation.duplicatesMerged, 1);
    assert.ok(out.before && out.after);
    assert.ok(out.ledger.some(e => e.op === 'maintenance'));
  });
});

// ═══ 7. Project Intelligence ═════════════════════════════════════════════════

describe('project intelligence', () => {
  beforeEach(resetAll);

  test('one call, one organized knowledge space', () => {
    seedFact(seedUKO('doc.pdf'), 'Sigma signed the contract on 2026-02-01', ['Sigma']);
    seedFact(seedUKO('clip.mp4', 'video'), 'Sigma discussed the roadmap', ['Sigma']);
    rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, OWNER);
    const p = PI.projectIntelligence(DEPS, OWNER);
    assert.deepEqual(p.artifactCounts, { document: 1, video: 1 });
    assert.ok(p.knowledge.facts >= 2);
    assert.ok(p.knowledge.keyEntities.some(e => e.entity.toLowerCase().includes('sigma')));
    assert.ok('lifecycle' in p && 'versions' in p && 'reasoning' in p);
  });
});

// ═══ 8. Facade (core.js) ═════════════════════════════════════════════════════

describe('PIC facade', () => {
  beforeEach(resetAll);

  test('onKnowledgeIngested: lifecycle for objects + facts, entity-merge revisions, ledger, metrics', () => {
    const a = seedUKO('f1.pdf'), b = seedUKO('f2.pdf');
    const { fact } = seedFact(a, 'OpenAI raised $10M', ['OpenAI']);
    seedFact(b, 'Open AI confirmed the raise', ['Open AI']);
    const built = rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, OWNER);

    const out = PIC.onKnowledgeIngested({
      ownerId: OWNER, ukoIds: [a.id, b.id],
      entities: built.entities, contradictions: built.contradictions,
    });
    assert.equal(out.ok, true);
    assert.equal(PIC.getLifecycle(OWNER, `uko:${a.id}`).state, 'linked');
    assert.equal(PIC.getLifecycle(OWNER, `fact:${fact.id}`).state, 'linked');
    const merged = built.entities.find(e => e.aliases.length);
    assert.ok(merged, 'precondition: resolver merged OpenAI/Open AI');
    assert.ok(PIC.getHistory(OWNER, merged.id).some(r => r.kind === 'entity_merge'));
    assert.ok(PIC.getLedger(OWNER).some(e => e.op === 'ingest'));
    assert.equal(PIC.getPICMetrics().ingests, 1);
  });

  test('fail-open: bad input and kill switch never throw', () => {
    assert.equal(PIC.onKnowledgeIngested({}).ok, false);
    assert.deepEqual(PIC.retrieveKnowledge(null, 'x').items, []);
    process.env.AQUA_PIC = 'off';
    assert.equal(PIC.onKnowledgeIngested({ ownerId: OWNER, ukoIds: ['u'] }).skipped, true);
    assert.deepEqual(PIC.retrieveKnowledge(OWNER, 'query').items, []);
    assert.equal(PIC.recordReasoningOutcome(OWNER, { outcome: 'verified' }), null);
    assert.equal(PIC.getPICMetrics().enabled, false);
  });

  test('recordReasoningOutcome transitions used facts to reasoned', () => {
    const a = seedUKO('rr.pdf');
    const { fact } = seedFact(a, 'Lambda deployed the service', ['Lambda']);
    PIC.onKnowledgeIngested({ ownerId: OWNER, ukoIds: [a.id] });
    const entry = PIC.recordReasoningOutcome(OWNER, { outcome: 'verified', usedFacts: [fact.id], query: 'q' });
    assert.equal(entry.outcome, 'verified');
    assert.equal(PIC.getLifecycle(OWNER, `fact:${fact.id}`).state, 'reasoned');
    assert.ok(PIC.reasoningBoost(OWNER, fact.id) > 0);
  });

  test('retrieveKnowledge facade wraps the composer + metrics', () => {
    const a = seedUKO('rk.pdf');
    seedFact(a, 'Omicron acquired the startup', ['Omicron']);
    rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, OWNER);
    const out = PIC.retrieveKnowledge(OWNER, 'Omicron acquired');
    assert.ok(out.items.length >= 1);
    assert.ok(PIC.getPICMetrics().retrievalsNonEmpty >= 1);
  });
});

// ═══ 9. Scale + incremental behavior ═════════════════════════════════════════

describe('scale', () => {
  beforeEach(resetAll);

  test('500 facts: consolidation + retrieval stay fast; stores stay bounded', () => {
    const ukos = Array.from({ length: 10 }, (_, i) => seedUKO(`bulk-${i}.pdf`));
    for (let i = 0; i < 500; i++) {
      const u = ukos[i % ukos.length];
      seedFact(u, `Company${i % 40} completed milestone ${i} of the program`, [`Company${i % 40}`], { confidence: 0.6 + (i % 4) / 10 });
    }
    rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, OWNER);

    let t = Date.now();
    const report = CE.consolidateOwner(DEPS, OWNER);
    const consolidateMs = Date.now() - t;
    assert.equal(report.factsScanned, 500);
    assert.ok(consolidateMs < 5000, `consolidation took ${consolidateMs}ms`);

    t = Date.now();
    const out = RI.retrieveKnowledge(DEPS, OWNER, 'Company7 milestone program');
    const retrieveMs = Date.now() - t;
    assert.ok(out.items.length >= 1);
    assert.ok(retrieveMs < 2000, `retrieval took ${retrieveMs}ms`);

    PIC.onKnowledgeIngested({ ownerId: OWNER, ukoIds: ukos.map(u => u.id) });
    const stats = STORE.getPicStoreStats();
    assert.ok(stats.subjects <= STORE.MAX_SUBJECTS_PER_OWNER);
  });
});

// ═══ 10. End-to-end: one connected core ══════════════════════════════════════

describe('e2e — the unified core', () => {
  beforeEach(resetAll);

  test('ingest → graph → PIC sync → knowledge retrieval → feedback → consolidation → promotion', () => {
    // The deal corpus, heterogeneous artifact kinds.
    const report  = seedUKO('report.pdf');
    const meeting = seedUKO('meeting.mp4', 'video');
    const invoice = seedUKO('invoice.pdf');
    const { fact: raise } = seedFact(report,  'OpenAI raised $10M in funding on 2026-01-15', ['OpenAI'], { confidence: 0.9 });
    seedFact(meeting, 'Open AI and Samko discussed the deal terms', ['Open AI', 'Samko'], { confidence: 0.75 });
    seedFact(invoice, 'Payment of $10M to OpenAI Inc. recorded 2026-01-25', ['OpenAI Inc.'], { confidence: 0.9 });

    // 1. Graph + PIC sync (what fileEngine does per batch).
    const built = rebuildOwnerGraph({ evidenceStore: ES, ukoStore: US }, OWNER);
    const sync = PIC.onKnowledgeIngested({
      ownerId: OWNER, ukoIds: [report.id, meeting.id, invoice.id],
      entities: built.entities, contradictions: built.contradictions,
    });
    assert.equal(sync.ok, true);

    // 2. Knowledge-first retrieval: one call, connected knowledge with provenance.
    const k1 = PIC.retrieveKnowledge(OWNER, 'what do we know about the OpenAI deal and payment?');
    assert.ok(k1.items.filter(i => i.kind === 'fact').length >= 2, 'facts across files');
    assert.ok(k1.items.some(i => i.kind === 'entity' && i.files.length >= 2), 'one canonical entity across files');
    assert.ok(k1.block.length > 0);

    // 3. Verification verdict trains retrieval.
    PIC.recordReasoningOutcome(OWNER, {
      outcome: 'verified', query: 'deal',
      usedFacts: k1.items.filter(i => i.kind === 'fact').map(i => i.id),
    });
    assert.ok(PIC.reasoningBoost(OWNER, raise.id) > 0);

    // 4. Retrieval touched lifecycles; consolidation promotes the corroborated,
    //    repeatedly-used raise fact once it carries multi-file evidence.
    const ev2 = ES.saveEvidence(OWNER, createEvidence({
      sourceFileId: invoice.id, sourceType: 'document', extractionMethod: 'text-layer',
      snippet: 'raise confirmed', location: { page: 2 },
    }));
    ES.updateFact(OWNER, raise.id, { evidence: [...ES.getFact(OWNER, raise.id).evidence, ev2.id] });
    PIC.retrieveKnowledge(OWNER, 'OpenAI funding raised');
    const consolidation = PIC.maintain(OWNER).consolidation;
    assert.ok(consolidation.promoted >= 1, 'promotion path fired');
    assert.equal(ES.getFact(OWNER, raise.id).trusted, true);

    // 5. History never destroyed: full trajectory queryable.
    assert.ok(PIC.getHistory(OWNER, `fact:${raise.id}`).length >= 1);
    assert.equal(PIC.getHealth(OWNER).status !== undefined, true);
  });
});
