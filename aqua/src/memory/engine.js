/**
 * AQUA Unified Memory Engine — THE facade.
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONLY module the chat pipeline (and upload/project routes) import for
 * memory. Everything under src/memory/* and src/mind/* is a STAGE of the
 * pipelines defined here — never called directly by routes.
 *
 *   resolveOwner(ids)                — ONE owner model (ownerResolver.js)
 *   memoryObserve(owner, turn)       — ONE observation pipeline:
 *                                        extract → forget/update → resolve →
 *                                        store facts → beliefs/goals/working/
 *                                        episodes/graph (mind observers)
 *   memoryRetrieve(owner, query)     — ONE retrieval pipeline, ONE budget:
 *                                        ranked facts + cognitive state +
 *                                        file memory → single prompt block
 *   memoryAfterTurn(owner, meta)     — predictions rebuild + reflection
 *   rememberFile / rememberWorkspace — uploads & workspaces become durable
 *                                        owner memory (Req 10)
 *   getMemoryTrace(requestId)        — Memory Inspector (Req 14): every
 *                                        decision explainable per request
 *
 * ONE store backs all of it: mindStore (.aqua-mind.json). Fail-safe: any
 * stage failure degrades to a neutral value — chat can never break on memory.
 */
import { resolveOwner, isUserOwner } from './ownerResolver.js';
import { extractFactsWithReport, detectMemoryUpdate, detectForget, resolveCanonicalKey } from './memoryExtractor.js';
import { storeFacts, storeFact, deleteFact, getFacts } from './longTermMemory.js';
import { retrieveRelevantFacts, formatFactsForPrompt } from './memoryRetriever.js';
import { getIdentity, hasIdentity, formatIdentityBlock, isIdentityQuery, answerIdentityQuery } from './identity.js';
import { mindObserve, mindContext, mindAfterTurn } from '../mind/index.js';
import { getMind, peekMind, touchMind } from '../mind/mindStore.js';
import { upsertNode, upsertEdge, SELF_KEY } from '../mind/relationshipGraph.js';
import { recallGraphPaths, formatGraphRecall } from '../mind/graphRecall.js';
import { recallEpisodes, formatEpisodeRecall, isPastRecallQuery, latestEpisode } from '../mind/episodeRecall.js';
import { detectContinuation } from './continuation.js';
import { recordMemoryRetrieval } from '../core/observability.js';
import { estimateTokens } from '../core/tokenManager.js';
import { indexOwnerFacts, semanticFactScores } from '../embeddings/semanticMemory.js';
import { indexFileChunks, fileChunkScores, removeFileChunks } from '../embeddings/fileMemory.js';

export { resolveOwner, isUserOwner };
// Phase 2 — semantic retrieval. Re-exported through the ONE memory facade so
// the chat pipeline never reaches into src/embeddings/* directly (same rule
// every other memory stage follows). semanticFactScores() is awaited at
// prepareTurn's query seam; indexOwnerFacts() is fire-and-forget after observe.
export { indexOwnerFacts, semanticFactScores };
// Phase D — file content recall. Same seam pattern: chat starts
// semanticFileChunks() early (async, fail-open → []) and hands the resolved
// chunks to memoryRetrieve, which stays synchronous.
export { fileChunkScores as semanticFileChunks };
// Memory 5.1 — explicit editing + reasoning surfaces, re-exported so routes
// keep importing ONLY this facade (the same rule every stage follows).
// Editing: correction/replacement ride the conflict-resolved write path;
// merge/split/pin/archive snapshot history first — never a silent overwrite.
// Reasoning: deterministic, evidence-backed answers over facts/episodes/
// goals/graph/timeline. Both fail open; neither can sink chat or a route.
export {
  correctFact, replaceFact, mergeFacts, splitFact,
  pinFact, archiveFact, restoreFact,
  getEditableFact, listAllFacts,
} from './memoryEditor.js';
export {
  reasonOverMemory, findContradictions, detectTrends, findGaps,
  compareDecisions, whatChanged,
} from './memoryReasoner.js';

const TOTAL_BUDGET_TOKENS = 800;   // one budget for the whole memory block
const MIN_COGNITIVE_BUDGET = 150;
const FILE_MEMORY_CAP = 60;        // per owner; oldest-least-referenced evicted
const FILE_SUMMARY_CHARS = 280;
const TRACE_RING_MAX = 100;

// ── Memory Inspector: per-request trace ring ─────────────────────────────────
const traces = new Map(); // requestId → trace

