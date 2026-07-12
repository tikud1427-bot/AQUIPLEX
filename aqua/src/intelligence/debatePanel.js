/**
 * AQUA Internal Intelligence Engine — Debate Panel (Phase 6, deterministic half)
 *
 * The spec's Internal Debate calls for multiple reasoning agents that
 * independently analyze a problem, a synthesizer that merges conclusions,
 * and disagreements preserved until resolved. This module is everything
 * about that which does NOT need a model:
 *
 *   PERSONAS        the reviewer charters (what each voice is allowed to
 *                   care about — and, by omission, what it must ignore)
 *   selectPanel()   taskType + multiLabel tags → exactly 3 personas.
 *                   Deterministic so the same request always convenes the
 *                   same panel (reproducible diagnostics, testable rules).
 *   synthesizeDebate()  merges per-persona findings into one decision:
 *                   consensus pass / preserved minority disagreement /
 *                   escalate to revision.
 *
 * The LLM half — actually convening the panel against a draft and writing
 * revisions — lives in debateAgent.js, which consumes these functions.
 *
 * Cost stance mirrors critic.js's honest-scope note: persona selection and
 * verdict merging are pure decision logic, so they run for free; only the
 * panel review itself (one call carrying all three charters) and any
 * revision spend tokens, and only on turns chat.js already deemed worth a
 * deep review.
 *
 * Deterministic: no LLM calls, no I/O.
 */

/**
 * Reviewer charters. Charters are deliberately narrow: a persona reporting
 * outside its charter is how multi-voice review collapses into one generic
 * critic, which is exactly what Phase 6 exists to avoid. The panel prompt
 * (debateAgent.js) instructs each reviewer to flag issues ONLY within its
 * own charter and never for style or phrasing.
 */
export const PERSONAS = {
  skeptic: {
    id: 'skeptic',
    name: 'Skeptic',
    charter: 'assumptions presented as facts, logical gaps or contradictions, unsupported or likely-hallucinated claims, conclusions the given evidence does not actually support',
  },
  coder: {
    id: 'coder',
    name: 'Coder',
    charter: 'code correctness: wrong or misused APIs, off-by-one and boundary errors, unhandled failure paths, code that would not run or does not do what the prose around it claims',
  },
  architect: {
    id: 'architect',
    name: 'Architect',
    charter: 'design soundness: tight coupling, missing module boundaries, scalability ceilings, requirements the proposal silently drops, trade-offs asserted without justification',
  },
  security: {
    id: 'security',
    name: 'Security Reviewer',
    charter: 'injection and input-validation gaps, authentication/authorization mistakes, secrets or sensitive data exposure, unsafe defaults, missing rate limiting where it matters',
  },
  performance: {
    id: 'performance',
    name: 'Performance Reviewer',
    charter: 'algorithmic complexity blowups, N+1 access patterns, unbounded memory growth, blocking work on hot paths, waste that compounds at scale',
  },
  analyst: {
    id: 'analyst',
    name: 'Analyst',
    charter: 'coverage of what was actually asked: dropped requirements, missing edge cases, unstated constraints treated as settled, answers that resolve less than the question',
  },
  compliance: {
    id: 'compliance',
    name: 'Compliance Reviewer',
    charter: 'overconfident claims in regulated or high-stakes domains (financial, medical), missing caveats where the answer could be acted on, factual assertions that need sourcing',
  },
};

/** taskType → the two seats beside the always-present skeptic. */
const TASK_SEATS = {
  coding:        ['coder', 'performance'],
  debugging:     ['coder', 'performance'],
  architecture:  ['architect', 'performance'],
  project_query: ['architect', 'performance'],
  planning:      ['analyst', 'architect'],
};

const DEFAULT_SEATS = ['analyst', 'architect'];

/**
 * Convene the panel for this turn. Always exactly 3, skeptic always seated
 * first — one constant voice keeps panels comparable across task types.
 *
 * Tag overrides (from multiLabelClassifier.js):
 *   security          → security reviewer takes the last seat
 *   financial|medical → compliance reviewer takes the last seat;
 *                       when security ALSO fired, security keeps the last
 *                       seat and compliance takes the middle one — both
 *                       sensitive-domain voices are seated, at the cost of
 *                       the weaker task-matched seat.
 *
 * @param {string} taskType
 * @param {string[]} [tags]
 * @returns {Array<{id: string, name: string, charter: string}>}
 */
