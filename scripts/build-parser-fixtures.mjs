#!/usr/bin/env node
/**
 * AQUA Parser Fixture Builder — Blueprint E1/PR-1
 *
 * WHY THIS EXISTS
 * ---------------
 * Two of our parser dependencies are scheduled for replacement (E1/PR-2 swaps
 * `xlsx`, E1/PR-3 swaps or bounds `adm-zip`). Both swaps are only safe if we
 * can prove the replacement reads the SAME BYTES to the SAME TEXT.
 *
 * We could not prove that before this file existed, because the existing
 * parser tests build their fixtures with the very libraries under replacement:
 *
 *     documentParser.test.js:  buildDocx() → new AdmZip()
 *                              buildPptx() → new AdmZip()
 *                              buildXlsx() → XLSX.write()
 *
 * Swap the library and the fixture changes with it. "Parity" measured against
 * a moving input is not parity — it is two unknowns compared to each other.
 *
 * So the fixtures are FROZEN BYTES on disk, and this script is the only thing
 * that produces them. It uses no third-party dependency at all: ZIP, TAR and
 * the OOXML/ODF/EPUB skeletons are written here by hand against their format
 * specs, using nothing but `node:zlib` and `node:crypto`.
 *
 * DETERMINISM
 * -----------
 * Every structural byte is fixed: entry order, DOS timestamps (1980-01-01),
 * external attributes, version fields. Running this script twice produces
 * byte-identical output, and `parserBaseline.test.js` asserts exactly that by
 * rebuilding in-process and comparing against the committed files.
 *
 * The one exception is deliberate and declared. Fixtures whose payload is
 * DEFLATE- or GZIP-compressed depend on the zlib shipped with the running Node
 * build, so their bytes are not guaranteed identical across Node majors. Those
 * carry `zlibDependent: true` in the manifest; the test still checks their
 * committed hash (integrity) but does not require the rebuild to match
 * (reproducibility). Honest guarantee beats a flaky one.
 *
 * USAGE
 *   node scripts/build-parser-fixtures.mjs            # rebuild fixtures + manifest
 *   node scripts/build-parser-fixtures.mjs --golden   # …and re-record golden.json
 *   node scripts/build-parser-fixtures.mjs --check    # verify only, write nothing
 *
 * `--golden` runs the real parsers over the fixtures and rewrites the expected
 * output snapshot. Regenerating goldens is how an INTENTIONAL behaviour change
 * gets recorded; the diff it produces is the thing a reviewer must justify.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const FIXTURE_DIR = path.join(ROOT, 'src/upload/tests/fixtures');

/** Bump when the fixture SPEC changes. A bump invalidates every hash below. */
export const SPEC_VERSION = 1;

// ── CRC-32 (ZIP requires it; no dependency worth taking for 12 lines) ─────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── ZIP writer ────────────────────────────────────────────────────────────────
//
// Local header → …entries… → central directory → EOCD. Fixed DOS date/time of
// 1980-01-01 00:00:00 (dosDate 0x0021, dosTime 0x0000) so nothing in the output
// depends on when the script ran.

const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