function beginTrace(requestId, base) {
  if (!requestId) return makeTrace(base);
  const t = makeTrace(base);
  traces.set(requestId, t);
  if (traces.size > TRACE_RING_MAX) {
    const oldest = traces.keys().next().value;
    traces.delete(oldest);
  }
  return t;
}

function makeTrace(base = {}) {
  return {
    ts: Date.now(),
    ownerId: null, userId: null, conversationId: null,
    extracted: [], rejected: [], actions: [],       // observation
    forget: null, correction: null,
    mind: { signals: 0, goalsTouched: 0 },
    ranking: [], consideredFacts: 0, droppedByGate: 0, // retrieval
    identity: null, identityQuery: false,               // canonical identity (bypass)
    retrieved: [], cognitiveUsed: {}, filesInjected: [],
    injectedTokens: 0, budgetTokens: TOTAL_BUDGET_TOKENS,
    duplicates: 0,
    notes: [],
    ...base,
  };
}

export function getMemoryTrace(requestId) {
  return traces.get(requestId) ?? null;
}

// ── ONE observation pipeline ─────────────────────────────────────────────────
/**
 * Observe one user turn. Single entry: fact extraction, explicit
 * forget/update handling, conflict-resolved storage, and cognitive
 * observation (beliefs, goals, working memory, episodes, graph) — in order,
 * sharing one extraction pass (the mind's fact bridge reuses extractedFacts).
 */
export function memoryObserve(ownerId, {
  userMessage = '', taskType = 'conversation',
  workspaceId = null, conversationId = null, userId = null, requestId = null,
} = {}) {
  const trace = beginTrace(requestId, { ownerId, userId, conversationId });
  if (!ownerId) {
    trace.notes.push('owner_null_memory_disabled');
    return { extractedFacts: [], mind: { signals: 0, goalsTouched: 0 }, trace };
  }

  let extractedFacts = [];
  try {
    // 1. Extract (parser → candidates → normalize → dedupe → resolve-vs-stored)
    const { facts, report } = extractFactsWithReport(userMessage, ownerId);
    extractedFacts = facts;
    trace.extracted = facts.map(f => ({ key: f.key, value: f.value, confidence: f.confidence, action: f.action, category: f.category }));
    trace.duplicates = report.duplicates;
    trace.rejectedCount = report.rejected;

    // 2. Store through the ONE conflict-resolving fact layer.
    //    conversationId travels as PROVENANCE only — never as the key.
    if (facts.length) {
      storeFacts(ownerId, facts.map(f => ({ ...f, sourceConversation: conversationId })), { trace });
    }

    // 3. Explicit forget
    const forgetResult = detectForget(userMessage);
    if (forgetResult.isForget && forgetResult.hint) {
      const hintKey = resolveCanonicalKey(forgetResult.hint.replace(/my\s+/i, '').trim());
      const deleted = deleteFact(ownerId, hintKey);
      trace.forget = { hint: forgetResult.hint, key: hintKey, deleted };
    }

    // 4. Explicit correction ("actually my X is now Y")
    const updateResult = detectMemoryUpdate(userMessage);
    if (updateResult.isUpdate) {
      storeFact(ownerId, {
        key: updateResult.key, value: updateResult.value,
        confidence: 0.95, importance: 9,
        sourceText: userMessage, ts: Date.now(), isCorrection: true,
      }, { trace });
      trace.correction = { key: updateResult.key, value: updateResult.value };
    }
  } catch (err) {
    console.warn('[MEMORY] fact observation failed (non-fatal):', err.message);
    trace.notes.push(`fact_stage_error:${err.message}`);
  }

  // 5. Cognitive observation — same turn, same facts, no re-parse
  const mindDiag = mindObserve(ownerId, { userMessage, taskType, extractedFacts, workspaceId, conversationId });
  trace.mind = mindDiag;

  // 6. Phase 2 — refresh this owner's fact vectors for semantic retrieval.
  //    Fire-and-forget (NOT awaited): never adds latency to the response path,
  //    fails open internally. Only runs when this turn actually changed facts
  //    (a new/updated fact, a forget, or a correction) — a no-op chat turn
  //    embeds nothing. A brand-new fact whose vector isn't ready yet simply
  //    falls back to keyword this turn and is covered on the next.
  const factsChanged = extractedFacts.length > 0 || trace.forget || trace.correction;
  if (factsChanged) {
    indexOwnerFacts(ownerId, getFacts(ownerId)).catch(() => {});
  }

  return { extractedFacts, mind: mindDiag, trace };
}

