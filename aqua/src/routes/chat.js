/**
AQUA Chat Route v5 — Full memory pipeline + Real Streaming (Day 3)

Two endpoints, ONE pipeline:

  POST /chat         — original request/response JSON (unchanged contract)
  POST /chat/stream  — Server-Sent Events over POST fetch. Same pipeline,
                       tokens streamed the moment the provider emits them.

The pre-generation pipeline (classify → orchestrate → plan → intelligence →
memory extract/update → memory retrieve → project retrieve → prompt build →
context window) is factored into prepareTurn() and shared verbatim by both
endpoints — /chat behavior is byte-identical to v4, /chat/stream additionally
reports each REAL stage as it starts (no fake progress).

SSE protocol (/chat/stream):
  event: meta       { requestId, conversationId, isNewConversation }
  event: stage      { id, label }            — genuine pipeline stage starting
  event: provider   { provider, score, attempt }
  event: provider_failed { provider, reason }— pre-first-token fallback only
  event: workspace  { workspaceId, contextInjected, filesReferenced }
  event: search     { used, cached, provider, query, sources } — Web Search grounding for this turn
  event: token      { t }                    — raw text delta
  event: replace    { text }                 — verification revised the answer
  event: patch      { ...proposal }          — Day 4: patch-first edit proposal (diff hunks, stats, verification)
  event: done       { ...same diagnostics payload as POST /chat, answer included }
  event: error      { error, recoverable, fallbackChain }

Streaming guarantees:
  • Provider fallback only before the first token (see router.js
    generateTextStream). Verification, when warranted, runs AFTER the stream
    completes and emits `replace` if it revises — the draft stays visible
    meanwhile.
  • Client disconnect (Stop button / closed tab) aborts the provider call
    immediately; whatever partial text the user saw is persisted to the
    conversation so history matches the screen.
  • Both endpoints persist user + assistant turns identically.

Execution order (every request):
ID management      — single getOrCreateConversation() call, unique requestId
Classify           — once, result passed to router (no double classification)
Plan               — Phase 4: complexity tier + reasoning mode from classification
Internal Intelligence — Planner→Reasoning Engine→Critic→Synthesizer brief (no-op below medium complexity)
Extract facts      — regex extraction from user message → long-term memory
Handle forget/update — "forget my name" / "my language is now Go"
Retrieve memories  — relevant facts ranked and fetched BEFORE prompt build
Build system prompt — identity + memory block + reasoning directive + task module
Build context window — recent conversation history (short-term memory), budget scaled by plan complexity
Generate           — router with full fallback chain, biased by plan complexity
Persist messages   — user + assistant saved to conversation store
Respond            — includes conversationId so client can echo it next turn

ROOT FIX (v4 — orphan entries + impossible log sequence, see conversationStore.js):
getOrCreateConversation(id, meta) is the ONLY place that decides new-vs-existing.
*/
import express  from 'express';
import { v4 as uuidv4 } from 'uuid';
import { generateText, generateTextStream } from '../providers/router.js';
import { buildSystemPrompt, composeIngestedContext } from '../core/promptBuilder.js';
import { buildContextWindowWithStats, estimateTokens } from '../core/tokenManager.js';
import { buildConversationContext, conversationContextStats, referenceNote, renderRecentConversation, resolvedQuestionFor } from '../core/conversationContext.js';
import { acquireConversationTurn } from '../core/conversationTurnLock.js';
import { classifyTask }           from '../core/classifier.js';
import { factLabel, factItems }   from '../memory/displayLabels.js';
import { factPromptLine }         from '../memory/memoryRetriever.js';
import { contextRefs }            from '../memory/contextProvenance.js';
import { uusEnabled }             from '../understanding/flags.js';
import { UNDERSTANDING_TASK, classifyForMode, isInterviewTurn } from '../understanding/interviewMode.js';
import { directive as interviewSteer } from '../understanding/interview.js';
import { beliefsForCoverage, goalsForCoverage } from '../understanding/mindView.js';
import { createContext, logCompletion, logMemoryEvent, logPlanEvent, logIntelligenceEvent, logOrchestratorEvent, logVerificationEvent, logCognitionEvent } from '../core/observability.js';
import { createExecutionPlan }    from '../core/executionPlanner.js';
import { getReasoningStrategy }   from '../core/reasoningStrategy.js';
import { runIntelligencePipeline } from '../intelligence/internalIntelligenceEngine.js';
import { assessConfidence, isGroundingExpected } from '../intelligence/confidenceEngine.js';
import { composeEvidenceContext } from '../intelligence/evidenceContext.js';
import { recordReasoningOutcome, picEnabled } from '../pic/core.js';   // Persistent Intelligence Core (Phase 4)
import { cognitivePrepare, cognitiveKnowledgeRetrieve, observeDraft, concludeTurn } from '../cognition/index.js';   // Cognitive Intelligence Engine (CIE)
import { verificationStatus, reviewDepth } from '../orchestrator/verificationStrategy.js';
import { recordOutcome, getTaskStats } from '../intelligence/learningLedger.js';
import { orchestrate, formatOrchestratorLog } from '../orchestrator/toolOrchestrator.js';
import { getAgent } from '../intelligence/agentRegistry.js';
import '../intelligence/verificationAgent.js'; // side-effect: registers the 'verification' agent on load
import '../intelligence/debateAgent.js';       // side-effect: registers the 'debate' agent on load (Phase 6)
import '../intelligence/reasoningAgent.js';    // side-effect: registers the 'reasoning' agent on load (Phase 3)
import '../search/searchAgent.js';             // side-effect: registers the 'web_search' agent on load
import { logSearchEvent, formatSearchDecisionLog } from '../core/observability.js';
import { computeContextBudget, optimizeContext } from '../core/contextOptimizer.js';
import {
  getOrCreateConversation,
  getConversation,
  addMessage,
  updateConversationMeta,
  deriveTitle,
  conversationExists,
  canAccessConversation,
  conversationLoadState,
  persistenceState,
} from '../memory/conversationStore.js';
import { resolveOwner, memoryObserve, memoryRetrieve, getMemoryTrace, semanticFactScores, semanticFileChunks, legacySupersessionNotes, uncertaintyNotes } from '../memory/engine.js';
import { recallEnabled, recallForTurn, startRecallQueryVector } from '../memory/episodicRecall.js';
import { mindRelevanceEnabled } from '../mind/mindRetriever.js';
import { sensitivePolicy, redactSensitiveSentences, scrubSensitiveLines, classifyText } from '../memory/sensitivity.js';
import * as Brain from '../brain/index.js';
import { proactiveDirectiveForTurn } from '../brain/proactive/index.js';
import { scorePairs as crossEncoderScorePairs } from '../brain/contextEngine/crossEncoderLocal.js';
import { runPostTurn, durableTurnLearningActive, commitTurnWithLearning } from './turnPostProcess.js';
import { flushScopeStrict } from '../core/storage/requestWrites.js';
import { formatCitation } from '../files/evidence.js';
import { retrieveProjectContext, formatProjectContext }    from '../project/projectRetriever.js';
import { semanticFileScores }                              from '../project/semanticProject.js';
import { formatAttachmentsForPrompt, getAttachments }       from '../upload/attachmentStore.js';
import { proposeEdit, serializeProposal }                   from '../project/editEngine.js';
import { getIndex }                                         from '../project/projectIndex.js';
import { detectIdentityIntent, answerFromIdentity, isRefusal, violatesIdentityContract } from '../identity/index.js';
import { detectArtifactIntent, detectArtifactEditIntent, MIN_ARTIFACT_CONFIDENCE } from '../artifacts/artifactIntent.js';
import { editArtifact } from '../artifacts/editEngine.js';
import { publicManifest, composeArtifactEditSummary } from '../artifacts/engine.js';
import { listArtifacts as listStoredArtifacts } from '../artifacts/artifactStore.js';
import '../artifacts/engine.js';               // side-effect: registers the 'artifact' agent on load (Artifact Engine P1)
import { ErrorCodes, publicErrorMessage } from './envelope.js';
import { createTurnLedger, recordTurnCost } from '../core/costAccounting.js';
import { defer } from '../core/jobs/jobRegistry.js';
import { authorizedWorkspaceId } from '../project/workspaceAccess.js';
import { textMeta, stripQuoted, shortHash, ownerLogId } from '../core/logSafety.js';
import { noteFeature } from '../core/flags.js';
import { analyseInformationNeeds, infoNeedsMode } from '../brain/contextEngine/informationNeeds.js';
import { hybridContextMode, hybridSettings, hybridContribution, hybridSummaryLine } from '../brain/contextEngine/hybridContext.js';

/** One warning per process per key (configuration notices, not per-turn noise). */
const warnedOnce = new Set();
function warnOnce(key, message) { if (warnedOnce.has(key)) return; warnedOnce.add(key); console.warn(message); }
import { beginTurnMemory, noteTurnForget, sealTurnMemory, commitTurnMemory, rollbackTurnMemory } from '../memory/turnCommit.js';

/**
 * Persist the user's message — THE COMMIT BOUNDARY of a turn's memory
 * (memory/turnCommit.js). Every path that records the user message after
 * prepareTurn goes through here; a request that ends without it rolls back.
 */
/** Phase 4A — the refund owed by a failed request, recorded before the client hears of the failure (bounded). */
async function awaitRefund(req, ms = 5_000) {
  if (typeof req?.creditContext?.refund !== 'function') return;
  await Promise.race([
    Promise.resolve().then(() => req.creditContext.refund()).catch(() => {}),
    new Promise(r => setTimeout(r, ms).unref?.()),
  ]);
}

function persistUserTurn(memoryTxn, conversationId, userMessage) {
  addMessage(conversationId, 'user', userMessage);
  commitTurnMemory(memoryTxn);
}

const router = express.Router();

/**
 * The workspace this turn may use. Everything downstream — project retrieval,
 * semantic file scores, the edit branch, artifact turns, the graph runtime —
 * reads only this value, never the raw request body. An id the session may not
 * use is dropped (the turn runs as one without a workspace), and said so in
 * the log; see project/workspaceAccess.js for why it is not an error.
 */
function turnWorkspaceId(req, requested, requestId) {
  const workspaceId = authorizedWorkspaceId(req.aquaUserId ?? null, requested);
  if (requested && !workspaceId) {
    console.warn(`[CHAT] workspace ignored — not accessible to this session ws=${String(requested).slice(0, 64)} req=${requestId}`);
  }
  return workspaceId;
}

/**
 * Resolve the conversation a turn runs in (2026-11-16, audit D-07 / D-13).
 *
 * BEFORE: any id missing from this process's Map was silently re-created EMPTY
 * at that id — after a restart, on a second instance, or while the mirror was
 * unverified, a follow-up was answered with no history and no error.
 *
 * NOW, for a client-supplied id:
 *   present / recovered (re-read from disk) → ownership check, then the turn
 *   unavailable (persistence cannot answer now) → 503, retryable
 *   absent + server-issued id (UUID — the server mints only these) → 404:
 *     the conversation is gone; it is never replaced by an empty one
 *   absent + a client-chosen id (eval clients, tests: "conv-…") → created at
 *     that id with the caller as owner — the documented contract, kept
 *   any existing conversation of another user → 404 (no existence oracle)
 * AQUA_STRICT_CONVERSATION_IDS=off restores the old silent re-creation.
 */
const SERVER_ISSUED_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function strictConversationIds() {
  return String(process.env.AQUA_STRICT_CONVERSATION_IDS ?? 'on').trim().toLowerCase() !== 'off';
}
function resolveTurnConversation(req, requestId) {
  const requestedId = req.body?.conversationId ?? null;
  const userId = req.aquaUserId ?? null;
  const notFound = { status: 404, body: { success: false, code: ErrorCodes.NOT_FOUND, requestId, error: 'Conversation not found' } };
  let loadState = null;
  if (requestedId) {
    loadState = strictConversationIds() ? conversationLoadState(requestedId, userId) : (conversationExists(requestedId) ? 'present' : 'absent');
    if (loadState === 'unavailable') {
      console.warn(`[CHAT] conversation unavailable (persistence not ready) conv=#${shortHash(String(requestedId))} req=${requestId}`);
      return { error: { status: 503, retryAfterS: 5, body: { success: false, code: ErrorCodes.UNAVAILABLE, requestId, retryable: true, error: 'This conversation is temporarily unavailable. Please try again in a moment.' } } };
    }
    if (loadState === 'absent' && strictConversationIds() && SERVER_ISSUED_ID_RE.test(String(requestedId))) {
      console.warn(`[CHAT] conversation not found — not re-created empty conv=#${shortHash(String(requestedId))} req=${requestId}`);
      return { error: notFound };
    }
    if (loadState !== 'absent' && !canAccessConversation(userId, requestedId)) return { error: notFound };
  }
  const { id, isNew } = getOrCreateConversation(requestedId, {
    userAgent: req.headers['user-agent']?.slice(0, 80),
    ip:        req.ip,
    userId,    // platform session identity (AQUIPLEX)
  });
  return { conversationId: id, isNew, loadState };
}

/**
 * One privacy-safe line per completed turn (2026-11-16, audit D-16/R-6) —
 * enough to investigate a future "it didn't understand the follow-up" report
 * without logging any message, memory or document text: pseudonymous
 * conversation id, counts, statuses and the execution path only.
 */
function logTurnDiagnostics({ requestId, conversationId, prep, verification, payload, path, stream }) {
  try {
    const c = conversationContextStats(prep?.conversation);
    const w = prep?.windowStats ?? {};
    console.log(`[TURN] conv=#${shortHash(String(conversationId))} req=${requestId} path=${path}${stream ? '/stream' : ''}`
      + ` history=${c.history} window=${w.included ?? '-'}/${(w.included ?? 0) + (w.excluded ?? 0)} truncated=${w.truncated ?? 0} tokens≈${prep?.promptTokens ?? '-'}`
      + ` ref=${c.refStatus} refSubjects=${c.refSubjects} retrievalAugmented=${c.augmented} personal=${c.personal}`
      + ` facts=${prep?.relevantFacts?.length ?? 0} knowledgeItems=${prep?.knowledgeItems?.length ?? 0} evidence=${prep?.knowledgeEpistemic ?? '-'}`
      + ` verify=${verification?.status ?? '-'} outcome=${verification?.outcome ?? '-'} applied=${!!verification?.applied}`
      + ` read=${prep?.readState?.mode ?? '-'}${prep?.readState?.degraded ? '(degraded)' : ''} persistence=${payload?.persistence?.state ?? '-'}`);
  } catch { /* diagnostics never affect a turn */ }
}

/** 409 for a conversation whose previous turn is still running (D-14). */
function busyResponse(res, requestId, conversationId) {
  res.set('Retry-After', '3');
  return res.status(409).json({ success: false, code: ErrorCodes.CONFLICT, requestId, conversationId, retryable: true,
    error: 'The previous reply in this conversation is still being generated. Please wait for it to finish.' });
}