/**
 * @param {Array<{name: string, data: Buffer|string, deflate?: boolean, encryptedFlag?: boolean}>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflate = entry.deflate === true;
    const stored = deflate ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const method = deflate ? 8 : 0;
    // Bit 0 = "file is encrypted". We never actually encrypt — the fixture
    // exists to pin how the extractor REACTS to the flag, which is the branch
    // that has to keep working after the adm-zip swap.
    const flags = entry.encryptedFlag ? 0x0001 : 0x0000;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal attributes
    central.writeUInt32LE(0, 38);         // external attributes
    central.writeUInt32LE(offset, 42);    // relative offset of local header
    name.copy(central, 46);

    locals.push(local, stored);
    centrals.push(central);
    offset += local.length + stored.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ── TAR writer (ustar) ────────────────────────────────────────────────────────

function tarHeader(name, size) {
  const h = Buffer.alloc(512, 0);
  const put = (str, off, len) => Buffer.from(str, 'utf8').copy(h, off, 0, Math.min(len - 1, str.length));
  const oct = (n, off, len) => put(n.toString(8).padStart(len - 1, '0'), off, len);

  put(name, 0, 100);
  oct(0o644, 100, 8);    // mode
  oct(0, 108, 8);        // uid
  oct(0, 116, 8);        // gid
  oct(size, 124, 12);
  oct(0, 136, 12);       // mtime — fixed at epoch for determinism
  h.write('        ', 148, 8, 'utf8'); // checksum placeholder = 8 spaces
  h.write('0', 156, 1, 'utf8');        // typeflag: regular file
  h.write('ustar\0', 257, 6, 'utf8');
  h.write('00', 263, 2, 'utf8');

  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return h;
}

/** @param {Array<{name: string, data: Buffer|string}>} entries */
export function buildTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    blocks.push(tarHeader(e.name, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // two zero blocks = end of archive
  return Buffer.concat(blocks);
}

// ── Document skeletons ────────────────────────────────────────────────────────

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * XLSX with the cases that actually differ between SheetJS and any fork:
 * a comma inside a value (CSV quoting), a leading-zero string (numeric
 * coercion), a decimal, a unicode cell, an XML-entity cell, a gap column,
 * a skipped row, and a sheet with no rows at all.
 */
function buildXlsxFixture() {
  const strings = [
    'Name', 'Score', 'Note',
    'Alice',
    'Smith, John', 'café ☕',
    '007', 'Rock & Roll <live>',
    'Zoë',
    'A note about the results',
  ];
  const si = strings.map(s => `<si><t xml:space="preserve">${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t></si>`).join('');
  const sharedStrings = `${XML_DECL}\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${si}</sst>`;

  const s = i => `t="s"><v>${i}</v>`;
  const rows = [
    `<row r="1"><c r="A1" ${s(0)}</c><c r="B1" ${s(1)}</c><c r="C1" ${s(2)}</c></row>`,
    `<row r="2"><c r="A2" ${s(3)}</c><c r="B2"><v>90</v></c></row>`,               // C2 absent → gap
    `<row r="3"><c r="A3" ${s(4)}</c><c r="B3"><v>85.5</v></c><c r="C3" ${s(5)}</c></row>`,
    `<row r="4"><c r="A4" ${s(6)}</c><c r="B4"><v>0</v></c><c r="C4" ${s(7)}</c></row>`,
    `<row r="6"><c r="A6" ${s(8)}</c><c r="B6"><v>100</v></c></row>`,               // row 5 skipped
  ].join('');
  const sheet1 = `${XML_DECL}\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C6"/><sheetData>${rows}</sheetData></worksheet>`;
  const sheet2 = `${XML_DECL}\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" ${s(9)}</c></row></sheetData></worksheet>`;
  const sheet3 = `${XML_DECL}\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;

  const workbook = `${XML_DECL}\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_OFFICE_REL}"><sheets><sheet name="Results" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/><sheet name="Empty" sheetId="3" r:id="rId3"/></sheets></workbook>`;
  const wbRels = `${XML_DECL}\n<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS_OFFICE_REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${NS_OFFICE_REL}/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="${NS_OFFICE_REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const rootRels = `${XML_DECL}\n<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `${XML_DECL}\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/sharedStrings.xml', data: sharedStrings },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1 },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2 },
    { name: 'xl/worksheets/sheet3.xml', data: sheet3 },
  ]);
}

/** PPTX with 10 numbered slides (10 vs 2 ordering), entities, and a text-free slide. */
function buildPptxFixture() {
  const slide = runs => `${XML_DECL}\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${runs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const run = t => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;

  const entries = [
    { name: '[Content_Types].xml', data: `${XML_DECL}\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>` },
  ];
  for (let i = 1; i <= 10; i++) {
    const runs = i === 1
      ? run('Rock &amp; Roll &lt;live&gt;') + run(`Slide number ${i}`)
      : run(`Slide number ${i}`);
    entries.push({ name: `ppt/slides/slide${i}.xml`, data: slide(runs) });
  }
  entries.push({ name: 'ppt/slides/slide11.xml', data: slide('') });          // no text runs
  entries.push({ name: 'ppt/notesSlides/notesSlide1.xml', data: slide(run('Speaker note — must NOT appear')) });
  return buildZip(entries);
}

/** DOCX skeleton mammoth can read. Not swapped in E1, but frozen so the existing suite can stop depending on adm-zip to build it. */
function buildDocxFixture() {
  const contentTypes = `${XML_DECL}\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rootRels = `${XML_DECL}\n<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>`;
  const paras = ['First paragraph.', 'Second paragraph with café ☕.', 'Third &amp; last.']
    .map(p => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('');
  const documentXml = `${XML_DECL}\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`;
  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

/** ODT — mimetype first and STORED, per the ODF package rules. */
function buildOdtFixture() {
  const content = `${XML_DECL}\n<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>First ODT paragraph.</text:p><text:p>Second with &amp; entity and café.</text:p><text:p>Line one<text:line-break/>line two</text:p></office:text></office:body></office:document-content>`;
  const meta = `${XML_DECL}\n<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>Quarterly Notes</dc:title></office:meta></office:document-meta>`;
  return buildZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
    { name: 'content.xml', data: content },
    { name: 'meta.xml', data: meta },
  ]);
}

/** EPUB — container.xml → OPF → spine order, with a manifest item the spine skips. */
function buildEpubFixture() {
  const container = `${XML_DECL}\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const opf = `${XML_DECL}\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Frozen Fixture</dc:title></metadata><manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.png" media-type="image/png"/></manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/><itemref idref="cover"/></spine></package>`;
  const ch = (h, p) => `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${h}</h1><p>${p}</p></body></html>`;
  return buildZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: container },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/ch1.xhtml', data: ch('Chapter One', 'The first chapter body.') },
    { name: 'OEBPS/ch2.xhtml', data: ch('Chapter Two', 'The second chapter, with caf&#233; and &amp;.') },
    { name: 'OEBPS/cover.png', data: Buffer.from('89504e470d0a1a0a', 'hex') },
  ]);
}

