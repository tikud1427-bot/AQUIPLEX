/**
 * File Intelligence V1 — UKO schema + Parser Registry tests.
 *
 * Pins the two foundational contracts: every parser output satisfies one
 * schema (validateUKO is the gate the engine enforces), and the registry —
 * not any switch statement — owns parser selection: registration shape,
 * priority, health degradation/recovery, capability routing, batch claims.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createUKO, recordStage, finalizeUKO, validateUKO, UKO_SCHEMA_VERSION } from '../uko.js';
import {
  registerParser, unregisterParser, resolveParser, claimBatch, getParser,
  recordParserOutcome, isParserHealthy, listParsers, listParsersByCapability,
  _resetRegistryForTests,
} from '../parserRegistry.js';

const SRC = { name: 'a.txt', ext: '.txt', bytes: 3, hash: 'f'.repeat(64) };

// ── UKO ───────────────────────────────────────────────────────────────────────

test('createUKO births a complete shell — every consumer field exists from day one', () => {
  const uko = createUKO({ ownerId: 'u1', conversationId: 'c1', sourceFile: SRC, fileType: 'source', mimeType: 'text/plain' });
  assert.equal(uko.schemaVersion, UKO_SCHEMA_VERSION);
  assert.equal(uko.owner, 'u1');
  for (const f of ['entities', 'topics', 'keywords', 'timeline', 'relationships', 'facts', 'reasoningHints']) {
    assert.deepEqual(uko[f], [], `${f} present + empty`);
  }
  assert.equal(uko.rawContent, '');
  assert.deepEqual(uko.processing.stages, []);
  assert.equal(validateUKO(uko).valid, true);
});

test('createUKO refuses a sourceFile without name/hash (cache identity is mandatory)', () => {
  assert.throws(() => createUKO({ sourceFile: { name: 'x' }, fileType: 'source' }), /hash/);
});

test('recordStage captures duration + outcome for sync, async, and throwing stages', async () => {
  const uko = createUKO({ sourceFile: SRC, fileType: 'source' });
  await recordStage(uko, 'sync',  () => 1);
  await recordStage(uko, 'async', async () => 2);
  await assert.rejects(() => recordStage(uko, 'boom', () => { throw new Error('nope'); }), /nope/);

  assert.equal(uko.processing.stages.length, 3);
  assert.deepEqual(uko.processing.stages.map(s => s.ok), [true, true, false]);
  assert.equal(uko.processing.stages[2].error, 'nope');
  assert.deepEqual(uko.processing.errors, ['boom: nope']);
  assert.ok(uko.processing.stages.every(s => typeof s.durationMs === 'number'));

  finalizeUKO(uko);
  assert.ok(uko.processing.durationMs >= 0);
  assert.ok(uko.processing.completedAt >= uko.processing.startedAt);
});

test('validateUKO reports every structural violation, never throws', () => {
  const broken = createUKO({ sourceFile: SRC, fileType: 'source' });
  broken.entities = 'nope';
  broken.rawContent = 42;
  const { valid, problems } = validateUKO(broken);
  assert.equal(valid, false);
  assert.ok(problems.some(p => p.includes('entities')));
  assert.ok(problems.some(p => p.includes('rawContent')));
  assert.deepEqual(validateUKO(null), { valid: false, problems: ['uko must be an object'] });
});

// ── Registry ──────────────────────────────────────────────────────────────────

const parserStub = (over = {}) => ({
  id: 'stub', version: '1.0.0', kinds: ['stub'], extensions: ['.stub'],
  mimeTypes: [], capabilities: ['TextExtraction'], priority: 50,
  parse: async () => ({ title: 'x', format: 'stub', metadata: {}, content: 'x', sections: [], pages: null, language: null, truncated: false }),
  ...over,
});

beforeEach(() => _resetRegistryForTests());

test('registration validates shape: duplicate ids, missing parse, unknown capabilities all rejected', () => {
  registerParser(parserStub());
  assert.throws(() => registerParser(parserStub()),                              /duplicate id/);
  assert.throws(() => registerParser(parserStub({ id: 'b', parse: undefined })), /parse\(\) required/);
  assert.throws(() => registerParser(parserStub({ id: 'c', capabilities: ['Teleportation'] })), /unknown capabilities/);
  assert.throws(() => registerParser(parserStub({ id: 'd', kinds: [] })),        /kinds\[\] required/);
});

test('resolveParser matches by kind, falls back to extension/mime, returns null for strangers', () => {
  registerParser(parserStub({ id: 'byKind', kinds: ['doc'] }));
  registerParser(parserStub({ id: 'byExt', kinds: ['other'], extensions: ['.eml'] }));
  registerParser(parserStub({ id: 'byMime', kinds: ['other2'], mimeTypes: ['x/y'] }));

  assert.equal(resolveParser({ name: 'a', classification: { kind: 'doc' } }).id, 'byKind');
  assert.equal(resolveParser({ name: 'a.eml', classification: { kind: 'unknown', ext: '.eml' } }).id, 'byExt');
  assert.equal(resolveParser({ name: 'a', classification: { kind: 'unknown', mime: 'x/y' } }).id, 'byMime');
  assert.equal(resolveParser({ name: 'a', classification: { kind: 'nope', ext: '.nope' } }), null);
});

test('priority wins among healthy candidates; canParse veto is honored and exception-safe', () => {
  registerParser(parserStub({ id: 'low',  kinds: ['doc'], priority: 10 }));
  registerParser(parserStub({ id: 'high', kinds: ['doc'], priority: 90 }));
  registerParser(parserStub({ id: 'veto', kinds: ['doc'], priority: 99, canParse: () => false }));
  registerParser(parserStub({ id: 'boom', kinds: ['doc'], priority: 99, canParse: () => { throw new Error('x'); } }));
  assert.equal(resolveParser({ name: 'a', classification: { kind: 'doc' } }).id, 'high');
});

test('health: 3 consecutive failures degrade a parser (healthy alternative wins), one success recovers it', () => {
  registerParser(parserStub({ id: 'flaky',  kinds: ['doc'], priority: 90 }));
  registerParser(parserStub({ id: 'backup', kinds: ['doc'], priority: 10 }));

  for (let i = 0; i < 3; i++) recordParserOutcome('flaky', false, 'crash');
  assert.equal(isParserHealthy('flaky'), false);
  assert.equal(resolveParser({ name: 'a', classification: { kind: 'doc' } }).id, 'backup',
    'unhealthy high-priority parser must lose to a healthy low-priority one');

  recordParserOutcome('flaky', true);
  assert.equal(isParserHealthy('flaky'), true);
  assert.equal(resolveParser({ name: 'a', classification: { kind: 'doc' } }).id, 'flaky', 'recovery restores priority order');
});

test('capability routing lists parsers by capability — the future orchestrator interface', () => {
  registerParser(parserStub({ id: 'ocr1', capabilities: ['OCR', 'Vision'] }));
  registerParser(parserStub({ id: 'ocr2', kinds: ['k2'], capabilities: ['OCR'] }));
  registerParser(parserStub({ id: 'ear',  kinds: ['k3'], capabilities: ['SpeechRecognition'] }));
  assert.deepEqual(listParsersByCapability('OCR').sort(), ['ocr1', 'ocr2']);
  assert.deepEqual(listParsersByCapability('SpeechRecognition'), ['ear']);
  assert.deepEqual(listParsersByCapability('KnowledgeGraphSupport'), []);
});

test('claimBatch: first (highest-priority, healthy) consumesBatch parser with a non-null claim wins', () => {
  registerParser(parserStub({
    id: 'batcher', consumesBatch: true, priority: 80,
    claimBatch: (classified) => classified.some(c => c.cls.kind === 'special')
      ? { claimed: classified.filter(c => c.cls.kind === 'special').map(c => c.name), reason: 'special' }
      : null,
  }));
  registerParser(parserStub({ id: 'plain', kinds: ['x'] }));

  const claim = claimBatch([
    { name: 'a', cls: { kind: 'special' } },
    { name: 'b', cls: { kind: 'other' } },
  ]);
  assert.equal(claim.parser.id, 'batcher');
  assert.deepEqual([...claim.claimed], ['a']);
  assert.equal(claimBatch([{ name: 'b', cls: { kind: 'other' } }]), null);
});

test('listParsers exposes the full matrix with live health', () => {
  registerParser(parserStub());
  recordParserOutcome('stub', false, 'x');
  const [row] = listParsers();
  assert.equal(row.id, 'stub');
  assert.equal(row.healthy, true);
  assert.equal(row.health.failed, 1);
  unregisterParser('stub');
  assert.equal(getParser('stub'), null);
});
