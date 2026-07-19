/**
 * AQUA Internal Intelligence Engine — Debate Agent (Phase 6, LLM half)
 *
 * The multi-voice counterpart to verificationAgent.js. Where verification
 * asks ONE critic to check a draft against a risk rubric, debate convenes
 * the deterministic panel debatePanel.js selects (three narrow charters)
 * and has each voice report independently — in a SINGLE model call carrying
 * all three charters, not three calls. The structured verdicts are merged
 * by the deterministic synthesizer; only an escalating panel (one high
 * finding, or two voices in agreement) spends a second call on a revision.
 *
 * Seat in the pipeline: chat.js's verification wrapper picks this agent
 * INSTEAD of 'verification' for deep-review turns (high complexity or low
 * classifier confidence) when it is registered — same run() signature,
 * superset return shape, so logVerificationEvent(), confidenceEngine's
 * verification factor, and buildResponsePayload() all work unchanged.
 * Everything verificationAgent.js promises still holds here:
 *
 *   - Fails open at every step: panel call error, unparseable panel JSON,
 *     or revision call error can never lose an accepted revision, let
 *     alone the original draft.
 *   - Reuses generateText() end-to-end (ranking, health, fallback,
 *     timeout budgeting); real taskType keeps provider ranking
 *     domain-appropriate; responseBudget inherited as-is.
 *   - Bounded convergence loop: maxPasses caps PANEL reviews; a revision
 *     is re-paneled while budget remains. Worst case LLM calls = 2×maxPasses
 *     (panel+revision per pass), and the agent only runs on turns that
 *     already earned a deep review — bulk traffic cost unchanged.
 *
 * Disagreement semantics (spec: "preserved until resolved"):
 *   - Non-escalating minority findings ship in `disagreements` — surfaced
 *     in the payload and observability rather than silently dropped or
 *     allowed to unilaterally rewrite the draft.
 *   - A failed revision call converts the escalated issues themselves into
 *     `disagreements`: the panel's objection is on the record even though
 *     the fix couldn't be produced.
 */

import { generateText }  from '../providers/router.js';
import { createContext } from '../core/observability.js';
import { registerAgent } from './agentRegistry.js';
import { selectPanel, normalizeFinding, synthesizeDebate } from './debatePanel.js';
import { hasGroundedEvidence, isCapabilityRefusal } from './evidenceContext.js';

/**
 * Phase 0 (audit F3) — grounding contract, panel edition. Deep-review turns
 * (high complexity / low confidence) seat THIS agent instead of the single
 * verifier, so a blind panel was the WORST-case instance of the overwrite
 * bug: three personas re-litigating a grounded multimodal answer with zero
 * sight of the evidence. Every voice now reviews with the drafter's context.
 *
 * @param {Array<{id, name, charter}>} panel
 * @param {boolean} grounded - evidence block accompanies the review input
 * @returns {string} system prompt for the single panel-review call
 */
function buildPanelPrompt(panel, grounded = false) {
  const roster = panel.map(p => `- ${p.id} (${p.name}): ${p.charter}`).join('\n');
  const ids = panel.map(p => p.id).join(', ');
  return [
    "You are AQUA's internal review panel. Three independent reviewers each examine a draft answer strictly from their own charter. Reviewers do not defer to each other — genuine disagreement must be reported, not smoothed over.",
    '',
    ...(grounded ? [
      'The draft was written WITH the evidence context included in the review input (file analyses, project context, search results, memory). Every reviewer treats that evidence as ground truth available to the drafter: claims supported by it are grounded, NOT hallucinations, and file/media analyses there were already performed by the platform. No reviewer may report an issue asserting that files, videos, images, audio, or documents cannot be accessed or analyzed.',
      '',
    ] : []),
    'Reviewers and charters:',
    roster,
    '',
    'Respond with EXACTLY one JSON object — no markdown fences, no prose before or after — in this schema:',
    '{"findings":[{"persona":"<id>","verdict":"pass"} or {"persona":"<id>","verdict":"issue","severity":"low|medium|high","issue":"<the specific problem>","suggestion":"<fix direction>"}]}',
    `Valid persona ids: ${ids}.`,
    '',
    'Every reviewer must appear exactly once. A reviewer reports an issue ONLY for a real, specific problem inside its own charter — never for style, tone, or phrasing preferences, and never for concerns belonging to another charter. severity "high" is reserved for problems that would make the answer wrong, unsafe, or materially misleading if shipped as-is.',
  ].join('\n');
}

