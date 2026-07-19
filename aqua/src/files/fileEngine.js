/**
 * AQUA File Engine — File Intelligence V1
 *
 * THE universal lifecycle. Every uploaded digital artifact — any kind, any
 * future kind — flows through exactly this sequence:
 *
 *   buffers → detect (classifyUpload)
 *           → registry.claimBatch (batch-consuming parsers first: repository)
 *           → registry.resolveParser (per remaining file)
 *           → parser.parse → UKO core                (recordStage: parse)
 *           → validateUKO                            (contract gate)
 *           → knowledge enrichment                   (skipped on cache hit)
 *           → integration enrichment                 (always: embeddings, memory, search)
 *           → ukoStore (persist + content-hash cache)
 *           → attachmentStore (legacy-compatible attachment for prompt injection)
 *           → results (byte-compatible with the pre-V1 route contract, + ukoId)
 *
 * The engine contains ZERO file-type knowledge. Kinds, extensions, batch
 * semantics, extraction, limits — all live behind the parser interface.
 * Adding a file type = registerParser(). Nothing here changes.
 *
 * Failure model: per-file isolation. One file's parser throwing produces
 * one 'failed' result (same messages users see today) and records parser
 * health; the rest of the batch continues. Enrichment is fail-open inside
 * runEnrichment. The engine itself throws only on programmer error.
 *
 * Concurrency: individual files run through a small promise pool
 * (PARALLELISM) — media parsing is network-bound, documents are CPU-bound;
 * three in flight keeps large batches moving without stampeding providers.
 */
import crypto from 'crypto';
import path from 'path';
import { classifyUpload } from '../upload/uploadClassifier.js';
import { attachToConversation } from '../upload/attachmentStore.js';
import { createUKO, recordStage, finalizeUKO, validateUKO } from './uko.js';
import { resolveParser, claimBatch, recordParserOutcome } from './parserRegistry.js';
import { registerBuiltinParsers } from './parsers.js';
import { runEnrichment } from './enrichmentPipeline.js';
import { saveUKO, cacheKnowledge, getCachedKnowledge } from './ukoStore.js';

registerBuiltinParsers();

const PARALLELISM = 3;

