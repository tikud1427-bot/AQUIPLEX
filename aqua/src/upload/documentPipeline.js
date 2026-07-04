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
import AdmZip from 'adm-zip';
import { parseDocument, isDocumentExt as isCoreDocumentExt } from '../project/documentParser.js';

const MAX_CONTENT_CHARS = 200_000; // richer than code files (100 KB) — documents ARE the content
export const PIPELINE_DOCUMENT_EXTS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.odt', '.epub']);

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
 * @returns {Promise<{ title, format, metadata, content, pages, sections, language, truncated }>}
 * @throws on unsupported ext / corrupt file / oversize (caller shows the message)
 */
export async function processDocument(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  if (!PIPELINE_DOCUMENT_EXTS.has(ext)) {
    throw new Error(`Unsupported document format: ${ext || '(no extension)'}`);
  }

  let text, meta = {};

  if (isCoreDocumentExt(ext)) {
    // PDF / DOCX / PPTX / XLSX — reuse the existing extractor verbatim
    const extracted = await parseDocument(ext, buffer);
    if (!extracted?.text) throw new Error('No extractable text found in document');
    text = extracted.text;
    meta = extracted.meta ?? {};
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
