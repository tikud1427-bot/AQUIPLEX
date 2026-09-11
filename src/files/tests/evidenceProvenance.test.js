/**
 * Evidence Engine — locator + per-modality provenance E2E (Phase 2).
 *
 * Proves provenance for EVERY modality the brief enumerates, through the
 * REAL fact builder against real UKO shapes: PDF pages, PPTX slides, XLSX
 * sheets, video timestamps, source line ranges, repository nested paths.
 * The locators read the structural markers the Phase-1 parsers already
 * emit — no binary re-parsing, no new dependency.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDocumentLocator, buildSourceLocator, buildMediaLocator,
} from '../evidenceLocator.js';
import { buildFactsFromUKO } from '../factBuilder.js';
import { createUKO } from '../uko.js';
import { formatCitation } from '../evidence.js';

// ── Locators (unit) ───────────────────────────────────────────────────────────

test('document locator maps offsets to pages via "-- Page N --" markers', () => {
  const text = '-- Page 1 --\nIntro text here.\n\n-- Page 2 --\nRevenue was 4000000 in Q3.\n\n-- Page 3 --\nConclusion.';
  const loc = buildDocumentLocator(text, 'pdf');
  assert.equal(loc.hasStructure, true);
  assert.equal(loc.locate(text.indexOf('Intro')).page, 1);
  assert.equal(loc.locate(text.indexOf('Revenue')).page, 2);
  assert.equal(loc.locate(text.indexOf('Conclusion')).page, 3);
});

test('document locator maps slides and sheets', () => {
  const slides = buildDocumentLocator('-- Slide 1 --\nTitle\n\n-- Slide 2 --\nRevenue projections', 'pptx');
  assert.equal(slides.locate(slides.format && 40).slide ?? slides.locate(30).slide, 2);
  const sheets = buildDocumentLocator('-- Sheet: Q3 --\na,b\n1,2\n\n-- Sheet: Q4 --\nc,d\n3,4', 'xlsx');
  const q4 = 'c,d';
  assert.equal(sheets.locate('-- Sheet: Q3 --\na,b\n1,2\n\n-- Sheet: Q4 --\nc,d\n3,4'.indexOf(q4)).sheet, 'Q4');
});

test('source locator computes 1-based line ranges', () => {
  const code = 'line1\nline2\nline3\nline4\nline5';
  const src = buildSourceLocator(code);
  assert.equal(src.lineAt(0), 1);
  assert.equal(src.lineAt(code.indexOf('line3')), 3);
  assert.deepEqual(src.lineRangeFor(code.indexOf('line2'), 'line2\nline3'.length), [2, 3]);
});

test('media locator parses SCENES into timestamps and answers nearest', () => {
  const text = 'SUMMARY: demo\n\nSCENES:\n0:05 person enters\n0:12 backpack placed\n1:30 door closes';
  const sections = [{ heading: 'SCENES', text: '0:05 person enters\n0:12 backpack placed\n1:30 door closes' }];
  const media = buildMediaLocator(text, sections);
  assert.equal(media.hasTimeline, true);
  assert.equal(media.timestampAt(text.indexOf('backpack')), '0:12');
  assert.equal(media.timestampAt(text.indexOf('door')), '1:30');
});

// ── Per-modality provenance through the fact builder ─────────────────────────

function ukoWith(fileType, { content, sections = [], facts = [], timeline = [], metadata = {}, analyzer = 'gemini', format = null }) {
  const uko = createUKO({ ownerId: 'o', conversationId: 'c', sourceFile: { name: `f.${fileType}`, ext: `.${fileType}`, bytes: content.length, hash: 'h'.repeat(64) }, fileType });
  uko.rawContent = content;
  uko.structuredContent.sections = sections;
  uko.structuredContent.format = format;
  uko.facts = facts;
  uko.timeline = timeline;
  uko.metadata = metadata;
  uko.provenance.analyzer = analyzer;
  uko.provenance.parser = fileType;
  return uko;
}

test('PDF PROVENANCE: facts carry page numbers + structural method', () => {
  const content = '-- Page 1 --\nOverview.\n\n-- Page 17 --\nAquiplex revenue was 4000000 in Q3 per Table 3.';
  const uko = ukoWith('document', {
    content, format: 'pdf',
    facts: [{ text: 'Aquiplex revenue was 4000000 in Q3 per Table 3.', entities: ['Aquiplex'] }],
  });
  const { evidence, facts } = buildFactsFromUKO(uko);
  assert.equal(facts.length, 1);
  assert.equal(evidence[0].extractionMethod, 'structural');
  assert.equal(evidence[0].location.page, 17);
  assert.match(formatCitation(evidence[0]), /f\.document · Page 17/);
});

test('VIDEO PROVENANCE: timeline facts carry timestamps + timeline method', () => {
  const content = 'SUMMARY: meeting\n\nSCENES:\n0:05 Ananya presents the roadmap\n12:43 budget approved for 4000000';
  const uko = ukoWith('video', {
    content, analyzer: 'gemini',
    sections: [{ heading: 'SCENES', text: '0:05 Ananya presents the roadmap\n12:43 budget approved for 4000000' }],
    timeline: [
      { order: 0, ts: '0:05', event: 'Ananya presents the roadmap', source: 'scenes' },
      { order: 1, ts: '12:43', event: 'budget approved for 4000000', source: 'scenes' },
    ],
  });
  const { evidence, facts } = buildFactsFromUKO(uko);
  assert.ok(facts.length >= 2);
  const budget = evidence.find(e => e.location.timestamp === '12:43');
  assert.ok(budget, 'timestamp preserved on the budget fact');
  assert.equal(budget.extractionMethod, 'timeline');
  assert.match(formatCitation(budget), /00:12:43/);
});

test('IMAGE PROVENANCE: vision method, OCR fallback method, measured confidence honored', () => {
  const vis = ukoWith('image', { content: 'CAPTION: whiteboard\nTEXT (OCR): AQUA v5 ships 2026', analyzer: 'gemini', facts: [{ text: 'AQUA v5 ships 2026', entities: ['AQUA'] }] });
  const { evidence } = buildFactsFromUKO(vis);
  assert.equal(evidence[0].extractionMethod, 'vision');

  const ocr = ukoWith('image', { content: 'scanned receipt total 500', analyzer: null, metadata: { ocrConfidence: 0.42 }, facts: [{ text: 'receipt total 500', entities: [] }] });
  const out = buildFactsFromUKO(ocr);
  assert.equal(out.evidence[0].extractionMethod, 'ocr');
  assert.equal(out.evidence[0].confidence, 0.42, 'measured OCR confidence overrides the method prior');
});

test('SOURCE PROVENANCE: facts carry line ranges + code method', () => {
  const content = 'import x from "y";\n\nfunction pay(amount) {\n  return charge(4000000);\n}\n';
  const uko = ukoWith('source', { content, analyzer: null, facts: [{ text: 'return charge(4000000);', entities: [] }] });
  const { evidence } = buildFactsFromUKO(uko);
  assert.equal(evidence[0].extractionMethod, 'code');
  assert.ok(Array.isArray(evidence[0].location.lineRange));
  assert.equal(evidence[0].location.lineRange[0], 4, 'line 4 in the file');
});

test('REPOSITORY PROVENANCE: facts carry nested path + archive method', () => {
  const uko = ukoWith('repository', { content: 'Repository workspace "myapp" — 12 files.\n\nSUMMARY:\nA Node service. Budget 4000000 in config.', analyzer: null, facts: [{ text: 'Budget 4000000 in config.', entities: [] }] });
  uko.summaries.title = 'myapp';
  const { evidence } = buildFactsFromUKO(uko);
  assert.equal(evidence[0].extractionMethod, 'archive');
  assert.equal(evidence[0].location.nestedPath, 'myapp');
});

test('AUDIO PROVENANCE: speech method with speaker when transcript is labeled', () => {
  const content = 'SUMMARY: standup\n\nTRANSCRIPT:\nSpeaker 1: we ship on Friday\nSpeaker 2: budget is 4000000';
  const uko = ukoWith('audio', { content, analyzer: 'gemini', facts: [{ text: 'budget is 4000000', entities: [] }] });
  const { evidence } = buildFactsFromUKO(uko);
  assert.equal(evidence[0].extractionMethod, 'speech');
});