// ── ONE retrieval pipeline ───────────────────────────────────────────────────
/**
 * Build the single memory block for the system prompt: ranked facts +
 * cognitive state + relevant file memory, under ONE token budget. Smallest
 * high-quality context — nothing dumped.
 */
export function memoryRetrieve(ownerId, {
  query = '', taskType = 'conversation',
  budgetTokens = TOTAL_BUDGET_TOKENS, factLimit = 10, requestId = null,
  semanticScores = null, fileChunks = null,
} = {}) {
  const trace = (requestId && traces.get(requestId)) || makeTrace({ ownerId });
  trace.budgetTokens = budgetTokens;
  if (!ownerId) return { block: '', relevantFacts: [], cognitiveUsed: {}, trace };

  // Phase F — timing + continuation fast-path. "Let's continue" carries no
  // retrievable tokens, but it's the clearest possible request for context:
  // the latest episode and the active workspace surface without being asked.
  const t0 = performance.now();
  const continuing = detectContinuation(query);
  if (continuing) trace.continuation = true;

  // 0. IDENTITY FIRST — canonical structured state, NOT semantic recall.
  //    Assembled directly from the isolated identity fact keys and injected at
  //    the top of the memory block on EVERY turn (it is always relevant and
  //    tiny). Because it never passes through retrieveRelevantFacts(), an
  //    identity question ("what's my name?", "who am I?") can never be crowded
  //    out by other high-importance facts, dropped by the relevance gate, or
  //    lost under the token budget. On an explicit identity question the card
  //    is scoped to what was asked; otherwise the compact full card rides along.
  let identityBlock = '';
  try {
    const identity = getIdentity(ownerId);
    if (hasIdentity(identity)) {
      identityBlock = isIdentityQuery(query)
        ? answerIdentityQuery(identity, query)
        : formatIdentityBlock(identity);
      trace.identity = Object.fromEntries(
        Object.entries(identity).map(([k, v]) => [k, v.value]));
      trace.identityQuery = isIdentityQuery(query);
    }
  } catch (err) {
    console.warn('[MEMORY] identity retrieval failed (non-fatal):', err.message);
    trace.notes.push(`identity_error:${err.message}`);
  }

  let factBlock = '';
  let relevantFacts = [];
  try {
    relevantFacts = retrieveRelevantFacts(ownerId, query, factLimit, { trace, semanticScores });
    factBlock = formatFactsForPrompt(relevantFacts);
    trace.retrieved = relevantFacts.map(f => ({ key: f.key, value: f.value }));
  } catch (err) {
    console.warn('[MEMORY] fact retrieval failed (non-fatal):', err.message);
    trace.notes.push(`retrieve_facts_error:${err.message}`);
  }

  // Cognitive block rides whatever budget the identity card + facts leave.
  const identityTokens = estimateTokens(identityBlock);
  const factTokens = estimateTokens(factBlock);
  const cognitiveBudget = Math.max(MIN_COGNITIVE_BUDGET, budgetTokens - identityTokens - factTokens);
  const cognitive = mindContext(ownerId, { query, taskType, budgetTokens: cognitiveBudget });
  trace.cognitiveUsed = cognitive.used || {};

  // ── Memory 5.0 lanes (Phases B + C) — each budget-gated, each fail-open ─────
  // Remaining budget after the classic three blocks; a lane that doesn't fit
  // is dropped WHOLE (never truncated mid-line).
  let spentTokens = identityTokens + factTokens + estimateTokens(cognitive.block);
  const laneFits = (block) => block && (spentTokens + estimateTokens(block)) <= budgetTokens;

  // Phase B — multi-hop graph recall: connected knowledge the query names.
  let graphBlock = '';
  try {
    const mindView = peekMind(ownerId);
    if (mindView) {
      const paths = recallGraphPaths(mindView, query);
      if (paths.length) {
        const candidate = formatGraphRecall(paths);
        if (laneFits(candidate)) {
          graphBlock = candidate;
          spentTokens += estimateTokens(candidate);
          trace.graphPaths = paths.map(p => p.line);
        }
      }
    }
  } catch (err) {
    console.warn('[MEMORY] graph recall failed (non-fatal):', err.message);
    trace.notes.push(`graph_recall_error:${err.message}`);
  }

  // Phase C — episodic recall: past arcs matching the query (or generic
  // past-tense recall). Answers "what did we do about X" from experience.
  let episodeBlock = '';
  try {
    const mindView = peekMind(ownerId);
    if (mindView) {
      let eps = recallEpisodes(mindView, query);
      // Continuation fast-path: no token match, but the user asked to resume —
      // the latest (active-first) arc IS the answer to "where were we".
      if (!eps.length && continuing) {
        const latest = latestEpisode(mindView);
        if (latest) eps = [{ episode: latest, score: 5 }];
      }
      if (eps.length) {
        const candidate = formatEpisodeRecall(eps);
        if (laneFits(candidate)) {
          episodeBlock = candidate;
          spentTokens += estimateTokens(candidate);
          trace.episodesRecalled = eps.map(e => e.episode.title);
          trace.pastRecallQuery = isPastRecallQuery(query);
        }
      }
    }
  } catch (err) {
    console.warn('[MEMORY] episode recall failed (non-fatal):', err.message);
    trace.notes.push(`episode_recall_error:${err.message}`);
  }

  // Phase D — file CONTENT recall: top semantic chunks of uploaded files,
  // precomputed by the async caller (chat's seam) exactly like semanticScores.
  // null/[] → lane absent, behavior identical to pre-Phase-D.
  let fileChunkBlock = '';
  try {
    if (Array.isArray(fileChunks) && fileChunks.length) {
      const top = fileChunks.slice(0, 2);
      const lines = top.map(c => `- [${c.name}] "${String(c.text).replace(/\s+/g, ' ').slice(0, 220)}${String(c.text).length > 220 ? '…' : ''}"`);
      const candidate = [
        '--- FILE RECALL (from uploaded content) ---',
        ...lines,
        '--- END FILE RECALL ---',
      ].join('\n');
      if (laneFits(candidate)) {
        fileChunkBlock = candidate;
        spentTokens += estimateTokens(candidate);
        trace.fileChunksInjected = top.map(c => ({ name: c.name, idx: c.idx, score: c.score }));
      }
    }
  } catch (err) {
    console.warn('[MEMORY] file recall failed (non-fatal):', err.message);
    trace.notes.push(`file_recall_error:${err.message}`);
  }

  // File memory — only when the query plausibly touches files (continuation
  // counts: resuming work implies the active workspace/files matter).
  const fileBlock = retrieveFileMemory(ownerId, query, taskType, trace, { force: continuing });

  const block = [identityBlock, factBlock, cognitive.block, graphBlock, episodeBlock, fileChunkBlock, fileBlock].filter(Boolean).join('\n\n');
  trace.injectedTokens = estimateTokens(block);

  // Phase F — retrieval quality/latency metrics (fail-open, never throws).
  try {
    const lanes = [];
    if (identityBlock) lanes.push('identity');
    if (factBlock) lanes.push('facts');
    if (cognitive.block) lanes.push('cognitive');
    if (graphBlock) lanes.push('graph');
    if (episodeBlock) lanes.push('episodes');
    if (fileChunkBlock) lanes.push('fileChunks');
    if (fileBlock) lanes.push('files');
    recordMemoryRetrieval({
      latencyMs: +(performance.now() - t0).toFixed(2),
      nonEmpty: block.length > 0,
      lanes,
    });
  } catch { /* non-fatal */ }

  return { block, relevantFacts, cognitiveUsed: cognitive.used || {}, trace };
}

