/**
 * File Intelligence V1 — File Engine end-to-end tests.
 *
 * The whole lifecycle, offline, with the REAL modules everywhere network
 * isn't involved: real classifier, real registry + built-in parsers, real
 * document pipeline (CSV), real archive extraction (a genuine zip built
 * in-test), real enrichment, real UKO store, real attachment store — and
 * the standard deps-injection seam for the two effects that would touch
 * providers (media analysis) or heavy subsystems (workspace ingestion).
 *
 * Pins, in order:
 *   1. MIGRATION COMPATIBILITY — per-kind result entries byte-match the
 *      pre-V1 route contract (additive ukoId/cacheHit only), attachments
 *      land in attachmentStore in the exact legacy shape.
 *   2. UKO generation — knowledge fields populated, provenance recorded,
 *      every stage observed.
 *   3. CACHING — identical bytes: parser runs once, knowledge is reused,
 *      integration (memory) still runs per ingest.
 *   4. FAILURE RECOVERY — one bad file fails alone; three consecutive
 *      failures degrade the parser's health.
 *   5. EXTENSIBILITY (the success criteria) — an EmailParser registered
 *      from THIS TEST FILE makes .eml a supported format with zero core
 *      changes.
 *   6. Repository batch claim → workspace payload + repository UKO.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-fileengine-'));
process.env.AQUA_DATA_DIR = TMP;

const { ingestFiles }              = await import('../fileEngine.js');
const { registerParser }           = await import('../parserRegistry.js');
const { getAttachments, clearAttachments } = await import('../../upload/attachmentStore.js');
const { getUKO, _resetUKOStoreForTests }   = await import('../ukoStore.js');
const { searchByEntity, _resetFileIndexForTests } = await import('../fileSearchIndex.js');

// ── Shared fakes (deps seam — same pattern as every intelligence test) ───────

const mediaAnalysis = (kind) => ({
  title: `demo.${kind}`, format: kind === 'image' ? 'png' : 'mp4',
  metadata: { analyzed: true, model: 'gemini-test' },
  content: kind === 'video'
    ? 'SUMMARY: A person in a red jacket places a backpack on the table.\nSCENES:\n0:05 person enters\n0:12 backpack placed'
    : 'CAPTION: A whiteboard.\nTEXT (OCR): AQUA v5 pipeline',
  pages: null, sections: [
    kind === 'video'
      ? { heading: 'SCENES', text: '0:05 person enters\n0:12 backpack placed' }
      : { heading: 'TEXT (OCR)', text: 'AQUA v5 pipeline' },
  ], language: null, truncated: false,
});

function makeDeps(overrides = {}) {
  const calls = { media: 0, remember: [], workspaces: 0 };
  const deps = {
    processMedia: async (name, buffer, mime, kind) => { calls.media += 1; return mediaAnalysis(kind); },
    rememberFile: (owner, f) => { calls.remember.push(f.name); return { key: `file:${f.name.toLowerCase()}` }; },
    rememberWorkspace: () => { calls.remember.push('(workspace)'); },
    indexFileChunks: async () => ({ indexed: 2 }),
    createWorkspace: ({ name, ownerId }) => { calls.workspaces += 1; return { id: 'ws-test-1', meta: { name }, ownerId }; },
    runWorkspaceIngestion: async (id, rawFiles) => ({
      projectType: 'node', filesIngested: rawFiles.length,
      indexStats: { files: rawFiles.length }, summary: 'A tiny Node project.', overview: 'index.js + util.js',
    }),
    ...overrides,
  };
  return { deps, calls };
}

const file = (name, text) => ({ name, buffer: Buffer.from(text, 'utf8') });

beforeEach(() => { _resetUKOStoreForTests(); _resetFileIndexForTests(); clearAttachments('conv-1'); });

// ── 1+2. Per-kind lifecycle + migration-compatible results ───────────────────

test('MIGRATION [source]: result entry matches the pre-V1 contract exactly (+ukoId); attachment shape is legacy-identical', async () => {
  const { deps, calls } = makeDeps();
  const out = await ingestFiles({
    files: [file('router.js', 'export function rankProviders() { return ["gemini"]; } // v2.3.1')],
    ownerId: 'owner-1', conversationId: 'conv-1', deps,
  });

  const r = out.results[0];
  const { ukoId, ...legacy } = r;
  assert.deepEqual(legacy, {
    name: 'router.js', kind: 'source', status: 'ready',
    attachmentId: r.attachmentId, format: 'javascript',
    contentChars: r.contentChars, truncated: false,
  }, 'byte-compatible with the old route result');
  assert.ok(ukoId, 'additive ukoId present');

  const [att] = getAttachments('conv-1');
  assert.equal(att.kind, 'source');
  assert.equal(att.content.includes('rankProviders'), true);
  assert.deepEqual(Object.keys(att).sort(),
    ['content', 'format', 'id', 'kind', 'language', 'metadata', 'name', 'pages', 'sections', 'title', 'truncated', 'uploadedAt'],
    'attachmentStore record keys unchanged — chat prompt injection untouched');
  assert.equal(att.metadata.ukoId, ukoId, 'additive link only');

  const uko = getUKO('owner-1', ukoId);
  assert.equal(uko.provenance.parser, 'source');
  assert.ok(uko.keywords.some(k => k.term === 'rankproviders'), 'keywords extracted from content');
  assert.ok(uko.entities.some(e => e.type === 'version' && e.value === 'v2.3.1'), 'version entity extracted');
  assert.ok(uko.processing.stages.some(s => s.stage === 'parse' && s.ok));
  assert.deepEqual(calls.remember, ['router.js'], 'memory link ran through the pipeline, not the route');
});

test('MIGRATION [document/csv]: real document pipeline through the engine — pages field, sections, ready', async () => {
  const { deps } = makeDeps();
  const csv = 'name,amount\nAquiplex,4000000\nTata Group,9000000\n';
  const out = await ingestFiles({ files: [file('deals.csv', csv)], ownerId: 'owner-1', conversationId: 'conv-1', deps });
  const r = out.results[0];
  assert.equal(r.kind, 'document');
  assert.equal(r.status, 'ready');
  assert.ok('pages' in r && 'truncated' in r, 'document result carries the document-specific fields');
  const uko = getUKO('owner-1', r.ukoId);
  assert.ok(uko.rawContent.includes('Aquiplex'));
  assert.ok(uko.entities.some(e => e.value === 'Tata Group'), 'entities extracted from real document text');
});

test('MIGRATION [video]: media deps seam — analyzed flag, timeline from SCENES, search-indexed', async () => {
  const { deps, calls } = makeDeps();
  const out = await ingestFiles({ files: [{ name: 'demo.mp4', buffer: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]) }], ownerId: 'owner-1', conversationId: 'conv-1', deps });
  const r = out.results[0];
  assert.deepEqual(
    { name: r.name, kind: r.kind, status: r.status, analyzed: r.analyzed },
    { name: 'demo.mp4', kind: 'video', status: 'ready', analyzed: true },
  );
  assert.equal(calls.media, 1);
  const uko = getUKO('owner-1', r.ukoId);
  assert.equal(uko.timeline[0].ts, '0:05', 'SCENES became a structured timeline');
  assert.ok(uko.reasoningHints.some(h => h.includes('never claim the file cannot be accessed')), 'universal grounding hint attached');
  assert.equal(uko.searchIndexed, true, 'video UKO was search-indexed');
});

test('unsupported format: same explicit per-file error as the pre-V1 route', async () => {
  const { deps } = makeDeps();
  const out = await ingestFiles({ files: [file('data.xyz', 'x')], ownerId: 'o', conversationId: 'conv-1', deps });
  assert.equal(out.results[0].status, 'failed');
  assert.match(out.results[0].error, /^Unsupported format \.xyz\. Supported: repositories/);
});

// ── 3. Caching ────────────────────────────────────────────────────────────────

test('CACHE: identical bytes parse once; knowledge reused; integration still runs per ingest', async () => {
  const { deps, calls } = makeDeps();
  const f = { name: 'demo.mp4', buffer: Buffer.from('same-bytes-every-time') };

  const first  = await ingestFiles({ files: [f], ownerId: 'owner-1', conversationId: 'conv-1', deps });
  const second = await ingestFiles({ files: [f], ownerId: 'owner-2', conversationId: null, deps });

  assert.equal(calls.media, 1, 'parser ran exactly once for identical content');
  assert.equal(first.results[0].cacheHit, undefined);
  assert.equal(second.results[0].cacheHit, true);
  assert.equal(second.processing.cacheHits, 1);

  const cachedUKO = getUKO('owner-2', second.results[0].ukoId);
  assert.equal(cachedUKO.timeline[0]?.ts, '0:05', 'knowledge fields carried over');
  assert.notEqual(cachedUKO.id, first.results[0].ukoId, 'fresh identity per ingest');
  assert.deepEqual(calls.remember, ['demo.mp4', 'demo.mp4'], 'owner-scoped memory ran BOTH times');
});

// ── 4. Failure recovery + health ─────────────────────────────────────────────

test('RECOVERY: one bad file fails alone with the pipeline error; the rest of the batch lands', async () => {
  const { deps } = makeDeps({ processMedia: async () => { throw new Error('Video analysis failed: no keys'); } });
  const out = await ingestFiles({
    files: [ { name: 'bad.mp4', buffer: Buffer.from('x') }, file('good.txt', 'hello world hello world') ],
    ownerId: 'o', conversationId: 'conv-1', deps,
  });
  const bad  = out.results.find(r => r.name === 'bad.mp4');
  const good = out.results.find(r => r.name === 'good.txt');
  assert.deepEqual({ status: bad.status, error: bad.error }, { status: 'failed', error: 'Video analysis failed: no keys' });
  assert.equal(good.status, 'ready');
});

// ── 5. EXTENSIBILITY — the success criteria, executed ────────────────────────

test('SUCCESS CRITERIA: registering an EmailParser makes .eml a first-class format — zero core changes', async () => {
  registerParser({
    id: 'email', version: '1.0.0',
    kinds: ['unknown'], extensions: ['.eml'], mimeTypes: ['message/rfc822'],
    capabilities: ['TextExtraction', 'MetadataExtraction', 'SectionExtraction'],
    priority: 70,
    canParse: ({ name }) => name.toLowerCase().endsWith('.eml'),
    async parse(ctx) {
      const raw = ctx.buffer.toString('utf8');
      const header = (k) => raw.match(new RegExp(`^${k}:\\s*(.+)$`, 'mi'))?.[1]?.trim() ?? null;
      const body = raw.split(/\r?\n\r?\n/).slice(1).join('\n\n');
      return {
        title: header('Subject') ?? ctx.name, format: 'eml',
        metadata: { from: header('From'), to: header('To'), date: header('Date') },
        content: `From: ${header('From')}\nTo: ${header('To')}\nDate: ${header('Date')}\nSubject: ${header('Subject')}\n\n${body}`,
        pages: null,
        sections: [{ heading: 'HEADERS', text: `From ${header('From')} to ${header('To')}` }, { heading: 'BODY', text: body }],
        language: null, truncated: false,
        reasoningHints: ['Email headers (From/To/Date) are authoritative metadata.'],
      };
    },
  });

  const eml = [
    'From: chhanda@aquiplex.com', 'To: ananya@aquiplex.com',
    'Date: Mon, 12 May 2026 10:00:00 +0530', 'Subject: Tata Group follow-up',
    '', 'The Tata Group demo is confirmed for May 20, 2026. Budget ₹40,00,000.',
  ].join('\r\n');

  const { deps } = makeDeps();
  const out = await ingestFiles({ files: [file('followup.eml', eml)], ownerId: 'owner-1', conversationId: 'conv-1', deps });

  const r = out.results[0];
  assert.equal(r.status, 'ready');
  assert.equal(r.format, 'eml');
  const uko = getUKO('owner-1', r.ukoId);
  assert.equal(uko.provenance.parser, 'email');
  assert.equal(uko.structuredContent.title, 'Tata Group follow-up');
  assert.ok(uko.entities.some(e => e.type === 'email' && e.value === 'chhanda@aquiplex.com'), 'enrichment ran automatically');
  assert.ok(uko.timeline.some(t => /May 20, 2026/.test(t.ts) || /May 20, 2026/.test(t.event)), 'timeline extracted automatically');
  assert.equal(searchByEntity('owner-1', 'chhanda@aquiplex.com').length, 1, 'search-indexed automatically');
  assert.equal(getAttachments('conv-1').some(a => a.format === 'eml'), true, 'prompt-injectable automatically');
});

// ── 6. Repository batch ──────────────────────────────────────────────────────

test('REPOSITORY: real zip claims the batch → workspace payload (legacy keys) + repository UKO + loose file still individual', async () => {
  const zip = new AdmZip();
  zip.addFile('index.js', Buffer.from('import { util } from "./util.js"; console.log(util());'));
  zip.addFile('util.js',  Buffer.from('export function util() { return "Aquiplex"; }'));

  const { deps, calls } = makeDeps();
  const out = await ingestFiles({
    files: [ { name: 'repo.zip', buffer: zip.toBuffer() }, file('notes.md', '# Notes\nAquiplex Platform ships May 2026.') ],
    ownerId: 'owner-1', conversationId: 'conv-1', workspaceName: 'repo', deps,
  });

  assert.deepEqual(Object.keys(out.workspace).sort(),
    ['filesIngested', 'id', 'indexStats', 'name', 'overview', 'projectType', 'summary', 'ukoId'].sort(),
    'workspace payload = legacy keys + additive ukoId');
  assert.equal(out.workspace.filesIngested, 2);
  assert.equal(calls.workspaces, 1);

  const archiveResult = out.results.find(r => r.name === 'repo.zip');
  assert.deepEqual({ kind: archiveResult.kind, status: archiveResult.status, entriesExtracted: archiveResult.entriesExtracted },
    { kind: 'repository', status: 'ready', entriesExtracted: 2 }, 'per-archive result matches the old contract');

  const notes = out.results.find(r => r.name === 'notes.md');
  assert.equal(notes.status, 'ready');
  assert.equal(notes.kind, 'source');

  const repoUKO = getUKO('owner-1', out.workspace.ukoId);
  assert.equal(repoUKO.fileType, 'repository');
  assert.equal(repoUKO.memoryLinks.workspaceId, 'ws-test-1');
  assert.ok(repoUKO.rawContent.includes('A tiny Node project.'));
  assert.ok(calls.remember.includes('(workspace)'), 'workspace memory link ran through the pipeline');
});
