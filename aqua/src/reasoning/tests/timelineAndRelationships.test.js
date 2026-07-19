/**
 * Cross-File Reasoning — timeline / relationship / contradiction component
 * tests (Phase 3). Each engine tested in isolation behind a mock store, so
 * failures point at one component (the modularity the brief requires).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEvents, buildTimeline, _eventPatterns } from '../timelineEngine.js';
import { buildRelationships, detectCrossFileContradictions } from '../relationshipEngine.js';

// Minimal evidenceStore mock: facts carry their own evidence inline.
function mockStore(facts) {
  const evById = new Map();
  for (const f of facts) for (const e of f._evidence ?? []) evById.set(e.id, e);
  return {
    listFacts: () => facts,
    evidenceForFact: (_o, fid) => (facts.find(f => f.id === fid)?._evidence ?? []),
    getEvidence: (_o, id) => evById.get(id) ?? null,
    getFact: (_o, fid) => facts.find(f => f.id === fid) ?? null,
  };
}
const fact = (id, statement, entities, evidence) => ({ id, statement, entities, confidence: 0.9, evidence: evidence.map(e => e.id), _evidence: evidence });
const ev = (id, fileId, loc = {}, method = 'structural') => ({ id, sourceFileId: fileId, sourceFileName: `${fileId}.pdf`, extractionMethod: method, location: { timestamp: null, ...loc }, confidence: 0.9, snippet: '' });

// ── Timeline ──────────────────────────────────────────────────────────────────

test('extractEvents recognizes event types from fact statements', () => {
  const facts = [
    fact('f1', 'The contract was signed on 2026-01-20', ['A'], [ev('e1', 'doc', {})]),
    fact('f2', 'Invoice was paid in full', ['B'], [ev('e2', 'doc', {})]),
    fact('f3', 'We deployed the service to production', ['C'], [ev('e3', 'doc', {})]),
    fact('f4', 'The sky is blue', ['D'], [ev('e4', 'doc', {})]),  // not an event
  ];
  const events = extractEvents(mockStore(facts), 'o', facts);
  const types = events.map(e => e.type);
  assert.ok(types.includes('contract_signed'));
  assert.ok(types.includes('invoice_paid'));
  assert.ok(types.includes('deployment'));
  assert.equal(events.length, 3, 'the non-event sentence produced no event');
  assert.ok(events.every(e => e.evidence.length > 0), 'every event is grounded');
});

test('timestamps: from evidence location AND from statement text; certainty flagged', () => {
  const facts = [
    fact('f1', 'Meeting recorded', ['A'], [ev('e1', 'vid', { timestamp: '12:43' }, 'timeline')]),
    fact('f2', 'The contract was signed on 2026-01-20', ['B'], [ev('e2', 'doc', {})]),
    fact('f3', 'The deal was approved', ['C'], [ev('e3', 'doc', {})]),  // no date → unknown
  ];
  const events = extractEvents(mockStore(facts), 'o', facts);
  const byType = Object.fromEntries(events.map(e => [e.type, e]));
  assert.equal(byType.meeting.certainty, 'exact');
  assert.equal(byType.meeting.timestamp, '00:12:43');
  assert.equal(byType.contract_signed.certainty, 'exact', 'date mined from statement');
  assert.equal(byType.approval.certainty, 'unknown', 'no time → not fabricated');
});

test('buildTimeline orders anchored events chronologically; unanchored tail retains certainty', () => {
  const events = [
    { id: 'a', type: 'x', statement: 'later', timestampSeconds: 200, timestamp: 'B', certainty: 'exact', evidence: ['e'], sourceFiles: ['f'] },
    { id: 'b', type: 'y', statement: 'earlier', timestampSeconds: 100, timestamp: 'A', certainty: 'exact', evidence: ['e'], sourceFiles: ['f'] },
    { id: 'c', type: 'z', statement: 'floating', timestampSeconds: null, certainty: 'unknown', evidence: ['e'], sourceFiles: ['f'] },
  ];
  const tl = buildTimeline(events);
  assert.equal(tl.anchored, 2);
  assert.equal(tl.unanchored, 1);
  assert.deepEqual(tl.ordered.slice(0, 2).map(e => e.statement), ['earlier', 'later'], 'chronological');
  assert.equal(tl.ordered[2].position, 'unordered', 'floating event flagged, not given a fake time');
});

test('event pattern registry is exposed for extension', () => {
  assert.ok(_eventPatterns.includes('contract_signed'));
  assert.ok(_eventPatterns.includes('funding'));
});

// ── Relationships ─────────────────────────────────────────────────────────────

const entity = (id, canonical, aliases = []) => ({ id, canonical, type: 'name', aliases, files: new Set(), mentions: [], confidence: 1 });

test('buildRelationships infers entity↔entity edges from co-occurrence, confidence grows with files', () => {
  const entities = [entity('e:openai', 'OpenAI'), entity('e:sam', 'Sam Altman'), entity('e:other', 'Acme')];
  const facts = [
    fact('f1', 'OpenAI and Sam Altman announced funding', ['OpenAI', 'Sam Altman'], [ev('ev1', 'fileA')]),
    fact('f2', 'Sam Altman leads OpenAI', ['Sam Altman', 'OpenAI'], [ev('ev2', 'fileB')]),  // second file
    fact('f3', 'Acme is unrelated', ['Acme'], [ev('ev3', 'fileC')]),  // singleton → no edge
  ];
  const rels = buildRelationships(entities, facts, mockStore(facts), 'o');
  assert.equal(rels.length, 1, 'one relationship (OpenAI↔Sam); Acme alone yields none');
  const r = rels[0];
  assert.equal(r.kind, 'derived');
  assert.ok(r.confidence > 0.5, 'two co-mentioning files raise confidence above the floor');
  assert.equal(r.supportingFacts.length, 2);
  assert.ok(r.sourceFiles.length >= 2 && r.evidence.length >= 2, 'provenance preserved');
});

test('buildRelationships NEVER invents: no co-occurrence → no relationship', () => {
  const entities = [entity('e:a', 'A'), entity('e:b', 'B')];
  const facts = [fact('f1', 'A did something', ['A'], [ev('e1', 'f')]), fact('f2', 'B did something else', ['B'], [ev('e2', 'f')])];
  assert.deepEqual(buildRelationships(entities, facts, mockStore(facts), 'o'), []);
});

// ── Cross-file contradictions ────────────────────────────────────────────────

test('detectCrossFileContradictions: numeric conflict on one entity across two files', () => {
  const entities = [entity('e:openai', 'OpenAI')];
  const facts = [
    fact('f1', 'OpenAI raised 10000000 in funding', ['OpenAI'], [ev('e1', 'report')]),
    fact('f2', 'OpenAI raised 99000000 in funding', ['OpenAI'], [ev('e2', 'deck')]),
  ];
  const c = detectCrossFileContradictions(entities, facts, mockStore(facts), 'o');
  assert.equal(c.length, 1);
  assert.equal(c[0].type, 'numeric');
  assert.deepEqual(c[0].factIds.sort(), ['f1', 'f2']);
  assert.equal(c[0].sourceFiles.length, 2, 'both sides tracked to their files');
});

test('detectCrossFileContradictions: negation conflict; and SAME-file conflicts are ignored', () => {
  const entities = [entity('e:deal', 'DealX')];
  const crossFile = [
    fact('f1', 'The DealX contract was signed successfully', ['DealX'], [ev('e1', 'fileA')]),
    fact('f2', 'The DealX contract was not signed', ['DealX'], [ev('e2', 'fileB')]),
  ];
  assert.equal(detectCrossFileContradictions(entities, crossFile, mockStore(crossFile), 'o').length, 1, 'negation across files');

  const sameFile = [
    fact('f3', 'DealX revenue was 100', ['DealX'], [ev('e3', 'fileA')]),
    fact('f4', 'DealX revenue was 200', ['DealX'], [ev('e4', 'fileA')]),  // same file
  ];
  assert.equal(detectCrossFileContradictions(entities, sameFile, mockStore(sameFile), 'o').length, 0, 'same-file conflicts are Phase-2 QC, not cross-file');
});

test('contradictions are surfaced, never resolved (both statements retained)', () => {
  const entities = [entity('e:x', 'X')];
  const facts = [
    fact('f1', 'X count was 5 units total', ['X'], [ev('e1', 'a')]),
    fact('f2', 'X count was 9 units total', ['X'], [ev('e2', 'b')]),
  ];
  const [c] = detectCrossFileContradictions(entities, facts, mockStore(facts), 'o');
  assert.equal(c.statements.length, 2);
  assert.ok(c.statements[0] !== c.statements[1], 'both sides kept intact for the user to adjudicate');
});