const REVISION_PROMPT = [
  "You are AQUA's internal revision pass. A review panel found specific issues in a draft answer.",
  '',
  'Respond with the complete corrected replacement answer only — no preamble, no explanation of what changed, no meta-commentary about the review. Your response must be ready to send to the user exactly as-is, as a full replacement for the draft.',
  '',
  'Fix ONLY the listed issues. Preserve everything else about the draft: its structure, level of detail, and voice.',
].join('\n');

/**
 * Defensive parse of the panel's JSON. Tolerates fenced output and
 * surrounding prose by slicing the outermost {...}. Entries from unknown
 * personas or with unknown verdicts are dropped individually; a panel with
 * ZERO valid findings is unusable and throws (caught by the caller's
 * fail-open branch).
 *
 * @param {string} text
 * @param {Set<string>} allowedIds
 * @returns {Array<object>} normalized findings
 */
export function parsePanelResponse(text, allowedIds) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('panel_unparseable: no JSON object in panel response');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error(`panel_unparseable: ${err.message}`);
  }

  const findings = (Array.isArray(parsed?.findings) ? parsed.findings : [])
    .map(f => normalizeFinding(f, allowedIds))
    .filter(Boolean);

  if (findings.length === 0) {
    throw new Error('panel_unparseable: no valid findings for the seated panel');
  }
  return findings;
}

/**
 * Run the internal debate on a draft answer. Same signature family as
 * runVerification() plus `tags` (multiLabel cross-cutting tags — seats the
 * security/compliance reviewers).
 *
 * @param {object} input
 * @param {string}   input.userMessage
 * @param {string}   input.draftAnswer
 * @param {string}   input.taskType
 * @param {string[]} [input.tags]
 * @param {string}   [input.requestId]
 * @param {string}   [input.conversationId]
 * @param {number}   [input.maxPasses]      - cap on PANEL reviews (revisions ride along)
 * @param {object}   [input.responseBudget]
 * @param {Function} [input.generate]       - test injection; defaults to generateText()
 * @returns {Promise<{
 *   ran: boolean, passed: boolean|null, revised: boolean, converged: boolean,
 *   inconclusive: boolean, passes: number, finalAnswer: string, agent: 'debate',
 *   panel: string[], findings: Array<object>, disagreements: Array<object>,
 *   provider?: string, latencyMs?: number, attemptCount?: number, error?: string
 * }>}
 */
