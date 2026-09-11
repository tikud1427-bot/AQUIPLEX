/**
 * File Intelligence V1 — extractors + enrichment pipeline tests.
 *
 * Extractors: deterministic knowledge from text — the heuristic v1 workers.
 * Pipeline: the architecture claims that matter long-term — stages are
 * REPLACEABLE behind one signature (a fake "LLM" entity stage swaps in
 * without the pipeline knowing), FAIL-OPEN (a throwing stage becomes a
 * warning, never a lost upload), class-filtered (knowledge vs integration),
 * and fully observed (every run lands in processing.stages).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractKeywords, extractEntities, extractTimeline, extractFacts,
  deriveTopics, shortSummary,
} from '../extractors.js';
import {
  runEnrichment, KNOWLEDGE_STAGES, INTEGRATION_STAGES, entityStage,
} from '../enrichmentPipeline.js';
import { createUKO } from '../uko.js';

const SAMPLE = [
  'Aquiplex Platform quarterly review. Aquiplex Platform shipped the artifact engine.',
  'Contact chhanda@aquiplex.com or see https://aquiplex.com/roadmap for details.',
  'The licensee shall pay ₹40,00,000 annually starting 2026-04-01.',
  'Deploy config lives in router.js and billing.js; release v2.3.1 lands May 12, 2026.',
].join('\n');

// ── Extractors ────────────────────────────────────────────────────────────────

test('extractKeywords: frequency-ranked, stopword-free, deterministic', () => {
  const kw = extractKeywords(SAMPLE);
  assert.ok(kw.length > 0);
  assert.ok(kw.some(k => k.term === 'aquiplex'));
  assert.ok(!kw.some(k => ['the', 'and', 'for'].includes(k.term)));
  assert.deepEqual(kw, extractKeywords(SAMPLE), 'same input, same output');
});

test('extractEntities: typed extraction — emails, urls, money, dates, versions, filenames, proper nouns', () => {
  const es = extractEntities(SAMPLE);
  const byType = (t) => es.filter(e => e.type === t).map(e => e.value);
  assert.ok(byType('email').includes('chhanda@aquiplex.com'));
  assert.ok(byType('url')[0].startsWith('https://aquiplex.com'));
  assert.ok(byType('money').some(v => v.includes('40,00,000')));
  assert.ok(byType('date').some(v => v.includes('2026')));
  assert.ok(byType('version').includes('v2.3.1'));
  assert.ok(byType('filename').includes('router.js'));
  assert.ok(byType('name').some(v => v.includes('Aquiplex')), 'repeated proper noun becomes a name entity');
});

test('extractTimeline: SCENES lines + dated sentences, ordered, source-tagged', () => {
  const sections = [{ heading: 'SCENES', text: '0:05 person enters\n0:12 — backpack placed on the table' }];
  const tl = extractTimeline(SAMPLE, sections);
  assert.equal(tl[0].ts, '0:05');
  assert.equal(tl[0].source, 'scenes');
  assert.ok(tl.some(e => e.source === 'dated-sentence' && e.event.includes('₹40,00,000')));
  assert.deepEqual(tl.map(e => e.order), tl.map((_, i) => i), 'orders are sequential');
});

test('extractFacts: sentences joining a named entity with a number — capped, sourced', () => {
  const es = extractEntities(SAMPLE);
  const facts = extractFacts(SAMPLE, es);
  assert.ok(facts.length > 0);
  assert.ok(facts.every(f => /\d/.test(f.text) && f.entities.length > 0 && f.source === 'heuristic'));
});

test('deriveTopics: headings first (analysis-structure headings excluded), keywords fill', () => {
  const topics = deriveTopics(
    [{ heading: 'Payment Terms', text: 'x' }, { heading: 'TRANSCRIPT', text: 'y' }],
    [{ term: 'aquiplex', count: 4 }],
  );
  assert.equal(topics[0].topic, 'Payment Terms');
  assert.ok(!topics.some(t => t.topic === 'TRANSCRIPT'), 'structure headings are not topics');
  assert.ok(topics.some(t => t.topic === 'aquiplex'));
});

test('shortSummary: whitespace-collapsed, hard-capped with ellipsis', () => {
  assert.equal(shortSummary('a  b\n\nc'), 'a b c');
  const long = shortSummary('x'.repeat(500));
  assert.equal(long.length, 240);
  assert.ok(long.endsWith('…'));
  assert.equal(shortSummary(''), '');
});

// ── Enrichment pipeline ───────────────────────────────────────────────────────

function seedUKO() {
  const uko = createUKO({
    ownerId: 'owner-1', conversationId: 'c1',
    sourceFile: { name: 'contract.pdf', ext: '.pdf', bytes: 100, hash: 'a'.repeat(64) },
    fileType: 'document', mimeType: 'application/pdf',
  });
  uko.rawContent = SAMPLE;
  uko.structuredContent.sections = [{ heading: 'Payment Terms', text: SAMPLE }];
  return uko;
}

test('knowledge stages populate every UKO knowledge field and record themselves', async () => {
  const uko = seedUKO();
  await runEnrichment(uko, { only: 'knowledge' });
  assert.ok(uko.keywords.length && uko.entities.length && uko.topics.length && uko.timeline.length && uko.facts.length);
  assert.ok(uko.summaries.short.length > 0);
  assert.ok(uko.reasoningHints.some(h => h.includes('never claim the file cannot be accessed')));
  const ran = uko.processing.stages.map(s => s.stage);
  for (const name of ['enrich:keywords', 'enrich:entities', 'enrich:topics', 'enrich:timeline', 'enrich:facts', 'enrich:summary']) {
    assert.ok(ran.includes(name), `${name} recorded`);
  }
  assert.ok(uko.processing.stages.every(s => s.ok), 'all green');
});

test('REPLACEABILITY: a fake "LLM" entity stage swaps in behind the same signature — pipeline unchanged', async () => {
  const llmEntityStage = {
    name: 'entities', version: '2.0.0-llm', class: 'knowledge',
    applicable: entityStage.applicable,
    run(uko) { uko.entities = [{ type: 'org', value: 'Aquiplex (from LLM)', count: 1 }]; },
  };
  const stages = KNOWLEDGE_STAGES.map(s => (s === entityStage ? llmEntityStage : s));
  const uko = seedUKO();
  await runEnrichment(uko, { stages, only: 'knowledge' });
  assert.deepEqual(uko.entities, [{ type: 'org', value: 'Aquiplex (from LLM)', count: 1 }]);
  assert.ok(uko.keywords.length, 'neighbor stages untouched');
});

test('FAIL-OPEN: a throwing stage becomes a warning; later stages still run; nothing is lost', async () => {
  const bomb = { name: 'bomb', version: '1', class: 'knowledge', applicable: () => true, run() { throw new Error('kaboom'); } };
  const after = { name: 'after', version: '1', class: 'knowledge', applicable: () => true, run(u) { u.metadata.afterRan = true; } };
  const uko = seedUKO();
  await runEnrichment(uko, { stages: [bomb, after] });
  assert.ok(uko.processing.warnings.some(w => w.includes('bomb') && w.includes('kaboom')));
  assert.deepEqual(uko.processing.errors, [], 'fail-open downgrades the stage error');
  assert.equal(uko.metadata.afterRan, true);
  const bombStage = uko.processing.stages.find(s => s.stage === 'enrich:bomb');
  assert.equal(bombStage.ok, false, 'observability still shows the failure');
});

test('class filter + applicable(): integration-only run touches no knowledge field; throwing applicable = skip', async () => {
  const uko = seedUKO();
  const captured = [];
  const deps = {
    indexFileChunks: async () => ({ indexed: 3 }),
    rememberFile:    (owner, f) => { captured.push([owner, f.name]); return { key: `file:${f.name}` }; },
    indexUKO:        () => ({ indexed: true }),
  };
  await runEnrichment(uko, { deps, only: 'integration' });
  assert.deepEqual(uko.keywords, [], 'knowledge fields untouched');
  assert.equal(uko.embeddings.indexed, 3);
  assert.equal(uko.memoryLinks.fileKey, 'file:contract.pdf');
  assert.equal(uko.searchIndexed, true);
  assert.deepEqual(captured, [['owner-1', 'contract.pdf']]);

  const moody = { name: 'moody', version: '1', class: 'knowledge', applicable: () => { throw new Error('?'); }, run(u) { u.metadata.never = true; } };
  await runEnrichment(uko, { stages: [moody] });
  assert.notEqual(uko.metadata.never, true, 'throwing applicable() means skip, not crash');
});

test('ownerless UKO skips every integration stage (no memory writes without an owner)', async () => {
  const uko = seedUKO();
  uko.owner = null;
  let called = 0;
  await runEnrichment(uko, { deps: { rememberFile: () => { called += 1; }, indexFileChunks: async () => { called += 1; }, indexUKO: () => { called += 1; } }, only: 'integration' });
  assert.equal(called, 0);
  assert.equal(INTEGRATION_STAGES.every(s => !s.applicable(uko)), true);
});
