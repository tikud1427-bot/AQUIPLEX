/**
 * AQUA Parser Registry — File Intelligence V1
 *
 * The single seam between "a classified upload" and "the parser that turns
 * it into a Universal Knowledge Object". The engine and routes communicate
 * ONLY with this registry and the parser interface — never with parser
 * implementations. Adding a new file type is registerParser(), nothing else
 * (proven by test: an EmailParser registers from a test file and the whole
 * pipeline handles .eml with zero core changes).
 *
 * Parser interface (validated at registration):
 *   {
 *     id:            'document' | 'image' | … (unique)
 *     version:       '1.0.0'
 *     kinds:         ['document']            // classifier kinds it accepts
 *     extensions:    ['.pdf', '.docx', …]    // informational + fallback match
 *     mimeTypes:     ['application/pdf', …]  // informational + fallback match
 *     capabilities:  ['TextExtraction', 'OCR', …]   // see CAPABILITIES
 *     priority:      50                      // higher wins when several match
 *     consumesBatch: false                   // true: may claim whole batches (repository)
 *     claimBatch?:   (classified[]) => { claimed: [names], reason } | null
 *     canParse?:     ({ name, buffer, classification }) => boolean   // optional veto
 *     parse:         async (ctx) => parserResult      // see parsers/* for ctx + result shape
 *   }
 *
 * Health: every parse outcome is recorded per parser (ok/fail counters +
 * consecutive-failure streak). resolveParser() skips parsers that are
 * currently unhealthy (streak ≥ UNHEALTHY_STREAK) when a healthy
 * alternative matches — a broken parser degrades gracefully instead of
 * black-holing every upload of its kind, and recovers on its next success.
 *
 * Capability routing: listParsersByCapability() lets future orchestrators
 * route work by capability ('OCR', 'SpeechRecognition') instead of file
 * type — the interface the brief requires, ready before the reasoning
 * phases need it.
 */

export const CAPABILITIES = Object.freeze([
  'TextExtraction', 'TableExtraction', 'SectionExtraction', 'MetadataExtraction',
  'OCR', 'Vision', 'SpeechRecognition', 'TimelineExtraction', 'ObjectDetection',
  'EntityExtraction', 'RelationshipExtraction', 'EmbeddingGeneration',
  'WorkspaceIngestion', 'ArchiveExtraction', 'KnowledgeGraphSupport',
  'ReasoningSupport', 'SearchSupport',
]);

const UNHEALTHY_STREAK = 3;

/** id → parser */
const parsers = new Map();
/** id → { ok, failed, streak, lastError, lastOutcomeAt } */
const health  = new Map();

function assertParserShape(p) {
  const fail = (msg) => { throw new Error(`registerParser(${p?.id ?? '?'}): ${msg}`); };
  if (!p || typeof p !== 'object')                 fail('parser must be an object');
  if (!p.id || typeof p.id !== 'string')           fail('id required');
  if (parsers.has(p.id))                           fail('duplicate id — parser ids must be unique');
  if (!p.version)                                  fail('version required');
  if (!Array.isArray(p.kinds) || !p.kinds.length)  fail('kinds[] required');
  if (!Array.isArray(p.capabilities))              fail('capabilities[] required');
  const unknown = p.capabilities.filter(c => !CAPABILITIES.includes(c));
  if (unknown.length)                              fail(`unknown capabilities: ${unknown.join(', ')}`);
  if (typeof p.parse !== 'function')               fail('parse() required');
}

export function registerParser(parser) {
  assertParserShape(parser);
  const normalized = {
    extensions: [], mimeTypes: [], priority: 50, consumesBatch: false,
    ...parser,
  };
  parsers.set(normalized.id, normalized);
  health.set(normalized.id, { ok: 0, failed: 0, streak: 0, lastError: null, lastOutcomeAt: null });
  console.log(`[FILES] Parser registered id=${normalized.id} v${normalized.version} kinds=[${normalized.kinds.join(',')}] priority=${normalized.priority}`);
  return normalized;
}

