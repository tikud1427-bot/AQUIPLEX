/**
 * AQUA Evidence Engine — Universal Evidence Object + Fact schema (Phase 2)
 *
 * THE TRUST LAYER. Phase 1 gave every file one Universal Knowledge Object;
 * this phase makes every extracted FACT traceable back to the exact place
 * it came from. Nothing a future reasoning engine asserts should ever be
 * un-attributable — a Fact with no Evidence is a bug, not a shortcut.
 *
 * Two structures, one contract:
 *
 *   Evidence — a universal SOURCE LOCATOR. Answers "where did this come
 *     from?" across every modality with the same shape: which file, and
 *     then whichever of page/paragraph/section/table/cell/slide/sheet/
 *     frame/timestamp/lineRange/speaker/boundingBox/objectId actually
 *     applies. Every field is optional; a parser fills as many as its
 *     modality supports and leaves the rest null. Confidence and the
 *     producing extractor/method travel WITH the locator — provenance and
 *     certainty are never separated from the claim.
 *
 *   Fact — a statement PLUS its evidence[]. Facts are no longer plain text:
 *     they carry normalizedRepresentation, referenced entities, and one or
 *     more Evidence ids. Reasoning operates over Facts, never over raw
 *     extracted text (the reasoning contract).
 *
 * Storage model: Evidence is content-checksummed and SHARED. Ten facts
 * from the same table row reference one Evidence object, not ten copies
 * (the performance requirement). Facts hold evidence IDs; the store
 * hydrates. This module is pure — construction, checksums, validation.
 * No I/O.
 */
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export const EVIDENCE_SCHEMA_VERSION = 1;
export const FACT_SCHEMA_VERSION     = 1;

/** How a value was produced — drives confidence priors and QC. */
export const EXTRACTION_METHODS = Object.freeze([
  'text-layer',     // digital PDF/DOCX text — high trust
  'structural',     // marker-delimited region (page/slide/sheet/section) of extracted text
  'ocr',            // vision OCR — medium, region/quality dependent
  'vision',         // image understanding
  'speech',         // audio/video transcription
  'timeline',       // timestamped scene/segment
  'code',           // source line/symbol reference — exact
  'archive',        // nested-path reference inside an archive
  'heuristic',      // regex/frequency extractor (Phase 1 extractors)
  'model',          // LLM-produced (future)
]);

/** Default confidence priors by method — NEVER invent certainty. */
const METHOD_CONFIDENCE = {
  'text-layer': 0.98, structural: 0.95, code: 0.97, archive: 0.9,
  timeline: 0.8, speech: 0.75, vision: 0.7, ocr: 0.6, heuristic: 0.55, model: 0.7,
};

export function defaultConfidenceFor(method) {
  return METHOD_CONFIDENCE[method] ?? 0.5;
}

// ── Evidence ──────────────────────────────────────────────────────────────────

/**
 * Create a universal Evidence object. `location` carries whichever
 * modality-specific coordinates apply; everything defaults to null so a
 * consumer can read any field without guarding.
 *
 * @param {object} p
 * @param {string}  p.sourceFileId   - UKO id the evidence points into
 * @param {string}  p.sourceFileName
 * @param {string}  p.sourceType     - fileType: document|image|audio|video|source|repository
 * @param {string}  p.parser         - parser id that owns the source
 * @param {string}  p.extractionMethod - one of EXTRACTION_METHODS
 * @param {object}  [p.location]     - { page, paragraph, section, table, cell, slide, sheet, frame, timestamp, lineRange, boundingBox, speaker, objectId, ocrRegion, nestedPath, innerFile, archive }
 * @param {number}  [p.confidence]   - 0..1; defaults to the method prior
 * @param {string}  [p.extractor]    - specific extractor/model name
 * @param {string}  [p.snippet]      - the exact source text this evidence covers (checksum basis)
 * @returns {object} Evidence
 */