const CACHED_FIELDS = [
  'metadata', 'rawContent', 'structuredContent',
  'entities', 'topics', 'keywords', 'timeline', 'facts', 'summaries', 'reasoningHints',
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Ingest a batch of decoded files through the universal lifecycle.
 *
 * @param {object} args
 * @param {Array<{name:string, buffer:Buffer}>} args.files
 * @param {string|null} args.ownerId          - resolveOwner() output (memory scope)
 * @param {string|null} args.conversationId   - attachment scope (null = no attachments)
 * @param {string}      [args.workspaceName]
 * @param {string}      [args.traceId]
 * @param {object}      [args.deps]           - parser/enrichment dependency injection (tests)
 * @returns {Promise<{results: Array, workspace: object|null, ukoIds: string[], processing: object}>}
 */
export async function ingestFiles({ files, ownerId = null, conversationId = null, workspaceName = 'Uploaded project', traceId = null, deps = {} }) {
  const startedAt = Date.now();
  const results = [];
  const ukoIds  = [];
  let workspace = null;

  // ── 1. Detect ──
  const classified = files.map(f => ({ name: f.name, buffer: f.buffer, cls: classifyUpload(f.name, f.buffer) }));

  // ── 2. Batch claim (repository experience — engine knows only "a parser claimed these") ──
  const claim = claimBatch(classified);
  if (claim) {
    const batchFiles = classified.filter(c => claim.claimed.has(c.name));
    try {
      const parsed = await claim.parser.parseBatch({ files: batchFiles, ownerId, workspaceName, deps });
      results.push(...(parsed.workspaceResults ?? []));
      workspace = parsed.workspace ?? null;
      recordParserOutcome(claim.parser.id, true);

      // The batch becomes ONE UKO — the repository as a knowledge object.
      const batchHash = sha256(Buffer.concat(batchFiles.map(f => f.buffer)));
      const uko = buildUKOFromParse({
        parsed, parser: claim.parser, ownerId, conversationId: null, traceId,
        source: { name: workspaceName, ext: '', bytes: batchFiles.reduce((n, f) => n + f.buffer.length, 0), hash: batchHash },
        fileType: 'repository', mimeType: null,
      });
      if (workspace) uko.memoryLinks.workspaceId = workspace.id;
      await runEnrichment(uko, { deps });
      finalizeUKO(uko);
      saveUKO(uko);
      ukoIds.push(uko.id);
      if (workspace) workspace.ukoId = uko.id;
    } catch (err) {
      recordParserOutcome(claim.parser.id, false, err.message);
      for (const a of batchFiles.filter(f => f.cls.kind === 'repository')) {
        if (!results.some(r => r.name === a.name)) {
          results.push({ name: a.name, kind: 'repository', status: 'failed', error: err.message });
        }
      }
    }
  }

  // ── 3. Per-file lifecycle for everything unclaimed ──
  const claimed = claim?.claimed ?? new Set();
  const individual = classified.filter(c => !claimed.has(c.name));

  await promisePool(individual, PARALLELISM, async (item) => {
    const r = await ingestOne({ item, ownerId, conversationId, traceId, deps });
    results.push(r.result);
    if (r.ukoId) ukoIds.push(r.ukoId);
  });

  // ── Cross-file reasoning graph (Phase 3) ──
  // Built ONCE per batch, after every file is enriched, so entity
  // resolution sees the whole batch at once (a file that shares an entity
  // with another in the same upload must merge). The graph is derived state
  // over the evidence store, so this is a re-derive over the compact
  // fact/mention set — not a text re-parse. Fail-open: a graph error never
  // sinks an otherwise-successful ingest. Opt-out via deps.skipGraph (batch
  // sub-ingests, tests that assert on raw results).
  let graph = null;
  if (ownerId && !deps.skipGraph && ukoIds.length) {
    try {
      const { rebuildOwnerGraph } = await import('../reasoning/graphBuilder.js');
      const es = deps.evidenceStore ?? await import('./evidenceStore.js');
      const us = deps.ukoStore ?? await import('./ukoStore.js');
      const built = rebuildOwnerGraph({ evidenceStore: es, ukoStore: us }, ownerId);
      graph = { stats: built.stats, entities: built.entities.length, ambiguousPairs: built.ambiguous.length, contradictions: built.contradictions.length };
    } catch (err) {
      console.warn(`[FILES] reasoning graph build failed (non-fatal): ${err.message}`);
    }
  }

  return {
    results, workspace, ukoIds, graph,
    processing: { traceId, durationMs: Date.now() - startedAt, files: files.length, cacheHits: results.filter(r => r.cacheHit).length },
  };
}

// ── Single-file lifecycle ─────────────────────────────────────────────────────

async function ingestOne({ item, ownerId, conversationId, traceId, deps }) {
  const { name, buffer, cls } = item;

  const parser = resolveParser({ name, buffer, classification: cls });
  if (!parser) {
    const ext = path.extname(name) || '(no extension)';
    return { result: {
      name, kind: 'unknown', status: 'failed',
      error: `Unsupported format ${ext}. Supported: repositories (zip/tar/tar.gz), documents (pdf/docx/pptx/xlsx/csv/odt/epub), images, audio, video, and source/text files.`,
    } };
  }

  const hash = sha256(buffer);
  const uko = createUKO({
    ownerId, conversationId,
    sourceFile: { name, ext: cls.ext ?? path.extname(name).toLowerCase(), bytes: buffer.length, hash },
    fileType: cls.kind, mimeType: cls.mime ?? null, traceId,
  });
  uko.provenance.parser        = parser.id;
  uko.provenance.parserVersion = parser.version;

  try {
    // ── Parse (or content-hash cache) ──
    const cached = getCachedKnowledge(hash, cls.kind);
    if (cached) {
      uko.processing.cacheHit = true;
      for (const f of CACHED_FIELDS) uko[f] = structuredClone(cached[f]);
      uko.provenance.analyzer = cached.analyzer ?? null;
      uko.processing.stages.push({ stage: 'parse', ok: true, durationMs: 0, cacheHit: true });
    } else {
      const parsed = await recordStage(uko, 'parse', () =>
        parser.parse({ name, buffer, classification: cls, deps, ownerId }));
      applyParseResult(uko, parsed);
    }
    recordParserOutcome(parser.id, true);

    // ── Contract gate ──
    const check = validateUKO(uko);
    if (!check.valid) throw new Error(`Parser output failed UKO validation: ${check.problems.join('; ')}`);

    // ── Enrichment: knowledge only on cache miss; integration always ──
    if (!uko.processing.cacheHit) {
      await runEnrichment(uko, { deps, only: 'knowledge' });
      cacheKnowledge(uko);
    }
    await runEnrichment(uko, { deps, only: 'integration' });

    finalizeUKO(uko);
    saveUKO(uko);

    // ── Legacy-compatible attachment (prompt injection lane, unchanged) ──
    let attachmentId = null;
    if (conversationId) {
      const attach = deps?.attachToConversation ?? attachToConversation;
      attachmentId = attach(conversationId, toLegacyAttachment(uko)).id;
    }

    return { ukoId: uko.id, result: legacyResult(uko, attachmentId) };
  } catch (err) {
    recordParserOutcome(parser.id, false, err.message);
    console.error(`[FILES] Ingest failed file=${name} parser=${parser.id}:`, err.message);
    return { result: { name, kind: cls.kind, status: 'failed', error: err.message } };
  }
}

function applyParseResult(uko, parsed) {
  uko.metadata   = parsed.metadata ?? {};
  uko.rawContent = parsed.content ?? '';
  uko.structuredContent = {
    title:     parsed.title ?? uko.sourceFile.name,
    format:    parsed.format ?? null,
    sections:  parsed.sections ?? [],
    pages:     parsed.pages ?? null,
    language:  parsed.language ?? null,
    truncated: Boolean(parsed.truncated),
  };
  uko.provenance.analyzer = parsed.analyzer ?? null;
  if (Array.isArray(parsed.reasoningHints)) uko.reasoningHints.push(...parsed.reasoningHints);
}

function buildUKOFromParse({ parsed, parser, ownerId, conversationId, traceId, source, fileType, mimeType }) {
  const uko = createUKO({ ownerId, conversationId, sourceFile: source, fileType, mimeType, traceId });
  uko.provenance.parser        = parser.id;
  uko.provenance.parserVersion = parser.version;
  applyParseResult(uko, parsed);
  return uko;
}

// ── Legacy compatibility (attachmentStore + route results stay byte-stable) ──

/** UKO → the exact { name, kind, normalized } shape attachmentStore stores today. */
export function toLegacyAttachment(uko) {
  return {
    name: uko.sourceFile.name,
    kind: uko.fileType,
    normalized: {
      title:     uko.structuredContent.title,
      format:    uko.structuredContent.format,
      metadata:  { ...uko.metadata, ukoId: uko.id },   // additive — nothing reads unknown keys
      content:   uko.rawContent,
      pages:     uko.structuredContent.pages,
      sections:  uko.structuredContent.sections,
      language:  uko.structuredContent.language,
      truncated: uko.structuredContent.truncated,
    },
  };
}

/** UKO → the exact per-file result entry the pre-V1 route returned, + additive fields. */
function legacyResult(uko, attachmentId) {
  const base = {
    name: uko.sourceFile.name, kind: uko.fileType, status: 'ready',
    attachmentId, format: uko.structuredContent.format,
    contentChars: uko.rawContent.length,
    ukoId: uko.id,
    ...(uko.processing.cacheHit ? { cacheHit: true } : {}),
  };
  if (uko.fileType === 'document') {
    return { ...base, pages: uko.structuredContent.pages, truncated: uko.structuredContent.truncated };
  }
  if (uko.fileType === 'image' || uko.fileType === 'audio' || uko.fileType === 'video') {
    return { ...base, analyzed: uko.metadata.analyzed !== false };
  }
  if (uko.fileType === 'source') {
    return { ...base, truncated: uko.structuredContent.truncated };
  }
  return base;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function promisePool(items, size, worker) {
  const queue = [...items];
  const lanes = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(lanes);
}