export async function runDebate({
  userMessage,
  draftAnswer,
  taskType,
  tags = [],
  requestId,
  conversationId,
  responseBudget,
  maxPasses = 1,
  evidenceContext = '',           // Phase 0 (F3): grounding contract — see buildPanelPrompt
  generate = generateText,
}) {
  const panel      = selectPanel(taskType, tags);
  const panelIds   = panel.map(p => p.id);
  const allowedIds = new Set(panelIds);
  const grounded   = hasGroundedEvidence(evidenceContext);
  const panelPrompt = buildPanelPrompt(panel, grounded);
  const evidenceBlock = grounded
    ? `Evidence context available to the drafter (ground truth):\n${evidenceContext}\n\n`
    : '';

  const debateCtx = createContext({
    conversationId,
    requestId: requestId ? `${requestId}-debate` : undefined,
  });

  const cap   = Math.max(1, maxPasses);
  const start = Date.now();

  let current  = draftAnswer;
  let passes   = 0;
  let revised  = false;
  let passed   = false;
  let converged = false;
  let inconclusive = false;
  let findings = [];
  let disagreements = [];
  let provider;

  const failOpen = (error, extraDisagreements = disagreements) => {
    console.warn(`[DEBATE] ${error} — passing ${revised ? 'latest revision' : 'draft'} through unchanged`);
    return {
      ran: passes > 0,
      passed: passes > 0 ? false : null,
      revised,
      converged: false,
      inconclusive: false,
      passes,
      finalAnswer: current,
      agent: 'debate',
      panel: panelIds,
      findings,
      disagreements: extraDisagreements,
      provider,
      latencyMs: Date.now() - start,
      error,
      attemptCount: debateCtx.attempts.length,
    };
  };

  // ── Convergence loop — same invariant as verificationAgent.js: `current`
  // is always the best answer we are willing to ship. ─────────────────────────
  while (passes < cap) {
    // 1) Panel review — one call, all three charters.
    let panelText;
    try {
      const result = await generate(
        userMessage,
        panelPrompt,
        [{ role: 'user', content: `${evidenceBlock}Original user question:\n${userMessage}\n\nDraft answer to review:\n${current}` }],
        debateCtx,
        taskType,
        undefined,
        responseBudget,
      );
      provider  = result.provider ?? provider;
      panelText = result.text;
    } catch (err) {
      return failOpen(`panel call failed on pass ${passes + 1}/${cap}: ${err.message}`);
    }

    let synth;
    try {
      findings = parsePanelResponse(panelText, allowedIds);
      synth    = synthesizeDebate(findings, panel.length);
    } catch (err) {
      return failOpen(err.message);
    }
    passes += 1;

    if (synth.consensusPass) {
      passed = true;
      converged = true;
      disagreements = [];
      break;
    }

    if (synth.inconclusive) {
      // Part of the panel went silent and nobody objected. Silence is not
      // approval: neither a pass nor grounds for revision — neutral
      // evidence, draft unchanged, surfaced in diagnostics.
      inconclusive = true;
      converged = true;
      disagreements = [];
      console.warn(`[DEBATE] inconclusive panel on pass ${passes}/${cap} — ${synth.attendance}/${panel.length} voices reported, no issues; treating as neutral`);
      break;
    }

    if (!synth.escalate) {
      // Minority view: preserved, not empowered to rewrite. Converged —
      // the panel has spoken and nothing warrants another round.
      converged = true;
      disagreements = synth.minorityReport;
      break;
    }

    // 2) Escalation → revision call.
    const issueList = synth.issues
      .map(f => `- [${f.persona}/${f.severity}] ${f.issue}${f.suggestion ? ` — suggested direction: ${f.suggestion}` : ''}`)
      .join('\n');
    try {
      const result = await generate(
        userMessage,
        REVISION_PROMPT,
        [{ role: 'user', content: `${evidenceBlock}Original user question:\n${userMessage}\n\nDraft answer:\n${current}\n\nPanel issues to fix:\n${issueList}` }],
        debateCtx,
        taskType,
        undefined,
        responseBudget,
      );
      provider = result.provider ?? provider;
      const revision = (result.text ?? '').trim();

      // ── Phase 0 (audit F1/F3) — capability-deletion guard ───────────────────
      // Same invariant as verificationAgent.js: a reviser may correct facts,
      // never delete capability. On a grounded turn a revision denying access
      // to the analyzed files is wrong by construction — discard it, keep the
      // grounded draft, record the panel's issues as unresolved disagreements
      // (their objection stands on the record; the FIX was invalid), and stop.
      // `revised` untouched → the ledger never books the malfunction (F2).
      if (grounded && isCapabilityRefusal(revision)) {
        console.warn(`[DEBATE] capability-refusal revision SUPPRESSED on grounded turn (pass ${passes}/${cap}) — keeping ${revised ? 'latest revision' : 'draft'}`);
        disagreements = synth.issues;
        converged = false;
        break;
      }

      current  = revision;
      revised  = true;
      disagreements = []; // objections are being resolved by this revision…
    } catch (err) {
      // …unless the fix couldn't be produced: the panel's objection goes on
      // the record as an unresolved disagreement instead of vanishing.
      return failOpen(`revision call failed on pass ${passes}/${cap}: ${err.message}`, synth.issues);
    }
    // Loop: re-panel the revision if budget remains; else ship it
    // unreviewed with converged=false (mirrors verificationAgent's cap).
  }

  return {
    ran: true,
    passed,
    revised,
    converged,
    inconclusive,
    passes,
    finalAnswer: current,
    agent: 'debate',
    panel: panelIds,
    findings,
    disagreements,
    provider,
    latencyMs: Date.now() - start,
    attemptCount: debateCtx.attempts.length,
  };
}

registerAgent('debate', {
  name: 'debate',
  description:
    'Phase 6 internal debate: a three-voice review panel (deterministically seated by task type and cross-cutting tags) independently critiques a draft in one structured model call; a deterministic synthesizer merges verdicts. Escalating findings (one high-severity, or two voices in agreement) trigger a revision that is re-paneled while the pass budget lasts; non-escalating minority findings ship as preserved disagreements. Fails open at every step — a broken panel or revision call can never lose an accepted revision or the original draft.',
  run: runDebate,
});