export function createEvidence({
  sourceFileId, sourceFileName = null, sourceType, parser = null,
  extractionMethod, location = {}, confidence = null, extractor = null, snippet = '',
}) {
  if (!sourceFileId) throw new Error('createEvidence: sourceFileId required');
  if (!EXTRACTION_METHODS.includes(extractionMethod)) {
    throw new Error(`createEvidence: unknown extractionMethod "${extractionMethod}"`);
  }
  const loc = {
    page: null, paragraph: null, section: null, table: null, cell: null,
    slide: null, sheet: null, frame: null, timestamp: null, lineRange: null,
    boundingBox: null, speaker: null, objectId: null, ocrRegion: null,
    nestedPath: null, innerFile: null, archive: null,
    ...location,
  };
  const conf = clamp01(confidence == null ? defaultConfidenceFor(extractionMethod) : confidence);
  return {
    id:               uuidv4(),
    schemaVersion:    EVIDENCE_SCHEMA_VERSION,
    sourceFileId,
    sourceFileName,
    sourceType,
    parser,
    extractor,
    extractionMethod,
    location:         loc,
    confidence:       conf,
    snippet:          snippet.slice(0, 500),
    checksum:         evidenceChecksum({ sourceFileId, extractionMethod, loc, snippet }),
    createdAt:        Date.now(),
  };
}

/**
 * Stable identity for dedup + sharing. Two evidence objects with the same
 * source, method, location, and snippet are THE SAME evidence — the store
 * keeps one and every fact references it.
 */
