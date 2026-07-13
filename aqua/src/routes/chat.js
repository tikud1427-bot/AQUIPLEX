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
import { buildSystemPrompt }      from '../core/promptBuilder.js';
import { buildContextWindow, estimateTokens } from '../core/tokenManager.js';
import { classifyTask }           from '../core/classifier.js';
import { createContext, logMemoryEvent, logPlanEvent, logIntelligenceEvent, logOrchestratorEvent, logVerificationEvent } from '../core/observability.js';
import { createExecutionPlan }    from '../core/executionPlanner.js';
import { getReasoningStrategy }   from '../core/reasoningStrategy.js';
import { runIntelligencePipeline } from '../intelligence/internalIntelligenceEngine.js';
import { assessConfidence, isGroundingExpected } from '../intelligence/confidenceEngine.js';
import { LOW_CONFIDENCE_THRESHOLD } from '../orchestrator/verificationStrategy.js';
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
} from '../memory/conversationStore.js';
import { resolveOwner, memoryObserve, memoryRetrieve, memoryAfterTurn, getMemoryTrace, semanticFactScores } from '../memory/engine.js';
import { retrieveProjectContext, formatProjectContext }    from '../project/projectRetriever.js';
import { semanticFileScores }                              from '../project/semanticProject.js';
import { formatAttachmentsForPrompt, getAttachments }       from '../upload/attachmentStore.js';
import { proposeEdit, serializeProposal }                   from '../project/editEngine.js';
import { getIndex }                                         from '../project/projectIndex.js';
import { detectIdentityIntent, answerFromIdentity, isRefusal } from '../identity/index.js';

const router = express.Router();

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
    verification: { warranted: true, reason: 'patch static verification', ran: v.ran, passed: v.passed, revised: false },
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
async function prepareTurn({ userMessage, workspaceId, conversationId, userId = null, ctx, requestId, onStage = () => {} }) {
  // ── 1. Resolve the ONE memory owner (unified engine) ────────────────────────
  // Platform user identity when present (cross-conversation, cross-device),
  // else this conversation as a dev/standalone fallback (adopted into the
  // user's memory on first login). Null disables memory entirely.
  const memoryOwner = resolveOwner({ userId, conversationId });
  // ── Phase 2 — semantic retrieval: start the query embedding NOW so its
  // network round-trip overlaps the synchronous prep below (classify,
  // orchestrate, observe). Awaited only at the retrieval seam. Fail-open:
  // semanticFactScores never rejects — it resolves to null when embeddings
  // are unavailable, and the retriever then behaves exactly as pre-Phase-2.
  const semanticScoresP = semanticFactScores(memoryOwner, userMessage);
  // ── 2. Classify (once — result passed to router, no double classification) ──
  onStage('classify', 'Understanding your request…');
  const { task: taskType, confidence, labels } = classifyTask(userMessage);
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
  const observed = memoryObserve(memoryOwner, {
    userMessage, taskType, workspaceId, conversationId, userId, requestId,
  });
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
    requestId,
    conversationId,
  });
  logIntelligenceEvent(ctx, intelligence);

  // ── 3. Retrieve — the ONE retrieval pipeline (unified engine) ───────────────
  // Ranked facts + cognitive state + file memory under a single token
  // budget → one memoryBlock for the prompt. Smallest high-quality context.
  const retrieved = memoryRetrieve(memoryOwner, {
    query: userMessage, taskType, factLimit: 10, requestId,
    semanticScores: await semanticScoresP,   // Phase 2: resolved query embedding (null if unavailable)
  });
  const relevantFacts = retrieved.relevantFacts;
  const memoryBlock   = retrieved.block;
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
    const projSemScores = await semanticFileScores(workspaceId, userMessage);
    const rawContext = retrieveProjectContext(workspaceId, userMessage, undefined, { semanticScores: projSemScores });
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

  // ── 6. Build system prompt ────────────────────────────────────────────────────
  onStage('prompt', 'Preparing response…');
  // Attachment context rides the projectContext slot — same injection point,
  // same budget handling in promptBuilder, no signature change.
  const combinedContext = [attachmentContext, projectContext].filter(Boolean).join('\n\n');
  const { prompt: systemPrompt, modules: promptModules } = buildSystemPrompt(taskType, memoryBlock, reasoning.directive, combinedContext, intelligence.synthesis.text, identityIntent, searchContext);

  // ── 7. Build context window (short-term message history) ─────────────────────
  const history    = getConversation(conversationId);
  const ctxBudget  = computeContextBudget(plan.complexity, orchestration.budget.maxContextTokens);
  const window     = buildContextWindow(history, ctxBudget);
  const { messages, stats: contextStats } = optimizeContext([...window, { role: 'user', content: userMessage }]);

  const promptTokens = estimateTokens(systemPrompt + messages.map(m => m.content).join(' '));

  return {
    taskType, confidence, labels,
    identityIntent,
    orchestration, plan, reasoning, intelligence,
    extractedFacts, relevantFacts,
    memoryOwner, mindOwner: memoryOwner, mind: { observedSignals: observed.mind.signals, goalsTouched: observed.mind.goalsTouched, contextInjected: !!memoryBlock, contextUsed: cognitive.used },
    projectContext, projectFiles,
    search,
    attachments: conversationAttachments.map(a => ({ id: a.id, name: a.name, kind: a.kind })),
    systemPrompt, promptModules,
    messages, contextStats, promptTokens,
  };
}

