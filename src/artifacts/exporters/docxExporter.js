/**
 * AQUA Artifact Engine — DOCX Exporter (P2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Real Word documents via the `docx` package. Renders the SHARED document
 * block model (documentModel.js) — same JSON the pdf exporter consumes,
 * different renderer. docx is XML underneath, so full Unicode (Hindi,
 * anything) works with no WinAnsi caveat.
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType,
} from 'docx';
import { registerExporter } from './registry.js';
import { ensureExtension }  from './common.js';
import {
  DOCUMENT_SCHEMA_HINT, buildDocumentModel, validateDocumentModel,
} from './documentModel.js';

const GUIDANCE = 'A polished Word document: clear heading hierarchy, short paragraphs, bullets and tables where they genuinely help.';

const HEADING_LEVEL = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };

const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: 'D0D0D0' };
const CELL_BORDERS = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

function renderTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((cells, r) => new TableRow({
      tableHeader: r === 0,
      children: cells.map(text => new TableCell({
        borders: CELL_BORDERS,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({
          children: [new TextRun({ text, bold: r === 0, size: 20 })], // half-points → 10pt
        })],
      })),
    })),
  });
}

function renderBlocks(model) {
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text: model.title })],
    }),
  ];

  for (const block of model.blocks) {
    if (block.type === 'spacer') {
      children.push(new Paragraph({ text: '' }));
    } else if (block.type === 'heading') {
      children.push(new Paragraph({
        heading: HEADING_LEVEL[block.level] ?? HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
        children: [new TextRun({ text: block.text })],
      }));
    } else if (block.type === 'paragraph') {
      children.push(new Paragraph({
        spacing: { after: 160 },
        children: [new TextRun({ text: block.text, size: 22 })], // 11pt
      }));
    } else if (block.type === 'bullets') {
      for (const item of block.items) {
        children.push(new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 60 },
          children: [new TextRun({ text: item, size: 22 })],
        }));
      }
    } else if (block.type === 'table') {
      children.push(renderTable(block.rows));
      children.push(new Paragraph({ text: '' }));
    }
  }
  return children;
}

registerExporter('docx', {
  label: 'Word document',
  extensions: ['.docx'],
  mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  contentModel: 'document',
  guidance: GUIDANCE,
  schemaHint: DOCUMENT_SCHEMA_HINT, // P5 — model-edit prompts reuse the build schema

  async build({ spec, helpers }) {
    return buildDocumentModel({ spec, helpers, formatGuidance: GUIDANCE });
  },

  validate: validateDocumentModel,

  async export(model, { spec }) {
    const doc = new Document({
      creator: 'AQUA',
      title: model.title,
      sections: [{ children: renderBlocks(model) }],
    });
    const buffer = await Packer.toBuffer(doc);
    return {
      files: [{
        path: ensureExtension(spec.files[0].path, '.docx'),
        buffer,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }],
    };
  },
});

export {};