// ══════════════════════════════════════════════════════════════════════════════
// Day 4 — Conversational patch-first editing
//
// "Add rate limiting." against an indexed workspace should produce an
// explained, previewable, verifiable PATCH — not a wall of regenerated code.
// Detection is deliberately conservative: imperative edit verbs only, and
// questions ("how would I add…?", trailing "?") always take the normal
// explain path. Any edit-pipeline failure falls back to the normal chat
// pipeline — an edit attempt can never make a request fail outright.
// ══════════════════════════════════════════════════════════════════════════════

const EDIT_VERB_RE = /^(please\s+|now\s+|ok(ay)?[,\s]+)*\s*(add|implement|fix|refactor|rename|update|change|remove|delete|create|modify|extract|convert|migrate|introduce|wire|hook|integrate|replace|improve|harden|clean\s*up)\b/i;
const QUESTION_RE  = /^(how|what|why|where|when|which|who|is|are|does|do|should|can|could|would|will|explain|describe|show\s+me|tell\s+me|walk\s+me)\b/i;
const EXPLAIN_ONLY_RE = /\b(don'?t\s+(edit|change|modify)|explain\s+only|no\s+patch|just\s+explain)\b/i;

function isEditIntent(userMessage, workspaceId) {
  if (!workspaceId) return false;
  if (!getIndex(workspaceId)) return false;          // index must be live — never guess-edit
  const msg = userMessage.trim();
  if (msg.endsWith('?')) return false;
  if (QUESTION_RE.test(msg)) return false;
  if (EXPLAIN_ONLY_RE.test(msg)) return false;
  return EDIT_VERB_RE.test(msg);
}

/** Human-readable explanation of a proposal — persisted as the assistant turn. */
function composePatchExplanation(p) {
  const lines = [`### ${p.summary}`, ''];
  if (p.reasoning) lines.push(`**Approach:** ${p.reasoning}`, '');
  if (p.impact)    lines.push(`**Expected impact:** ${p.impact}`, '');

  lines.push('**Files changed:**');
  for (const f of p.files) {
    const tag = f.changeType === 'create' ? 'new file' : f.changeType;
    lines.push(`- \`${f.path}\` (${tag}, +${f.stats.added} −${f.stats.removed})${f.explanation ? ` — ${f.explanation}` : ''}`);
  }

  if (p.breakingChanges?.length) {
    lines.push('', '**⚠️ Breaking changes:**');
    for (const b of p.breakingChanges) lines.push(`- ${b}`);
  }
  if (p.risks?.length) {
    lines.push('', '**Risks:**');
    for (const r of p.risks) lines.push(`- ${r}`);
  }
  if (p.relatedFiles?.length) {
    lines.push('', '**May need follow-up (imports edited files):**');
    for (const rf of p.relatedFiles) lines.push(`- \`${rf.path}\` — ${rf.reason}`);
  }
  if (p.failedOperations?.length) {
    lines.push('', '**Skipped operations:**');
    for (const fo of p.failedOperations) lines.push(`- \`${fo.file}\`: ${fo.error}`);
  }

  const v = p.verification;
  lines.push('', v.passed
    ? `**Verification:** ${v.checks.length} static checks passed.`
    : `**Verification:** ⚠️ ${v.warnings.length} warning(s) — ${v.warnings.join('; ')}`);

  lines.push('', 'Review the diff below — nothing is applied until you approve it.');
  return lines.join('\n');
}

/** Chat-response payload for an edit turn — same shape the UI already consumes. */
function buildEditResponsePayload({ requestId, conversationId, isNew, proposal, answer, workspaceId }) {
  const v = proposal.verification;
  return {
    success: true,
    requestId,
    conversationId,
    isNewConversation: isNew,
    mode: 'edit',

    provider:      proposal.provider ?? 'unknown',
    providerScore: 0,
    taskType:      'coding',
    taskLabels:    ['coding', 'edit'],
    confidence:    1,
    promptModules: ['edit-engine'],
    latencyMs:     proposal.latencyMs,
    fallbackChain: [],
    answer,
    truncated:     false,
    finishReason:  'stop',

    memory:  { extracted: 0, injected: 0, facts: [] },
    plan:    { complexity: 'complex', multiStep: true, reasoningMode: 'edit', contextTokensBefore: 0, contextTokensAfter: 0 },
    intelligence: { active: false, pipeline: [], strategy: 'patch-first-editing', criticFocus: [] },
    verification: { warranted: true, reason: 'patch static verification', ran: v.ran, passed: v.passed, revised: false,
      status: v.ran ? (v.passed ? 'verified' : 'issues_unresolved') : 'unavailable', verified: !!(v.ran && v.passed) },
    orchestration: {
      profile: 'edit', profileLabel: 'Patch-first editing',
      capabilitiesEnabled: ['edit_locate', 'edit_generate', 'edit_diff', 'edit_verify'],
      capabilitiesSkipped: [], estimatedCost: 'medium', estimatedLatency: 'medium',
      verificationEnabled: true, multiLabel: ['coding'], tags: ['edit'],
    },

    project: { workspaceId, contextInjected: true, filesReferenced: proposal.files.map(f => f.path) },
    patch:   serializeProposal(proposal),
  };
}

// ── Universal Artifact Engine (P1) ───────────────────────────────────────────
// Rollback switch: ARTIFACTS_ENABLED=false turns the branch off — every
// request takes today's exact path. Default ON.
const ARTIFACTS_ENABLED = process.env.ARTIFACTS_ENABLED !== 'false';

/**
 * done/response payload for an artifact turn — mirrors
 * buildEditResponsePayload field-for-field so every existing client renders
 * it without changes; the ONLY additions are mode:'artifact' and the
 * `artifact` manifest. recordOutcome is deliberately skipped (the learning
 * ledger models the conversational pipeline; artifact turns bypass it) —
 * the same call the edit branch already skips.
 */
function buildArtifactResponsePayload({ requestId, conversationId, isNew, prep, result, workspaceId }) {
  const { manifest, summaryText, providers, latencyMs } = result;
  return {
    success: true,
    requestId,
    conversationId,
    isNewConversation: isNew,
    mode: 'artifact',

    provider:      providers[providers.length - 1] ?? 'unknown',
    providerScore: 0,
    taskType:      prep.taskType,
    taskLabels:    [prep.taskType, 'artifact'],
    confidence:    prep.confidence,
    promptModules: ['artifact-engine'],
    latencyMs,
    fallbackChain: [],
    answer: summaryText,
    truncated:     false,
    finishReason:  'stop',

    memory:  { extracted: prep.extractedFacts?.length ?? 0, injected: prep.relevantFacts?.length ?? 0, facts: [] },
    plan:    { complexity: 'complex', multiStep: true, reasoningMode: 'artifact',
               contextTokensBefore: prep.contextStats?.tokensBefore ?? 0,
               contextTokensAfter:  prep.contextStats?.tokensAfter  ?? 0 },
    intelligence: { active: false, pipeline: [], strategy: 'artifact-generation', criticFocus: [] },
    verification: { warranted: false, reason: 'artifact static validation', ran: true, passed: true, revised: false },
    orchestration: {
      profile: 'artifact', profileLabel: 'Artifact generation',
      capabilitiesEnabled: ['artifact_plan', 'artifact_build', 'artifact_validate', 'artifact_package', 'artifact_store'],
      capabilitiesSkipped: [], estimatedCost: 'high', estimatedLatency: 'high',
      verificationEnabled: false, multiLabel: [prep.taskType], tags: ['artifact'],
    },

    ...(workspaceId ? {
      project: { workspaceId, contextInjected: !!prep.projectContext, filesReferenced: prep.projectFiles ?? [] },
    } : {}),

    artifact: manifest,
  };
}

/**
 * Shared artifact-turn runner for /chat and /chat/stream. Runs AFTER
 * prepareTurn (the engine grounds the plan/builder in the turn's memory,
 * attachments, and search results) and REPLACES only the generation step.
 * Returns { result, payload } on success; THROWS on any failure so the
 * caller applies the edit-branch fallback contract (log + normal pipeline —
 * a broken artifact turn becomes a chat answer, never a failed request).
 */
async function runArtifactTurn({
  userMessage, prep, intent, conversationId, workspaceId, requestId, isNew,
  clientSignal, onEvent,
}) {
  const agent = getAgent('artifact');
  if (!agent) return null; // engine module failed to load — silent fallback
  const result = await agent.run({
    userMessage, prep, intent,
    ownerId: prep.memoryOwner ?? null,
    conversationId, workspaceId: workspaceId ?? null, requestId,
    clientSignal, onEvent,
  });
  persistUserTurn(prep.memoryTxn, conversationId, userMessage);
  addMessage(conversationId, 'assistant', result.summaryText);
  const payload = buildArtifactResponsePayload({ requestId, conversationId, isNew, prep, result, workspaceId });
  return { result, payload };
}

/**
 * P5 — edit-turn runner. Fires only when the message reads as a
 * modification AND the conversation actually has an artifact to modify
 * (newest wins; owner-scoped exactly like the routes). Returns null when
 * there is no target — the caller falls through to the CREATE branch and
 * then the normal pipeline. Throws on pipeline failure (edit-branch
 * fallback contract).
 */
async function runArtifactEditTurn({
  userMessage, prep, conversationId, workspaceId, requestId, isNew,
  onEvent,
}) {
  const editIntent = detectArtifactEditIntent(userMessage);
  if (!editIntent.wants) return null;

  const candidates = listStoredArtifacts({
    ownerId: prep.memoryOwner ?? null,
    conversationId,
  });
  if (!candidates.length) return null; // nothing to edit — not our turn
  const target = candidates[0];        // newest first
  console.log(`[ARTIFACT] edit turn → id=${target.id} title=(${textMeta(target.title)}) (${stripQuoted(editIntent.reason)})`);

  const r = await editArtifact({
    artifactId: target.id,
    instruction: userMessage,
    requestId, conversationId,
    onEvent,
  });

  const pub = publicManifest(r.manifest);
  const summaryText = composeArtifactEditSummary(pub, r.changed);
  persistUserTurn(prep.memoryTxn, conversationId, userMessage);
  addMessage(conversationId, 'assistant', summaryText);
  const payload = buildArtifactResponsePayload({
    requestId, conversationId, isNew, prep, workspaceId,
    result: { manifest: pub, summaryText, providers: r.providers, latencyMs: r.latencyMs },
  });
  return { result: { manifest: pub, summaryText }, payload };
}

/**
 * P6.1 — is this turn going to be handled by the Artifact Engine?
 *
 * Pure and free (regex only), so it can run BEFORE prepareTurn and let the
 * expensive pre-generation reasoning pass be skipped for a turn whose
 * generation step gets replaced anyway.
 *
 * NOTE ON PRIORITY: the artifact branch has never consulted classifyTask() —
 * a message classified 'planning' still takes the artifact path. That
 * classification only ranks providers (planning-strong models plan better).
 * What the classification DID cost was a discarded reasoning pass; this hint
 * removes that cost without coupling the two systems.
 */
function detectArtifactWork(userMessage) {
  if (!ARTIFACTS_ENABLED) return { create: null, edit: false };
  const create = detectArtifactIntent(userMessage);
  const edit   = detectArtifactEditIntent(userMessage);
  return {
    create: create.wants && create.confidence >= MIN_ARTIFACT_CONFIDENCE ? create : null,
    edit:   edit.wants === true,
  };
}

// Repo-intent override (additive): whole-repo questions ("explain this
// repository", "where is authentication") often classify as conversation/
// simple_qa, whose profiles skip project_retrieval — leaving the model
// blind to an explicitly attached workspace. If the user's words clearly
// reference the codebase, force retrieval regardless of profile.
const REPO_INTENT_RE = /\b(repo(sitory)?|codebase|this project|the project|architecture|endpoint|api route|auth(entication|orization)?|database|db|folder|module|file|function|class|component|config(uration)?|dependenc|todo|fixme|business logic|trace|refactor|implement|where (is|should)|what would break)\b/i;

/**
 * Shared pre-generation pipeline — identical for /chat and /chat/stream.
 * `onStage(id, label)` fires as each REAL stage begins (no-op for /chat);
 * only stages that actually run are reported — never fake progress.
 *
 * ASYNC since the Web Search integration: the search step (5d) awaits
 * provider calls. Both call sites (`await prepareTurn(...)`) are inside
 * async handlers in this file — no external caller exists.
 */
export async function prepareTurn({ userMessage, workspaceId, conversationId, userId = null, ctx, requestId, onStage = () => {}, skipReasoningPass = false, mode = null, rememberSensitive = false }) {
  // ── 1. Resolve the ONE memory owner (unified engine) ────────────────────────
  // Platform user identity when present (cross-conversation, cross-device),
  // else this conversation as a dev/standalone fallback (adopted into the
  // user's memory on first login). Null disables memory entirely.
  const memoryOwner = resolveOwner({ userId, conversationId });
  // ── 1⁰. Resolved conversation context (2026-11-16, audit D-01..D-04) ────────
  // ONE frozen view of this conversation for every stage that shapes the
  // answer: recent turns, what a follow-up's "it / that / which one" refers to
  // (or that it is ambiguous), whether the question is about the user's own
  // world, and the retrieval query (message + resolved subject). Retrieval
  // lanes use `retrievalQuery`; classification, memory WRITES and the user turn
  // itself keep the literal message. The focus carry-over is the existing
  // conversationFocus store, read once here (no second focus system).
  const history = getConversation(conversationId);
  const conversation = buildConversationContext({
    message: userMessage, conversationId, ownerId: memoryOwner, history,
    focusEntityIds: Brain.conversationFocusFor(memoryOwner, conversationId, userMessage),
  });
  const retrievalQuery = conversation.retrievalQuery;
  // ── 1a. Sensitive categories (memory/sensitivity.js, 2026-10-28) ────────────
  // Health and mood: not stored unless the user opted in (`rememberSensitive`,
  // the account's privacy setting), and never injected unless opted in AND this
  // message is itself about that topic. `memoryWriteMessage` is what every
  // memory writer of this turn sees; the conversation itself is untouched.
  const sensitive = sensitivePolicy({ rememberSensitive, message: userMessage });
  const writeView = rememberSensitive ? { text: userMessage, removed: [] } : redactSensitiveSentences(userMessage);
  if (writeView.removed.length) {
    console.log(`[SENSITIVE] not stored owner=${ownerLogId(memoryOwner)} sentences=${writeView.removed.length} kinds=${[...new Set(writeView.removed)].join(',')} req=${requestId}`);
  }
  // ── Phase 2 — semantic retrieval: start the query embedding NOW so its
  // network round-trip overlaps the synchronous prep below (classify,
  // orchestrate, observe). Awaited only at the retrieval seam. Fail-open:
  // semanticFactScores never rejects — it resolves to null when embeddings
  // are unavailable, and the retriever then behaves exactly as pre-Phase-2.
  // D-03: every retrieval lane below queries with `retrievalQuery` — the
  // literal message, plus the resolved subject for a follow-up.
  const semanticScoresP = semanticFactScores(memoryOwner, retrievalQuery);
  // E7 canonical semantic lane: fact.id is the retrieval identity, so dense
  // scores can be consumed directly by Context Engine candidate.semanticId.
  const canonicalSemanticP = Brain.canonicalSemanticScores(memoryOwner, retrievalQuery);
  // Phase D — file content recall: same seam, same contract. Resolves to []
  // when embeddings are unavailable or no uploaded content matches.
  const fileChunksP = semanticFileChunks(memoryOwner, retrievalQuery);
  // Semantic episodic recall (memory/semanticRecall.js): its query vector, on the
  // DEDICATED credential, started here so the round trip overlaps the turn; recall
  // (step 5d) reuses it. Started only under recall's own conditions and only when
  // recall is certain to rank — never a call the turn would not have made. null
  // when not started; resolves to null on any failure (keyword recall then).
  const recallQueryVecP = memoryOwner && !isInterviewTurn(mode) && recallEnabled() && !detectIdentityIntent(userMessage).isSelf
    ? startRecallQueryVector({ userId, conversationId, query: retrievalQuery })
    : null;
  // ── 2. Classify (once — result passed to router, no double classification) ──
  onStage('classify', 'Understanding your request…');
  // Mark the intro conversation so the first-run gate can tell an account that
  // has done this from one that has not — DERIVED state, not a stored "has
  // onboarded" flag. conversation.meta is an open bag, so this is zero schema
  // change, and a marker that lives beside the conversation itself cannot end
  // up disagreeing with whether the conversation actually happened.
  if (isInterviewTurn(mode) && conversationId) {
    try { updateConversationMeta(conversationId, { kind: 'understanding_intro' }); }
    catch { /* fail open — a missing marker costs a re-offer, not a turn */ }
  }

  // The interview declares its own intent. classifyTask() scores ordinary
  // first-person speech at 0.45 — below LOW_CONFIDENCE_THRESHOLD — which fires
  // verification and debate on 4 of 8 typical answers: up to five extra LLM
  // calls, 1.5-16.7s measured, and the drafted answer visibly REPLACED
  // mid-stream. Against a promise of "about two minutes", in the conversation
  // whose entire job is to earn trust.
  //
  // This is not a classifier fix. The classifier is still wrong about
  // first-person statements everywhere else, and that is a separate change
  // with a much wider blast radius. Here the caller already KNOWS the intent,
  // so guessing it is the mistake.
  const { task: taskType, confidence, labels } = classifyForMode(mode, userMessage, classifyTask);
  console.log(`[CLASSIFIER] task=${taskType} conf=${confidence.toFixed(2)} req=${requestId}`);

  // ── 1b. Smart Router — is this a question about AQUA/Aquiplex itself? ────────
  // Runs BEFORE retrieval. When true, the Identity & Self-Knowledge Layer owns
  // the answer: project/vector retrieval is skipped (irrelevant noise for a
  // brand question) and the full identity profile + a confidence directive are
  // injected into the system prompt. A post-generation guard (see the
  // endpoints) substitutes the deterministic profile answer if the model ever
  // hedges — so AQUA can never fail to answer a question about itself.
  const identityIntent = detectIdentityIntent(userMessage);
  if (identityIntent.isSelf) {
    onStage('identity', 'Answering from self-knowledge…');
    console.log(`[IDENTITY] self-question detected topics=[${identityIntent.topics}] score=${identityIntent.score} req=${requestId}`);
  }

  // ── 2a. OBSERVE — MANDATORY, BEFORE ORCHESTRATION ───────────────────────────
  // The ONE observation pipeline (unified engine): normalize → identity /
  // preference / goal / relationship / project / fact extraction →
  // conflict-resolved storage → beliefs / goals / working memory / episodes /
  // graph. Runs for EVERY user message. The orchestrator below routes
  // EXPENSIVE stages (workspace analysis, repo scan, reasoning, critic);
  // it has no say over observation — durable memory is never optional.
  // (classifyTask above is deterministic, <1ms, zero-LLM — part of
  // normalization; observers use its taskType for trait signals.)
  onStage('memory', 'Checking memory…');
  // Sprint 1 (memory/turnCommit.js): what this turn teaches the Mind commits only
  // when its user message is persisted (persistUserTurn); otherwise it is undone.
  const memoryTxn = beginTurnMemory(memoryOwner, { requestId });
  if (ctx) ctx.memoryTxn = memoryTxn;
  const observed = memoryObserve(memoryOwner, {
    userMessage, taskType, workspaceId, conversationId, userId, requestId,
    extractMessage: writeView.text, rememberSensitive,
    defer: memoryTxn?.defer,
  });
  noteTurnForget(memoryTxn, observed.trace.forget);
  const extractedFacts = observed.extractedFacts;
  logMemoryEvent(ctx, 'EXTRACTED', extractedFacts.map(f => `${f.key}=${f.value}`));
  if (observed.trace.forget)     logMemoryEvent(ctx, 'DELETED', [observed.trace.forget.key]);
  if (observed.trace.correction) logMemoryEvent(ctx, 'UPDATED', [`${observed.trace.correction.key}=${observed.trace.correction.value}`]);
  if (observed.mind.signals || observed.mind.goalsTouched) {
    logMemoryEvent(ctx, 'MIND_OBSERVED', [`signals=${observed.mind.signals}`, `goals=${observed.mind.goalsTouched}`]);
  }

  // ── 2b. Adaptive Tool Orchestrator (Phase 6) ────────────────────────────────
  // Pure/deterministic, no LLM calls, no I/O — see toolOrchestrator.js.
  // Conservative integration preserved from v4: never gates memory
  // extraction/retrieval (cheap local ops); only narrows project retrieval
  // and sizes budgets. See AQUA_PHASE6_NOTES.md.
  const orchestration = orchestrate({
    userMessage,
    taskType,
    confidence,
    hasWorkspaceId: !!workspaceId,
    history: getTaskStats(taskType), // Phase 11: null until the ledger's sample gate is met
  });
  logOrchestratorEvent(ctx, orchestration, formatOrchestratorLog(orchestration));

  // ── 2b. Execution plan + reasoning strategy (Phase 4) ───────────────────────
  const plan      = createExecutionPlan(taskType, confidence);
  const reasoning = getReasoningStrategy(taskType, plan.complexity);
  logPlanEvent(ctx, { ...plan, mode: reasoning.mode });

  // ── 2c. Internal Intelligence Engine ─────────────────────────────────────────
  const intelligence = await runIntelligencePipeline({
    taskType,
    complexity: plan.complexity,
    confidence,
    userMessage,
    // The reasoning pass reads the question as the conversation resolved it.
    reasoningMessage: resolvedQuestionFor(conversation),
    requestId,
    conversationId,
    costLedger: ctx.costLedger,
    tags: orchestration.multiLabel?.tags ?? [],   // reviewDepth: sensitive domains keep the pass at low confidence
    // Artifact turns replace generation entirely — the reasoning pass's
    // analysis would be built and thrown away. classifyTask() still labels
    // these 'planning' (correct: it drives provider ranking), so the SKIP is
    // driven by the pure artifact detector, not by the classifier.
    skipReasoningPass,
  });
  logIntelligenceEvent(ctx, intelligence);

  // ── 2d. Cognitive Intelligence Engine — the executive reasoning plan ────────
  // Meta-reasoning ABOVE classifier/planner/orchestrator/IIE (all unchanged):
  // question model → adaptive cognitive style (13 styles) → executive plan
  // (evidence posture, retrieval expectations, verification encouragement,
  // uncertainty stance, clarification decision) + a bounded directive
  // appended AFTER the Phase-4 reasoning directive at the prompt seam.
  // Fail-open: AQUA_CIE=off (or any internal error) yields a null plan and
  // an empty directive — the pipeline stays byte-identical to pre-CIE.
  onStage('cognition', 'Planning how to think…');
  const cognition = cognitivePrepare({
    userMessage, taskType, confidence,
    complexity: plan.complexity,
    hasWorkspace: !!workspaceId,
    hasOwner: !!memoryOwner,
    // The conversation resolved the deictic reference: not an ambiguity to clarify.
    referenceResolved: conversation.reference.status === 'resolved',
  });
  logCognitionEvent(ctx, cognition.plan);

  // ── 3. Retrieve — the ONE retrieval pipeline (unified engine) ───────────────
  // Ranked facts + cognitive state + file memory under a single token
  // budget → one memoryBlock for the prompt. Smallest high-quality context.
  // E10 read mode (Brain.canonicalReadMode): 'authoritative' is the default —
  // the canonical World Model answers, legacy identity/regex facts only fill
  // gaps it does not contradict; 'canonical' = no legacy user memory; 'legacy'
  // = rollback.
  // The mode this turn can SERVE, not just the configured one: a configured but
  // unreachable database degrades to the legacy read, logged, instead of
  // vetoing every legacy fact against a World Model that is not there.
  const readState = await Brain.resolveReadMode();
  const readMode = readState.mode;
  if (readState.degraded) {
    console.warn(`[MEMORY] read mode ${readState.configured} → legacy (${readState.reason}) owner=${memoryOwner} req=${requestId}`);
  }
  const retrieved = memoryRetrieve(memoryOwner, {
    query: retrievalQuery, taskType, factLimit: 10, requestId,
    semanticScores: await semanticScoresP,   // Phase 2: resolved query embedding (null if unavailable)
    fileChunks: await fileChunksP,           // Phase D: uploaded-content chunks ([] if unavailable)
    legacyUserMemory: readMode === 'legacy' ? true : readMode === 'authoritative' ? 'gapfill' : false,
    // Degraded (the canonical store is configured but unreachable): no canonical
    // veto exists, but the owner's deletions still apply (PWI Phase 1).
    legacyVeto: readMode === 'authoritative' ? await Brain.legacyVetoFor(memoryOwner) : readState.degraded ? Brain.deletionVetoFor(memoryOwner) : null,
    sensitive,
    // C9: the claim scores this turn already computes (started above), for the Mind's
    // question-aware selection only. Awaited here only when AQUA_MIND_RELEVANCE=on;
    // otherwise nothing changes on this path. null when embeddings are unavailable.
    claimScores: mindRelevanceEnabled() ? await canonicalSemanticP : null,
  });
  const relevantFacts = retrieved.relevantFacts;
  if (memoryOwner && mindRelevanceEnabled()) noteFeature('AQUA_MIND_RELEVANCE', 'ran');
  let memoryBlock     = retrieved.block;
  // Phase 1a.1 — uploaded-file content (verbatim chunks, summaries, names,
  // file-graph paths). Untrusted: it joins the FENCED ingested context below,
  // never the unfenced memory block.
  let fileMemoryContext = retrieved.fileContext ?? '';
  let sensitiveWithheld = (retrieved.trace?.sensitiveWithheld ?? 0)
    + (retrieved.trace?.notes ?? []).filter(n => n.startsWith('sensitive_withheld_lines:')).reduce((n, s) => n + Number(s.split(':')[1] || 0), 0);
  if (relevantFacts.length) {
    logMemoryEvent(ctx, 'RETRIEVED', relevantFacts.map(f => `${f.key}=${f.value}`));
    logMemoryEvent(ctx, 'INJECTED',  relevantFacts.map(f => f.key));
  } else {
    logMemoryEvent(ctx, 'NO_MEMORIES', []);
  }
  const cognitive = { block: '', used: retrieved.cognitiveUsed };
  if (Object.values(retrieved.cognitiveUsed).some(n => n > 0)) {
    logMemoryEvent(ctx, 'MIND_INJECTED', Object.entries(retrieved.cognitiveUsed).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`));
  }

  // ── 5b. Retrieve project context (Phase 5, gated by orchestrator in Phase 6) ──
  let projectContext = '';
  let projectFiles   = [];
  const wantsProjectRetrieval = orchestration.enabled.some(c => c.id === 'project_retrieval');
  const repoIntent = REPO_INTENT_RE.test(userMessage);
  // Identity questions never need the codebase — skip retrieval even if the
  // repo-intent regex fired on a shared word (e.g. "architecture", "module").
  if (workspaceId && identityIntent.isSelf) {
    console.log(`[PROJECT] Skipped — identity/self-question owns this turn workspace=${workspaceId}`);
  } else if (workspaceId && (wantsProjectRetrieval || repoIntent)) {
    onStage('workspace', 'Reading workspace…');
    if (!wantsProjectRetrieval) console.log(`[PROJECT] Repo-intent override — profile=${orchestration.profile.label} skipped project_retrieval but query references the codebase workspace=${workspaceId}`);
    // Phase 2c — semantic file scores. The query vector is content-hash cached,
    // so embedding userMessage here is a cache HIT from the memory retrieval
    // earlier this same turn — no extra embedding cost. null → keyword only.
    const projSemScores = await semanticFileScores(workspaceId, retrievalQuery);
    const rawContext = retrieveProjectContext(workspaceId, retrievalQuery, undefined, { semanticScores: projSemScores });
    if (rawContext) {
      projectContext = formatProjectContext(rawContext);
      projectFiles   = rawContext.files.map(f => f.path ?? f.name ?? String(f)).filter(Boolean);
      console.log(`[PROJECT] Context injected workspace=${workspaceId} files=${rawContext.files.length}`);
    }
  } else if (workspaceId) {
    console.log(`[PROJECT] Skipped — profile=${orchestration.profile.label} does not require project_retrieval workspace=${workspaceId}`);
  }

  // ── 5c. Conversation attachments (Day 5 — Universal Upload) ─────────────────
  // Anything uploaded via POST /upload (PDFs, images, spreadsheets, audio…)
  // is registered against this conversationId in the attachment store with
  // its content ALREADY extracted at upload time — zero re-processing here.
  // Injected unconditionally (not orchestrator-gated): a user who just
  // uploaded a file is about to ask about it; withholding it is never right.
  const conversationAttachments = getAttachments(conversationId);
  let attachmentContext = '';
  if (conversationAttachments.length) {
    onStage('attachments', 'Reading your files…');
    attachmentContext = formatAttachmentsForPrompt(conversationId);
    console.log(`[UPLOAD] Attachment context injected conversation=${conversationId} attachments=${conversationAttachments.length}`);
  }

  // ── 5c¹. Information needs (Sprint 3 — brain/contextEngine/informationNeeds.js) ──
  // What does THIS question need, what does the user's world say about each
  // need, what is missing? Gate AQUA_INFO_NEEDS: off (default) = not run;
  // shadow = run and log counts, prompt unchanged; on = when the engine
  // understood the question, its context REPLACES the broad personal lanes
  // (identity/profile/cognitive block, PIC knowledge, whole-history recall).
  // Turns it does not understand keep the existing pipeline. Fail-open.
  // The history window is computed here (it was step 5d²) so the engine never
  // quotes a message the model already sees.
  // (history was read once at step 1⁰ — the same array the conversation context saw.)
  const ctxBudget  = computeContextBudget(plan.complexity, orchestration.budget.maxContextTokens);
  // D-08: a contiguous recent suffix; oversized messages are truncated copies,
  // never a silent wipe of all older turns. Counts only — never content — are logged.
  const { messages: window, stats: windowStats } = buildContextWindowWithStats(history, ctxBudget);
  const needsMode  = infoNeedsMode();
  // Hybrid context (Sprint 6, AQUA_HYBRID_CONTEXT): the engine runs beside the existing
  // pipeline and may only ADD a bounded block after it (step 5d³). It takes precedence over
  // AQUA_INFO_NEEDS=on (replacement): with both on, the existing context is kept.
  const hybridMode = hybridContextMode();
  const hybridCfg  = hybridMode !== 'off' ? hybridSettings() : null;
  if (hybridMode !== 'off' && needsMode === 'on') warnOnce('hybrid-precedence', '[HYBRID] AQUA_INFO_NEEDS=on is not applied: AQUA_HYBRID_CONTEXT is set and keeps the existing context');
  let infoNeeds = null;
  let hybridEngineError = null;
  const needsEligible = memoryOwner && !identityIntent.isSelf && !isInterviewTurn(mode);
  if ((needsMode !== 'off' || hybridMode !== 'off') && needsEligible) {
    try {
      infoNeeds = analyseInformationNeeds({
        ownerId: memoryOwner, userId, conversationId, question: userMessage, taskType,
        excludeFromIndex: history.length - window.length, sensitive,
        // The work budget applies only when the hybrid asked for the analysis.
        ...(hybridCfg ? { budget: { maxSentences: hybridCfg.maxSentences, deadlineMs: hybridCfg.maxMs } } : {}),
      });
      if (needsMode !== 'off') noteFeature('AQUA_INFO_NEEDS', 'ran');
      const n = infoNeeds.summary;
      if (needsMode !== 'off') console.log(`[NEEDS] mode=${needsMode} applied=${n.applied} reason=${n.reason ?? '-'} intent=${n.intent} needs=${n.needs} essential=${n.essential} found=${n.found} missing=${n.missing} uncertain=${n.uncertain} contradictory=${n.contradictory} outdated=${n.outdated} forgotten=${n.forgotten} ambiguous=${n.ambiguous} sufficiency=${n.sufficiency ?? '-'} quotes=${n.quotes} ms=${n.ms} owner=#${shortHash(memoryOwner)} req=${requestId}`);   // metrics only: the owner is a per-process HMAC, never the account id (Sprint 4 shadow readiness)
    } catch (err) {
      if (needsMode !== 'off') noteFeature('AQUA_INFO_NEEDS', 'failed', err?.name);
      console.warn(`[NEEDS] failed (existing pipeline serves this turn): ${err?.name ?? 'error'} req=${requestId}`);
      infoNeeds = null;
      hybridEngineError = err?.name ?? 'error';
    }
  }
  const needsOwnsContext = needsMode === 'on' && hybridMode === 'off' && infoNeeds?.applied === true;
  if (needsOwnsContext) {
    const scrubbedNeeds = scrubSensitiveLines(infoNeeds.memoryBlock, sensitive);   // backstop, as for every lane
    sensitiveWithheld += scrubbedNeeds.removed;
    memoryBlock = scrubbedNeeds.block;
    // Unchanged behaviour: before Phase 1a.1 the file lanes rode in memoryBlock
    // and were replaced along with it when the needs engine owns the context.
    fileMemoryContext = '';
  }

  // ── 5c². Connected knowledge — Persistent Intelligence Core (Phase 4) ──────
  // Knowledge-first retrieval over EVERYTHING ever ingested for this owner:
  // grounded facts ∪ resolved entities ∪ graph-connected facts ∪ cross-file
  // timeline, ranked with lifecycle flags (trusted/disputed/stale) and
  // reasoning feedback. First consumer of the Phase-3 query layer. Fail-open
  // by construction: an empty block leaves the prompt byte-identical to
  // pre-PIC turns. Identity/self-questions never need it (same rule project
  // retrieval and search follow above).
  let knowledgeContext = '';
  let knowledgePolicy  = '';     // D-17: Context Engine operator policy (never fenced data)
  let knowledgeEpistemic = null; // Context Engine epistemic state, for diagnostics
  let knowledgeItems   = [];
  let knowledgeStats   = {};
  if (memoryOwner && !identityIntent.isSelf && !needsOwnsContext) {
    // CIE seam ("should I retrieve more?"): PIC stays the sole retrieval
    // owner — the wrapper makes the exact same call first (safe floor), then
    // MAY add one bounded keyword-broadened retry when the cognitive plan
    // requires evidence and the first pass came back empty. CIE off ⇒ pure
    // passthrough, byte-identical to calling PIC directly.
    //
    // B4 — Context Engine V2: the CIE+PIC call becomes the FLOOR for the
    // ten-dimension scorer + budgeted, diversity-aware assembler. Superset
    // return shape ({ items, block, stats }), so knowledgeContext/Items/Stats
    // downstream are untouched. Fail-safe: any V2 failure returns the PIC
    // floor unchanged. Off unless AQUA_CONTEXT_V2=on (then pure passthrough).
    // The semantic scores are pre-awaited here — the async boundary the CIE
    // path already owns — and handed in, keeping the engine itself pure.
    const floorRetrieve = (oid, q, o) => cognitiveKnowledgeRetrieve(oid, q, { ...o, plan: cognition.plan });
    const useCrossEncoder = Brain.contextV2Active() && String(process.env.AQUA_CROSS_ENCODER ?? '').toLowerCase() === 'on';
    const knowledge = Brain.contextV2Active()
      ? await Brain.assembleContextAsync(memoryOwner, retrievalQuery, floorRetrieve, {
          limit: 8, plan: cognition.plan, taskType, formatCitation, conversationId,
          // D-01: personal-world sufficiency applies only to questions about
          // the user's own world (or follow-ups to them).
          personalWorld: conversation.personalWorld,
          // The existing focus carry-over, as recorded in the shared context.
          ...(conversation.focusEntityIds.length ? { priorEntityIds: [...conversation.focusEntityIds] } : {}),
          // The served mode, not the configured one: degraded ⇒ the PIC floor
          // answers instead of canonical lanes that cannot be reached.
          canonicalOnly: readMode !== 'legacy',
          // E7 canonical dense lane: these scores are keyed by the canonical
          // claim retrieval identity and hydrated once at this seam.
          semanticScores: await canonicalSemanticP,
          activeProjectId: workspaceId ?? null,
          ...(useCrossEncoder ? {
            crossEncoder: {
              scorePairs: crossEncoderScorePairs,
              candidateLimit: Number(process.env.AQUA_CROSS_ENCODER_POOL ?? 32),
              blendWeight: Number(process.env.AQUA_CROSS_ENCODER_BLEND ?? 0.20),
            },
          } : {}),
        })
      : floorRetrieve(memoryOwner, retrievalQuery, { limit: 8 });
    if (picEnabled()) noteFeature('AQUA_PIC', 'ran');
    // D-17: when the Context Engine split its block, only the user-derived
    // half is knowledge DATA (fenced as untrusted downstream); its policy half
    // (evidence status, ordering rule, footer) is AQUA's operator text.
    const split = typeof knowledge.dataBlock === 'string' || typeof knowledge.policyBlock === 'string';
    knowledgePolicy = split ? String(knowledge.policyBlock ?? '') : '';
    // Sensitive categories: the conversation evidence lane and the canonical
    // World Model answer here, outside memoryRetrieve — same rule, same policy.
    const scrubbedKnowledge = scrubSensitiveLines(split ? String(knowledge.dataBlock ?? '') : knowledge.block, sensitive);
    knowledgeContext = scrubbedKnowledge.block;
    knowledgeEpistemic = knowledge.stats?.contextEngine?.epistemicState ?? null;
    knowledgeItems   = (knowledge.items ?? []).filter(i => {
      const kind = classifyText([i.text, i.statement, i.label, i.snippet, i.content].filter(v => typeof v === 'string').join(' '));
      return !kind || sensitive.allows(kind);
    });
    sensitiveWithheld += scrubbedKnowledge.removed + ((knowledge.items ?? []).length - knowledgeItems.length);
    knowledgeStats   = knowledge.stats ?? {};
    // D-16: "injected" means items reached the prompt. A block carrying only
    // engine policy (e.g. an evidence-status header) is logged as such.
    if (knowledgeContext && !(knowledge.items ?? []).length) {
      const ce = knowledge.stats?.contextEngine;
      console.log(`[PIC] Knowledge policy-only owner=${ownerLogId(memoryOwner)} read=${readMode}${readState.degraded ? '(degraded)' : ''} items=0 epistemic=${knowledgeEpistemic ?? '-'}${ce ? ` [CTXv2 selected=${ce.selected}/${ce.candidates} dropped=${ce.dropped}]` : ''}`);
    } else if (knowledgeContext) {
      const ce = knowledge.stats?.contextEngine;
      // In a canonical read the PIC floor is deliberately empty, so its
      // facts/entities/timeline counters are 0 even when the World Model
      // supplied the whole block — print what was actually selected beside them.
      const byKind = (knowledge.items ?? []).reduce((m, i) => (m[i.kind ?? 'item'] = (m[i.kind ?? 'item'] ?? 0) + 1, m), {});
      console.log(`[PIC] Knowledge injected owner=${ownerLogId(memoryOwner)} read=${readMode}${readState.degraded ? '(degraded)' : ''} items=${(knowledge.items ?? []).length} kinds=${JSON.stringify(byKind)} worldCore=${knowledge.stats?.worldCore?.rendered ?? 0} facts=${knowledge.stats.facts} entities=${knowledge.stats.entities} timeline=${knowledge.stats.timelineEvents} feedbackReuse=${knowledge.stats.reusedSignals}${knowledge.stats.broadened ? ` broadened=+${knowledge.stats.broadenGained}` : ''}${ce ? ` [CTXv2 selected=${ce.selected}/${ce.candidates} dropped=${ce.dropped}]` : ''}`);
    } else {
      // OBSERVABILITY ONLY — no behaviour change, and the line above is
      // untouched so anything grepping it keeps working.
      //
      // The candidates/selected counters already existed, but only on the
      // success path. The measurement that matters most is the OPPOSITE case:
      // the post-PR-1 re-audit found the Context Engine selecting 100% of its
      // pool at every session length (3/3, 9/9, 18/18, nothing ever dropped)
      // and 4 of 7 flagship questions returning an EMPTY block. An empty block
      // logged nothing at all, so from production traffic those turns were
      // indistinguishable from turns that never asked.
      //
      // A zero is a measurement. This makes "the engine had nothing to offer"
      // countable, which is the only way to tell whether the fixture's pool
      // density resembles a real owner's.
      const ce = knowledge.stats?.contextEngine;
      console.log(`[PIC] Knowledge empty owner=${ownerLogId(memoryOwner)} read=${readMode}${readState.degraded ? '(degraded)' : ''} floor=${knowledge.stats?.facts ?? 0}${knowledgePolicy ? ' policy=yes' : ''} epistemic=${knowledgeEpistemic ?? '-'}${ce ? ` [CTXv2 selected=${ce.selected}/${ce.candidates} dropped=${ce.dropped}]` : ''}`);
    }
  }

  // ── 5d. Web Search (gated by the orchestrator's web_search capability) ──────
  // The orchestrator already made the pure/deterministic decision
  // (capabilities.js → decideWebSearch); this step only EXECUTES it.
  // Identity/self-questions never search — the Identity Layer owns those
  // turns outright (same rule project retrieval follows above).
  // performSearch() NEVER throws: any failure returns { used:false } and
  // the request proceeds exactly as if search did not exist.
  let search = null;
  const webSearchCap   = orchestration.capabilities.find(c => c.id === 'web_search');
  const wantsWebSearch = orchestration.enabled.some(c => c.id === 'web_search');
  if (wantsWebSearch && !identityIntent.isSelf) {
    const searchAgent = getAgent('web_search');
    if (searchAgent) {
      search = await searchAgent.run({ userMessage, taskType, requestId, onStage });
      logSearchEvent(ctx, search);   // structured AQUA_SEARCH line + metrics
    }
  } else if (wantsWebSearch && identityIntent.isSelf) {
    console.log(`[SEARCH] Skipped — identity/self-question owns this turn req=${requestId}`);
  }
  // SEARCH DECISION block — logged on EVERY turn (ran OR skipped). States the
  // decision + reason, and when search ran, the provider / results / cache /
  // injected-tokens / latency. This is the line that replaces the old bare
  // "Skipped: Web Search" for non-search turns (Logging section of the spec).
  console.log(formatSearchDecisionLog(webSearchCap, search));
  const searchContext = search?.contextBlock ?? '';

  // ── 5d². Episodic recall — the user's own words from earlier conversations ──
  // The World Model above is what Aqua UNDERSTOOD; this is what the user SAID,
  // verbatim and dated, matched to this message (memory/episodicRecall.js).
  // Extraction is lossy and late; quotes are neither. The window is computed
  // here (it was step 7) so recall never repeats a message the model already
  // sees. Supersession notes come from the World Model on a canonical read and
  // from the fact store's version history on a legacy one (2026-10-29).
  // Health and mood sentences follow this turn's sensitive policy, like
  // every other lane. Fail-open: an empty block leaves the prompt as it was.
  // (history / ctxBudget / window are computed at 5c¹.)
  let recall = { block: '', excerpts: [], stats: null };
  if (needsOwnsContext) {
    // The information-needs engine already chose the user's words for each
    // need (same units, forget list and sensitive policy as recall).
    recall = { block: infoNeeds.recallBlock, excerpts: [], stats: { mode: 'information-needs', quotes: infoNeeds.summary.quotes } };
  } else if (memoryOwner && !identityIntent.isSelf && !isInterviewTurn(mode) && recallEnabled()) {
    recall = await recallForTurn({
      ownerId: memoryOwner, userId, conversationId, query: retrievalQuery,
      excludeFromIndex: history.length - window.length,
      queryVector: recallQueryVecP ?? undefined,
      // Uncertainty notes come from the Mind, the same store in either read mode (legacy includes them).
      notesFor: readMode !== 'legacy' ? async o => [...(await Brain.supersessionNotesFor(o)), ...uncertaintyNotes(o)] : legacySupersessionNotes,
      sensitive,
    });
    const rs = recall.stats ?? {};
    noteFeature('AQUA_EPISODIC_RECALL', rs.error ? 'failed' : 'ran', rs.error ? 'recall-error' : null);
    if (rs.semantic) noteFeature('AQUA_SEMANTIC_RECALL', rs.semantic.timedOut ? 'failed' : 'ran', rs.semantic.timedOut ? 'timeout' : null);
    console.log(`[RECALL] owner=${ownerLogId(memoryOwner)} excerpts=${recall.excerpts.length} candidates=${rs.candidates ?? 0} matched=${rs.matched ?? 0} followUps=${rs.followUps ?? 0} annotated=${rs.annotated ?? 0} redacted=${rs.redactedSentences ?? 0} ms=${rs.ms ?? 0} mode=${rs.mode ?? '-'}${rs.semantic ? ` semanticOnly=${rs.semanticOnly ?? 0} semanticMs=${rs.semantic.queryMs ?? '-'}${rs.semantic.timedOut ? ' semanticTimeout' : ''}` : ''}${rs.error ? ` error=${rs.error}` : ''}`);
  }
  // ── 5d³. Hybrid context (Sprint 6) — the needs check ADDED after the existing context ──
  // Everything above stays as it is. The block goes after the recall excerpts so it
  // passes the same sensitive scrub, the same untrusted-content fence and the
  // reviewers' evidence view. shadow: computed and logged (counts only), not sent.
  if (hybridMode !== 'off' && needsEligible) {
    let hs;
    try {
      const h = hybridEngineError
        ? { block: '', summary: { reason: `engine-${hybridEngineError}`, added: 0, dup: 0, weak: 0, conflicts: 0, changes: 0, ended: 0, ambiguous: 0, unknownsDeclared: 0, notMatched: 0, notRetrieved: 0, question: 0, tokens: 0, trimmed: 0 } }
        : hybridContribution({ v2: infoNeeds, aContext: { memoryBlock: [memoryBlock, fileMemoryContext].filter(Boolean).join('\n\n'), knowledgeContext, recallBlock: recall.block }, maxTokens: hybridCfg.maxTokens, maxMs: hybridCfg.maxMs });
      hs = h.summary;
      if (hybridMode === 'on' && h.block) recall = { ...recall, block: [recall.block, h.block].filter(Boolean).join('\n\n') };
      noteFeature('AQUA_HYBRID_CONTEXT', hybridEngineError ? 'failed' : 'ran', hybridEngineError ?? null);
    } catch (err) {
      noteFeature('AQUA_HYBRID_CONTEXT', 'failed', err?.name);
      hs = { reason: `hybrid-${err?.name ?? 'error'}`, added: 0, dup: 0, weak: 0, conflicts: 0, changes: 0, ended: 0, ambiguous: 0, unknownsDeclared: 0, notMatched: 0, notRetrieved: 0, question: 0, tokens: 0, trimmed: 0 };
    }
    // Metrics only: labels and counts, the engine's ms, a per-process HMAC of the owner.
    console.log(`[HYBRID] ${hybridSummaryLine(hybridMode, hs)} ms=${infoNeeds?.summary?.ms ?? '-'} owner=#${shortHash(memoryOwner)} req=${requestId}`);
  }

  // Backstop over the formatted block, as for the knowledge lane above.
  const scrubbedRecall = scrubSensitiveLines(recall.block, sensitive);
  sensitiveWithheld += scrubbedRecall.removed;
  const recallContext = scrubbedRecall.block;

  // ── 5e. Evidence context (Phase 0, audit F1) ────────────────────────────────
  // THE GROUNDING CONTRACT: everything that grounded THIS turn's draft,
  // assembled once, carried in prep, and handed to any post-generation
  // reviewer (verification / debate). A reviewer that sees less evidence
  // than the drafter will "correct" grounded multimodal answers into
  // "I cannot watch videos" — the root cause of the overwrite bug.
  // ── 5e⁰. AQUA's own context policy for this turn (D-01/D-09/D-17) ────────────
  // Operator text, outside the untrusted fence: what a follow-up refers to (or
  // that it is ambiguous), the Context Engine's evidence status for the user's
  // world, and — distinct from "not known" — that personal memory could not be
  // read this turn.
  const degradedNote = readState.degraded
    ? "Personal memory notice: the user's long-term memory store could not be read this turn. If a personal detail seems missing, say it could not be checked right now — not that it is unknown. General knowledge and this conversation are unaffected."
    : '';
  const enginePolicy = [referenceNote(conversation), knowledgePolicy, degradedNote].filter(Boolean).join('\n');

  const evidenceContext = composeEvidenceContext({
    attachmentContext, fileMemoryContext, projectContext,
    // Reviewers must see the quotes the drafter answered from, or they
    // "correct" a grounded answer (the F1 overwrite bug) — and the policy the
    // drafter followed (D-17 split it out of the knowledge block).
    knowledgeContext: [knowledgePolicy, knowledgeContext, recallContext].filter(Boolean).join('\n\n'),
    memoryBlock, searchContext,
  });

  // ── 6. Build system prompt ────────────────────────────────────────────────────
  onStage('prompt', 'Preparing response…');
  // UUS — steer the interviewer toward what is still unknown. Deterministic
  // ranking over the same coverage math the understanding card uses, so the
  // conversation and the summary can never disagree about what is known. Rides
  // the existing directive channel; empty for every non-interview turn, so
  // ordinary traffic is byte-identical. Fail-open: a steering hint is never
  // worth failing a turn over.
  let interviewDirective = '';
  if (isInterviewTurn(mode)) {
    try {
      interviewDirective = interviewSteer({
        beliefsByDimension: beliefsForCoverage(memoryOwner),
        goals: goalsForCoverage(memoryOwner),
      });
    } catch { interviewDirective = ''; }
  }
  // Attachment context rides the projectContext slot — same injection point,
  // same budget handling in promptBuilder, no signature change.
  // Phase 1a.1: uploaded-file memory joins here, so it is fenced with the rest.
  const combinedContext = composeIngestedContext({ attachmentContext, fileMemoryContext, projectContext, knowledgeContext, recallContext });
  // CIE directive rides the SAME channel the Phase-4 reasoning directive
  // already owns — appended after it, never replacing it. Empty when CIE is
  // off or the style is 'fast', keeping casual traffic byte-identical.
  // The revision voice rides the SAME directive channel, appended last so it
  // never displaces reasoning or the interviewer. Empty on almost every turn:
  // the flag is off by default, the turn must be a conversational one, and a
  // revision is raised at most once ever. Fail-open — AQUA noticing something
  // is never worth failing a turn over. See brain/reflectionV2/revisionVoice.js.
  let revisionDirective = '';
  try {
    revisionDirective = await Brain.revisionDirectiveForTurn(memoryOwner, { taskType, mode, conversationId });
  } catch { revisionDirective = ''; }

  // Phase 4 — at most ONE proactive intervention per turn (claimed with CAS,
  // so it is raised once), never on identity or interview turns. Empty unless
  // AQUA_PROACTIVE=on and the policy fired something deliverable. Fail-open.
  let proactiveDirective = '';
  if (memoryOwner && !identityIntent.isSelf && !isInterviewTurn(mode)) {
    try { proactiveDirective = await proactiveDirectiveForTurn(memoryOwner); } catch { proactiveDirective = ''; }
  }

  const reasoningDirective = [reasoning.directive, cognition.directive, interviewDirective, revisionDirective, proactiveDirective].filter(Boolean).join('\n');
  const { prompt: systemPrompt, modules: promptModules } = buildSystemPrompt(taskType, memoryBlock, reasoningDirective, combinedContext, intelligence.synthesis.text, identityIntent, searchContext, enginePolicy);

  // ── 7. Context window (short-term message history; computed at 5d²) ─────────
  const { messages, stats: contextStats } = optimizeContext([...window, { role: 'user', content: userMessage }]);

  const promptTokens = estimateTokens(systemPrompt + messages.map(m => m.content).join(' '));
  // The turn's own retrieval bookkeeping (touchRetrieved) is part of the turn.
  sealTurnMemory(memoryTxn);
  if (sensitiveWithheld) {
    console.log(`[SENSITIVE] withheld from context owner=${ownerLogId(memoryOwner)} lines=${sensitiveWithheld} optedIn=${sensitive.rememberSensitive} topic=${sensitive.topic ?? 'none'} req=${requestId}`);
  }

  return {
    // What every post-turn memory writer may see (sensitive sentences removed
    // unless opted in) — runPostTurn takes these, never the raw turn.
    memoryWriteMessage: writeView.text, rememberSensitive: !!rememberSensitive, sensitiveWithheld,
    memoryTxn,
    infoNeeds: { mode: needsMode, applied: needsOwnsContext, summary: infoNeeds?.summary ?? null },
    taskType, confidence, labels,
    identityIntent,
    orchestration, plan, reasoning, intelligence,
    extractedFacts, relevantFacts,
    memoryOwner, mindOwner: memoryOwner, mind: { observedSignals: observed.mind.signals, goalsTouched: observed.mind.goalsTouched, contextInjected: !!(memoryBlock || fileMemoryContext), contextUsed: cognitive.used },
    projectContext, projectFiles,
    knowledgeContext, knowledgeItems, knowledgeStats,
    recall: { excerpts: recall.excerpts, stats: recall.stats },
    readState,
    cognition: { plan: cognition.plan, directiveApplied: !!cognition.directive },
    search,
    evidenceContext,
    memoryBlock, searchContext,   // Orchestration 2.0: raw grounding blocks for the graph runtime
    attachments: conversationAttachments.map(a => ({ id: a.id, name: a.name, kind: a.kind })),
    systemPrompt, promptModules,
    messages, contextStats, promptTokens,
    // 2026-11-16 — the turn's shared conversation context (frozen), the
    // history-window counts, and the Context Engine's epistemic state.
    conversation, windowStats, enginePolicy, knowledgeEpistemic,
  };
}

/**
 * The turn as the post-turn memory writers (evidence lane, World Model / E6,
 * Digital Twin) may see it: health and mood sentences removed from BOTH sides
 * unless the user opted in — conversation ingest reads the answer too, and an
 * answer can restate what the user said.
 */
export function memoryWriteTurn(prep, finalAnswer) {
  if (prep?.rememberSensitive) return { userMessage: prep.memoryWriteMessage, assistantMessage: finalAnswer };
  return {
    userMessage: prep?.memoryWriteMessage ?? '',
    assistantMessage: redactSensitiveSentences(finalAnswer).text,
  };
}

/** Verification pass — shared by both endpoints. Fails open by construction.
 * Phase 12 actuator + Phase 6 seat: high complexity or shaky classification
 * earns a deep review — the multi-voice debate panel when registered
 * (falling back to the single critic), with a second pass so a revision
 * gets re-reviewed. Everything else keeps the original single-critic,
 * single-pass check. */
async function runVerification({ orchestration, userMessage, draftAnswer, taskType, requestId, conversationId, plan, confidence, evidenceContext = '', knowledgeItems = [], memoryOwner = null, cognitiveEscalation = null, costLedger = null, conversationContext = null }) {
  let verification = { ran: false, passed: null, revised: false };
  // CIE escalation can only ADD review — the orchestrator's shouldVerify()
  // decision is a floor. A turn the orchestrator skipped gets pulled into
  // verification when the reasoning monitor flagged the draft (dead end,
  // contradiction, unsupported specifics under an evidence-required plan).
  const escalatedByCognition = !orchestration.verification.enabled && !!cognitiveEscalation?.escalate;
  if (escalatedByCognition) {
    console.log(`[CIE] Verification escalated by reasoning monitor: ${cognitiveEscalation.reason} req=${requestId}`);
  }
  if (orchestration.verification.enabled || escalatedByCognition) {
    // One policy for verification, reasoning pass and debate seating
    // (verificationStrategy.reviewDepth): a short, non-sensitive question that
    // merely matched no classifier pattern no longer seats the debate panel.
    const deepReview = reviewDepth({
      complexity: plan?.complexity, confidence,
      tags: orchestration.multiLabel?.tags ?? [], userMessage,
    }).deepReview;
    const agent = (deepReview && getAgent('debate')) || getAgent('verification');
    if (agent) {
      verification = await agent.run({
        userMessage,
        draftAnswer,
        taskType,
        requestId,
        conversationId,
        responseBudget: orchestration.budget,
        maxPasses: deepReview ? 2 : 1,
        tags: orchestration.multiLabel?.tags ?? [], // debate seats security/compliance reviewers from these; verification ignores it
        evidenceContext, // Phase 0 (F1/F3): reviewers see the drafter's evidence — grounding contract
        conversationContext, // D-02 (2026-11-16): reviewers see the conversation the draft answered
        costLedger,
      });
    }
  }
  // True only when the monitor's escalation actually produced a review the
  // orchestrator had skipped — payload diagnostics + reflection read this.
  verification.escalatedByCognition = escalatedByCognition && verification.ran;
  // The single truthful verdict (orchestrator/verificationStrategy.js):
  // `verified` only when a completed pass confirmed the delivered answer.
  verification.status = verificationStatus(verification, { warranted: orchestration.verification.enabled || escalatedByCognition });

  // ── PIC reasoning feedback (Phase 4) — the verdict trains retrieval ────────
  // The knowledge this turn injected was just judged: a clean pass ⇒ those
  // facts held up under review ('verified'); a revision ⇒ 'corrected'; a
  // failed, unrevised pass ⇒ 'unsupported'. recordReasoningOutcome is
  // fail-open internally and a no-op when nothing was injected — turns
  // without PIC knowledge are byte-identical to pre-Phase-4 behavior.
  // Only a review that FINISHED is evidence about the facts: a timeout,
  // truncated or unparseable reviewer says nothing about them, and booking it
  // as 'unsupported' taught retrieval to distrust facts a provider failed on.
  const FEEDBACK = { verified: 'verified', revised_unconfirmed: 'corrected', issues_unresolved: 'unsupported' };
  if (FEEDBACK[verification.status] && memoryOwner && knowledgeItems.length) {
    recordReasoningOutcome(memoryOwner, {
      requestId,
      // Health/mood sentences removed (found by the Phase 3 journey: this
      // diagnostic field persisted the raw message into the user's PIC store,
      // bypassing the sensitivity policy). Always redacted: this function does
      // not know the user's opt-in, and the field is only a diagnostic label.
      query: redactSensitiveSentences(userMessage).text,
      outcome: FEEDBACK[verification.status],
      usedFacts:    knowledgeItems.filter(i => i.kind === 'fact').map(i => i.id),
      usedEntities: knowledgeItems.filter(i => i.kind === 'entity').map(i => i.entity),
    });
  }
  return verification;
}

/** Diagnostics payload — identical shape between /chat JSON and /chat/stream `done`. */
const CLAIM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Canonical claims used for this answer → user-facing correction references. Bounded (G6). */
export function worldModelClaimRefs(items, max = 12) {
  return (Array.isArray(items) ? items : [])
    .filter(i => i?.kind === 'fact' && CLAIM_ID_RE.test(String(i.id ?? '')))
    .slice(0, max)
    .map(i => ({
      claimId: String(i.id),
      statement: i.statement ?? null,
      understood: i.understood ?? null,
      disputed: !!i.disputed,
      correct: `/brain/claims/${encodeURIComponent(String(i.id))}/correct`,
      history: `/brain/claims/${encodeURIComponent(String(i.id))}/history`,
    }));
}

/**
 * CONTEXT USED (2026-10-28) — what Aqua knew about the user that was put in
 * front of the model for THIS answer, in the user's terms, for the optional
 * "Context used" disclosure under the answer. Only items that were actually
 * injected: the facts memoryRetrieve returned (already relevance-gated,
 * sensitivity-filtered and schema-checked) and the canonical claims the
 * context engine assembled. Each carries what the client needs to forget or
 * correct it — a fact key or a claim id — and nothing internal (no scores,
 * lanes or slot ids). Labels follow the Memory page's rules
 * (memory/displayLabels.js): a custom_ key has no heading, only its value.
 *
 * Checked against the FINAL system prompt, not just the retrieval output
 * (2026-10-29): a fact is listed only if its exact prompt line is in the
 * prompt (retrieval returns facts from 0.5 confidence, the formatter injects
 * from 0.55), and a claim only if the knowledge block that renders it is.
 * No prompt (a branch that built none) → nothing listed. Fail closed: the
 * list may understate (superseded history lines are not listed), never
 * overstate.
 */
export function contextUsedItems(relevantFacts = [], knowledgeItems = [], { systemPrompt = '', knowledgeContext = '', max = 8 } = {}) {
  const out = [];
  if (typeof systemPrompt !== 'string' || !systemPrompt) return out;
  const seen = new Set();
  const push = item => {
    const k = item.text.toLowerCase();
    if (!item.text || seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(item);
  };
  const claimsInPrompt = typeof knowledgeContext === 'string' && knowledgeContext.trim() !== '' && systemPrompt.includes(knowledgeContext.trim());
  for (const i of claimsInPrompt && Array.isArray(knowledgeItems) ? knowledgeItems : []) {
    if (i?.kind !== 'fact' || !CLAIM_ID_RE.test(String(i.id ?? '')) || i.superseded) continue;
    const text = String(i.statement ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
    if (text) push({ kind: 'claim', id: String(i.id), text, disputed: !!i.disputed, value: i.understood?.object ?? null });
  }
  for (const f of Array.isArray(relevantFacts) ? relevantFacts : []) {
    if (!f?.key || typeof f.key !== 'string') continue;
    const line = factPromptLine(f);
    if (!line || !systemPrompt.includes(line)) continue;
    const text = factItems(f.value).join(', ').slice(0, 280);
    if (text) push({ kind: 'fact', key: f.key, label: factLabel(f), text });
  }
  return out;
}

function buildResponsePayload({
  requestId, conversationId, isNew, result, finalAnswer, taskType, confidence,
  promptModules, prep, orchestration, plan, reasoning, intelligence, verification,
  extractedFacts, relevantFacts, contextStats, workspaceId, projectContext, projectFiles,
  identityGuarded = false,
  durableCommit = false,      // the turn was committed through the durable (partition) path
  draftObservation = null,   // CIE reasoning-monitor result (null on artifact/edit branches)
}) {
  // Phase 12 — per-RESPONSE confidence, deterministic aggregation of this
  // turn's own signals (see intelligence/confidenceEngine.js). Distinct
  // from top-level `confidence`, which is the CLASSIFIER's confidence and
  // keeps its exact meaning and position for existing clients. Hoisted so
  // the CIE conclusion below can fold it into the reasoning dimension.
  const responseConfidence = assessConfidence({
    classifierConfidence: confidence,
    factsInjected:        relevantFacts.length,
    projectFilesUsed:     projectFiles.length,
    groundingExpected:    isGroundingExpected(taskType),
    attemptCount:         result.fallbackChain?.length ?? 1,
    truncated:            result.truncated ?? false,
    finishReason:         result.finishReason ?? 'stop',
    verification,
  });

  // CIE conclusion — 7-dimension structured confidence (retrieval / evidence /
  // reasoning / entity / relationship / timeline / overall) + reflection +
  // strategy learning. Null when the CIE is off or the turn had no cognitive
  // plan (artifact & edit branches): the absent key keeps those payloads
  // byte-identical to pre-CIE.
  const cognitionBlock = concludeTurn({ prep, verification, responseConfidence, draftObservation });

  return {
    success:        true,
    requestId,
    conversationId,
    isNewConversation: isNew,

    provider:       result.provider,
    providerScore:  +result.score.toFixed(1),
    taskType,
    taskLabels:     result.labels,
    confidence:     +confidence.toFixed(2),
    promptModules,
    latencyMs:      result.latency,
    fallbackChain:  result.fallbackChain,
    answer:         finalAnswer,
    truncated:      result.truncated ?? false,
    finishReason:   result.finishReason ?? 'stop',

    memory: {
      owner:      prep.memoryOwner ?? null,
      trace:      getMemoryTrace(requestId) ? `/memory/inspector/${requestId}` : null,
      extracted:  extractedFacts.length,
      injected:   relevantFacts.length,
      facts:      relevantFacts.map(f => ({ key: f.key, value: f.value })),
      // Which store answered: 'authoritative'/'canonical' = World Model;
      // 'legacy' with degraded=true = the canonical store was unreachable.
      readMode:   prep?.readState?.mode ?? null,
      degraded:   prep?.readState?.degraded ?? false,
    },

    mind: prep?.mind ?? { observedSignals: 0, goalsTouched: 0, contextInjected: false, contextUsed: {} },

    // 2026-11-16 (additive) — how this turn used the conversation: counts and
    // statuses only, never text. `reference` is resolved / ambiguous /
    // unresolved / own_subject / none (core/conversationContext.js).
    conversation: {
      ...conversationContextStats(prep?.conversation),
      window: prep?.windowStats ? { included: prep.windowStats.included, excluded: prep.windowStats.excluded, truncated: prep.windowStats.truncated } : null,
      evidenceState: prep?.knowledgeEpistemic ?? null,
    },

    // 2026-11-16 (audit D-15) — what the server actually knows about where this
    // turn is stored: DURABLE | MIRRORED | LOCAL_ONLY | DEGRADED | FAILED.
    persistence: { state: persistenceState({ durableCommit }) },

    // CORRECTION REFERENCES (Phase 3, 2026-10-06). Every canonical World-Model
    // claim this answer was grounded in, with the endpoint that corrects it
    // and the one that shows its history — so "that's wrong" can always be
    // routed to the canonical write path for the exact claim Aqua relied on.
    // Absent when no canonical claim was used (payload unchanged).
    ...(() => {
      const claims = worldModelClaimRefs(prep?.knowledgeItems);
      return claims.length ? { worldModel: { claims } } : {};
    })(),

    // CONTEXT USED (2026-10-28): see contextUsedItems. Absent when nothing
    // about the user was injected, so trivial answers carry no disclosure.
    ...(() => {
      const items = contextUsedItems(relevantFacts, prep?.knowledgeItems, { systemPrompt: prep?.systemPrompt, knowledgeContext: prep?.knowledgeContext });
      return items.length ? { contextUsed: { items } } : {};
    })(),

    // RECALL SOURCES (2026-10-20): the earlier conversations this answer
    // quoted the user from — where to look, never the quoted text itself
    // (the client already has the user's own conversations). Absent when
    // nothing was recalled.
    ...(prep?.recall?.excerpts?.length ? {
      recall: {
        excerpts: prep.recall.excerpts.slice(0, 12).map(e => ({
          conversationId: e.conversationId,
          title: e.title ?? null,
          date: Number.isFinite(e.ts) ? new Date(e.ts).toISOString() : null,
          changed: !!e.changes?.length,
        })),
      },
    } : {}),

    plan: {
      complexity:           plan.complexity,
      multiStep:             plan.multiStep,
      reasoningMode:         reasoning.mode,
      contextTokensBefore:   contextStats.tokensBefore,
      contextTokensAfter:    contextStats.tokensAfter,
    },

    intelligence: {
      active:         intelligence.plan.active,
      pipeline:       intelligence.plan.pipeline.map(s => s.name),
      strategy:       intelligence.reasoning.strategy ?? null,
      criticFocus:    intelligence.critic.focusRisks ?? [],
      reasoningPass:  intelligence.reasoningPass?.ran
        ? { ran: true, provider: intelligence.reasoningPass.provider, latencyMs: intelligence.reasoningPass.latencyMs }
        : { ran: false },
    },

    verification: {
      warranted:  orchestration.verification.enabled,
      reason:     orchestration.verification.reason,
      // status/verified are the fields to read; ran/passed are kept for
      // existing consumers. verified ⇔ a completed pass confirmed this answer.
      status:     verification.status,
      verified:   verification.status === 'verified',
      error:      verification.error ?? null,
      ran:        verification.ran,
      passed:     verification.passed,
      revised:    verification.revised,
      passes:     verification.passes ?? (verification.ran ? 1 : 0),
      converged:  verification.converged ?? verification.passed ?? null,
      agent:      verification.agent ?? (verification.ran ? 'verification' : null),
      panel:      verification.panel ?? null,          // debate only: seated persona ids
      disagreements: verification.disagreements ?? [], // debate only: preserved minority findings
      grounded:           verification.grounded ?? false,           // Phase 0: reviewer saw the drafter's evidence
      suppressedRefusals: verification.suppressedRefusals ?? 0,     // Phase 0: capability-deleting revisions discarded
      suppressedMalformed: verification.suppressedMalformed ?? 0,   // forensic pass (Bug 1): empty/whitespace revisions discarded
      escalatedByCognition: verification.escalatedByCognition ?? false, // CIE: monitor pulled review into an orchestrator-skipped turn
    },

    // Phase 12 — see the hoisted assessConfidence call above.
    responseConfidence,

    // Cognitive Intelligence Engine — executive-layer diagnostics for this
    // turn: plan (style/depth/source), monitor findings, 7-dim structured
    // confidence, reflection outcome. Present only when the CIE ran.
    ...(cognitionBlock ? { cognition: cognitionBlock } : {}),

    orchestration: {
      profile:            orchestration.profile.id,
      profileLabel:       orchestration.profile.label,
      capabilitiesEnabled: orchestration.enabled.map(c => c.id),
      capabilitiesSkipped: orchestration.skipped.map(c => c.id),
      estimatedCost:      orchestration.estimatedCost,
      estimatedLatency:   orchestration.estimatedLatency,
      verificationEnabled: orchestration.verification.enabled,
      multiLabel:         orchestration.multiLabel.labels,
      tags:               orchestration.multiLabel.tags,
    },

    ...(workspaceId ? {
      project: {
        workspaceId,
        contextInjected: !!projectContext,
        filesReferenced: projectFiles ?? [],
      },
    } : {}),

    // Day 5 — Universal Upload: attachments grounding this answer.
    ...(prep?.attachments?.length ? { attachments: prep.attachments } : {}),

    // Web Search: present only when the orchestrator enabled the capability
    // for this turn (used=false still reported — a skipped/failed search is
    // diagnostic signal, not an error).
    ...(prep?.search ? {
      search: {
        used:      prep.search.used,
        cached:    prep.search.cached,
        provider:  prep.search.provider,
        query:     prep.search.query,
        sources:   prep.search.sources,
        tokens:    prep.search.contextTokens,
        latencyMs: prep.search.latencyMs,
        ...(prep.search.reason ? { reason: prep.search.reason } : {}),
      },
    } : {}),

    // Identity & Self-Knowledge Layer: present only when this turn was a
    // question about AQUA/Aquiplex itself.
    ...(prep?.identityIntent?.isSelf ? {
      identity: {
        selfQuestion: true,
        topics:       prep.identityIntent.topics,
        guardEngaged: identityGuarded,   // true only if the model hedged and we substituted
      },
    } : {}),
  };
}

// ── POST /chat — original request/response endpoint (contract unchanged) ─────
/**
 * Per-turn AI consumption for the platform's product-event tap (chat_turn
 * props): provider calls and tokens from this turn's cost ledger, plus how
 * many provider attempts the answer took. Counts only — never content, never
 * ids beyond the session user the tap already has. Fail-open.
 */
export function aiUsageForTurn(costLedger, result) {
  try {
    const s = costLedger?.summary?.() ?? {};
    const attempts = Array.isArray(result?.fallbackChain) ? result.fallbackChain.length : null;
    const out = {
      aiCalls: Number.isFinite(s.calls) ? s.calls : null,
      aiInTok: Number.isFinite(s.inputTokens) ? s.inputTokens : null,
      aiOutTok: Number.isFinite(s.outputTokens) ? s.outputTokens : null,
      providerAttempts: attempts,
      fallback: attempts != null ? attempts > 1 : null,
      provider: typeof result?.provider === 'string' ? result.provider : null,
    };
    for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
    return out;
  } catch {
    return {};
  }
}

router.post('/', async (req, res) => {
  const requestId = uuidv4();
  // Phase 0 (audit F4) — the chat endpoints are the largest attachment/
  // history consumers, and previously reused ANY existing conversationId:
  // a caller with someone else's id could read their history, attachments,
  // and memory into a response AND append messages. Same contract as every
  // other guarded route: sessions touch only their own conversations,
  // sessionless/dev unchanged, mismatch = 404 (no existence oracle). A
  // NON-existent client-chosen id keeps the create-with-that-id contract; a
  // server-issued id that cannot be loaded is never re-created empty (D-07,
  // resolveTurnConversation).
  const resolved = resolveTurnConversation(req, requestId);
  if (resolved.error) {
    if (resolved.error.retryAfterS) res.set('Retry-After', String(resolved.error.retryAfterS));
    return res.status(resolved.error.status).json(resolved.error.body);
  }
  const { conversationId, isNew } = resolved;
  console.log(`[CHAT] ${isNew ? 'CONVERSATION_CREATED' : resolved.loadState === 'recovered' ? 'CONVERSATION_RECOVERED' : 'CONVERSATION_REUSED'} id=${conversationId} req=${requestId}`);
  // D-14: one turn at a time per conversation (bounded wait, then 409).
  const releaseTurn = await acquireConversationTurn(conversationId);
  if (!releaseTurn) return busyResponse(res, requestId, conversationId);
  const ctx = createContext({ conversationId, requestId });
  const costLedger = createTurnLedger();
  ctx.costLedger = costLedger;
  ctx.costPurpose = 'chat';

  try {
    const { message, workspaceId: requestedWorkspaceId = null, mode = null } = req.body ?? {};
    const workspaceId = turnWorkspaceId(req, requestedWorkspaceId, requestId);
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        success: false,
        requestId,
        conversationId,
        code: ErrorCodes.BAD_REQUEST,
        error: 'message is required and must be a non-empty string',
      });
    }
    const userMessage = message.trim();

    // P0 — the server owns conversation titles now. Derive once, on the very
    // first message; renames later arrive via PATCH /conversations/:id.
    if (isNew) updateConversationMeta(conversationId, { title: deriveTitle(userMessage) });

    // ── Day 4: patch-first editing branch ────────────────────────────────────
    if (isEditIntent(userMessage, workspaceId)) {
      try {
        const proposal = await proposeEdit({ workspaceId, instruction: userMessage, requestId, conversationId });
        const answer = composePatchExplanation(proposal);
        addMessage(conversationId, 'user',      userMessage);
        addMessage(conversationId, 'assistant', answer);
        return res.json(buildEditResponsePayload({ requestId, conversationId, isNew, proposal, answer, workspaceId }));
      } catch (err) {
        // Fall back to the normal explain pipeline — an edit attempt never
        // fails the whole request. The model will answer conversationally.
        console.warn(`[EDIT] falling back to chat pipeline (${err.code ?? 'ERROR'}): ${err.message}`);
      }
    }

    const artifactWork = detectArtifactWork(userMessage);
    const prep = await prepareTurn({
      mode,
      userMessage, workspaceId, conversationId, userId: req.aquaUserId ?? null, ctx, requestId,
      skipReasoningPass: !!(artifactWork.create || artifactWork.edit),
      rememberSensitive: req.aquaSettings?.rememberSensitive === true,
    });
    const {
      taskType, confidence, orchestration, plan, reasoning, intelligence,
      extractedFacts, relevantFacts, projectContext, projectFiles,
      systemPrompt, promptModules, messages, contextStats,
    } = prep;

    // ── Universal Artifact Engine branch (P1 create / P5 edit) ─────────────────
    // After prepareTurn (grounding), before generation (which it replaces).
    // Edit is checked FIRST — "change slide 5" must never mint a new deck.
    // Any failure falls back to the normal pipeline — edit-branch contract.
    if (ARTIFACTS_ENABLED) {
      try {
        const editTurn = await runArtifactEditTurn({ userMessage, prep, conversationId, workspaceId, requestId, isNew, onEvent: () => {} });
        if (editTurn) return res.json(editTurn.payload);
      } catch (err) {
        console.warn(`[ARTIFACT] edit failed, falling back to chat pipeline (${err.code ?? err.name ?? 'ERROR'}): ${err.message}`);
      }
      const artifactIntent = artifactWork.create;
      if (artifactIntent) {
        try {
          const art = await runArtifactTurn({ userMessage, prep, intent: artifactIntent, conversationId, workspaceId, requestId, isNew });
          if (art) return res.json(art.payload);
        } catch (err) {
          console.warn(`[ARTIFACT] falling back to chat pipeline (${err.code ?? err.name ?? 'ERROR'}): ${err.message}`);
        }
      }
    }

    // ── 8. Generate — router handles ranking + fallback + circuit breaker ──────
    // Orchestration 2.0 (additive, fail-open): agent tasks and explicitly
    // multi-part high-complexity requests run through the task-graph runtime
    // — decompose → route each subtask to a specialist (providers/router
    // still owns model choice per call) → verify/score → recover → synthesize.
    // The runtime returns a generateText-superset result, so EVERYTHING
    // downstream (CIE monitor, verification, payload, learning ledger) is
    // untouched. Any runtime error falls back to the legacy single call.
    // Kill switch: AQUA_GRAPH=off. Streaming path is intentionally untouched.
    let result = null;
    const graphEligible = String(process.env.AQUA_GRAPH ?? 'on').toLowerCase() !== 'off'
      && !prep.identityIntent?.isSelf
      && (taskType === 'agent_task' || (plan.complexity === 'high' && /\n\s*\d+[.)]\s+/.test(userMessage)));
    if (graphEligible) {
      try {
        const { runTaskGraph } = await import('../orchestrator/graphRuntime.js');
        result = await runTaskGraph({
          userMessage, taskType, plan,
          context: {
            memory: prep.memoryBlock ?? '', evidence: prep.evidenceContext ?? '', search: prep.searchContext ?? '',
            // D-04 (2026-11-16): the graph continues THIS conversation.
            conversation: renderRecentConversation(prep.conversation, { maxChars: 1500 }),
            conversationNote: referenceNote(prep.conversation),
          },
          budget: orchestration.budget, ctx,
        });
        noteFeature('AQUA_GRAPH', 'ran');
        console.log(`[GRAPH] chat turn served by task-graph runtime nodes=${result.orchestration2.nodes.length} conf=${result.orchestration2.confidence.overall} req=${requestId}`);
      } catch (err) {
        noteFeature('AQUA_GRAPH', 'failed', err?.name);
        console.warn(`[GRAPH] falling back to single-call pipeline (${err.message}) req=${requestId}`);
        result = null;
      }
    }
    if (!result) result = await generateText(
      userMessage,
      systemPrompt,
      messages,
      ctx,
      taskType,
      plan,
      orchestration.budget,
    );

    // ── 8a². CIE reasoning monitor — inspect the draft, maybe escalate review ──
    // Deterministic structural checks (dead ends, circularity, unsupported
    // specifics, contradiction-lite, token waste) at the SAME seam
    // verification uses. Fail-open; empty result when CIE is off.
    const draftObservation = observeDraft({ draft: result.text, prep });

    // ── 8b. Verification (Phase 6 decision → real pass) ─────────────────────────
    let finalAnswer = result.text;
    const verification = await runVerification({
      orchestration, userMessage, draftAnswer: result.text, taskType, requestId, conversationId, plan, confidence,
      evidenceContext: prep.evidenceContext,
      conversationContext: prep.conversation,
      knowledgeItems: prep.knowledgeItems, memoryOwner: prep.memoryOwner,   // PIC feedback loop (Phase 4)
      cognitiveEscalation: draftObservation.escalate,                       // CIE: monitor can only ADD review
      costLedger,
    });
    if (verification.revised && verification.finalAnswer) {
      finalAnswer = verification.finalAnswer;
    }
    logVerificationEvent(ctx, verification);

    // ── 8c. Identity contract guard — self answers must stay first-party grounded ─
    // The compact identity block + directive make a hedge on a self-question
    // extremely unlikely, but this is the hard guarantee: if the model still
    // refused, replace the answer with the deterministic profile answer.
    let identityGuarded = false;
    if (prep.identityIntent?.isSelf && (isRefusal(finalAnswer) || violatesIdentityContract(finalAnswer))) {
      const grounded = answerFromIdentity(userMessage);
      if (grounded) {
        console.warn(`[IDENTITY] guard engaged — model hedged on a self-question; substituting profile answer req=${requestId}`);
        finalAnswer = grounded;
        identityGuarded = true;
      }
    }

    // ── 9. Persist messages ──────────────────────────────────────────────────────
    const assistantExtra = {
      contextRefs: contextRefs(contextUsedItems(relevantFacts, prep?.knowledgeItems, { systemPrompt: prep?.systemPrompt, knowledgeContext: prep?.knowledgeContext })),
      // D-06: the verdict on the text that becomes history (status words only).
      verification: { status: verification.status ?? null, outcome: verification.outcome ?? null, revised: !!(verification.revised && verification.finalAnswer) },
      ownerUserId: req.aquaUserId ?? null,   // D-13: only used if the store must auto-create
    };
    const postTurnArgs = { ownerId: prep.memoryOwner, conversationId, ...memoryWriteTurn(prep, finalAnswer), taskType, workspaceId };
    const durableCommit = durableTurnLearningActive();
    if (durableCommit) {
      // Scalability Phase 3: messages + learning jobs in ONE transaction; the
      // workers learn. Throws (retryable → 503, refund, memory rollback) when
      // the turn could not be made durable — it is then not acknowledged.
      await commitTurnWithLearning({
        conversationId, userMessage, assistantMessage: finalAnswer, assistantExtra,
        ownerId: prep.memoryOwner, taskType, workspaceId, rememberSensitive: !!prep?.rememberSensitive,
        commitMemory: () => commitTurnMemory(ctx.memoryTxn),   // the commit boundary
        memoryTxn: ctx.memoryTxn,   // Phase 4A: effects awaited; embeddings as a durable job
        chargeId: req.creditContext?.chargeId ?? null,   // Phase 4B: COMMITTED in the turn's transaction
        legacyPostTurn: () => runPostTurn(postTurnArgs),
      });
    } else {
      persistUserTurn(ctx.memoryTxn, conversationId, userMessage);   // the commit boundary
      addMessage(conversationId, 'assistant', finalAnswer, assistantExtra);

      // ── 9b-9d. Post-turn understanding — Mind post-turn, world-model ingest,
      //          Digital Twin, cadence-gated Reflection V2. Extracted to ONE
      //          shared unit so both endpoints cannot drift (audit W6); the
      //          behaviour is unchanged from when this block was inline.
      runPostTurn(postTurnArgs);
    }

    // ── 10. Respond ──────────────────────────────────────────────────────────────
    const payload = buildResponsePayload({
      identityGuarded, draftObservation, durableCommit,
      requestId, conversationId, isNew, result, finalAnswer, taskType, confidence,
      promptModules, prep, orchestration, plan, reasoning, intelligence, verification,
      extractedFacts, relevantFacts, contextStats, workspaceId, projectContext, projectFiles,
    });
    logTurnDiagnostics({ requestId, conversationId, prep, verification, payload, path: result.orchestration2 ? "graph" : "single", stream: false });

    // ── 10b. Learning ledger (Phase 11) — fail-open inside recordOutcome ────────
    recordOutcome({
      taskType,
      provider: result.provider,
      responseConfidence: payload.responseConfidence,
      verification,
      verificationWarranted: orchestration.verification.enabled,
      latencyMs: result.latency,
    });

    recordTurnCost(costLedger.summary(), { providerCallsAlreadyCounted: true });
    logCompletion(ctx, { taskType, classifierConfidence: confidence, promptModules,
      responseLength: finalAnswer.length, selectedProvider: result.provider, finalLatencyMs: result.latency });
    if (res.locals) res.locals.aiUsage = aiUsageForTurn(costLedger, result);
    return res.json(payload);
  } catch (err) {
    console.error('[CHAT] Request failed:', err.message);
    logCompletion(ctx, { error: err });
    // P1 (freemium trust) — usageGuard deducted credits on entry; a failed
    // generation must give them back. refund() is idempotent-safe upstream.
    req.creditContext?.refund?.().catch?.(() => {});
    ctx.attempts ??= [];

    // Retryable exhaustion (every provider hit a TRANSIENT failure: 429/503/
    // timeout/network/no-capacity) is NOT a 500. Answer 503 + Retry-After so a
    // benchmark client (AQEval) retries into a recovered provider instead of
    // recording a hard infrastructure failure. Only genuinely terminal errors
    // (auth/config/deprecated-model, or a non-provider bug) return 500.
    const retryable = err?.retryable === true;
    const status    = retryable ? 503 : 500;
    if (retryable) {
      const retryAfterS = Math.max(1, Math.ceil((err.retryAfterMs ?? 2000) / 1000));
      res.set('Retry-After', String(retryAfterS));
    }
    console.error(`[CHAT] → HTTP ${status} retryable=${retryable} type=${err?.type ?? 'n/a'} req=${requestId}`);
    return res.status(status).json({
      success:        false,
      code:           retryable ? ErrorCodes.UNAVAILABLE : ErrorCodes.INTERNAL,
      requestId,
      conversationId,
      // The router's message and the per-provider errors stay in the log
      // above; the browser gets a sentence and the shape of the attempts.
      error:          publicErrorMessage(err),
      retryable,
      errorType:      err?.type ?? null,
      retryAfterMs:   retryable ? (err.retryAfterMs ?? 2000) : null,
      fallbackChain:  (err?.attempts ?? ctx.attempts).map(a => ({ outcome: a.outcome, reason: a.reason ?? a.type })),
    });
  } finally {
    // A turn whose user message was never persisted leaves no knowledge behind
    // (memory/turnCommit.js). No-op when it committed.
    rollbackTurnMemory(ctx.memoryTxn, { reason: 'not-persisted' });
    releaseTurn();   // D-14 — always, on success, error and early return
  }
});