export function selectPanel(taskType, tags = []) {
  const seats = ['skeptic', ...(TASK_SEATS[taskType] ?? DEFAULT_SEATS)];

  const wantsSecurity   = tags.includes('security');
  const wantsCompliance = tags.includes('financial') || tags.includes('medical');

  if (wantsSecurity && wantsCompliance) {
    seats[1] = 'compliance';
    seats[2] = 'security';
  } else if (wantsSecurity) {
    seats[2] = 'security';
  } else if (wantsCompliance) {
    seats[2] = 'compliance';
  }

  // Dedupe guard: a tag override can collide with a task-matched seat
  // (e.g. security tag on a taskType that... none today, but the guard is
  // cheaper than the invariant breaking silently later). Backfill from the
  // default seats, then the full roster, preserving order determinism.
  const seen = new Set();
  const unique = seats.filter(id => !seen.has(id) && seen.add(id));
  if (unique.length < 3) {
    for (const id of [...DEFAULT_SEATS, ...Object.keys(PERSONAS)]) {
      if (unique.length === 3) break;
      if (!seen.has(id)) { seen.add(id); unique.push(id); }
    }
  }

  return unique.slice(0, 3).map(id => PERSONAS[id]);
}

const SEVERITIES = new Set(['low', 'medium', 'high']);

/**
 * Normalize one raw finding from the panel's JSON. Returns null for
 * entries that can't be trusted (unknown persona, unknown verdict) —
 * the agent proceeds with whatever validly parsed rather than discarding
 * a whole panel over one malformed entry.
 */
export function normalizeFinding(raw, allowedIds) {
  if (!raw || typeof raw !== 'object') return null;
  const persona = String(raw.persona ?? '').toLowerCase().trim();
  if (!allowedIds.has(persona)) return null;

  const verdict = String(raw.verdict ?? '').toLowerCase().trim();
  if (verdict === 'pass') return { persona, verdict: 'pass' };
  if (verdict !== 'issue') return null;

  const severity = SEVERITIES.has(String(raw.severity ?? '').toLowerCase())
    ? String(raw.severity).toLowerCase()
    : 'medium'; // an issue without a legible severity is still an issue
  return {
    persona,
    verdict: 'issue',
    severity,
    issue:      String(raw.issue ?? '').trim(),
    suggestion: String(raw.suggestion ?? '').trim(),
  };
}

/**
 * The synthesizer: merge independent verdicts into one panel decision.
 *
 * Escalation rule — revision is earned by either DEPTH or AGREEMENT:
 *   any single HIGH-severity finding              → escalate (depth)
 *   two or more DISTINCT personas finding issues  → escalate (agreement)
 * One verbose reviewer filing several low/medium issues is still one
 * dissenting voice — that is a minority report, not agreement.
 *
 * Attendance rule — consensus requires the FULL panel:
 *   `seatedCount` is how many personas were seated. A pass verdict from
 *   only part of the panel (a voice went silent / was dropped as junk)
 *   is `inconclusive`, NOT consensus — silence never counts as approval.
 *   Callers reviewing a real panel response MUST pass seatedCount;
 *   omitting it (null) skips the attendance check and exists only for
 *   verdict-level unit composition.
 *
 * A single low/medium finding from one voice does NOT rewrite the answer:
 * that is precisely the "disagreement preserved until resolved" case — the
 * minority view ships in the diagnostics (payload + observability) instead
 * of being either silently dropped or allowed to unilaterally overrule the
 * draft. Resolution, when it happens, is the revision the next escalating
 * panel triggers.
 *
 * @param {Array<{persona, verdict, severity?, issue?, suggestion?}>} findings
 * @param {number|null} [seatedCount]
 * @returns {{
 *   consensusPass: boolean,
 *   inconclusive: boolean,        // no issues, but not every seated voice reported
 *   escalate: boolean,
 *   attendance: number,           // distinct personas that validly reported
 *   issues: Array<object>,        // every issue finding, any severity
 *   minorityReport: Array<object> // issues preserved as disagreement (non-escalating only)
 * }}
 */
export function synthesizeDebate(findings = [], seatedCount = null) {
  const issues = findings.filter(f => f?.verdict === 'issue');
  const dissentingVoices = new Set(issues.map(f => f.persona)).size;
  const attendance = new Set(findings.filter(f => f?.persona).map(f => f.persona)).size;

  const escalate = issues.some(f => f.severity === 'high') || dissentingVoices >= 2;
  const fullAttendance = seatedCount == null || attendance >= seatedCount;

  return {
    consensusPass: issues.length === 0 && fullAttendance,
    inconclusive:  issues.length === 0 && !fullAttendance,
    escalate,
    attendance,
    issues,
    minorityReport: escalate ? [] : issues,
  };
}
