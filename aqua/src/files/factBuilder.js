/**
 * AQUA Fact Builder — Phase 2
 *
 * Turns a Phase-1 UKO into grounded Facts: each candidate statement is
 * located back to its source and paired with an Evidence object carrying
 * modality-correct provenance. This is where "every parser preserves
 * provenance" is realized — not by rewriting the parsers, but by a single
 * builder that reads the structural markers every parser already emits
 * (see evidenceLocator) and produces the right locator per fileType.
 *
 * Provider-independent by construction: the builder never calls a model.
 * It reasons over the UKO's extracted text + sections + Phase-1 heuristic
 * facts/entities/timeline, all of which are already provider-normalized.
 * A future model-based fact extractor plugs in behind the same output
 * contract (return Facts + Evidence) exactly like enrichment stages.
 *
 * Per-modality provenance:
 *   document   → page / slide / sheet / paragraph / table   (structural markers)
 *   image      → OCR region / vision                         (extractionMethod ocr|vision)
 *   audio      → timestamp / speaker / segment               (speech)
 *   video      → timestamp / scene / frame                   (timeline)
 *   source     → lineRange                                   (code)
 *   repository → nestedPath / innerFile                      (archive)
 *
 * Confidence is never invented: it comes from the extraction method prior
 * (evidence.defaultConfidenceFor) unless the UKO metadata carries a real
 * measured confidence (e.g. an OCR quality signal), in which case that wins.
 */
import {
  createEvidence, createFact, defaultConfidenceFor,
} from './evidence.js';
import {
  buildDocumentLocator, buildSourceLocator, buildMediaLocator,
} from './evidenceLocator.js';

const MAX_FACTS_PER_FILE = 40;

/**
 * @param {object} uko - a fully enriched Phase-1 UKO
 * @returns {{ evidence: object[], facts: object[] }} shared-ready evidence + grounded facts
 */
export function buildFactsFromUKO(uko) {
  const method   = methodFor(uko);
  const locator  = locatorFor(uko);
  const evidence = [];
  const facts    = [];

  const base = {
    sourceFileId: uko.id, sourceFileName: uko.sourceFile.name,
    sourceType: uko.fileType, parser: uko.provenance.parser,
    extractor: uko.provenance.analyzer ?? uko.provenance.parser,
  };
  // A real measured confidence on the UKO overrides the method prior.
  const measured = typeof uko.metadata?.ocrConfidence === 'number' ? uko.metadata.ocrConfidence
    : typeof uko.metadata?.confidence === 'number' ? uko.metadata.confidence : null;

  const emit = (statement, { snippet, location, entities = [], extra = {} }) => {
    if (facts.length >= MAX_FACTS_PER_FILE) return;
    const ev = createEvidence({
      ...base, extractionMethod: method, location,
      confidence: measured ?? defaultConfidenceFor(method),
      snippet: snippet ?? statement,
    });
    evidence.push(ev);
    facts.push(createFact({
      statement, entities, evidence: [ev],
      reasoningHints: uko.reasoningHints.slice(0, 2),
      ...extra,
    }));
  };

  // ── Promote Phase-1 heuristic facts, now with real provenance ──
  for (const hf of uko.facts ?? []) {
    const offset = uko.rawContent.indexOf(hf.text);
    emit(hf.text, {
      snippet: hf.text,
      entities: hf.entities ?? [],
      location: locateOffset(locator, uko, offset >= 0 ? offset : 0, hf.text.length),
    });
  }

  // ── Timeline events become time-located facts (media + dated docs) ──
  for (const te of uko.timeline ?? []) {
    if (facts.length >= MAX_FACTS_PER_FILE) break;
    const offset = uko.rawContent.indexOf(te.event);
    const loc = locateOffset(locator, uko, offset >= 0 ? offset : 0, (te.event ?? '').length);
    if (te.ts && (uko.fileType === 'video' || uko.fileType === 'audio')) loc.timestamp = te.ts;
    emit(te.event, { snippet: te.event, location: loc });
  }

  return { evidence, facts };
}

// ── modality wiring ───────────────────────────────────────────────────────────

function methodFor(uko) {
  switch (uko.fileType) {
    case 'document':   return uko.metadata?.ocr ? 'ocr' : 'structural';
    case 'image':      return uko.provenance.analyzer ? 'vision' : 'ocr';
    case 'audio':      return 'speech';
    case 'video':      return 'timeline';
    case 'source':     return 'code';
    case 'repository': return 'archive';
    default:           return 'heuristic';
  }
}

function locatorFor(uko) {
  if (uko.fileType === 'document') return { kind: 'document', doc: buildDocumentLocator(uko.rawContent, uko.structuredContent.format) };
  if (uko.fileType === 'source')   return { kind: 'source', src: buildSourceLocator(uko.rawContent) };
  if (uko.fileType === 'video' || uko.fileType === 'audio') return { kind: 'media', media: buildMediaLocator(uko.rawContent, uko.structuredContent.sections) };
  return { kind: uko.fileType };
}

function locateOffset(locator, uko, offset, len) {
  if (locator.kind === 'document') {
    return { ...locator.doc.locate(offset), ...locator.doc.tableAt(offset) };
  }
  if (locator.kind === 'source') {
    return { lineRange: locator.src.lineRangeFor(offset, len) };
  }
  if (locator.kind === 'media') {
    const loc = {};
    const ts = locator.media.timestampAt(offset);
    if (ts) loc.timestamp = ts;
    const sp = locator.media.speakerAt(offset);
    if (sp) loc.speaker = sp;
    return loc;
  }
  if (uko.fileType === 'repository') {
    return { nestedPath: uko.summaries.title ?? uko.sourceFile.name };
  }
  return {};
}