/** Verification pass — shared by both endpoints. Fails open by construction.
 * Phase 12 actuator + Phase 6 seat: high complexity or shaky classification
 * earns a deep review — the multi-voice debate panel when registered
 * (falling back to the single critic), with a second pass so a revision
 * gets re-reviewed. Everything else keeps the original single-critic,
 * single-pass check. */
async function runVerification({ orchestration, userMessage, draftAnswer, taskType, requestId, conversationId, plan, confidence }) {
  let verification = { ran: false, passed: null, revised: false };
  if (orchestration.verification.enabled) {
    const deepReview = plan?.complexity === 'high'
      || (typeof confidence === 'number' && confidence < LOW_CONFIDENCE_THRESHOLD);
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
      });
    }
  }
  return verification;
}

/** Diagnostics payload — identical shape between /chat JSON and /chat/stream `done`. */
function buildResponsePayload({
  requestId, conversationId, isNew, result, finalAnswer, taskType, confidence,
  promptModules, prep, orchestration, plan, reasoning, intelligence, verification,
  extractedFacts, relevantFacts, contextStats, workspaceId, projectContext, projectFiles,
  identityGuarded = false,
}) {
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
    },

    mind: prep?.mind ?? { observedSignals: 0, goalsTouched: 0, contextInjected: false, contextUsed: {} },

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
      ran:        verification.ran,
      passed:     verification.passed,
      revised:    verification.revised,
      passes:     verification.passes ?? (verification.ran ? 1 : 0),
      converged:  verification.converged ?? verification.passed ?? null,
      agent:      verification.agent ?? (verification.ran ? 'verification' : null),
      panel:      verification.panel ?? null,          // debate only: seated persona ids
      disagreements: verification.disagreements ?? [], // debate only: preserved minority findings
    },

    // Phase 12 — per-RESPONSE confidence, deterministic aggregation of this
    // turn's own signals (see intelligence/confidenceEngine.js). Distinct
    // from top-level `confidence`, which is the CLASSIFIER's confidence and
    // keeps its exact meaning and position for existing clients.
    responseConfidence: assessConfidence({
      classifierConfidence: confidence,
      factsInjected:        relevantFacts.length,
      projectFilesUsed:     projectFiles.length,
      groundingExpected:    isGroundingExpected(taskType),
      attemptCount:         result.fallbackChain?.length ?? 1,
      truncated:            result.truncated ?? false,
      finishReason:         result.finishReason ?? 'stop',
      verification,
    }),

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
router.post('/', async (req, res) => {
  const requestId = uuidv4();
  const { id: conversationId, isNew } = getOrCreateConversation(req.body?.conversationId ?? null, {
    userAgent: req.headers['user-agent']?.slice(0, 80),
    ip:        req.ip,
    userId:    req.aquaUserId ?? null, // platform session identity (AQUIPLEX)
  });
  console.log(`[CHAT] ${isNew ? 'CONVERSATION_CREATED' : 'CONVERSATION_REUSED'} id=${conversationId} req=${requestId}`);
  const ctx = createContext({ conversationId, requestId });

  try {
    const { message, workspaceId } = req.body ?? {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        success: false,
        requestId,
        conversationId,
        error: 'message is required and must be a non-empty string',
      });
    }
    const userMessage = message.trim();

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

    const prep = await prepareTurn({ userMessage, workspaceId, conversationId, userId: req.aquaUserId ?? null, ctx, requestId });
    const {
      taskType, confidence, orchestration, plan, reasoning, intelligence,
      extractedFacts, relevantFacts, projectContext, projectFiles,
      systemPrompt, promptModules, messages, contextStats,
    } = prep;

    // ── 8. Generate — router handles ranking + fallback + circuit breaker ──────
    const result = await generateText(
      userMessage,
      systemPrompt,
      messages,
      ctx,
      taskType,
      plan,
      orchestration.budget,
    );

    // ── 8b. Verification (Phase 6 decision → real pass) ─────────────────────────
    let finalAnswer = result.text;
    const verification = await runVerification({
      orchestration, userMessage, draftAnswer: result.text, taskType, requestId, conversationId, plan, confidence,
    });
    if (verification.revised && verification.finalAnswer) {
      finalAnswer = verification.finalAnswer;
    }
    logVerificationEvent(ctx, verification);

    // ── 8c. Identity refusal guard (spec: never "I don't know" about self) ──────
    // The compact identity block + directive make a hedge on a self-question
    // extremely unlikely, but this is the hard guarantee: if the model still
    // refused, replace the answer with the deterministic profile answer.
    let identityGuarded = false;
    if (prep.identityIntent?.isSelf && isRefusal(finalAnswer)) {
      const grounded = answerFromIdentity(userMessage);
      if (grounded) {
        console.warn(`[IDENTITY] guard engaged — model hedged on a self-question; substituting profile answer req=${requestId}`);
        finalAnswer = grounded;
        identityGuarded = true;
      }
    }

    // ── 9. Persist messages ──────────────────────────────────────────────────────
    addMessage(conversationId, 'user',      userMessage);
    addMessage(conversationId, 'assistant', finalAnswer);

    // ── 9b. Mind post-turn — predictions rebuild + async reflection when due ────
    memoryAfterTurn(prep.memoryOwner, { taskType, workspaceId });

    // ── 10. Respond ──────────────────────────────────────────────────────────────
    const payload = buildResponsePayload({
      identityGuarded,
      requestId, conversationId, isNew, result, finalAnswer, taskType, confidence,
      promptModules, prep, orchestration, plan, reasoning, intelligence, verification,
      extractedFacts, relevantFacts, contextStats, workspaceId, projectContext, projectFiles,
    });

    // ── 10b. Learning ledger (Phase 11) — fail-open inside recordOutcome ────────
    recordOutcome({
      taskType,
      provider: result.provider,
      responseConfidence: payload.responseConfidence,
      verification,
      verificationWarranted: orchestration.verification.enabled,
      latencyMs: result.latency,
    });

    return res.json(payload);
  } catch (err) {
    console.error('[CHAT] Request failed:', err.message);
    ctx.attempts ??= [];
    return res.status(500).json({
      success:        false,
      requestId,
      conversationId,
      error:          err?.message ?? 'Internal server error',
      fallbackChain:  ctx.attempts.map(a => ({ provider: a.provider, outcome: a.outcome })),
    });
  }
});