// ── Post-turn ────────────────────────────────────────────────────────────────
export function memoryAfterTurn(ownerId, meta = {}) {
  return mindAfterTurn(ownerId, meta);
}

// ── File memory (Req 10) ─────────────────────────────────────────────────────
function fileKey(name) {
  return `file:${String(name).toLowerCase().trim()}`;
}

/**
 * Persist an uploaded attachment as durable owner memory: what it is, what
 * it contains (compact summary — NOT the full content), and where it came
 * from. Also lands in the relationship graph as an artifact the user uses.
 */
export function rememberFile(ownerId, { name, kind = 'document', summary = '', chars = 0, conversationId = null, workspaceId = null, content = '' } = {}) {
  if (!ownerId || !name) return null;
  try {
    const mind = getMind(ownerId);
    const key = fileKey(name);
    const now = Date.now();
    const existing = mind.files[key];
    const entry = existing || {
      key, name, kind, uploadedAt: now, refCount: 0,
    };
    entry.kind = kind;
    entry.summary = (summary || entry.summary || '').slice(0, FILE_SUMMARY_CHARS);
    entry.chars = chars || entry.chars || 0;
    entry.conversationId = conversationId || entry.conversationId || null;
    entry.workspaceId = workspaceId || entry.workspaceId || null;
    entry.lastReferencedAt = now;
    entry.refCount = (entry.refCount || 0) + 1;
    mind.files[key] = entry;
    enforceFileCap(mind);

    const node = upsertNode(mind, 'artifact', name);
    if (node) upsertEdge(mind, SELF_KEY, node.key, 'uses', kind);
    touchMind(mind);

    // Phase D — the CONTENT becomes durable, semantically searchable owner
    // knowledge. Fire-and-forget: never adds latency to the upload response;
    // fails open internally; no-op when embeddings are unavailable.
    if (content) {
      indexFileChunks(ownerId, key, name, content).catch(() => {});
    }

    console.log(`[MEMORY] FILE_REMEMBERED owner=${ownerId} name="${name}" kind=${kind}${content ? ` contentChars=${String(content).length}` : ''}`);
    return entry;
  } catch (err) {
    console.warn('[MEMORY] rememberFile failed (non-fatal):', err.message);
    return null;
  }
}