/** Test/hot-reload hygiene. Not used by production paths. */
export function unregisterParser(id) {
  parsers.delete(id);
  health.delete(id);
}

export function getParser(id) { return parsers.get(id) ?? null; }

export function isParserHealthy(id) {
  const h = health.get(id);
  return !h || h.streak < UNHEALTHY_STREAK;
}

/**
 * Pick the parser for one classified file.
 * Match: declared kind, else extension, else mimeType, all filtered by an
 * optional canParse() veto. Ranking: healthy-first, then priority desc,
 * then id (deterministic). Returns null when nothing matches — the engine
 * turns that into the explicit per-file "unsupported" result.
 */
export function resolveParser({ name, buffer = null, classification }) {
  const ext  = classification?.ext ?? '';
  const mime = classification?.mime ?? null;
  const kind = classification?.kind ?? 'unknown';

  const candidates = [...parsers.values()].filter(p =>
    (p.kinds.includes(kind) || p.extensions.includes(ext) || (mime && p.mimeTypes.includes(mime)))
    && (typeof p.canParse !== 'function' || safeVeto(p, { name, buffer, classification })),
  );
  if (!candidates.length) return null;

  candidates.sort((a, b) =>
    (isParserHealthy(b.id) - isParserHealthy(a.id))
    || (b.priority - a.priority)
    || a.id.localeCompare(b.id));
  return candidates[0];
}

function safeVeto(p, args) {
  try { return p.canParse(args) !== false; }
  catch (err) {
    console.warn(`[FILES] canParse threw for parser=${p.id}: ${err.message} — treating as no-match`);
    return false;
  }
}

/**
 * Give batch-consuming parsers (repository) first claim on the upload.
 * Engine calls this once per batch; the first non-null claim wins.
 * Returns { parser, claimed: Set<name>, reason } | null.
 */
export function claimBatch(classified) {
  const claimers = [...parsers.values()]
    .filter(p => p.consumesBatch && typeof p.claimBatch === 'function' && isParserHealthy(p.id))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const p of claimers) {
    try {
      const claim = p.claimBatch(classified);
      if (claim?.claimed?.length) return { parser: p, claimed: new Set(claim.claimed), reason: claim.reason ?? p.id };
    } catch (err) {
      console.warn(`[FILES] claimBatch threw for parser=${p.id}: ${err.message} — skipping claimer`);
    }
  }
  return null;
}

export function recordParserOutcome(id, ok, error = null) {
  const h = health.get(id);
  if (!h) return;
  h.lastOutcomeAt = Date.now();
  if (ok) { h.ok += 1; h.streak = 0; h.lastError = null; }
  else    { h.failed += 1; h.streak += 1; h.lastError = error; }
  if (!ok && h.streak === UNHEALTHY_STREAK) {
    console.warn(`[FILES] Parser id=${id} marked UNHEALTHY after ${h.streak} consecutive failures (${error})`);
  }
}

export function getParserHealth(id) { return health.get(id) ?? null; }

/** Full matrix — powers GET /upload/formats and diagnostics. */
export function listParsers() {
  return [...parsers.values()].map(p => ({
    id: p.id, version: p.version, kinds: p.kinds, extensions: p.extensions,
    mimeTypes: p.mimeTypes, capabilities: p.capabilities, priority: p.priority,
    consumesBatch: p.consumesBatch, healthy: isParserHealthy(p.id),
    health: getParserHealth(p.id),
  }));
}

/** Capability routing interface (future orchestrators route on this). */
export function listParsersByCapability(capability) {
  return [...parsers.values()].filter(p => p.capabilities.includes(capability)).map(p => p.id);
}

/** Test isolation. */
export function _resetRegistryForTests() {
  parsers.clear();
  health.clear();
}
