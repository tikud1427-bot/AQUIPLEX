/**
 * AQUA Artifact Engine — Document Content Model (P2)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE block-based content model shared by the pdf and docx exporters — the
 * LLM writes the same JSON for both; only the renderer differs. That keeps
 * the "no duplicated logic" rule intact across the two document formats and
 * means a docx→pdf (or pdf→docx) re-export in P5 is a renderer swap, not a
 * regeneration.
 *
 * Model:
 *   {
 *     "title": "Quarterly Report",
 *     "blocks": [
 *       { "type": "heading",   "level": 1, "text": "Overview" },
 *       { "type": "paragraph", "text": "…" },
 *       { "type": "bullets",   "items": ["…", "…"] },
 *       { "type": "table",     "rows": [["Item","Qty","Price"], ["…","…","…"]] },
 *       { "type": "spacer" }
 *     ]
 *   }
 */
import { cleanStringList } from './common.js';

export const DOCUMENT_SCHEMA_HINT = `{
  "title": "<document title>",
  "blocks": [
    { "type": "heading", "level": 1, "text": "<section heading>" },
    { "type": "paragraph", "text": "<body text>" },
    { "type": "bullets", "items": ["<point>", "<point>"] },
    { "type": "table", "rows": [["<header cell>", "<header cell>"], ["<cell>", "<cell>"]] },
    { "type": "spacer" }
  ]
}
(block order = document order; "level" is 1-3; first table row is the header row)`;

export const DOC_LIMITS = {
  MAX_BLOCKS: 400,
  MAX_TEXT: 8_000,
  MAX_BULLETS: 50,
  MAX_TABLE_ROWS: 200,
  MAX_TABLE_COLS: 12,
  MAX_CELL: 500,
};

const BLOCK_TYPES = new Set(['heading', 'paragraph', 'bullets', 'table', 'spacer']);

/** Shared build(): one generateJson call, normalized into the block model. */
export async function buildDocumentModel({ spec, helpers, formatGuidance }) {
  const file = spec.files[0];
  const json = await helpers.generateJson({
    spec, file, schemaHint: DOCUMENT_SCHEMA_HINT, formatGuidance,
  });
  return normalizeDocumentModel(json, spec);
}

/** Coerce raw JSON into a clean model; validation happens separately. */
export function normalizeDocumentModel(json, spec) {
  const title = typeof json?.title === 'string' && json.title.trim()
    ? json.title.trim().slice(0, 300)
    : spec.title;

  const blocks = [];
  for (const raw of Array.isArray(json?.blocks) ? json.blocks : []) {
    if (!raw || typeof raw !== 'object' || !BLOCK_TYPES.has(raw.type)) continue;
    if (blocks.length >= DOC_LIMITS.MAX_BLOCKS) break;

    if (raw.type === 'spacer') { blocks.push({ type: 'spacer' }); continue; }

    if (raw.type === 'heading') {
      const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 500) : '';
      if (!text) continue;
      const level = [1, 2, 3].includes(raw.level) ? raw.level : 2;
      blocks.push({ type: 'heading', level, text });
      continue;
    }

    if (raw.type === 'paragraph') {
      const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, DOC_LIMITS.MAX_TEXT) : '';
      if (text) blocks.push({ type: 'paragraph', text });
      continue;
    }

    if (raw.type === 'bullets') {
      const items = cleanStringList(raw.items, DOC_LIMITS.MAX_BULLETS, 1_000);
      if (items.length) blocks.push({ type: 'bullets', items });
      continue;
    }

    if (raw.type === 'table') {
      if (!Array.isArray(raw.rows)) continue;
      const rows = raw.rows
        .filter(r => Array.isArray(r) && r.length)
        .slice(0, DOC_LIMITS.MAX_TABLE_ROWS)
        .map(r => r.slice(0, DOC_LIMITS.MAX_TABLE_COLS)
          .map(c => String(c ?? '').trim().slice(0, DOC_LIMITS.MAX_CELL)));
      if (!rows.length) continue;
      const cols = Math.max(...rows.map(r => r.length));
      blocks.push({ type: 'table', rows: rows.map(r => [...r, ...Array(cols - r.length).fill('')]) });
    }
  }

  return { title, blocks };
}

/** Shared shape validation — renderer-independent. */
export function validateDocumentModel(model) {
  const errors = [];
  if (!model || typeof model !== 'object') return { valid: false, errors: ['document model missing'] };
  if (!model.title) errors.push('document model has no title');
  if (!Array.isArray(model.blocks) || model.blocks.length === 0) {
    errors.push('document model produced no content blocks');
  }
  return { valid: errors.length === 0, errors };
}

// ── Font-coverage guard (pdf only) ────────────────────────────────────────────
// P6 upgraded the pdf exporter from WinAnsi StandardFonts to an embedded
// DejaVu Sans (Latin + Latin-Extended + Cyrillic + Greek + ₹ and most
// symbols). Cleaning is now COVERAGE-based: any code point the embedded
// font actually has passes through; anything else is stripped and counted.
// If meaningful content (>15%) would be lost — Devanagari/CJK and other
// scripts that ALSO need text shaping pdf-lib cannot do — pdf export FAILS
// LOUDLY and the docx path (full Unicode) is suggested. Honest beats a PDF
// full of holes or, worse, unshaped Indic text rendered wrong.

const FALLBACK_MAP = new Map(Object.entries({
  '\u00A0': ' ', // NBSP → plain space (avoids odd wrapping)
}));

/**
 * @param {string} input
 * @param {Set<number>} coverage  code points the target font supports
 * @returns {{ text: string, lossRatio: number }}
 */
export function cleanForCoverage(input, coverage) {
  const src = String(input ?? '');
  let out = '';
  let considered = 0;
  let lost = 0;
  for (const ch of src) {
    const mapped = FALLBACK_MAP.get(ch);
    if (mapped != null) { out += mapped; considered += 1; continue; }
    const cp = ch.codePointAt(0);
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d || coverage.has(cp)) {
      out += ch;
      if (ch.trim()) considered += 1;
      continue;
    }
    if (ch.trim()) { considered += 1; lost += 1; }
  }
  return { text: out, lossRatio: considered ? lost / considered : 0 };
}