/**
 * A realistic upload: source files, ignorable directories, a nested binary
 * document (base64 carry-through), and a zip-slip traversal entry.
 */
function projectTreeEntries(pptxBytes) {
  return [
    { name: 'README.md', data: '# Demo project\n\nA fixture repository.\n' },
    { name: 'src/app.js', data: "export const app = () => 'hello';\n" },
    { name: 'src/util.js', data: 'export const add = (a, b) => a + b;\n' },
    { name: 'node_modules/left-pad/index.js', data: 'module.exports = () => {};\n' },
    { name: '.git/config', data: '[core]\n\trepositoryformatversion = 0\n' },
    { name: 'docs/deck.pptx', data: pptxBytes },
    { name: '../escape.txt', data: 'zip-slip payload\n' },
  ];
}

// ── Fixture set ───────────────────────────────────────────────────────────────

/**
 * Build every fixture in memory.
 * @returns {Map<string, {bytes: Buffer, zlibDependent: boolean, note: string}>}
 */
export function buildFixtures() {
  const out = new Map();
  const add = (name, bytes, note, zlibDependent = false) =>
    out.set(name, { bytes, zlibDependent, note });

  const pptx = buildPptxFixture();

  add('sample.xlsx', buildXlsxFixture(),
    'Three sheets. Comma-in-value, leading-zero string, decimal, unicode, XML entity, gap column, skipped row, empty sheet.');
  add('sample.pptx', pptx,
    '10 numbered slides (10-vs-2 ordering), entity-encoded runs, one text-free slide, one notes slide that must be ignored.');
  add('sample.docx', buildDocxFixture(),
    'Three paragraphs including unicode and an entity.');
  add('sample.odt', buildOdtFixture(),
    'content.xml + meta.xml with dc:title; entity, unicode and a line-break.');
  add('sample.epub', buildEpubFixture(),
    'container.xml → OPF; two spine chapters plus a non-XHTML spine item that must be skipped.');
  add('project.zip', buildZip(projectTreeEntries(pptx)),
    'Source tree + node_modules + .git + nested .pptx + a ../ traversal entry.');
  add('project.tar', buildTar(projectTreeEntries(pptx)),
    'Same logical tree as project.zip, TAR/ustar encoded.');
  add('project.tar.gz', gzipPortable(buildTar(projectTreeEntries(pptx))),
    'Gzipped project.tar — exercises the gunzip ratio guard and the tar-inside-gzip fallback.', true);
  add('encrypted.zip', buildZip([
    { name: 'README.md', data: '# secret\n', encryptedFlag: true },
  ]), 'General-purpose flag bit 0 set. Pins the password-protected rejection branch.');
  add('highratio.zip', buildZip([
    { name: 'bulk/data.txt', data: Buffer.alloc(1_048_576, 0x41), deflate: true },
  ]), '1 MiB of one repeated byte, DEFLATE compressed (~1000:1). Documents that no RATIO ceiling exists today — E1/PR-3 changes this.', true);

  return out;
}

