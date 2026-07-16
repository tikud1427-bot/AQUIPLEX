/**
 * AQUA Artifact Engine — XLSX Exporter (P2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Real .xlsx workbooks via the xlsx package ALREADY in aqua's dependency
 * tree (documentPipeline.js reads spreadsheets with it — this adds the write
 * direction, zero new deps).
 *
 * Content model ('sheet'):
 *   { "sheets": [ { "name": "Budget", "headers": ["Item","Cost"], "rows": [["Rent", 12000]] } ] }
 */
import XLSX from 'xlsx';
import { registerExporter } from './registry.js';
import { ensureExtension }  from './common.js';

const SHEET_SCHEMA_HINT = `{
  "sheets": [
    { "name": "<sheet name, ≤31 chars>", "headers": ["<col>", "<col>"], "rows": [["<cell>", 123.45], ["<cell>", 678]] }
  ]
}
(numbers as JSON numbers — NOT strings — so spreadsheet math works; dates as "YYYY-MM-DD" strings)`;

const GUIDANCE = 'A real Excel workbook. Design useful columns; numeric cells must be JSON numbers so formulas/sorting work.';

const LIMITS = { MAX_SHEETS: 10, MAX_ROWS: 5_000, MAX_COLS: 50, MAX_CELL: 500, NAME_MAX: 31 };
const BAD_SHEET_CHARS = /[[\]:*?/\\]/g;

function normalizeModel(json, spec) {
  const sheets = [];
  const seen = new Set();
  for (const raw of Array.isArray(json?.sheets) ? json.sheets : []) {
    if (sheets.length >= LIMITS.MAX_SHEETS) break;
    if (!raw || typeof raw !== 'object') continue;

    let name = String(raw.name ?? `Sheet${sheets.length + 1}`)
      .replace(BAD_SHEET_CHARS, ' ').trim().slice(0, LIMITS.NAME_MAX) || `Sheet${sheets.length + 1}`;
    let candidate = name;
    for (let n = 2; seen.has(candidate.toLowerCase()); n++) candidate = `${name.slice(0, LIMITS.NAME_MAX - 3)} ${n}`;
    name = candidate;
    seen.add(name.toLowerCase());

    const cleanCell = (c) => (typeof c === 'number' && Number.isFinite(c)) ? c
      : (typeof c === 'boolean') ? c
      : String(c ?? '').slice(0, LIMITS.MAX_CELL);

    const headers = Array.isArray(raw.headers) ? raw.headers.slice(0, LIMITS.MAX_COLS).map(cleanCell) : [];
    const rows = (Array.isArray(raw.rows) ? raw.rows : [])
      .filter(r => Array.isArray(r))
      .slice(0, LIMITS.MAX_ROWS)
      .map(r => r.slice(0, LIMITS.MAX_COLS).map(cleanCell));

    if (headers.length || rows.length) sheets.push({ name, headers, rows });
  }
  return { title: spec.title, sheets };
}

registerExporter('xlsx', {
  label: 'Excel workbook',
  extensions: ['.xlsx'],
  mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  contentModel: 'sheet',
  guidance: GUIDANCE,
  schemaHint: SHEET_SCHEMA_HINT, // P5 — model-edit prompts reuse the build schema

  async build({ spec, helpers }) {
    const json = await helpers.generateJson({
      spec, file: spec.files[0], schemaHint: SHEET_SCHEMA_HINT, formatGuidance: GUIDANCE,
    });
    return normalizeModel(json, spec);
  },

  validate(model) {
    const errors = [];
    if (!model?.sheets?.length) errors.push('workbook model produced no sheets');
    for (const s of model?.sheets ?? []) {
      if (!s.headers.length && !s.rows.length) errors.push(`sheet "${s.name}" is empty`);
    }
    return { valid: errors.length === 0, errors };
  },

  export(model, { spec }) {
    const wb = XLSX.utils.book_new();
    for (const s of model.sheets) {
      const aoa = s.headers.length ? [s.headers, ...s.rows] : s.rows;
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), s.name);
    }
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return {
      files: [{
        path: ensureExtension(spec.files[0].path, '.xlsx'),
        buffer,
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }],
    };
  },
});

export {};