/** Workspace (project upload) becomes a project node + file memory entry. */
export function rememberWorkspace(ownerId, workspace) {
  if (!ownerId || !workspace?.id) return;
  try {
    const mind = getMind(ownerId);
    const label = workspace.meta?.name || workspace.id;
    const node = upsertNode(mind, 'project', label);
    if (node) upsertEdge(mind, SELF_KEY, node.key, 'works_on', 'workspace');
    mind.files[`workspace:${workspace.id}`] = {
      key: `workspace:${workspace.id}`, name: label, kind: 'workspace',
      summary: workspace.summary || `${workspace.stats?.files ?? 0} files`,
      workspaceId: workspace.id, uploadedAt: workspace.createdAt || Date.now(),
      lastReferencedAt: Date.now(), refCount: 1,
    };
    enforceFileCap(mind);
    touchMind(mind);
  } catch (err) {
    console.warn('[MEMORY] rememberWorkspace failed (non-fatal):', err.message);
  }
}

function enforceFileCap(mind) {
  const keys = Object.keys(mind.files);
  if (keys.length <= FILE_MEMORY_CAP) return;
  const sorted = keys
    .map(k => [k, mind.files[k]])
    .sort((a, b) => (a[1].lastReferencedAt || 0) - (b[1].lastReferencedAt || 0));
  while (sorted.length > FILE_MEMORY_CAP) {
    const [k] = sorted.shift();
    delete mind.files[k];
    // Phase D — evicting the file entry also drops its content chunks; a
    // file the owner no longer "remembers" must not keep matching queries.
    removeFileChunks(mind.ownerId, k);
  }
}

const FILE_INTENT_RE = /\b(file|files|upload(ed)?|document|pdf|spreadsheet|attachment|workspace|repo|that (doc|report|sheet))\b/i;

function retrieveFileMemory(ownerId, query, taskType, trace, { force = false } = {}) {
  const mind = peekMind(ownerId);
  if (!mind || !Object.keys(mind.files || {}).length) return '';
  const q = (query || '').toLowerCase();
  const intent = force || FILE_INTENT_RE.test(q) || taskType === 'project_query';

  const tokens = q.match(/[a-z0-9_.-]{3,}/g) || [];
  const scored = [];
  for (const f of Object.values(mind.files)) {
    let score = 0;
    const nameLower = f.name.toLowerCase();
    if (tokens.some(t => nameLower.includes(t))) score += 3;                 // named directly
    if (intent) score += 1;                                                  // generic file intent
    if (score > 0) scored.push({ f, score });
  }
  if (!scored.length) return '';
  scored.sort((a, b) => b.score - a.score || (b.f.lastReferencedAt || 0) - (a.f.lastReferencedAt || 0));
  const top = scored.slice(0, 3).map(x => x.f);
  for (const f of top) { f.lastReferencedAt = Date.now(); f.refCount = (f.refCount || 0) + 1; }
  touchMind(mind);
  trace.filesInjected = top.map(f => f.name);

  const lines = top.map(f => `- ${f.name} (${f.kind}${f.chars ? `, ~${f.chars} chars` : ''})${f.summary ? `: ${f.summary}` : ''}`);
  return ['--- KNOWN FILES (long-term workspace memory) ---', ...lines, '--- END KNOWN FILES ---'].join('\n');
}