// ── Manifest ──────────────────────────────────────────────────────────────────

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * gzip whose bytes do not depend on the host operating system.
 *
 * RFC 1952 reserves header byte 9 for the FILESYSTEM the stream was produced
 * on. Node's zlib fills it in from the platform: 0x03 (Unix) on Linux and
 * macOS, 0x0a (NTFS) on Windows. Everything else in the header is already
 * fixed — MTIME is zeroed, XFL follows the level — so that single byte was the
 * entire difference between a fixture built on Linux and the same fixture
 * built on Windows.
 *
 * It cost a real failure. `project.tar.gz` rebuilt on Windows hashes to
 * 236a202e… against the committed 55342ef9…, identical in length, differing in
 * one byte. Confirmed by flipping byte 9 through its plausible values: OS=10
 * reproduces the Windows hash exactly.
 *
 * The trap was worse than the failing test. `--check` compares on-disk bytes
 * against a FRESH rebuild, so on Windows it reports DRIFTED and invites a
 * rebuild — which would rewrite manifest.json with NTFS hashes and move the
 * failure to every Linux machine and to CI.
 *
 * Pinning the byte to 0x03 makes the fixture genuinely reproducible everywhere
 * instead of exempting it from being checked. On Linux the output is
 * byte-identical to what is already committed, so this normalisation changes
 * no fixture and no hash.
 */
export function gzipPortable(buf, level = 9, gzip = zlib.gzipSync) {
  const out = Buffer.from(gzip(buf, { level }));
  out[9] = 0x03;
  return out;
}

export function manifestFor(fixtures) {
  const files = {};
  for (const [name, f] of [...fixtures].sort(([a], [b]) => a.localeCompare(b))) {
    files[name] = { bytes: f.bytes.length, sha256: sha256(f.bytes), zlibDependent: f.zlibDependent, note: f.note };
  }
  return { specVersion: SPEC_VERSION, builder: 'scripts/build-parser-fixtures.mjs', files };
}

// ── Golden normalisation ──────────────────────────────────────────────────────

/**
 * Archive extraction carries binary documents through as base64. Inlining one
 * 28 KB payload three times would make golden.json unreviewable, and an
 * unreviewable snapshot is a snapshot nobody checks — the exact failure mode
 * these tests exist to prevent.
 *
 * So base64 payloads are recorded as a digest plus a length. That is still an
 * EXACT contract (any byte change moves the hash) and it keeps the file
 * readable. Both the recorder and the test call this same function, so the two
 * can never normalise differently.
 */