// ── POST /chat/stream — Server-Sent Events (Day 3 — Real Streaming) ──────────
router.post('/stream', async (req, res) => {
  const requestId = uuidv4();
  const { id: conversationId, isNew } = getOrCreateConversation(req.body?.conversationId ?? null, {
    userAgent: req.headers['user-agent']?.slice(0, 80),
    ip:        req.ip,
    userId:    req.aquaUserId ?? null, // platform session identity (AQUIPLEX)
  });
  console.log(`[CHAT] ${isNew ? 'CONVERSATION_CREATED' : 'CONVERSATION_REUSED'} id=${conversationId} req=${requestId} (stream)`);
  const ctx = createContext({ conversationId, requestId });

  const { message, workspaceId } = req.body ?? {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({
      success: false,
      requestId,
      conversationId,
      error: 'message is required and must be a non-empty string',
    });
  }
  const userMessage = message.trim();

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
    const prep = await prepareTurn({
      userMessage, workspaceId, conversationId, userId: req.aquaUserId ?? null, ctx, requestId,
      onStage: (id, label) => send('stage', { id, label }),
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

    // ── 8b. Verification — runs AFTER the stream; revision replaces the draft ──
    let finalAnswer = result.text;
    let verification = { ran: false, passed: null, revised: false };
    if (orchestration.verification.enabled && !clientAbort.signal.aborted) {
      send('stage', { id: 'verify', label: 'Verifying answer…' });
      verification = await runVerification({
        orchestration, userMessage, draftAnswer: result.text, taskType, requestId, conversationId, plan, confidence,
      });
      if (verification.revised && verification.finalAnswer) {
        finalAnswer = verification.finalAnswer;
        send('replace', { text: finalAnswer });
      }
    }
    logVerificationEvent(ctx, verification);

    // ── 8c. Identity refusal guard (spec: never "I don't know" about self) ──────
    // Runs regardless of whether verification was enabled. If the model hedged
    // on a self-question, replace with the deterministic profile answer and
    // emit `replace` so the UI swaps the draft (same mechanism verification
    // uses). The always-injected identity block makes this path rare.
    let identityGuarded = false;
    if (prep.identityIntent?.isSelf && !clientAbort.signal.aborted && isRefusal(finalAnswer)) {
      const grounded = answerFromIdentity(userMessage);
      if (grounded) {
        console.warn(`[IDENTITY] guard engaged (stream) — substituting profile answer req=${requestId}`);
        finalAnswer = grounded;
        identityGuarded = true;
        send('replace', { text: finalAnswer });
      }
    }

    // ── 9. Persist ───────────────────────────────────────────────────────────────
    addMessage(conversationId, 'user',      userMessage);
    addMessage(conversationId, 'assistant', finalAnswer);

    // ── 9b. Mind post-turn — predictions rebuild + async reflection when due ────
    memoryAfterTurn(prep.memoryOwner, { taskType, workspaceId });

    // ── 10. Done event — same diagnostics shape as POST /chat ───────────────────
    const payload = buildResponsePayload({
      requestId, conversationId, isNew, result, finalAnswer, taskType, confidence,
      promptModules, prep, orchestration, plan, reasoning, intelligence, verification,
      extractedFacts, relevantFacts, contextStats, workspaceId, projectContext, projectFiles,
      identityGuarded,
    });

    // ── 10b. Learning ledger (Phase 11) — fail-open inside recordOutcome ────────
    recordOutcome({
      taskType,
      provider: result.provider,
      responseConfidence: payload.responseConfidence,
      verification,
      verificationWarranted: orchestration.verification.enabled,
      latencyMs: result.latency,
    });

    send('done', payload);
  } catch (err) {
    if (err.message === 'CLIENT_ABORTED') {
      // The user stopped generation. Persist exactly what they saw so
      // conversation history matches the screen — never lose the turn.
      const partial = err.partialText ?? '';
      addMessage(conversationId, 'user', userMessage);
      if (partial.trim()) addMessage(conversationId, 'assistant', partial);
      console.log(`[CHAT] stream aborted by client req=${requestId} persistedChars=${partial.length}`);
    } else {
      console.error('[CHAT] Stream request failed:', err.message);
      ctx.attempts ??= [];
      send('error', {
        error:         err?.message ?? 'Internal server error',
        recoverable:   true,
        requestId,
        conversationId,
        fallbackChain: ctx.attempts.map(a => ({ provider: a.provider, outcome: a.outcome })),
      });
    }
  } finally {
    clearInterval(heartbeat);
    closed = true;
    if (!res.writableEnded) res.end();
  }
});

export default router;
