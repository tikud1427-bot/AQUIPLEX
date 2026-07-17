/**
 * AQUA Document Pipeline — Day 5
 *
 * Wraps + extends project/documentParser.js (PDF/DOCX/PPTX/XLSX, unchanged)
 * with three new formats — CSV, ODT, EPUB — and normalizes EVERY document
 * into one shape the rest of the platform consumes:
 *
 *   {
 *     title:     string,          // best-effort (metadata > filename)
 *     format:    string,          // 'pdf' | 'docx' | ... 
 *     metadata:  object,          // pages / sheets / slides / warnings / ...
 *     content:   string,          // full extracted text (capped)
 *     pages:     number|null,
 *     sections:  [{ heading, text }],  // coarse structural split
 *     language:  string|null,     // cheap heuristic, null when unsure
 *     truncated: boolean,
 *   }
 *
 * ODT and EPUB reuse adm-zip (already a dependency) — both are ZIP
 * containers of XML/XHTML. No new dependencies.
 */
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { parseDocument, isDocumentExt as isCoreDocumentExt } from '../project/documentParser.js';
import { analyzeMediaWithGemini } from '../providers/gemini.js';

const MAX_CONTENT_CHARS = 200_000; // richer than code files (100 KB) — documents ARE the content
export const PIPELINE_DOCUMENT_EXTS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.odt', '.epub']);

// ── Scanned-PDF OCR fallback (P0 — "PDFs are sometimes unreadable") ──────────
// pdf-parse extracts the TEXT LAYER only. A scanned/image-only PDF has none,
// but the extractor still emits page separator lines ("-- 1 of 3 --"), so the
// old `!text.trim()` guard PASSED and the attachment silently carried nothing
// but markers — the model then "couldn't read" the PDF. Detection: strip the
// markers; if what remains is below a small floor, the PDF is treated as
// scanned and routed through the SAME Gemini vision call images already use
// (Gemini accepts application/pdf inline), which OCRs every page. No Gemini
// key / oversize → a clear, user-readable error instead of silent garbage.
const PAGE_MARKER_RE     = /^--\s*\d+\s*of\s*\d+\s*--$/gm;
const MIN_REAL_TEXT      = 40;            // chars of non-marker text to count as "has a text layer"
const MAX_OCR_PDF_BYTES  = 12_000_000;    // same inline-payload ceiling as images

const PDF_OCR_PROMPT = `This PDF is a scanned document with no text layer. Read it page by page. Respond in exactly this structure:

TITLE: best-guess document title.

TEXT (OCR): every piece of readable text, verbatim, page by page, preserving structure. Prefix each page with "-- Page N --".

TABLES: any tabular data, reconstructed row by row. Write "none" if there are no tables.

NOTES: stamps, signatures, handwriting, logos, or unreadable regions worth flagging. Write "none" if not applicable.`;