export function normalizeForGolden(value) {
  if (Array.isArray(value)) return value.map(normalizeForGolden);
  if (value && typeof value === 'object') {
    if (value.encoding === 'base64' && typeof value.content === 'string') {
      return {
        path: value.path,
        encoding: 'base64',
        contentBytes: Buffer.from(value.content, 'base64').length,
        contentSha256: sha256(Buffer.from(value.content, 'base64')),
      };
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeForGolden(v)]));
  }
  return value;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function recordGolden() {
  // Imported lazily and only in --golden mode: regenerating goldens is the one
  // operation that legitimately runs the parsers, and the builder must stay
  // dependency-free for every other use.
  const { parseDocument } = await import('../src/project/documentParser.js');
  const { extractArchive } = await import('../src/upload/archiveExtractor.js');
  const { processDocument } = await import('../src/upload/documentPipeline.js');
  const { extractZip } = await import('../src/project/fileIngester.js');
  const read = n => readFileSync(path.join(FIXTURE_DIR, n));

  const golden = {
    specVersion: SPEC_VERSION,
    'documentParser.xlsx': await parseDocument('.xlsx', read('sample.xlsx')),
    'documentParser.pptx': await parseDocument('.pptx', read('sample.pptx')),
    'documentParser.docx': await parseDocument('.docx', read('sample.docx')),
    'documentPipeline.odt': await processDocument('notes.odt', read('sample.odt')),
    'documentPipeline.epub': await processDocument('book.epub', read('sample.epub')),
    'archiveExtractor.zip': await extractArchive(read('project.zip'), 'zip'),
    'archiveExtractor.tar': await extractArchive(read('project.tar'), 'tar'),
    'archiveExtractor.tar.gz': await extractArchive(read('project.tar.gz'), 'tar.gz'),
    'fileIngester.extractZip': await extractZip(read('project.zip').toString('base64')),
  };
  writeFileSync(path.join(FIXTURE_DIR, 'golden.json'), `${JSON.stringify(normalizeForGolden(golden), null, 2)}\n`);
  console.log('golden.json  rewritten');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  const fixtures = buildFixtures();
  const manifest = manifestFor(fixtures);

  if (check) {
    // TWO SEPARATE QUESTIONS, and they were conflated.
    //
    //   INTEGRITY       do the committed bytes still match the committed
    //                   manifest? Always checked, for every fixture.
    //   REPRODUCIBILITY does a fresh build reproduce those bytes? Checked
    //                   only for fixtures that are not zlibDependent, which
    //                   is the exemption this file's header already declares.
    //
    // The previous version compared on-disk bytes against a FRESH REBUILD for
    // everything, which is the reproducibility question wearing the integrity
    // question's name. On Windows that reported DRIFTED for project.tar.gz and
    // invited a rebuild that would have rewritten manifest.json with NTFS
    // hashes and broken Linux and CI instead.
    const committedPath = path.join(FIXTURE_DIR, 'manifest.json');
    const committed = existsSync(committedPath)
      ? JSON.parse(readFileSync(committedPath, 'utf8'))
      : null;
    if (!committed) { console.error('MISSING  manifest.json'); process.exit(1); }

    let bad = 0;
    for (const [name, f] of fixtures) {
      const p = path.join(FIXTURE_DIR, name);
      if (!existsSync(p)) { console.error(`MISSING  ${name}`); bad++; continue; }
      const onDiskBytes = readFileSync(p);
      const onDisk = sha256(onDiskBytes);

      const entry = committed.files[name];
      if (!entry) { console.error(`UNLISTED ${name} — on disk but absent from manifest.json`); bad++; continue; }
      if (onDisk !== entry.sha256) { console.error(`DRIFTED  ${name} — committed bytes no longer match manifest.json`); bad++; continue; }

      if (!f.zlibDependent && !Buffer.from(f.bytes).equals(onDiskBytes)) {
        console.error(`UNREPRODUCIBLE  ${name} — a fresh build does not match the committed bytes`);
        bad++;
      }
    }
    for (const name of Object.keys(committed.files)) {
      if (!fixtures.has(name)) { console.error(`ORPHANED ${name} — in manifest.json but the builder no longer produces it`); bad++; }
    }
    console.log(bad ? `${bad} fixture problem(s)` : `${fixtures.size} fixtures verified`);
    process.exit(bad ? 1 : 0);
  }

  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const [name, f] of fixtures) {
    mkdirSync(path.dirname(path.join(FIXTURE_DIR, name)), { recursive: true });
    writeFileSync(path.join(FIXTURE_DIR, name), f.bytes);
    console.log(`${String(f.bytes.length).padStart(8)}  ${name}`);
  }
  writeFileSync(path.join(FIXTURE_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('manifest.json written');

  if (process.argv.includes('--golden')) await recordGolden();
}