export function evidenceChecksum({ sourceFileId, extractionMethod, loc, snippet }) {
  const canonical = JSON.stringify([
    sourceFileId, extractionMethod,
    loc.page, loc.paragraph, loc.section, loc.table, loc.cell, loc.slide,
    loc.sheet, loc.frame, loc.timestamp, loc.lineRange, loc.speaker,
    loc.objectId, loc.ocrRegion, loc.nestedPath, loc.innerFile,
    (snippet ?? '').trim().slice(0, 200),
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Human-readable citation string — the Citation Engine architecture. No UI;
 * this is the canonical text form future surfaces render from.
 *   "Financial_Report.pdf · Page 17 · Table 3 · Row 8"
 *   "meeting.mp4 · 00:12:43"
 *   "router.js · L42–L67"
 */
export function formatCitation(evidence) {
  const L = evidence.location;
  const parts = [evidence.sourceFileName ?? evidence.sourceFileId];
  if (L.nestedPath) parts.push(L.nestedPath);
  if (L.page   != null) parts.push(`Page ${L.page}`);
  if (L.slide  != null) parts.push(`Slide ${L.slide}`);
  if (L.sheet  != null) parts.push(`Sheet ${L.sheet}`);
  if (L.table  != null) parts.push(`Table ${L.table}`);
  if (L.cell   != null) parts.push(`Cell ${L.cell}`);
  if (L.paragraph != null) parts.push(`¶${L.paragraph}`);
  if (L.section != null && L.page == null && L.slide == null) parts.push(`§${L.section}`);
  if (L.lineRange) parts.push(`L${L.lineRange[0]}${L.lineRange[1] && L.lineRange[1] !== L.lineRange[0] ? `–L${L.lineRange[1]}` : ''}`);
  if (L.timestamp != null) parts.push(formatTimestamp(L.timestamp));
  if (L.frame != null) parts.push(`frame ${L.frame}`);
  if (L.speaker) parts.push(L.speaker);
  return parts.join(' · ');
}

/** seconds (number) or "M:SS"/"H:MM:SS" (string) → "HH:MM:SS". */
export function formatTimestamp(ts) {
  let sec;
  if (typeof ts === 'number') sec = ts;
  else {
    const p = String(ts).split(':').map(Number);
    if (p.some(Number.isNaN)) return String(ts);
    sec = p.reduce((acc, n) => acc * 60 + n, 0);
  }
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Fact ──────────────────────────────────────────────────────────────────────

/**
 * Create a Fact. `evidence` is an array of Evidence IDs (or Evidence
 * objects — ids extracted). A fact's confidence defaults to the MAX of its
 * evidence confidences (best support wins), never fabricated.
 *
 * @param {object} p
 * @param {string}   p.statement
 * @param {string}   [p.normalizedRepresentation]
 * @param {string[]} [p.entities]
 * @param {Array}    [p.relationships]
 * @param {Array}    [p.timeline]
 * @param {Array<string|object>} p.evidence - Evidence ids or objects
 * @param {number}   [p.confidence]
 * @param {string[]} [p.reasoningHints]
 * @returns {object} Fact
 */
export function createFact({
  statement, normalizedRepresentation = null, entities = [], relationships = [],
  timeline = [], evidence = [], confidence = null, reasoningHints = [],
}) {
  if (!statement || typeof statement !== 'string') throw new Error('createFact: statement required');
  const evidenceIds = evidence.map(e => (typeof e === 'string' ? e : e?.id)).filter(Boolean);
  const evConfidences = evidence.map(e => (typeof e === 'object' ? e.confidence : null)).filter(c => typeof c === 'number');
  const conf = confidence != null ? clamp01(confidence)
    : (evConfidences.length ? Math.max(...evConfidences) : 0.5);
  return {
    id:                       uuidv4(),
    schemaVersion:            FACT_SCHEMA_VERSION,
    statement:                statement.trim(),
    normalizedRepresentation: normalizedRepresentation ?? normalizeStatement(statement),
    entities:                 [...new Set(entities)],
    relationships,
    timeline,
    evidence:                 evidenceIds,   // IDs — the store hydrates to shared Evidence objects
    confidence:               conf,
    reasoningHints,
    createdAt:                Date.now(),
  };
}

/** Cheap normalization for dedup/join — lowercase, collapse ws, strip terminal punct. */
export function normalizeStatement(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();
}

// ── Validation (schema-level; QC lives in evidenceValidator.js) ──────────────

export function validateEvidence(ev) {
  const problems = [];
  const need = (c, m) => { if (!c) problems.push(m); };
  need(ev && typeof ev === 'object', 'evidence must be an object');
  if (!ev || typeof ev !== 'object') return { valid: false, problems };
  need(typeof ev.id === 'string', 'id missing');
  need(ev.schemaVersion === EVIDENCE_SCHEMA_VERSION, `schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
  need(typeof ev.sourceFileId === 'string' && ev.sourceFileId, 'sourceFileId missing');
  need(EXTRACTION_METHODS.includes(ev.extractionMethod), 'extractionMethod invalid');
  need(ev.location && typeof ev.location === 'object', 'location missing');
  need(typeof ev.confidence === 'number' && ev.confidence >= 0 && ev.confidence <= 1, 'confidence out of range');
  need(typeof ev.checksum === 'string' && ev.checksum.length >= 16, 'checksum missing');
  return { valid: problems.length === 0, problems };
}

export function validateFact(fact) {
  const problems = [];
  const need = (c, m) => { if (!c) problems.push(m); };
  need(fact && typeof fact === 'object', 'fact must be an object');
  if (!fact || typeof fact !== 'object') return { valid: false, problems };
  need(typeof fact.id === 'string', 'id missing');
  need(fact.schemaVersion === FACT_SCHEMA_VERSION, `schemaVersion must be ${FACT_SCHEMA_VERSION}`);
  need(typeof fact.statement === 'string' && fact.statement.length > 0, 'statement empty');
  need(Array.isArray(fact.evidence), 'evidence must be an array');
  need(fact.evidence.length > 0, 'fact has no evidence — every fact must be grounded'); // the core invariant
  need(typeof fact.confidence === 'number', 'confidence missing');
  return { valid: problems.length === 0, problems };
}

function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }
