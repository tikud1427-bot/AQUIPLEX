/**
 * AQUA Universal Knowledge Object (UKO) — File Intelligence V1
 *
 * THE universal internal language of AQUA's file intelligence. Every parser
 * outputs this exact structure; every downstream consumer (enrichment,
 * memory, search, prompt injection, future reasoning engines) reads ONLY
 * this structure. Nothing downstream may branch on the original file type —
 * a video, a contract PDF, and a repository are indistinguishable to the
 * rest of the platform except through the fields declared here.
 *
 * Design rules:
 *   - Parsers fill the CORE (source, rawContent, structured). Enrichment
 *     stages fill the KNOWLEDGE fields (entities, topics, timeline, facts,
 *     …). The engine fills PROVENANCE + PROCESSING. No field is filled in
 *     two places.
 *   - Every processing step is recorded in processing.stages via
 *     recordStage() — duration, cache hit, error, metadata. Observability
 *     is part of the schema, not an afterthought.
 *   - The schema is versioned (UKO_SCHEMA_VERSION). Consumers must treat
 *     unknown fields as additive and missing knowledge arrays as empty.
 *   - Binary payloads are NEVER stored on the UKO — only extracted text,
 *     structure, and a content hash for cache identity. The UKO must stay
 *     JSON-serializable and store-safe.
 *
 * Pure module: no I/O, no imports beyond uuid. Everything here is
 * synchronous and deterministic except recordStage's timing capture.
 */
import { v4 as uuidv4 } from 'uuid';

export const UKO_SCHEMA_VERSION = 1;

/**
 * Create a UKO shell. Parsers/engine fill it progressively; every field
 * exists from birth so consumers never null-check structure.
 *
 * @param {object} seed
 * @param {string}      seed.ownerId          - memory owner (resolveOwner output) or null
 * @param {string|null} seed.conversationId
 * @param {{name:string, ext:string, bytes:number, hash:string}} seed.sourceFile
 * @param {string}      seed.fileType         - classifier kind: document|image|audio|video|source|repository|…
 * @param {string|null} seed.mimeType
 * @param {string|null} [seed.traceId]
 * @returns {object} UKO
 */
export function createUKO({ ownerId = null, conversationId = null, sourceFile, fileType, mimeType = null, traceId = null }) {
  if (!sourceFile?.name || !sourceFile?.hash) {
    throw new Error('createUKO: sourceFile{name,hash} is required');
  }
  const now = Date.now();
  return {
    // ── Identity ──
    id:             uuidv4(),
    schemaVersion:  UKO_SCHEMA_VERSION,
    owner:          ownerId,
    conversation:   conversationId,

    // ── Source ──
    sourceFile:     { name: sourceFile.name, ext: sourceFile.ext ?? '', bytes: sourceFile.bytes ?? 0, hash: sourceFile.hash },
    fileType,
    mimeType,

    // ── Core content (parser-owned) ──
    metadata:       {},          // parser-specific extraction metadata (pages, model, warnings…)
    rawContent:     '',          // full extracted text — the canonical readable form
    structuredContent: {
      title:     sourceFile.name,
      format:    null,           // 'pdf' | 'mp4' | 'js' | …
      sections:  [],             // [{ heading, text }]
      pages:     null,
      language:  null,
      truncated: false,
    },

    // ── Knowledge (enrichment-owned; always arrays, may be empty) ──
    entities:       [],          // [{ type, value, count, spans?: [{start,end}] }]
    topics:         [],          // [{ topic, weight }]
    keywords:       [],          // [{ term, count }]
    timeline:       [],          // [{ order, ts?: string|null, event, source }]
    relationships:  [],          // [{ from, to, kind }] — reserved; graph phases fill this
    facts:          [],          // [{ text, entities: [value], source }]
    summaries:      { title: sourceFile.name, short: '' },

    // ── Integration ──
    embeddings:     { indexed: 0, namespace: null },   // fileMemory chunk stats
    memoryLinks:    { fileKey: null, workspaceId: null },
    searchIndexed:  false,
    evidence:       { factCount: 0, evidenceCount: 0 },   // Phase 2: grounded-fact stats (facts live in evidenceStore)
    reasoningHints: [],          // strings — how downstream models should use this object

    // ── Provenance + processing (engine-owned) ──
    provenance: {
      parser:        null,       // parser id
      parserVersion: null,
      analyzer:      null,       // model/provider used inside the parser, if any
      uploadedAt:    now,
      contentHash:   sourceFile.hash,
    },
    processing: {
      traceId:     traceId ?? null,
      startedAt:   now,
      completedAt: null,
      durationMs:  null,
      cacheHit:    false,        // whole-object cache (ukoStore)
      stages:      [],           // [{ stage, ok, durationMs, cacheHit?, error?, meta? }]
      warnings:    [],
      errors:      [],
    },
  };
}

/**
 * Run one processing stage against a UKO with automatic observability.
 * Works for sync and async fns. A throwing stage records the error and
 * RETHROWS — callers decide fail-open (enrichment) vs fail-loud (parsing).
 *
 * @param {object} uko
 * @param {string} stageName
 * @param {(uko: object) => any|Promise<any>} fn
 * @returns {Promise<any>} fn's return value
 */
export async function recordStage(uko, stageName, fn) {
  const started = Date.now();
  try {
    const out = await fn(uko);
    uko.processing.stages.push({
      stage: stageName, ok: true, durationMs: Date.now() - started,
      ...(out && typeof out === 'object' && out.__stageMeta ? { meta: out.__stageMeta } : {}),
    });
    return out;
  } catch (err) {
    uko.processing.stages.push({ stage: stageName, ok: false, durationMs: Date.now() - started, error: err.message });
    uko.processing.errors.push(`${stageName}: ${err.message}`);
    throw err;
  }
}

/** Mark the UKO finished and compute total duration. */
export function finalizeUKO(uko) {
  uko.processing.completedAt = Date.now();
  uko.processing.durationMs  = uko.processing.completedAt - uko.processing.startedAt;
  return uko;
}

/**
 * Structural validation — the contract every parser output must satisfy
 * before enrichment runs. Returns { valid, problems[] }; never throws.
 */
export function validateUKO(uko) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };

  need(uko && typeof uko === 'object',                       'uko must be an object');
  if (!uko || typeof uko !== 'object') return { valid: false, problems };

  need(typeof uko.id === 'string' && uko.id.length > 0,      'id missing');
  need(uko.schemaVersion === UKO_SCHEMA_VERSION,             `schemaVersion must be ${UKO_SCHEMA_VERSION}`);
  need(typeof uko.fileType === 'string' && uko.fileType,     'fileType missing');
  need(uko.sourceFile && typeof uko.sourceFile.name === 'string', 'sourceFile.name missing');
  need(uko.sourceFile && typeof uko.sourceFile.hash === 'string' && uko.sourceFile.hash.length >= 16, 'sourceFile.hash missing');
  need(typeof uko.rawContent === 'string',                   'rawContent must be a string');
  need(uko.structuredContent && Array.isArray(uko.structuredContent.sections), 'structuredContent.sections must be an array');
  for (const field of ['entities', 'topics', 'keywords', 'timeline', 'relationships', 'facts', 'reasoningHints']) {
    need(Array.isArray(uko[field]), `${field} must be an array`);
  }
  need(uko.provenance && typeof uko.provenance === 'object', 'provenance missing');
  need(uko.processing && Array.isArray(uko.processing.stages), 'processing.stages must be an array');

  return { valid: problems.length === 0, problems };
}
