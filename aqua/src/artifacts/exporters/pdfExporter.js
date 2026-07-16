/**
 * AQUA Artifact Engine — PDF Exporter (P2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Real PDFs via pdf-lib, rendering the SHARED document block model
 * (documentModel.js — same JSON the docx exporter consumes). pdf-lib is
 * deliberately low-level (no text flow), so this module carries a small
 * layout engine: word-wrap against real font metrics, cursor/pagination,
 * hanging bullet indents, bordered tables, page-number footers.
 *
 * KNOWN LIMIT (P2): StandardFonts encode WinAnsi only. Smart punctuation is
 * mapped to ASCII; if meaningful content (>15% of characters — Hindi, CJK…)
 * would be lost, validate() FAILS the export and the turn falls back to
 * chat — honest beats a PDF full of holes. Unicode font embedding
 * (@pdf-lib/fontkit + bundled TTF) is the tracked P6 item; docx already
 * handles full Unicode today.
 */
import fs from 'fs';
import { createRequire } from 'module';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { registerExporter } from './registry.js';
import { ensureExtension }  from './common.js';
import {
  DOCUMENT_SCHEMA_HINT, buildDocumentModel, validateDocumentModel, cleanForCoverage,
} from './documentModel.js';

// ── Embedded font (P6): DejaVu Sans — Latin + Latin-Ext + Cyrillic + Greek
//    + ₹ and ~5,900 glyphs, shipped as a data-only npm package. Parsed once
//    at module load; coverage drives validate(), bytes drive export().
//    Indic/CJK stay excluded: those scripts need TEXT SHAPING (conjuncts,
//    matra reordering) that pdf-lib cannot do — embedding a font would
//    render them WRONG, so the loss guard still routes them to docx.
const _require = createRequire(import.meta.url);
const FONT_BYTES = {
  regular: fs.readFileSync(_require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')),
  bold:    fs.readFileSync(_require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf')),
};
export const PDF_FONT_COVERAGE = new Set(fontkit.create(FONT_BYTES.regular).characterSet);

const GUIDANCE = 'A clean professional PDF: clear heading hierarchy, short paragraphs, bullets and simple tables where they help. Latin/Cyrillic/Greek scripts and symbols like the rupee sign are supported; for Indic or CJK scripts produce a Word document instead.';

const MAX_LOSS_RATIO = 0.15;

// ── Page geometry (A4) ────────────────────────────────────────────────────────
const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK    = rgb(0.12, 0.12, 0.13);
const SOFT   = rgb(0.45, 0.45, 0.48);
const RULE   = rgb(0.82, 0.82, 0.84);
const ACCENT = rgb(0.42, 0.36, 0.91);

const SIZES = {
  title:    { size: 24, lead: 1.25, boldFont: true, after: 14 },
  heading1: { size: 17, lead: 1.3,  boldFont: true, before: 16, after: 8 },
  heading2: { size: 14, lead: 1.3,  boldFont: true, before: 12, after: 6 },
  heading3: { size: 12, lead: 1.3,  boldFont: true, before: 10, after: 5 },
  body:     { size: 10.5, lead: 1.45, after: 8 },
  cell:     { size: 9.5,  lead: 1.3 },
};

// ── Layout engine ─────────────────────────────────────────────────────────────

function wrapText(text, font, size, maxWidth) {
  const lines = [];
  for (const rawLine of String(text).split('\n')) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const word of words) {
      const probe = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(probe, size) <= maxWidth || !line) {
        line = probe;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

class PdfWriter {
  constructor(doc, fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.page = null;
    this.y = 0;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  need(height) {
    if (this.y - height < MARGIN + 14) this.newPage(); // 14 → footer clearance
  }

  textBlock(text, { size, lead, boldFont = false, before = 0, after = 0, indent = 0, hang = '', color = INK }) {
    const font = boldFont ? this.fonts.bold : this.fonts.regular;
    const lineH = size * lead;
    this.y -= before;
    const maxW = CONTENT_W - indent - (hang ? this.fonts.regular.widthOfTextAtSize(hang, size) : 0);
    const lines = wrapText(text, font, size, maxW);
    for (let i = 0; i < lines.length; i++) {
      this.need(lineH);
      let x = MARGIN + indent;
      if (hang) {
        if (i === 0) this.page.drawText(hang, { x, y: this.y - size, size, font: this.fonts.regular, color });
        x += this.fonts.regular.widthOfTextAtSize(hang, size);
      }
      if (lines[i]) this.page.drawText(lines[i], { x, y: this.y - size, size, font, color });
      this.y -= lineH;
    }
    this.y -= after;
  }

  rule(color = RULE, thickness = 0.7) {
    this.need(8);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y },
      thickness, color,
    });
    this.y -= 8;
  }

  table(rows) {
    const cols = Math.max(...rows.map(r => r.length));
    const colW = CONTENT_W / cols;
    const { size, lead } = SIZES.cell;
    const padX = 5, padY = 4;

    for (let r = 0; r < rows.length; r++) {
      const isHeader = r === 0;
      const font = isHeader ? this.fonts.bold : this.fonts.regular;
      const cellLines = rows[r].map(c => wrapText(c, font, size, colW - padX * 2));
      const rowH = Math.max(...cellLines.map(l => l.length), 1) * size * lead + padY * 2;
      this.need(rowH + 2);

      if (isHeader) {
        this.page.drawRectangle({
          x: MARGIN, y: this.y - rowH, width: CONTENT_W, height: rowH,
          color: rgb(0.955, 0.955, 0.97),
        });
      }
      for (let c = 0; c < cols; c++) {
        const lines = cellLines[c] ?? [''];
        let ty = this.y - padY - size;
        for (const line of lines) {
          if (line) this.page.drawText(line, { x: MARGIN + c * colW + padX, y: ty, size, font, color: INK });
          ty -= size * lead;
        }
      }
      this.page.drawLine({
        start: { x: MARGIN, y: this.y - rowH }, end: { x: PAGE_W - MARGIN, y: this.y - rowH },
        thickness: 0.6, color: RULE,
      });
      this.y -= rowH;
    }
    this.y -= 8;
  }

  footers() {
    const pages = this.doc.getPages();
    pages.forEach((page, i) => {
      const label = `${i + 1} / ${pages.length}`;
      const w = this.fonts.regular.widthOfTextAtSize(label, 8.5);
      page.drawText(label, { x: (PAGE_W - w) / 2, y: MARGIN / 2, size: 8.5, font: this.fonts.regular, color: SOFT });
    });
  }
}

// ── Model → WinAnsi-clean model (with loss accounting) ────────────────────────

function cleanModelForPdf(model) {
  let considered = 0, lost = 0;
  const clean = (s) => {
    const r = cleanForCoverage(s, PDF_FONT_COVERAGE);
    const chars = String(s).replace(/\s/g, '').length;
    considered += chars;
    lost += Math.round(r.lossRatio * chars);
    return r.text;
  };
  const blocks = model.blocks.map(b => {
    if (b.type === 'heading')   return { ...b, text: clean(b.text) };
    if (b.type === 'paragraph') return { ...b, text: clean(b.text) };
    if (b.type === 'bullets')   return { ...b, items: b.items.map(clean) };
    if (b.type === 'table')     return { ...b, rows: b.rows.map(r => r.map(clean)) };
    return b;
  });
  return { model: { title: clean(model.title), blocks }, lossRatio: considered ? lost / considered : 0 };
}

// ── Exporter ──────────────────────────────────────────────────────────────────

registerExporter('pdf', {
  label: 'PDF document',
  extensions: ['.pdf'],
  mimes: ['application/pdf'],
  contentModel: 'document',
  guidance: GUIDANCE,
  schemaHint: DOCUMENT_SCHEMA_HINT, // P5 — model-edit prompts reuse the build schema

  async build({ spec, helpers }) {
    return buildDocumentModel({ spec, helpers, formatGuidance: GUIDANCE });
  },

  validate(model) {
    const base = validateDocumentModel(model);
    if (!base.valid) return base;
    const { lossRatio } = cleanModelForPdf(model);
    if (lossRatio > MAX_LOSS_RATIO) {
      return {
        valid: false,
        errors: [`content is ${(lossRatio * 100).toFixed(0)}% outside the PDF font's coverage (Indic/CJK scripts need text shaping) — a Word (.docx) artifact supports all languages today`],
      };
    }
    return base;
  },

  async export(model, { spec }) {
    const { model: m } = cleanModelForPdf(model);
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    doc.setTitle(m.title);
    doc.setProducer('AQUA Artifact Engine');
    const fonts = {
      regular: await doc.embedFont(FONT_BYTES.regular, { subset: true }),
      bold:    await doc.embedFont(FONT_BYTES.bold,    { subset: true }),
    };
    const w = new PdfWriter(doc, fonts);

    w.textBlock(m.title, SIZES.title);
    w.page.drawLine({
      start: { x: MARGIN, y: w.y }, end: { x: MARGIN + 64, y: w.y },
      thickness: 2.5, color: ACCENT,
    });
    w.y -= 16;

    for (const block of m.blocks) {
      if (block.type === 'spacer')         w.y -= 10;
      else if (block.type === 'heading')   w.textBlock(block.text, SIZES[`heading${block.level}`] ?? SIZES.heading2);
      else if (block.type === 'paragraph') w.textBlock(block.text, SIZES.body);
      else if (block.type === 'bullets') {
        for (const item of block.items) w.textBlock(item, { ...SIZES.body, after: 3, indent: 10, hang: '\u2022  ' });
        w.y -= 5;
      }
      else if (block.type === 'table')     w.table(block.rows);
    }

    w.footers();
    const buffer = Buffer.from(await doc.save());
    return {
      files: [{ path: ensureExtension(spec.files[0].path, '.pdf'), buffer, mime: 'application/pdf' }],
    };
  },
});

export {};