// OCR result cache (content-addressed, same pattern as mediaPipeline) —
// re-uploading the identical scanned PDF never pays for a second model call.
const OCR_CACHE_MAX = 30;
const ocrCache = new Map(); // sha256 → { text, meta }
function ocrCacheKey(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function ocrCacheSet(key, val) {
  if (ocrCache.size >= OCR_CACHE_MAX) ocrCache.delete(ocrCache.keys().next().value); // FIFO evict
  ocrCache.set(key, val);
}

function textWithoutPageMarkers(text) {
  return String(text ?? '').replace(PAGE_MARKER_RE, '').trim();
}

async function ocrScannedPdf(filename, buffer, pages, ocrFn) {
  if (buffer.length > MAX_OCR_PDF_BYTES) {
    throw new Error(`"${filename}" appears to be a scanned PDF (no selectable text) and is ${(buffer.length / 1e6).toFixed(1)} MB — over the ${MAX_OCR_PDF_BYTES / 1e6} MB OCR limit. Export it with a text layer or split it and retry.`);
  }
  const key = ocrCacheKey(buffer);
  const cached = ocrCache.get(key);
  if (cached) {
    console.log(`[UPLOAD] Scanned PDF OCR cache hit file=${filename}`);
    return cached;
  }
  let analysis;
  try {
    analysis = await ocrFn(
      [
        { inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') } },
        { text: PDF_OCR_PROMPT },
      ],
      {
        systemPrompt: 'You are a precise OCR engine. Transcribe text verbatim. Follow the requested structure exactly.',
        maxTokens: 8192,
      },
    );
  } catch (err) {
    throw new Error(`"${filename}" is a scanned PDF (no selectable text) and OCR failed: ${err.message}`);
  }
  const text = analysis?.text?.trim();
  if (!text) throw new Error(`"${filename}" is a scanned PDF and OCR returned no text.`);
  console.log(`[UPLOAD] Scanned PDF OCR ok file=${filename} pages=${pages ?? '?'} chars=${text.length} model=${analysis.model ?? '?'}`);
  const out = { text, meta: { pages, ocr: true, model: analysis.model ?? null } };
  ocrCacheSet(key, out);
  return out;
}

export function isPipelineDocumentExt(ext) {
  return PIPELINE_DOCUMENT_EXTS.has(ext);
}

// ── XML text extraction helpers ───────────────────────────────────────────────

function stripXml(xml) {
  return xml
    .replace(/<text:line-break[^>]*\/>/g, '\n')
    .replace(/<text:p[^>]*>/g, '\n')
    .replace(/<\/text:p>/g, '')
    .replace(/<(p|div|br|h[1-6]|li|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── ODT ───────────────────────────────────────────────────────────────────────

function parseOdt(buffer) {
  const zip = new AdmZip(buffer);
  const contentEntry = zip.getEntry('content.xml');
  if (!contentEntry) throw new Error('Invalid ODT: content.xml missing');
  const text = stripXml(contentEntry.getData().toString('utf8'));

  let title = null;
  const metaEntry = zip.getEntry('meta.xml');
  if (metaEntry) {
    const m = metaEntry.getData().toString('utf8').match(/<dc:title>([^<]*)<\/dc:title>/);
    if (m) title = m[1].trim() || null;
  }
  return { text, meta: { title } };
}

// ── EPUB ──────────────────────────────────────────────────────────────────────

function parseEpub(buffer) {
  const zip = new AdmZip(buffer);

  // Locate the OPF via META-INF/container.xml (per spec); fall back to globbing.
  let opfPath = null;
  const container = zip.getEntry('META-INF/container.xml');
  if (container) {
    const m = container.getData().toString('utf8').match(/full-path="([^"]+)"/);
    if (m) opfPath = m[1];
  }
  const opfEntry = opfPath ? zip.getEntry(opfPath) : zip.getEntries().find(e => e.entryName.endsWith('.opf'));
  if (!opfEntry) throw new Error('Invalid EPUB: package (.opf) file missing');

  const opfXml = opfEntry.getData().toString('utf8');
  const opfDir = path.posix.dirname(opfEntry.entryName);

  const titleMatch = opfXml.match(/<dc:title[^>]*>([^<]*)<\/dc:title>/);
  const title = titleMatch ? titleMatch[1].trim() : null;

  // Spine order: itemrefs → manifest hrefs
  const manifest = {};
  for (const m of opfXml.matchAll(/<item\s+[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*>/g)) {
    manifest[m[1]] = m[2];
  }
  // Attribute order varies — second pass with href before id
  for (const m of opfXml.matchAll(/<item\s+[^>]*href="([^"]+)"[^>]*id="([^"]+)"[^>]*>/g)) {
    manifest[m[2]] = manifest[m[2]] ?? m[1];
  }
  const spineIds = [...opfXml.matchAll(/<itemref\s+[^>]*idref="([^"]+)"/g)].map(m => m[1]);

  const chapters = [];
  for (const id of spineIds) {
    const href = manifest[id];
    if (!href || !/\.x?html?$/i.test(href)) continue;
    const entryName = opfDir === '.' ? href : path.posix.join(opfDir, href);
    const entry = zip.getEntry(entryName) ?? zip.getEntry(decodeURIComponent(entryName));
    if (!entry) continue;
    const chapterText = stripXml(entry.getData().toString('utf8'));
    if (chapterText) chapters.push(chapterText);
  }

  if (!chapters.length) throw new Error('EPUB contains no readable chapters');
  return { text: chapters.join('\n\n'), meta: { title, chapters: chapters.length } };
}

// ── CSV (text passthrough with light structure) ───────────────────────────────

function parseCsv(buffer) {
  const text = buffer.toString('utf8').trim();
  if (!text) throw new Error('CSV is empty');
  const lines = text.split(/\r?\n/);
  return { text, meta: { rows: lines.length, columns: (lines[0] ?? '').split(',').length } };
}

// ── Section splitting + language heuristic ────────────────────────────────────

function splitSections(text) {
  // Coarse: page/slide/sheet markers already embedded by the core parser,
  // otherwise blank-line paragraphs grouped into ≤10 sections.
  const markerRe = /^-- (Page|Slide|Sheet)[^\n]*--$/m;
  if (markerRe.test(text)) {
    return text.split(/^(?=-- (?:Page|Slide|Sheet))/m)
      .map(chunk => {
        const [first, ...rest] = chunk.split('\n');
        return { heading: first.trim(), text: rest.join('\n').trim() };
      })
      .filter(s => s.text)
      .slice(0, 100);
  }
  const paras = text.split(/\n{2,}/).filter(Boolean);
  const per = Math.max(1, Math.ceil(paras.length / 10));
  const sections = [];
  for (let i = 0; i < paras.length; i += per) {
    sections.push({ heading: null, text: paras.slice(i, i + per).join('\n\n') });
  }
  return sections;
}

const LANG_MARKERS = [
  ['en', /\b(the|and|of|to|is|in|that|for|with)\b/gi],
  ['es', /\b(el|la|de|que|y|los|las|una|para)\b/gi],
  ['fr', /\b(le|la|les|des|est|dans|pour|avec|une)\b/gi],
  ['de', /\b(der|die|das|und|ist|nicht|mit|für|ein)\b/gi],
  ['hi', /[\u0900-\u097F]/g],
  ['zh', /[\u4E00-\u9FFF]/g],
];

function detectLanguage(text) {
  const sample = text.slice(0, 4000);
  let best = null, bestCount = 0;
  for (const [lang, re] of LANG_MARKERS) {
    const count = (sample.match(re) ?? []).length;
    if (count > bestCount) { best = lang; bestCount = count; }
  }
  return bestCount >= 5 ? best : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract + normalize any supported document.
 *
 * @param {string} filename
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {Function} [opts.ocr]  OCR fn (parts, cfg) → { text, model } — test seam;
 *                               defaults to the same Gemini call images use.
 * @returns {Promise<{ title, format, metadata, content, pages, sections, language, truncated }>}
 * @throws on unsupported ext / corrupt file / oversize / scanned-PDF-without-OCR (caller shows the message)
 */
export async function processDocument(filename, buffer, { ocr = analyzeMediaWithGemini } = {}) {
  const ext = path.extname(filename).toLowerCase();
  if (!PIPELINE_DOCUMENT_EXTS.has(ext)) {
    throw new Error(`Unsupported document format: ${ext || '(no extension)'}`);
  }

  let text, meta = {};

  if (isCoreDocumentExt(ext)) {
    // PDF / DOCX / PPTX / XLSX — reuse the existing extractor verbatim
    const extracted = await parseDocument(ext, buffer);
    text = extracted?.text ?? '';
    meta = extracted?.meta ?? {};

    // P0 — scanned/image-only PDF: the extractor emits page markers even
    // when there is NO text layer, so `text` is non-empty garbage. Detect
    // by stripping the markers; below the floor → OCR the pages instead of
    // silently attaching markers the model can't answer from.
    if (ext === '.pdf' && textWithoutPageMarkers(text).length < MIN_REAL_TEXT) {
      console.log(`[UPLOAD] "${filename}" has no usable text layer (${textWithoutPageMarkers(text).length} real chars) — routing to OCR`);
      ({ text, meta } = await ocrScannedPdf(filename, buffer, meta.pages ?? null, ocr));
    } else if (!text) {
      throw new Error('No extractable text found in document');
    }
  } else if (ext === '.csv') {
    ({ text, meta } = parseCsv(buffer));
  } else if (ext === '.odt') {
    ({ text, meta } = parseOdt(buffer));
  } else if (ext === '.epub') {
    ({ text, meta } = parseEpub(buffer));
  }

  if (!text?.trim()) throw new Error('Document contains no extractable text');

  let truncated = false;
  if (text.length > MAX_CONTENT_CHARS) {
    text = text.slice(0, MAX_CONTENT_CHARS) + '\n... [truncated]';
    truncated = true;
  }

  return {
    title:     meta.title ?? path.basename(filename),
    format:    ext.slice(1),
    metadata:  meta,
    content:   text,
    pages:     meta.pages ?? meta.slideCount ?? meta.sheetCount ?? meta.chapters ?? null,
    sections:  splitSections(text),
    language:  detectLanguage(text),
    truncated,
  };
}
