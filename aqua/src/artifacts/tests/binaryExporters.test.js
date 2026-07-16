/**
 * P2 binary exporters — offline round-trip proofs.
 * Every format is verified by RE-OPENING the produced buffer with an
 * independent reader: xlsx via XLSX.read, docx/pptx via adm-zip (they're
 * OOXML zips) with XML content assertions, pdf via pdf-lib load + page
 * count. Engine e2e runs per format with a stubbed provider.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import XLSX from 'xlsx';
import { PDFDocument } from 'pdf-lib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-artifact-binary-'));
process.env.AQUA_ARTIFACTS_DIR = TMP;

const store  = await import('../artifactStore.js');
const engine = await import('../engine.js'); // registers text + binary exporters
const { getExporter, listExporters } = await import('../exporters/registry.js');
const { cleanForCoverage } = await import('../exporters/documentModel.js');
const { PDF_FONT_COVERAGE } = await import('../exporters/pdfExporter.js');

before(() => store._resetForTests());
after(() => {
  store._resetForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const PK = [0x50, 0x4b, 0x03, 0x04];

// ── Registry ──────────────────────────────────────────────────────────────────

test('binary formats registered alongside text formats', () => {
  const ids = listExporters();
  for (const f of ['pptx', 'pdf', 'docx', 'xlsx']) assert.ok(ids.includes(f), f);
});

// ── Content models (fixtures) ─────────────────────────────────────────────────

const DOC_MODEL = {
  title: 'Q3 Report',
  blocks: [
    { type: 'heading', level: 1, text: 'Overview' },
    { type: 'paragraph', text: 'Revenue grew 42% quarter over quarter across all regions.' },
    { type: 'bullets', items: ['Launched AQUA v2', 'Signed 3 enterprise clients'] },
    { type: 'table', rows: [['Region', 'Revenue'], ['North', '12,00,000'], ['South', '9,50,000']] },
    { type: 'spacer' },
    { type: 'heading', level: 2, text: 'Outlook' },
    { type: 'paragraph', text: 'Pipeline remains strong going into Q4.' },
  ],
};

const SHEET_MODEL_JSON = {
  sheets: [
    { name: 'Budget', headers: ['Item', 'Cost'], rows: [['Rent', 12000], ['Cloud', 3400.5]] },
    { name: 'Team',   headers: ['Name', 'Role'], rows: [['Ananya', 'Tech Lead']] },
  ],
};

const SLIDES_MODEL_JSON = {
  title: 'AQUA Investor Deck',
  subtitle: 'The AI Operating Layer for India',
  theme: 'dark',
  slides: [
    { title: 'Problem', bullets: ['Frontier models are unaffordable at Indian price points'], notes: 'Open with the cost story.' },
    { title: 'Solution', bullets: ['AQUA routes across providers', 'Learned quality priors'], notes: '' },
  ],
};

// ── xlsx: write → XLSX.read round-trip ────────────────────────────────────────

test('xlsx: workbook round-trips through an independent read', async () => {
  const x = getExporter('xlsx');
  const spec = { format: 'xlsx', title: 'Budget', files: [{ path: 'budget.xlsx' }], packaging: 'auto' };
  const model = await x.build({ spec, helpers: { generateJson: async () => SHEET_MODEL_JSON } });
  assert.equal(x.validate(model).valid, true);

  const { files } = await x.export(model, { spec });
  assert.equal(files[0].path, 'budget.xlsx');
  assert.deepEqual([...files[0].buffer.subarray(0, 4)], PK);

  const wb = XLSX.read(files[0].buffer, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Budget', 'Team']);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Budget, { header: 1 });
  assert.deepEqual(rows[0], ['Item', 'Cost']);
  assert.equal(rows[1][1], 12000); // numbers stayed numbers
});

test('xlsx: hostile sheet names sanitized + deduped, ext enforced', async () => {
  const x = getExporter('xlsx');
  const spec = { format: 'xlsx', title: 'X', files: [{ path: 'data.txt' }], packaging: 'auto' };
  const model = await x.build({ spec, helpers: { generateJson: async () => ({
    sheets: [
      { name: 'Bad[Name]:*?', headers: ['A'], rows: [['1']] },
      { name: 'Bad Name', headers: ['B'], rows: [['2']] },
    ],
  }) } });
  const { files } = await x.export(model, { spec });
  assert.equal(files[0].path, 'data.xlsx');
  const wb = XLSX.read(files[0].buffer, { type: 'buffer' });
  assert.equal(wb.SheetNames.length, 2);
  assert.ok(wb.SheetNames.every(n => !/[[\]:*?/\\]/.test(n)), wb.SheetNames.join(','));
  assert.notEqual(wb.SheetNames[0].toLowerCase(), wb.SheetNames[1].toLowerCase());
});

// ── docx: write → unzip → document.xml assertions ─────────────────────────────

test('docx: document round-trips (OOXML zip, content present, Unicode intact)', async () => {
  const d = getExporter('docx');
  const spec = { format: 'docx', title: 'Q3', files: [{ path: 'report.docx' }], packaging: 'auto' };
  const hindiModel = {
    ...DOC_MODEL,
    blocks: [...DOC_MODEL.blocks, { type: 'paragraph', text: 'राजस्व में 42% वृद्धि हुई' }],
  };
  const model = await d.build({ spec, helpers: { generateJson: async () => hindiModel } });
  assert.equal(d.validate(model).valid, true, 'docx takes full Unicode');

  const { files } = await d.export(model, { spec });
  assert.deepEqual([...files[0].buffer.subarray(0, 4)], PK);

  const zip = new AdmZip(files[0].buffer);
  const xml = zip.readAsText('word/document.xml');
  assert.ok(xml.includes('Q3 Report'));
  assert.ok(xml.includes('Launched AQUA v2'));
  assert.ok(xml.includes('राजस्व'), 'Hindi text survives in docx');
  assert.ok(xml.includes('<w:tbl>'), 'table rendered');
});

// ── pdf: write → pdf-lib load ─────────────────────────────────────────────────

test('pdf: renders, paginates, loads back with pdf-lib', async () => {
  const p = getExporter('pdf');
  const spec = { format: 'pdf', title: 'Q3', files: [{ path: 'report.pdf' }], packaging: 'auto' };
  // Enough paragraphs to force pagination past one A4 page.
  const longModel = {
    title: 'Q3 Report',
    blocks: Array.from({ length: 60 }, (_, i) => ({
      type: 'paragraph',
      text: `Paragraph ${i + 1}: revenue and pipeline commentary long enough to wrap across the content width of an A4 page with margins.`,
    })),
  };
  const model = await p.build({ spec, helpers: { generateJson: async () => longModel } });
  assert.equal(p.validate(model).valid, true);

  const { files } = await p.export(model, { spec });
  assert.equal(files[0].mime, 'application/pdf');
  assert.equal(files[0].buffer.subarray(0, 5).toString('ascii'), '%PDF-');

  const loaded = await PDFDocument.load(files[0].buffer);
  assert.ok(loaded.getPageCount() >= 2, `expected pagination, got ${loaded.getPageCount()} page(s)`);
});

test('pdf: coverage guard — ₹/Cyrillic/accents pass, Indic scripts fail loudly (P6)', async () => {
  const p = getExporter('pdf');
  // Coverage check: smart punctuation, rupee, Cyrillic, accents — all IN DejaVu
  const kept = cleanForCoverage('“Smart” — ₹499 café Дом …done', PDF_FONT_COVERAGE);
  assert.equal(kept.lossRatio, 0, 'nothing lost');
  assert.ok(kept.text.includes('₹499') && kept.text.includes('Дом') && kept.text.includes('“Smart”'));

  // Hindi content must STILL fail pdf validation (shaping, not coverage —
  // docx path handles it instead)
  const hindi = {
    title: 'रिपोर्ट',
    blocks: [{ type: 'paragraph', text: 'यह पूरी रिपोर्ट हिंदी में लिखी गई है और इसमें कोई लैटिन पाठ नहीं है' }],
  };
  const v = p.validate(hindi);
  assert.equal(v.valid, false);
  assert.match(v.errors[0], /coverage|shaping/);
  assert.match(v.errors[0], /\.docx/, 'points the user at the format that works');
});

// ── pptx: write → unzip → slide XML assertions ────────────────────────────────

test('pptx: deck round-trips (cover + content slides + notes)', async () => {
  const px = getExporter('pptx');
  const spec = { format: 'pptx', title: 'Deck', files: [{ path: 'deck.pptx' }], packaging: 'auto' };
  const model = await px.build({ spec, helpers: { generateJson: async () => SLIDES_MODEL_JSON } });
  assert.equal(px.validate(model).valid, true);
  assert.equal(model.theme, 'dark');

  const { files } = await px.export(model, { spec });
  assert.deepEqual([...files[0].buffer.subarray(0, 4)], PK);

  const zip = new AdmZip(files[0].buffer);
  const names = zip.getEntries().map(e => e.entryName);
  const slideXmls = names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.equal(slideXmls.length, 3, 'cover + 2 content slides');
  const allSlides = slideXmls.map(n => zip.readAsText(n)).join('');
  assert.ok(allSlides.includes('AQUA Investor Deck'));
  assert.ok(allSlides.includes('Problem'));
  const notes = names.filter(n => /^ppt\/notesSlides\//.test(n)).map(n => zip.readAsText(n)).join('');
  assert.ok(notes.includes('cost story'), 'speaker notes present');
});

// ── Engine e2e per binary format (stubbed provider) ───────────────────────────

function makeGenerate(planJson, modelJson) {
  return async (_u, systemPrompt) => {
    if (systemPrompt.includes('Artifact Planner')) return { text: JSON.stringify(planJson), provider: 'stub' };
    return { text: JSON.stringify(modelJson), provider: 'stub-builder' };
  };
}

test('engine e2e: pptx turn produces a stored .pptx with correct mime', async () => {
  const res = await engine.execute({
    userMessage: 'Create an investor pitch deck for AQUA',
    prep: {}, intent: { wants: true, format: 'pptx', confidence: 0.9 },
    ownerId: 'user:u1', conversationId: 'c-bin', requestId: 'req-b1',
    generate: makeGenerate(
      { format: 'pptx', title: 'AQUA Deck', files: [{ path: 'deck.pptx', role: 'primary' }], packaging: 'auto' },
      SLIDES_MODEL_JSON,
    ),
  });
  assert.equal(res.manifest.format, 'pptx');
  assert.equal(res.manifest.packaging, 'raw');
  assert.match(res.manifest.files[0].mime, /presentationml/);

  const onDisk = await store.getArtifact(res.manifest.id);
  const buf = fs.readFileSync(store.getFileAbsolutePath(onDisk, 'deck.pptx'));
  assert.deepEqual([...buf.subarray(0, 4)], PK);
});

test('engine e2e: xlsx turn — planner drift to txt path still lands as .xlsx', async () => {
  const res = await engine.execute({
    userMessage: 'Generate a spreadsheet with a financial model',
    prep: {}, intent: { wants: true, format: 'xlsx', confidence: 0.9 },
    ownerId: 'user:u1', conversationId: 'c-bin', requestId: 'req-b2',
    generate: makeGenerate(
      { format: 'xlsx', title: 'Model', files: [{ path: 'model.txt', role: 'primary' }], packaging: 'auto' },
      SHEET_MODEL_JSON,
    ),
  });
  assert.equal(res.manifest.files[0].path, 'model.xlsx');
  const onDisk = await store.getArtifact(res.manifest.id);
  const wb = XLSX.read(fs.readFileSync(store.getFileAbsolutePath(onDisk, 'model.xlsx')), { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Budget', 'Team']);
});
