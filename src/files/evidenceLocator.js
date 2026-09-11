/**
 * AQUA Evidence Locator — Phase 2
 *
 * The bridge from "a piece of extracted text" to "exactly where in the
 * source it lives". Every parser in Phase 1 already emits text carrying
 * STRUCTURAL MARKERS the extractors and document pipeline agreed on:
 *
 *   documents  "-- Page N --", "-- Slide N --", "-- Sheet: name --",
 *              "-- N of M --"  (PDF), "-- Page N --" (OCR)
 *   media      SCENES section with "M:SS event" / "H:MM:SS event" lines,
 *              TRANSCRIPT / TEXT (OCR) sections
 *   source     raw lines (line numbers are 1-based positions)
 *   repository nested paths preserved by the archive extractor
 *
 * This module reads those markers and returns modality-correct location
 * objects for a given character offset or line — WITHOUT re-parsing the
 * original binary and WITHOUT any new dependency. It is the provider-
 * independent core of provenance: the SAME offset→location machinery works
 * whether the text came from pdf-parse, Gemini OCR, or a future parser, as
 * long as the parser emits the shared markers (documented in the parser
 * integration guide).
 *
 * Pure + deterministic. Everything here is offset arithmetic over strings.
 */

// ── Marker maps ───────────────────────────────────────────────────────────────

const PAGE_MARKER   = /^--\s*(?:Page\s+)?(\d+)(?:\s+of\s+\d+)?\s*--$/gm;
const SLIDE_MARKER  = /^--\s*Slide\s+(\d+)\s*--$/gm;
const SHEET_MARKER  = /^--\s*Sheet:\s*(.+?)\s*--$/gm;

/**
 * Build an ordered [{ offset, label }] index of a marker's positions in
 * text. offset is where the region AFTER the marker begins.
 */
function markerIndex(text, regex) {
  const idx = [];
  for (const m of text.matchAll(regex)) {
    idx.push({ start: m.index, contentStart: m.index + m[0].length, label: m[1] });
  }
  return idx;
}

/** The marker region an absolute offset falls into, or null. */
function regionAt(index, offset) {
  let hit = null;
  for (const region of index) {
    if (region.start <= offset) hit = region; else break;
  }
  return hit;
}

/**
 * A DocumentLocator answers page/slide/sheet + paragraph for any offset in
 * a document's extracted text. Built once per UKO, queried per fact.
 */
export function buildDocumentLocator(text, format) {
  const pages  = markerIndex(text, PAGE_MARKER);
  const slides = markerIndex(text, SLIDE_MARKER);
  const sheets = markerIndex(text, SHEET_MARKER);

  // Paragraph boundaries (blank-line separated) for ¶ precision.
  const paras = [];
  let p = 0;
  for (const block of text.split(/\n{2,}/)) {
    paras.push({ start: p, text: block });
    p += block.length + 2;
  }

  return {
    format,
    hasStructure: pages.length + slides.length + sheets.length > 0,
    locate(offset) {
      const loc = {};
      if (slides.length) { const r = regionAt(slides, offset); if (r) loc.slide = Number(r.label); }
      if (sheets.length) { const r = regionAt(sheets, offset); if (r) loc.sheet = r.label; }
      if (pages.length && loc.slide == null) { const r = regionAt(pages, offset); if (r) loc.page = Number(r.label); }
      // Paragraph index within the whole doc (1-based) — coarse but honest.
      const paraIdx = paras.findIndex((pp, i) =>
        offset >= pp.start && (i === paras.length - 1 || offset < paras[i + 1].start));
      if (paraIdx >= 0) loc.paragraph = paraIdx + 1;
      return loc;
    },
    /** Detect a markdown/CSV-style table region around an offset (best-effort). */
    tableAt(offset) {
      const line = lineAround(text, offset);
      return /\|.*\|/.test(line) || /,.*,/.test(line) ? { table: true } : {};
    },
  };
}

/** Line + [startLine,endLine] for a source-file offset (1-based). */
export function buildSourceLocator(text) {
  // Precompute line-start offsets.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  return {
    lineAt(offset) {
      let lo = 0, hi = lineStarts.length - 1, ans = 0;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (lineStarts[mid] <= offset) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      return ans + 1;
    },
    /** Line range covering [offset, offset+len). */
    lineRangeFor(offset, len) {
      const start = this.lineAt(offset);
      const end   = this.lineAt(Math.max(offset, offset + len - 1));
      return [start, end];
    },
  };
}

/**
 * Media timeline locator: parse the SCENES section into
 * [{ timestamp, event, offset }] and answer the timestamp nearest a text
 * offset (for transcript/scene-derived facts). Also exposes speaker if the
 * transcript uses "Speaker N:" prefixes.
 */
export function buildMediaLocator(text, sections = []) {
  const scenes = [];
  const sceneSection = sections.find(s => /SCENE/i.test(s.heading ?? ''));
  if (sceneSection) {
    const base = text.indexOf(sceneSection.text);
    let cursor = base < 0 ? 0 : base;
    for (const line of (sceneSection.text ?? '').split('\n')) {
      const m = line.trim().match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*[—\-–:]?\s*(.+)$/);
      const at = text.indexOf(line, cursor);
      if (m) scenes.push({ timestamp: m[1], event: m[2].trim(), offset: at < 0 ? cursor : at });
      if (at >= 0) cursor = at + line.length;
    }
  }
  return {
    hasTimeline: scenes.length > 0,
    scenes,
    /** Nearest preceding scene timestamp for an offset. */
    timestampAt(offset) {
      let hit = null;
      for (const s of scenes) { if (s.offset <= offset) hit = s; else break; }
      return hit?.timestamp ?? (scenes[0]?.timestamp ?? null);
    },
    speakerAt(offset) {
      const line = lineAround(text, offset);
      const m = line.match(/^\s*(Speaker\s+\d+|[A-Z][a-z]+):/);
      return m ? m[1] : null;
    },
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function lineAround(text, offset) {
  const start = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  let end = text.indexOf('\n', offset);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

export function lineAroundOffset(text, offset) { return lineAround(text, offset); }
