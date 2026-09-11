/**
 * Day 5 — Universal Upload pipeline tests (node:test).
 * Run: node src/upload/tests/upload.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'zlib';
import AdmZip from 'adm-zip';

import { classifyUpload, sniffMagic } from '../uploadClassifier.js';
import { extractArchive, parseTar } from '../archiveExtractor.js';
import { processDocument } from '../documentPipeline.js';
import {
  attachToConversation, getAttachments, removeAttachment,
  formatAttachmentsForPrompt, clearAttachments,
} from '../attachmentStore.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTar(entries) {
  // Minimal ustar writer for tests
  const blocks = [];
  for (const { name, content } of entries) {
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148); // checksum placeholder (spaces)
    header.write('0', 156);        // typeflag: regular file
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
}

function makeZip(entries) {
  const zip = new AdmZip();
  for (const { name, content } of entries) zip.addFile(name, Buffer.from(content, 'utf8'));
  return zip.toBuffer();
}

const REPO_ENTRIES = [
  { name: 'src/index.js', content: 'export const answer = 42;' },
  { name: 'package.json', content: '{"name":"t","dependencies":{"express":"1"}}' },
  { name: 'node_modules/x/index.js', content: 'ignored' },
];

// ── Classifier ────────────────────────────────────────────────────────────────

test('classifier: extension routing across every kind', () => {
  const expectKind = {
    'a.zip': 'repository', 'a.tar': 'repository', 'a.tar.gz': 'repository', 'a.tgz': 'repository',
    'a.pdf': 'document', 'a.docx': 'document', 'a.pptx': 'document', 'a.xlsx': 'document',
    'a.csv': 'document', 'a.odt': 'document', 'a.epub': 'document',
    'a.png': 'image', 'a.jpg': 'image', 'a.svg': 'image', 'a.heic': 'image',
    'a.mp3': 'audio', 'a.wav': 'audio', 'a.m4a': 'audio',
    'a.mp4': 'video', 'a.mov': 'video', 'a.avi': 'video',
    'a.js': 'source', 'a.py': 'source', 'a.md': 'source', 'Dockerfile': 'source',
    'a.xyz': 'unknown',
  };
  for (const [name, kind] of Object.entries(expectKind)) {
    assert.equal(classifyUpload(name).kind, kind, name);
  }
});

test('classifier: magic bytes override unknown extensions', () => {
  const zipBuf = makeZip([{ name: 'x.txt', content: 'hi' }]);
  assert.equal(sniffMagic(zipBuf), 'zip');
  assert.equal(classifyUpload('mystery.dat', zipBuf).kind, 'repository');
});

test('classifier: extension/bytes disagreement flags corrupt', () => {
  const notAZip = Buffer.from('%PDF-1.4 pretending');
  const cls = classifyUpload('fake.zip', notAZip);
  assert.equal(cls.kind, 'repository');
  assert.equal(cls.corrupt, true);
});

// ── Archive extraction ────────────────────────────────────────────────────────

test('tar: parse + ignore rules + end-of-archive', () => {
  const tar = makeTar(REPO_ENTRIES);
  const parsed = parseTar(tar);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].data.toString(), 'export const answer = 42;');
});

test('extractArchive: tar applies ignore rules (node_modules dropped)', async () => {
  const files = await extractArchive(makeTar(REPO_ENTRIES), 'tar');
  assert.equal(files.length, 2);
  assert.ok(files.every(f => !f.path.includes('node_modules')));
});

test('extractArchive: tar.gz round-trips', async () => {
  const gz = zlib.gzipSync(makeTar(REPO_ENTRIES));
  const files = await extractArchive(gz, 'tar.gz');
  assert.equal(files.length, 2);
});

test('extractArchive: zip parity with tar', async () => {
  const files = await extractArchive(makeZip(REPO_ENTRIES), 'zip');
  assert.equal(files.length, 2);
});

test('extractArchive: corrupt gzip throws a readable error', async () => {
  await assert.rejects(() => extractArchive(Buffer.from('garbage'), 'tar.gz'), /Corrupted gzip/);
});

test('extractArchive: path traversal entries are dropped', async () => {
  const tar = makeTar([{ name: '../../etc/passwd', content: 'evil' }, { name: 'ok.js', content: 'fine' }]);
  const files = await extractArchive(tar, 'tar');
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'ok.js');
});

// ── Document pipeline ─────────────────────────────────────────────────────────

test('documents: csv normalizes with row/column metadata', async () => {
  const r = await processDocument('data.csv', Buffer.from('a,b\n1,2\n3,4'));
  assert.equal(r.format, 'csv');
  assert.deepEqual(r.metadata, { rows: 3, columns: 2 });
  assert.ok(r.content.includes('1,2'));
});

test('documents: odt extracts content.xml text + title', async () => {
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from('<doc xmlns:text="t"><text:p>Hello ODT</text:p></doc>'));
  zip.addFile('meta.xml', Buffer.from('<m><dc:title>T</dc:title></m>'));
  const r = await processDocument('f.odt', zip.toBuffer());
  assert.equal(r.title, 'T');
  assert.ok(r.content.includes('Hello ODT'));
});

test('documents: epub reads spine chapters', async () => {
  const zip = new AdmZip();
  zip.addFile('META-INF/container.xml', Buffer.from('<c><rootfiles><rootfile full-path="content.opf"/></rootfiles></c>'));
  zip.addFile('content.opf', Buffer.from('<p><metadata><dc:title>Book</dc:title></metadata><manifest><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></p>'));
  zip.addFile('c1.xhtml', Buffer.from('<html><body><p>Chapter text here</p></body></html>'));
  const r = await processDocument('b.epub', zip.toBuffer());
  assert.equal(r.title, 'Book');
  assert.ok(r.content.includes('Chapter text here'));
});

test('documents: empty document throws (never silent)', async () => {
  await assert.rejects(() => processDocument('empty.csv', Buffer.from('')), /empty/i);
});

test('documents: unsupported ext throws', async () => {
  await assert.rejects(() => processDocument('a.xyz', Buffer.from('x')), /Unsupported/);
});

// ── Attachment store ──────────────────────────────────────────────────────────

test('attachments: attach, list, format for prompt, remove', () => {
  const conv = 'test-conv-1';
  clearAttachments(conv);
  const norm = { format: 'pdf', title: 'Doc', content: 'The revenue grew.', metadata: {}, sections: [], pages: 3, language: 'en', truncated: false };
  const a = attachToConversation(conv, { name: 'r.pdf', kind: 'document', normalized: norm });

  assert.equal(getAttachments(conv).length, 1);
  const block = formatAttachmentsForPrompt(conv);
  assert.ok(block.includes('UPLOADED ATTACHMENTS'));
  assert.ok(block.includes('r.pdf'));
  assert.ok(block.includes('The revenue grew.'));

  assert.equal(removeAttachment(conv, a.id), true);
  assert.equal(getAttachments(conv).length, 0);
  assert.equal(formatAttachmentsForPrompt(conv), '');
});

test('attachments: newest-first ordering in prompt', () => {
  const conv = 'test-conv-2';
  clearAttachments(conv);
  const mk = (name, content) => attachToConversation(conv, { name, kind: 'document', normalized: { format: 'pdf', title: name, content, metadata: {}, sections: [], pages: null, language: null, truncated: false } });
  mk('old.pdf', 'OLD CONTENT');
  mk('new.pdf', 'NEW CONTENT');
  const block = formatAttachmentsForPrompt(conv);
  assert.ok(block.indexOf('NEW CONTENT') < block.indexOf('OLD CONTENT'));
});
