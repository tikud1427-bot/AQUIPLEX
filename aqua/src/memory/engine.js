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
import { storeFacts, storeFact, deleteFact } from './longTermMemory.js';
import { retrieveRelevantFacts, formatFactsForPrompt } from './memoryRetriever.js';
import { mindObserve, mindContext, mindAfterTurn } from '../mind/index.js';
import { getMind, peekMind, touchMind } from '../mind/mindStore.js';
import { upsertNode, upsertEdge, SELF_KEY } from '../mind/relationshipGraph.js';
import { estimateTokens } from '../core/tokenManager.js';

export { resolveOwner, isUserOwner };

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
} = {}) {
  const trace = (requestId && traces.get(requestId)) || makeTrace({ ownerId });
  trace.budgetTokens = budgetTokens;
  if (!ownerId) return { block: '', relevantFacts: [], cognitiveUsed: {}, trace };

  let factBlock = '';
  let relevantFacts = [];
  try {
    relevantFacts = retrieveRelevantFacts(ownerId, query, factLimit, { trace });
    factBlock = formatFactsForPrompt(relevantFacts);
    trace.retrieved = relevantFacts.map(f => ({ key: f.key, value: f.value }));
  } catch (err) {
    console.warn('[MEMORY] fact retrieval failed (non-fatal):', err.message);
    trace.notes.push(`retrieve_facts_error:${err.message}`);
  }

  // Cognitive block rides the remaining budget.
  const factTokens = estimateTokens(factBlock);
  const cognitiveBudget = Math.max(MIN_COGNITIVE_BUDGET, budgetTokens - factTokens);
  const cognitive = mindContext(ownerId, { query, taskType, budgetTokens: cognitiveBudget });
  trace.cognitiveUsed = cognitive.used || {};

  // File memory — only when the query plausibly touches files.
  const fileBlock = retrieveFileMemory(ownerId, query, taskType, trace);

  const block = [factBlock, cognitive.block, fileBlock].filter(Boolean).join('\n\n');
  trace.injectedTokens = estimateTokens(block);
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
export function rememberFile(ownerId, { name, kind = 'document', summary = '', chars = 0, conversationId = null, workspaceId = null } = {}) {
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
    console.log(`[MEMORY] FILE_REMEMBERED owner=${ownerId} name="${name}" kind=${kind}`);
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
  }
}

const FILE_INTENT_RE = /\b(file|files|upload(ed)?|document|pdf|spreadsheet|attachment|workspace|repo|that (doc|report|sheet))\b/i;

function retrieveFileMemory(ownerId, query, taskType, trace) {
  const mind = peekMind(ownerId);
  if (!mind || !Object.keys(mind.files || {}).length) return '';
  const q = (query || '').toLowerCase();
  const intent = FILE_INTENT_RE.test(q) || taskType === 'project_query';

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
