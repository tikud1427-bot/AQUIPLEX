/**
 * AQUA Cognitive Intelligence Engine — Reasoning Monitor (CIE Phase 1)
 *
 * REASONING MONITOR (spec): "Monitor reasoning while it is happening. Detect
 * missing evidence, contradictions, dead ends, circular reasoning,
 * unsupported assumptions, token waste, low confidence. Recover
 * intelligently."
 *
 * Runs on the completed draft at the SAME seam verification already uses
 * (post-generation, pre-review — for streams that is stream-end, exactly
 * where verificationAgent runs today). Its recovery lever is ESCALATION:
 * a dirty draft can pull the existing verification/debate agents into a
 * turn the orchestrator had skipped them on. It can only ADD review, never
 * remove it — the orchestrator's shouldVerify() decision is a floor.
 *
 * HONEST SCOPE (same discipline as critic.js): a deterministic module
 * cannot semantically judge reasoning — that is what the verification and
 * debate agents are for. What it CAN detect, cheaply and reliably, are the
 * structural failure signatures below. Every check is deliberately
 * conservative: a false escalation costs one extra verification pass; a
 * false finding pollutes the reflection store. Precision beats recall here.
 *
 * Pure, deterministic, no LLM calls, no I/O.
 */

const REFUSAL_RE = /\b(i can(?:no|')t\b|i cannot\b|i am unable to\b|i'?m unable to\b|i do(?:n'|no)t have (?:access|the ability)|as an ai\b)/i;
const HEDGE_RE   = /\b(might|maybe|perhaps|possibly|could be|not sure|i think|it seems|likely|presumably)\b/gi;
const FILLER_RE  = /\b(it'?s worth noting|as mentioned (earlier|above)|needless to say|at the end of the day|in conclusion)\b/gi;
const NEGATION_RE = /\b(not|never|no longer|isn'?t|aren'?t|wasn'?t|doesn'?t|don'?t)\b/i;

// Precise-claim candidates: 4+ digit numbers, dotted versions, percents, money.
const SPECIFICS_RE = /\b\d{4,}\b|\b\d+(?:\.\d+){1,3}\b|\b\d+(?:\.\d+)?\s?%|[$€£]\s?\d[\d,]*(?:\.\d+)?/g;

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const estTokens = (s) => Math.ceil((s?.length ?? 0) / 4);

function normalizeSentences(text) {
  return text
    .split(/[.!?\n]+/)
    .map(s => s.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(s => s.length >= 25);            // short sentences repeat legitimately
}

function significantWords(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
}

/**
 * Inspect a completed draft against this turn's cognitive plan and evidence.
 *
 * @param {object} input
 * @param {string}  input.draft
 * @param {object}  input.plan            CIE reasoning plan
 * @param {string}  [input.evidenceContext]  composed grounding block (Phase 0 contract)
 * @param {Array}   [input.knowledgeItems]   PIC items injected this turn
 * @param {object}  [input.budget]           orchestration.budget (maxResponseTokens)
 * @param {boolean} [input.verificationAlreadyEnabled] orchestrator's decision
 * @returns {{
 *   findings: Array<{id:string, severity:'info'|'warn'|'critical', detail:string, recovery:string}>,
 *   escalate: { escalate: boolean, reason: string|null },
 *   stats: { sentences:number, repetitionRatio:number, hedgeDensity:number, estTokens:number }
 * }}
 */
export function monitorDraft({
  draft,
  plan,
  evidenceContext = '',
  knowledgeItems = [],
  budget = null,
  verificationAlreadyEnabled = false,
} = {}) {
  const text = String(draft ?? '');
  const findings = [];
  const add = (id, severity, detail, recovery) => findings.push({ id, severity, detail, recovery });

  const sentences = normalizeSentences(text);
  const uniq = new Set(sentences);
  const repetitionRatio = sentences.length ? 1 - uniq.size / sentences.length : 0;
  const words = text ? text.split(/\s+/).length : 0;
  const hedges = (text.match(HEDGE_RE) ?? []).length;
  const hedgeDensity = words ? hedges / words : 0;
  const draftTokens = estTokens(text);
  const evidencePresent = evidenceContext.trim().length > 0;
  const evidencePosture = plan?.expectations?.evidence ?? 'none';
  const haystack = (evidenceContext + ' ' + knowledgeItems.map(i => i.statement ?? '').join(' ')).toLowerCase();

  // ── circular reasoning — the draft is going in loops ───────────────────────
  if (sentences.length >= 6 && repetitionRatio > 0.25) {
    add('circular_reasoning', 'warn',
      `repetition ratio ${repetitionRatio.toFixed(2)} across ${sentences.length} sentences`,
      'verification pass with focus on removing repeated reasoning');
  }

  // ── dead end — a capability refusal while the evidence sat right there ─────
  // Pre-review cousin of the Phase-0 suppressedRefusals guard: the drafter
  // claimed it can't, but this turn's grounding contract says it could have.
  if (evidencePresent && REFUSAL_RE.test(text)) {
    add('dead_end', 'critical',
      'draft contains a capability refusal while grounding context was injected',
      'escalate to verification — reviewers see the same evidence (grounding contract) and will restore a grounded answer');
  }

  // ── unsupported specifics — precise claims the evidence never contained ────
  if (evidencePosture !== 'none' && evidencePresent) {
    const specifics = [...new Set((text.match(SPECIFICS_RE) ?? []).map(s => s.trim()))];
    const missing = specifics.filter(s => !haystack.includes(s.toLowerCase()));
    if (missing.length >= 3) {
      add('unsupported_specifics', 'warn',
        `${missing.length} precise value(s) not found in the injected evidence (e.g. ${missing.slice(0, 3).join(', ')})`,
        'verify against evidence; soften or source the unsupported values');
    }
  }

  // ── possible contradiction — a grounded fact appears negated in the draft ──
  // Deliberately narrow: only fires when a fact's own opening phrase shows up
  // inside a negation window. Capped at 2 findings to stay conservative.
  {
    let hits = 0;
    const lower = text.toLowerCase();
    for (const item of knowledgeItems) {
      if (hits >= 2) break;
      if (item.kind !== 'fact' || !item.statement) continue;
      const key = significantWords(item.statement).slice(0, 3).join(' ');
      if (key.length < 12) continue;
      const idx = lower.indexOf(key);
      if (idx === -1) continue;
      const windowStart = Math.max(0, idx - 40);
      const window = lower.slice(windowStart, idx + key.length + 40);
      if (NEGATION_RE.test(window) && !NEGATION_RE.test(item.statement)) {
        hits += 1;
        add('possible_contradiction', 'warn',
          `draft negates grounded fact "${item.statement.slice(0, 60)}…"`,
          'verify the claim against the fact and its citations');
      }
    }
  }

  // ── token waste — the draft blew past its budget or pads itself ────────────
  const maxOut = budget?.maxResponseTokens ?? null;
  const filler = (text.match(FILLER_RE) ?? []).length;
  if ((maxOut && draftTokens > maxOut * 1.15) || (filler >= 3 && repetitionRatio > 0.15)) {
    add('token_waste', 'info',
      maxOut && draftTokens > maxOut * 1.15
        ? `~${draftTokens} tokens vs budget ${maxOut}`
        : `${filler} filler phrases with repetition ${repetitionRatio.toFixed(2)}`,
      'prefer a shallower reasoning depth for this shape of question');
  }

  // ── low confidence language — hedging beyond what the plan allows ──────────
  if (hedgeDensity > 0.05 && words > 60) {
    add('excess_hedging', plan?.expectations?.uncertainty === 'allow' ? 'info' : 'warn',
      `hedge density ${(hedgeDensity * 100).toFixed(1)}% over ${words} words`,
      'express uncertainty once, precisely, instead of hedging throughout');
  } else if (plan?.expectations?.uncertainty === 'quantify' && words > 80 && hedges === 0 && !/\bconfiden(t|ce)\b/i.test(text)) {
    add('missing_uncertainty', 'info',
      'plan expected quantified confidence; none expressed',
      'state confidence in the key conclusions');
  }

  // ── escalation — the monitor's recovery lever ──────────────────────────────
  // Only ADDS review. If the orchestrator already enabled verification, the
  // findings ride along as diagnostics; escalate stays false (nothing to add).
  const criticals = findings.filter(f => f.severity === 'critical').length;
  const warns     = findings.filter(f => f.severity === 'warn').length;
  let escalate = { escalate: false, reason: null };
  if (!verificationAlreadyEnabled) {
    if (criticals > 0) {
      escalate = { escalate: true, reason: findings.find(f => f.severity === 'critical').id };
    } else if (warns >= 2 && (evidencePosture === 'require' || plan?.expectations?.verification === 'encourage')) {
      escalate = { escalate: true, reason: `${warns} warnings under ${evidencePosture === 'require' ? 'evidence-required' : 'verify-encouraged'} plan` };
    }
  }

  return {
    findings,
    escalate,
    stats: {
      sentences: sentences.length,
      repetitionRatio: +clamp01(repetitionRatio).toFixed(2),
      hedgeDensity: +hedgeDensity.toFixed(3),
      estTokens: draftTokens,
    },
  };
}

/**
 * Incremental variant for streamed generations. Accumulates chunks with zero
 * per-chunk work; finish() runs the exact monitorDraft above on the full
 * text. Exists so a future in-stream early-warning (e.g. aborting a runaway
 * repetition loop) can slot in without changing callers.
 */
export function createStreamMonitor(planInput) {
  const chunks = [];
  return {
    addChunk(t) { if (t) chunks.push(String(t)); },
    finish(extra = {}) {
      return monitorDraft({ ...planInput, ...extra, draft: chunks.join('') });
    },
  };
}
