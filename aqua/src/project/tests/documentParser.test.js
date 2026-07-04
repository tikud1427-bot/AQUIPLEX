/**
 * AQUA Document Parser — Tests
 *
 * Every fixture here is a real, valid file of its format — a hand-built
 * minimal PDF (correct xref table), a minimal DOCX/PPTX (adm-zip, the
 * OOXML skeleton each format needs), and an XLSX round-tripped through
 * SheetJS's own writer. These aren't mocks — parseDocument() runs its
 * real dependency (pdf-parse / mammoth / xlsx) against real bytes.
 */
import { test, describe } from 'node:test';
import assert              from 'node:assert/strict';
import AdmZip               from 'adm-zip';
import * as XLSX             from 'xlsx';

import { parseDocument, isDocumentExt, DOCUMENT_EXTS } from '../documentParser.js';

// ── Fixture builders ─────────────────────────────────────────────────────────

/** Minimal valid single-page PDF with one text string, correct xref offsets. */
function buildPdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 1000 200] /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 72 100 Td (${text}) Tj ET`;
  const streamObj = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  offsets.push(pdf.length);
  pdf += `5 0 obj\n${streamObj}\nendobj\n`;

  const xrefStart = pdf.length;
  let xref = `xref\n0 ${objects.length + 2}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `${String(offsets[objects.length + 1]).padStart(10, '0')} 00000 n \n`;
  pdf += xref;
  pdf += `trailer\n<< /Size ${objects.length + 2} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'binary');
}

/** Minimal valid DOCX: just enough of the OOXML skeleton for mammoth to read the body. */
function buildDocx(paragraphs) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const body = paragraphs.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(contentTypes));
  zip.addFile('_rels/.rels', Buffer.from(rootRels));
  zip.addFile('word/document.xml', Buffer.from(documentXml));
  return zip.toBuffer();
}

/** Minimal PPTX: only what parsePptx() actually reads — ppt/slides/slideN.xml. */
function buildPptx(slidesTexts) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
  ));
  slidesTexts.forEach((texts, i) => {
    const runs = texts.map(t => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody>${runs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    zip.addFile(`ppt/slides/slide${i + 1}.xml`, Buffer.from(xml));
  });
  return zip.toBuffer();
}

/** Real XLSX round-tripped through SheetJS's own writer. */
function buildXlsx(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── isDocumentExt / DOCUMENT_EXTS ─────────────────────────────────────────────

describe('isDocumentExt', () => {
  test('recognizes the four supported extensions', () => {
    for (const ext of ['.pdf', '.docx', '.pptx', '.xlsx']) assert.ok(isDocumentExt(ext), ext);
  });
  test('rejects everything else', () => {
    for (const ext of ['.png', '.zip', '.js', '.txt', '']) assert.ok(!isDocumentExt(ext), ext);
  });
  test('DOCUMENT_EXTS matches isDocumentExt exactly', () => {
    for (const ext of DOCUMENT_EXTS) assert.ok(isDocumentExt(ext));
  });
});

// ── PDF ────────────────────────────────────────────────────────────────────────

describe('parseDocument — PDF', () => {
  test('extracts real text from a valid PDF', async () => {
    const result = await parseDocument('.pdf', buildPdf('Hello AQUA PDF Test'));
    assert.ok(result.text.includes('Hello AQUA PDF Test'), result.text);
    assert.equal(result.meta.pages, 1);
  });

  test('rejects a corrupt PDF instead of returning garbage', async () => {
    await assert.rejects(() => parseDocument('.pdf', Buffer.from('not a real pdf')));
  });
});

// ── DOCX ──────────────────────────────────────────────────────────────────────

describe('parseDocument — DOCX', () => {
  test('extracts multiple paragraphs in order', async () => {
    const result = await parseDocument('.docx', buildDocx(['First paragraph.', 'Second paragraph.']));
    assert.ok(result.text.includes('First paragraph.'));
    assert.ok(result.text.includes('Second paragraph.'));
    assert.ok(result.text.indexOf('First') < result.text.indexOf('Second'), 'should preserve paragraph order');
  });

  test('rejects a corrupt DOCX instead of returning garbage', async () => {
    await assert.rejects(() => parseDocument('.docx', Buffer.from('not a real docx')));
  });
});

// ── PPTX ──────────────────────────────────────────────────────────────────────

describe('parseDocument — PPTX', () => {
  test('extracts slides in numeric order, not lexicographic', async () => {
    // 10 slides so slide10.xml would sort before slide2.xml as plain strings
    const texts = Array.from({ length: 10 }, (_, i) => [`Slide number ${i + 1}`]);
    const result = await parseDocument('.pptx', buildPptx(texts));
    const posOf = n => result.text.indexOf(`Slide number ${n}`);
    assert.ok(posOf(2) < posOf(10), 'slide 2 should come before slide 10 in the output');
    assert.equal(result.meta.slideCount, 10);
  });

  test('decodes XML entities in slide text', async () => {
    const result = await parseDocument('.pptx', buildPptx([['Rock &amp; Roll &lt;live&gt;']]));
    assert.ok(result.text.includes('Rock & Roll <live>'), result.text);
  });

  test('skips slides with no text runs', async () => {
    const result = await parseDocument('.pptx', buildPptx([['Only slide with text'], []]));
    assert.equal(result.meta.slideCount, 1);
  });
});

// ── XLSX ──────────────────────────────────────────────────────────────────────

describe('parseDocument — XLSX', () => {
  test('extracts every sheet as readable text', async () => {
    const result = await parseDocument('.xlsx', buildXlsx({
      Results: [['Name', 'Score'], ['Alice', 90], ['Bob', 85]],
      Notes:   [['A note about the results']],
    }));
    assert.ok(result.text.includes('Alice'));
    assert.ok(result.text.includes('90'));
    assert.ok(result.text.includes('A note about the results'));
    assert.equal(result.meta.sheetCount, 2);
  });
});

// ── Dispatcher ────────────────────────────────────────────────────────────────

describe('parseDocument — dispatcher', () => {
  test('returns null for an unsupported extension', async () => {
    assert.equal(await parseDocument('.txt', Buffer.from('hi')), null);
  });

  test('rejects a buffer over the size ceiling', async () => {
    const huge = Buffer.alloc(15_000_001);
    await assert.rejects(() => parseDocument('.pdf', huge), /byte limit/);
  });
});