// ── POST /chat/stream — Server-Sent Events (Day 3 — Real Streaming) ──────────
router.post('/stream', async (req, res) => {
  const requestId = uuidv4();
  // Phase 0 (audit F4) — identical guard to POST /chat; runs BEFORE any SSE
  // headers so an unauthorized reuse gets a plain 404 JSON, not a stream.
  // Same resolution as POST /chat (D-07: never a silent empty re-creation).
  const resolved = resolveTurnConversation(req, requestId);
  if (resolved.error) {
    if (resolved.error.retryAfterS) res.set('Retry-After', String(resolved.error.retryAfterS));
    return res.status(resolved.error.status).json(resolved.error.body);
  }
  const { conversationId, isNew } = resolved;
  console.log(`[CHAT] ${isNew ? 'CONVERSATION_CREATED' : resolved.loadState === 'recovered' ? 'CONVERSATION_RECOVERED' : 'CONVERSATION_REUSED'} id=${conversationId} req=${requestId} (stream)`);
  const ctx = createContext({ conversationId, requestId });
  const costLedger = createTurnLedger();
  ctx.costLedger = costLedger;
  ctx.costPurpose = 'chat';

  const { message, workspaceId: requestedWorkspaceId = null, mode = null } = req.body ?? {};
  const workspaceId = turnWorkspaceId(req, requestedWorkspaceId, requestId);
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({
      success: false,
      requestId,
      conversationId,
      code: ErrorCodes.BAD_REQUEST,
      error: 'message is required and must be a non-empty string',
    });
  }
  const userMessage = message.trim();

  // D-14: one turn at a time per conversation — decided BEFORE the SSE
  // handshake, so a busy conversation gets a plain 409 JSON, not a stream.
  const releaseTurn = await acquireConversationTurn(conversationId);
  if (!releaseTurn) return busyResponse(res, requestId, conversationId);

  // P0 — server-owned title, derived on first message (see POST /chat note).
  if (isNew) updateConversationMeta(conversationId, { title: deriveTitle(userMessage) });

  // ── SSE handshake ────────────────────────────────────────────────────────────
  res.writeHead(200, {
    'Content-Type':      'text/event-stream; charset=utf-8',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx) — tokens must flush immediately
  });
  res.flushHeaders?.();

  let closed = false;
  const send = (event, data) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Client disconnect (Stop button, closed tab, network drop) → abort provider.
  const clientAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      closed = true;
      clientAbort.abort();
      console.log(`[CHAT] client disconnected mid-stream req=${requestId}`);
    }
  });

  // Heartbeat comment every 15s keeps proxies from timing out idle stretches
  // (long verification passes, slow first token). SSE comments are invisible
  // to EventSource-style parsers.
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': hb\n\n');
  }, 15_000);

  send('meta', { requestId, conversationId, isNewConversation: isNew });

  try {
    // ── Day 4: patch-first editing branch (streamed) ─────────────────────────
    // Real pipeline stages stream as they start; the finished proposal arrives
    // as a dedicated `patch` event; the explanation arrives as answer text.
    if (isEditIntent(userMessage, workspaceId)) {
      let editHandled = false;
      try {
        const proposal = await proposeEdit({
          workspaceId, instruction: userMessage, requestId, conversationId,
          onStage: (id, label) => send('stage', { id, label }),
        });
        const answer = composePatchExplanation(proposal);
        send('workspace', { workspaceId, contextInjected: true, filesReferenced: proposal.files.map(f => f.path) });
        send('patch', serializeProposal(proposal));
        send('token', { t: answer });
        addMessage(conversationId, 'user',      userMessage);
        addMessage(conversationId, 'assistant', answer);
        send('done', buildEditResponsePayload({ requestId, conversationId, isNew, proposal, answer, workspaceId }));
        editHandled = true;
      } catch (err) {
        if (clientAbort.signal.aborted) throw err;
        console.warn(`[EDIT] falling back to chat pipeline (${err.code ?? 'ERROR'}): ${err.message}`);
      }
      if (editHandled) {
        clearInterval(heartbeat);
        closed = true;
        if (!res.writableEnded) res.end();
        return;
      }
    }

    // Pipeline stages stream to the client AS THEY START — every stage event
    // corresponds to real work beginning, never a scripted animation.
    const artifactWork = detectArtifactWork(userMessage);
    const prep = await prepareTurn({
      mode,
      userMessage, workspaceId, conversationId, userId: req.aquaUserId ?? null, ctx, requestId,
      onStage: (id, label) => send('stage', { id, label }),
      skipReasoningPass: !!(artifactWork.create || artifactWork.edit),
      rememberSensitive: req.aquaSettings?.rememberSensitive === true,
    });
    const {
      taskType, confidence, orchestration, plan, reasoning, intelligence,
      extractedFacts, relevantFacts, projectContext, projectFiles,
      systemPrompt, promptModules, messages, contextStats,
    } = prep;

    // Web Search grounding — structured event so the UI can render source
    // chips ("answering from: [1] nodejs.org …") while tokens arrive. The
    // current pre-built frontend ignores unknown SSE events by design
    // (chatStream.ts default: forward-compatible), so this ships safely
    // ahead of any dist rebuild.
    if (prep.search) {
      send('search', {
        used:     prep.search.used,
        cached:   prep.search.cached,
        provider: prep.search.provider,
        query:    prep.search.query,
        sources:  prep.search.sources,
      });
    }

    // Surface workspace grounding before generation so the UI can show
    // "answering from workspace X, files …" while tokens arrive.
    if (workspaceId) {
      send('workspace', {
        workspaceId,
        contextInjected: !!projectContext,
        filesReferenced: projectFiles,
      });
    }

    // ── Universal Artifact Engine branch (P1 create / P5 edit, streamed) ───────
    // Engine events map onto SSE: real pipeline stages ride the existing
    // `stage` channel; `artifact_plan` / `artifact_progress` / `artifact` are
    // new event types — the deployed frontend parser ignores unknown events
    // by design (chatStream.ts default case), so this ships backend-first.
    if (ARTIFACTS_ENABLED) {
      // P5 — edit first: "change slide 5" must never mint a new deck.
      let artifactHandled = false;
      const mapEvent = (ev) => {
        if (ev.type === 'stage')         send('stage', { id: ev.id, label: ev.label });
        else if (ev.type === 'plan')     send('artifact_plan', ev.plan);
        else if (ev.type === 'progress') send('artifact_progress', ev.progress);
        else if (ev.type === 'artifact') send('artifact', ev.manifest);
      };
      try {
        const editTurn = await runArtifactEditTurn({
          userMessage, prep, conversationId, workspaceId, requestId, isNew,
          onEvent: mapEvent,
        });
        if (editTurn) {
          send('artifact', editTurn.result.manifest);
          send('token', { t: editTurn.result.summaryText });
          send('done', editTurn.payload);
          artifactHandled = true;
        }
      } catch (err) {
        if (clientAbort.signal.aborted) throw err;
        console.warn(`[ARTIFACT] edit failed, falling back to chat pipeline (${err.code ?? err.name ?? 'ERROR'}): ${err.message}`);
      }
      if (!artifactHandled) {
      const artifactIntent = artifactWork.create;
      if (artifactIntent) {
        try {
          const art = await runArtifactTurn({
            userMessage, prep, intent: artifactIntent, conversationId, workspaceId, requestId, isNew,
            clientSignal: clientAbort.signal,
            onEvent: mapEvent,
          });
          if (art) {
            send('token', { t: art.result.summaryText });
            send('done', art.payload);
            artifactHandled = true;
          }
        } catch (err) {
          if (clientAbort.signal.aborted) throw err;
          console.warn(`[ARTIFACT] falling back to chat pipeline (${err.code ?? err.name ?? 'ERROR'}): ${err.message}`);
        }
      }
      }
      if (artifactHandled) {
        clearInterval(heartbeat);
        closed = true;
        if (!res.writableEnded) res.end();
        return;
      }
    }

    // ── 8. Generate (streamed) ───────────────────────────────────────────────────
    send('stage', { id: 'generate', label: 'Generating response…' });

    const result = await generateTextStream({
      userMessage,
      systemPrompt,
      messages,
      ctx,
      preTaskType:    taskType,
      executionPlan:  plan,
      responseBudget: orchestration.budget,
      clientSignal:   clientAbort.signal,
      onEvent: (ev) => {
        if (ev.type === 'token')            send('token', { t: ev.text });
        else if (ev.type === 'provider_attempt') send('provider', { provider: ev.provider, score: ev.score, attempt: ev.attempt });
        else if (ev.type === 'provider_failed')  send('provider_failed', { provider: ev.provider, reason: ev.reason });
      },
    });

    // ── 8a². CIE reasoning monitor — stream-end draft inspection ───────────────
    // The draft is only complete now (same seam verification already uses for
    // streams). Its escalate decision can pull verification into a turn the
    // orchestrator skipped — the `replace` event delivers any revision, so
    // the UX contract is unchanged. Fail-open; empty result when CIE is off.
    const draftObservation = observeDraft({ draft: result.text, prep });

    // ── 8b. Verification — runs AFTER the stream; revision replaces the draft ──
    let finalAnswer = result.text;
    // Warranted but never run (client aborted) is 'unavailable', not silence.
    let verification = { ran: false, passed: null, revised: false, status: orchestration.verification.enabled ? 'unavailable' : 'not_requested' };
    if ((orchestration.verification.enabled || draftObservation.escalate.escalate) && !clientAbort.signal.aborted) {
      send('stage', { id: 'verify', label: 'Verifying answer…' });
      verification = await runVerification({
        orchestration, userMessage, draftAnswer: result.text, taskType, requestId, conversationId, plan, confidence,
        evidenceContext: prep.evidenceContext,
        conversationContext: prep.conversation,
        knowledgeItems: prep.knowledgeItems, memoryOwner: prep.memoryOwner,   // PIC feedback loop (Phase 4)
        cognitiveEscalation: draftObservation.escalate,                       // CIE: monitor can only ADD review
        costLedger,
      });
      if (verification.revised && verification.finalAnswer) {
        finalAnswer = verification.finalAnswer;
        send('replace', { text: finalAnswer });
      }
    }
    logVerificationEvent(ctx, verification);

    // ── 8c. Identity contract guard — self answers must stay first-party grounded ─
    // Runs regardless of whether verification was enabled. If the model hedged
    // on a self-question, replace with the deterministic profile answer and
    // emit `replace` so the UI swaps the draft (same mechanism verification
    // uses). The always-injected identity block makes this path rare.
    let identityGuarded = false;
    if (prep.identityIntent?.isSelf && !clientAbort.signal.aborted && (isRefusal(finalAnswer) || violatesIdentityContract(finalAnswer))) {
      const grounded = answerFromIdentity(userMessage);
      if (grounded) {
        console.warn(`[IDENTITY] guard engaged (stream) — substituting profile answer req=${requestId}`);
        finalAnswer = grounded;
        identityGuarded = true;
        send('replace', { text: finalAnswer });
      }
    }

    // ── 9. Persist the visible turn before terminalizing the stream ─────────────
    const assistantExtra = {
      contextRefs: contextRefs(contextUsedItems(relevantFacts, prep?.knowledgeItems, { systemPrompt: prep?.systemPrompt, knowledgeContext: prep?.knowledgeContext })),
      // D-06: the verdict on the text that becomes history (status words only).
      verification: { status: verification.status ?? null, outcome: verification.outcome ?? null, revised: !!(verification.revised && verification.finalAnswer) },
      ownerUserId: req.aquaUserId ?? null,   // D-13: only used if the store must auto-create
    };
    const postTurnArgs = { ownerId: prep.memoryOwner, conversationId, ...memoryWriteTurn(prep, finalAnswer), taskType, workspaceId };
    // Scalability Phase 3: on the durable path the turn and its learning jobs
    // commit in one transaction BEFORE `done` is sent; a failure becomes the
    // stream's error event (refund + memory rollback), never a `done`.
    const durableTurn = durableTurnLearningActive();
    if (durableTurn) {
      await commitTurnWithLearning({
        conversationId, userMessage, assistantMessage: finalAnswer, assistantExtra,
        ownerId: prep.memoryOwner, taskType, workspaceId, rememberSensitive: !!prep?.rememberSensitive,
        commitMemory: () => commitTurnMemory(ctx.memoryTxn),   // the commit boundary
        memoryTxn: ctx.memoryTxn,   // Phase 4A: effects awaited; embeddings as a durable job
        chargeId: req.creditContext?.chargeId ?? null,   // Phase 4B: COMMITTED in the turn's transaction
        legacyPostTurn: () => runPostTurn(postTurnArgs),
      });
    } else {
      persistUserTurn(ctx.memoryTxn, conversationId, userMessage);   // the commit boundary
      addMessage(conversationId, 'assistant', finalAnswer, assistantExtra);
    }

    // ── 10. Build + send the terminal response BEFORE non-critical post-turn
    // work. Verification is already complete at this point; nothing that follows
    // is allowed to hold the user's SSE terminal event hostage. In particular,
    // post-turn understanding / learning can trigger provider calls and durable
    // writes and must never make the UI sit on a blinking cursor after the answer
    // itself is ready.
    const payload = buildResponsePayload({
      requestId, conversationId, isNew, result, finalAnswer, taskType, confidence,
      promptModules, prep, orchestration, plan, reasoning, intelligence, verification,
      extractedFacts, relevantFacts, contextStats, workspaceId, projectContext, projectFiles,
      identityGuarded, draftObservation, durableCommit: durableTurn,
    });
    logTurnDiagnostics({ requestId, conversationId, prep, verification, payload, path: "single", stream: true });

    console.log(`[CHAT] STREAM_DONE_SENT req=${requestId} conv=${conversationId} chars=${finalAnswer.length} provider=${result.provider} verificationRan=${!!verification.ran} revised=${!!verification.revised}`);
    if (res.locals) res.locals.aiUsage = aiUsageForTurn(costLedger, result);
    send('done', payload);
    logCompletion(ctx, { taskType, classifierConfidence: confidence, promptModules,
      responseLength: finalAnswer.length, selectedProvider: result.provider, finalLatencyMs: result.latency });

    // ── 10b. Post-response bookkeeping — explicitly detached from the terminal
    // SSE event. The job registry gives the deferred work a shutdown-visible
    // lifecycle without making the client wait for it.
    defer('post-response', async () => {
      try {
        // Phase 11 learning ledger — fail-open inside recordOutcome.
        recordOutcome({
          taskType,
          provider: result.provider,
          responseConfidence: payload.responseConfidence,
          verification,
          verificationWarranted: orchestration.verification.enabled,
          latencyMs: result.latency,
        });
      } catch { /* fail-open: learning must never affect the completed turn */ }

      try {
        recordTurnCost(costLedger.summary(), { providerCallsAlreadyCounted: true });
      } catch { /* fail-open: accounting must never affect the completed turn */ }

      // Post-turn understanding — Mind post-turn, world-model ingest, Digital
      // Twin, cadence-gated Reflection V2. This helper schedules its own
      // background work and never blocks the already-sent response.
      // (Durable path: already scheduled as worker jobs in the commit above.)
      if (!durableTurn) {
        try {
          runPostTurn(postTurnArgs);
        } catch { /* fail-open */ }
      }
    });
  } catch (err) {
    if (err.message === 'CLIENT_ABORTED') {
      // The user stopped generation. Persist exactly what they saw so
      // conversation history matches the screen — never lose the turn.
      const partial = err.partialText ?? '';
      persistUserTurn(ctx.memoryTxn, conversationId, userMessage);   // stopped by the user: the turn happened
      if (partial.trim()) addMessage(conversationId, 'assistant', partial);
      else await awaitRefund(req); // stopped before any output — don't charge
      // Phase 4A: what the user saw is written now, not on a timer (logged on failure:
      // nobody is waiting for a response any more).
      try { await flushScopeStrict(); } catch (e) { console.error(`[CHAT] aborted turn not yet durable req=${requestId}: ${e?.message ?? e}`); }
      console.log(`[CHAT] stream aborted by client req=${requestId} persistedChars=${partial.length}`);
    } else {
      console.error('[CHAT] Stream request failed:', err.message);
      // P1 (freemium trust) — deduct-on-entry + failed turn = refund. Phase 4A:
      // awaited (bounded) before the error event, so an API exit right after it
      // cannot lose the credit.
      await awaitRefund(req);
      ctx.attempts ??= [];
      logCompletion(ctx, { error: err });
      send('error', {
        error:         publicErrorMessage(err),
        recoverable:   true,
        requestId,
        conversationId,
        fallbackChain: ctx.attempts.map(a => ({ outcome: a.outcome })),
      });
    }
  } finally {
    clearInterval(heartbeat);
    closed = true;
    if (!res.writableEnded) res.end();
    rollbackTurnMemory(ctx.memoryTxn, { reason: 'not-persisted' });   // no-op when committed (memory/turnCommit.js)
    releaseTurn();   // D-14 — always, including client aborts and errors
  }
});

export default router;