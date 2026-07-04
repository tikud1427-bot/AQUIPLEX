/**
 * AQUA Document Parser
 *
 * Real content extraction for binary document formats. Previously these
 * never reached fileParser.js at all: fileIngester.js's IGNORE_EXTS
 * dropped .pdf by explicit extension, and .docx/.pptx/.xlsx were silently
 * caught by the isBinary() heuristic on their zip-compressed bytes, since
 * the whole ingestion pipeline assumed text content (routes/project.js's
 * upload contract is JSON: { files: [{ path, content: string }] } or a
 * base64 zip — nothing here previously carried raw binary bytes safely).
 *
 * This module extracts real text so these formats can flow through the
 * exact same { path, content, lang } shape fileParser.js / projectIndex.js
 * / projectSummarizer.js / projectRetriever.js already handle generically
 * for code files — confirmed by reading all four: none of them assume a
 * code-language lang value, all fall back gracefully. No changes needed
 * in any of them.
 *
 * Supported: PDF (pdf-parse v2), DOCX (mammoth), XLSX (xlsx / SheetJS).
 * PPTX is hand-rolled rather than a new dependency: adm-zip is already in
 * package.json, and PPTX is itself a zip of XML — a full OOXML
 * relationship-graph reader is unnecessary when every real PowerPoint
 * file places slides at ppt/slides/slideN.xml, so this just globs that
 * path and sorts numerically (zip entry order is lexicographic, so
 * slide10.xml sorts before slide2.xml without this).
 *
 * Images, video, and audio are NOT handled here. That needs OCR /
 * transcription — a materially bigger dependency, and often a model
 * call rather than a local library — and was scoped out as a separate
 * phase in the original architecture audit, not attempted here.
 */
import AdmZip           from 'adm-zip';
import { PDFParse }     from 'pdf-parse';
import mammoth          from 'mammoth';
import * as XLSX        from 'xlsx';

// Raw byte ceiling BEFORE extraction. Intentionally more generous than
// fileIngester.js's MAX_FILE_SIZE (100KB), which caps EXTRACTED TEXT
// afterward — same truncation every other file type already goes
// through. Two independent caps: one on what we're willing to spend
// CPU/memory parsing, one on what we're willing to inject as context.
const MAX_DOCUMENT_BYTES = 15_000_000; // 15MB

export const DOCUMENT_EXTS = new Set(['.pdf', '.docx', '.pptx', '.xlsx']);

export function isDocumentExt(ext) {
  return DOCUMENT_EXTS.has(ext);
}

// ── PDF (pdf-parse v2 — constructor + async getText(), not the v1 pdf(buffer) API) ──

async function parsePdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { text: result.text.trim(), pages: result.total ?? null };
  } finally {
    await parser.destroy(); // required — frees the underlying worker/memory
  }
}

// ── DOCX ──────────────────────────────────────────────────────────────────────

async function parseDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return { text: result.value.trim(), warnings: result.messages.length };
}

// ── XLSX ──────────────────────────────────────────────────────────────────────

async function parseXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets = workbook.SheetNames.map(name => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]).trim();
    return `-- Sheet: ${name} --\n${csv}`;
  }).filter(s => !s.endsWith('--')); // drop genuinely empty sheets (header line only, no rows, produces '')

  return { text: sheets.join('\n\n').trim(), sheetCount: workbook.SheetNames.length };
}

// ── PPTX (hand-rolled: glob ppt/slides/slideN.xml via the existing adm-zip dep) ──

const SLIDE_PATH_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const TEXT_RUN_RE   = /<a:t[^>]*>(.*?)<\/a:t>/gs;

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // last — must not re-decode entities produced by the others
}

function parsePptx(buffer) {
  const zip = new AdmZip(buffer);

  const slides = zip.getEntries()
    .map(entry => ({ match: entry.entryName.match(SLIDE_PATH_RE), entry }))
    .filter(x => x.match)
    .map(({ match, entry }) => ({
      num: parseInt(match[1], 10),           // numeric, not lexicographic — slide10 must sort after slide2
      xml: entry.getData().toString('utf8'),
    }))
    .sort((a, b) => a.num - b.num)
    .map(({ num, xml }) => {
      const runs = [...xml.matchAll(TEXT_RUN_RE)].map(m => decodeXmlEntities(m[1]));
      const text = runs.join(' ').replace(/\s+/g, ' ').trim();
      return { num, text };
    })
    .filter(s => s.text.length > 0)          // skip slides with no text runs (image-only, etc.)
    .map(s => `-- Slide ${s.num} --\n${s.text}`);

  return { text: slides.join('\n\n').trim(), slideCount: slides.length };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Extract text from a document buffer, dispatched by extension.
 *
 * @param {string} ext     - lowercase extension including the dot, e.g. '.pdf'
 * @param {Buffer} buffer  - raw file bytes (already base64-decoded by the caller)
 * @returns {Promise<{ text: string, meta: object } | null>} null if ext isn't one of DOCUMENT_EXTS
 * @throws if the buffer exceeds MAX_DOCUMENT_BYTES, or the underlying library can't parse it
 *         (corrupt file, password-protected, etc.) — caller decides how to handle (see
 *         fileIngester.js, which skips the single file and continues the batch)
 */
export async function parseDocument(ext, buffer) {
  if (!DOCUMENT_EXTS.has(ext)) return null;

  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new Error(`Document exceeds ${MAX_DOCUMENT_BYTES}-byte limit (${buffer.length} bytes)`);
  }

  switch (ext) {
    case '.pdf': {
      const { text, pages } = await parsePdf(buffer);
      return { text, meta: { pages } };
    }
    case '.docx': {
      const { text, warnings } = await parseDocx(buffer);
      return { text, meta: { warnings } };
    }
    case '.xlsx': {
      const { text, sheetCount } = await parseXlsx(buffer);
      return { text, meta: { sheetCount } };
    }
    case '.pptx': {
      const { text, slideCount } = parsePptx(buffer);
      return { text, meta: { slideCount } };
    }
    /* istanbul ignore next -- unreachable: ext already checked against DOCUMENT_EXTS above */
    default:
      return null;
  }
}
