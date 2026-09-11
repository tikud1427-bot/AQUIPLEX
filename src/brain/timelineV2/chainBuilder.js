/**
 * AQUA Brain — Timeline V2: Chain Builder (Brain V1 / B7)
 *
 * THE BRIEF'S INSTRUCTION
 * ----------------------
 * "Teach AQUA chronological understanding. Instead of isolated memories:
 *  maintain timelines. Example: Idea ↓ Prototype ↓ Repository ↓ Launch ↓
 *  Investor outreach ↓ Funding."
 *
 * The existing timelineEngine already ORDERS events and is careful about
 * uncertainty (exact / approximate / relative / unknown, never a fabricated
 * time). What it does not do is recognise that a sequence of events is one
 * STORY: that "started building X", "shipped X" and "raised a round for X"
 * are stages of a single arc rather than three unrelated entries.
 *
 * That recognition is what this module adds.
 *
 * A CHAIN, PRECISELY
 * ------------------
 * A chain is a set of events that (a) concern the same subject entity and
 * (b) advance through a canonical lifecycle in a chronologically consistent
 * order. Three deliberate constraints keep it honest:
 *
 *   1. SHARED SUBJECT. Events must be about the same thing. Two projects
 *      launching in the same week are not one arc.
 *   2. STAGE PROGRESSION. Stages must not go backwards. "launched then
 *      prototyped" is not a progression — it is two events that happen to
 *      share a subject, and it is reported as such rather than reordered.
 *   3. NOT CAUSATION. A chain is temporal + stage-ordered EVIDENCE of a
 *      progression. It is never a claim that stage N caused stage N+1. The
 *      field is named `progression` and confidence reflects how much of the
 *      lifecycle is actually observed — a two-stage chain is weak evidence
 *      of an arc, and says so.
 *
 * Pure: (events) → chains. No I/O, no model, no state.
 */

/**
 * The canonical lifecycle, ordered. Maps the existing timelineEngine's event
 * types (and the Mind's own timeline kinds) onto stages — reusing the event
 * vocabulary that already exists rather than inventing a second one.
 *
 * Stage numbers are sparse so new stages can be slotted between without
 * renumbering, and so distance between stages is meaningful (a jump from
 * `idea` to `funding` is a bigger leap than `build` to `ship`).
 */
export const LIFECYCLE_STAGES = Object.freeze({
  idea:        { order: 10, description: 'conceived, proposed, considered' },
  decision:    { order: 20, description: 'agreed, approved, committed to' },
  build:       { order: 30, description: 'started building, prototyping' },
  artifact:    { order: 40, description: 'a repository, document or deliverable exists' },
  ship:        { order: 50, description: 'deployed, released, launched' },
  outreach:    { order: 60, description: 'pitched, presented, went to market' },
  outcome:     { order: 70, description: 'funded, signed, closed, paid' },
});

/**
 * Event type → lifecycle stage. Covers the reasoning graph's event types
 * (timelineEngine.EVENT_PATTERNS) and the Mind's timeline kinds, so a chain
 * can span both sources — which is the point of a unified timeline.
 */
const STAGE_OF_EVENT = Object.freeze({
  // reasoning-graph event types
  creation:         'idea',
  approval:         'decision',
  repo_update:      'build',
  capture:          'artifact',
  email_sent:       'outreach',
  meeting:          'outreach',
  deployment:       'ship',
  contract_signed:  'outcome',
  invoice_paid:     'outcome',
  funding:          'outcome',
  // Mind timeline kinds
  goal_created:     'idea',
  belief_established: 'decision',
  episode_opened:   'build',
  goal_completed:   'outcome',
});

/**
 * Textual stage cues, applied when the event TYPE is too coarse. The existing
 * `creation` pattern matches both "had the idea for X" and "built X" — words
 * that sit at opposite ends of a lifecycle — so the statement gets a second
 * look. Cues only ever REFINE a type-derived stage; they never invent one for
 * an event that has no stage at all.
 */
const STAGE_CUES = [
  ['idea',     /\b(?:idea|concept|thinking about|considering|proposed|brainstorm\w*)\b/i],
  ['decision', /\b(?:decided|agreed|approved|signed off|committed to|greenlit)\b/i],
  ['build',    /\b(?:building|started work|prototyp\w+|implement\w+|developing|in progress)\b/i],
  ['artifact', /\b(?:repository|repo|created the doc|wrote the spec|first draft|scaffold\w*)\b/i],
  ['ship',     /\b(?:launch\w*|shipped|released|deployed|went live|in production)\b/i],
  ['outreach', /\b(?:pitch\w*|investor|demo\w*|presented|reached out|announced)\b/i],
  ['outcome',  /\b(?:raised|funded|closed the|signed the|acquired|revenue|paid)\b/i],
];

/** The minimum stages before a set of events is worth calling an arc. */
const MIN_CHAIN_STAGES = 2;

/**
 * Assign a lifecycle stage to one event.
 *
 * IMPORTANT: cues are applied only to events whose text DESCRIBES what
 * happened — reasoning-graph events, which carry a `type` plus a statement
 * lifted from a fact. Mind timeline events carry a `kind` (the event itself)
 * plus a `subject` that is only a NAME, and a name is not a description: a
 * goal titled "launch AQUA" is an `idea` (a goal was created), not a `ship`
 * (nothing launched). Letting the cue win there would read intentions as
 * accomplishments — precisely the kind of confident wrongness a timeline must
 * not introduce.
 *
 * @returns {string|null} stage key, or null when the event has no place in a
 *          lifecycle (which is fine — most events do not).
 */
export function stageOf(event) {
  const byType = STAGE_OF_EVENT[event.type ?? event.kind] ?? null;
  if (!byType) return null;

  // Mind events: the kind is authoritative, the subject is just a label.
  const isDescriptive = event.type != null && event.statement != null;
  if (!isDescriptive) return byType;

  for (const [stage, re] of STAGE_CUES) {
    if (re.test(String(event.statement))) return stage;
  }
  return byType;
}

/**
 * Subject keys for an event — the entities it could belong to a chain about.
 * Normalized so "AQUA" and "aqua" group together.
 */
function subjectsOf(event) {
  const raw = event.entities ?? (event.subject ? [event.subject] : []);
  return [...new Set(raw.map(e => String(e).trim().toLowerCase()).filter(s => s.length > 1))];
}

/**
 * Build lifecycle chains from a set of events.
 *
 * Events may come from any source — the reasoning graph, the Mind's timeline,
 * conversation ingest — as long as they carry a type/kind, a subject or
 * entities, and (ideally) a sortable time.
 *
 * @param {Array} events
 * @param {object} [opts] - { minStages, maxChains }
 * @returns {Array} chains, most complete first
 */
export function buildChains(events, { minStages = MIN_CHAIN_STAGES, maxChains = 20 } = {}) {
  // 1. Stage-tag every event that has a place in a lifecycle.
  const staged = [];
  for (const e of events) {
    const stage = stageOf(e);
    if (!stage) continue;
    staged.push({ ...e, stage, stageOrder: LIFECYCLE_STAGES[stage].order, subjects: subjectsOf(e) });
  }
  if (!staged.length) return [];

  // 2. Group by subject. An event about two entities can belong to two arcs —
  //    "launched AQUA for Aquiplex" is a stage in both stories.
  const bySubject = new Map();
  for (const e of staged) {
    for (const s of e.subjects) {
      if (!bySubject.has(s)) bySubject.set(s, []);
      bySubject.get(s).push(e);
    }
  }

  // 3. Per subject, order chronologically and extract the progression.
  const chains = [];
  for (const [subject, group] of bySubject) {
    if (group.length < minStages) continue;
    const ordered = [...group].sort(byTime);
    const progression = extractProgression(ordered);
    const stages = [...new Set(progression.map(e => e.stage))];
    if (stages.length < minStages) continue;

    chains.push({
      subject,
      label: group[0].entities?.find(e => String(e).toLowerCase() === subject) ?? subject,
      stages,
      // The events that form the arc, in order.
      progression: progression.map(e => ({
        id: e.id, stage: e.stage, statement: e.statement ?? e.label ?? e.subject,
        timestamp: e.timestamp ?? null, timestampSeconds: e.timestampSeconds ?? e.ts ?? null,
        certainty: e.certainty ?? 'unknown',
        origin: e.origin ?? 'reasoning',
        sourceFiles: e.sourceFiles ?? [],
        evidence: e.evidence ?? [],
      })),
      // Events about this subject that did NOT fit the progression — reported,
      // never silently dropped or reordered to force a tidy story.
      offSequence: ordered.filter(e => !progression.includes(e)).map(e => ({
        id: e.id, stage: e.stage, statement: e.statement ?? e.label ?? e.subject,
      })),
      completeness: round2(stages.length / Object.keys(LIFECYCLE_STAGES).length),
      confidence: chainConfidence(progression, stages),
      span: timeSpan(progression),
    });
  }

  return chains
    .sort((a, b) => b.stages.length - a.stages.length || b.confidence - a.confidence)
    .slice(0, maxChains);
}

/**
 * The longest non-regressing run of stages through the chronologically ordered
 * events — a classic longest-increasing-subsequence, which is exactly the
 * "stages must not go backwards" rule made concrete.
 *
 * Events that break the progression are not discarded from the record: the
 * caller gets them back as `offSequence`, because "we launched, then went
 * back to prototyping" is real information, not noise to be smoothed away.
 */
function extractProgression(ordered) {
  if (!ordered.length) return [];
  const n = ordered.length;
  const best = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);
  let bestEnd = 0;

  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (ordered[j].stageOrder <= ordered[i].stageOrder && best[j] + 1 > best[i]) {
        best[i] = best[j] + 1;
        prev[i] = j;
      }
    }
    if (best[i] > best[bestEnd]) bestEnd = i;
  }

  const out = [];
  for (let i = bestEnd; i >= 0; i = prev[i]) {
    out.unshift(ordered[i]);
    if (prev[i] === -1) break;
  }
  return out;
}

/**
 * How much should a chain be believed?
 *
 * Two honest signals: how much of the lifecycle is actually observed, and how
 * well-anchored the events are in time. A two-stage chain built from events
 * with no timestamps is a weak guess and scores like one; a five-stage chain
 * of dated events is strong. Capped below 1 — a chain is inferred structure,
 * never certainty.
 */
function chainConfidence(progression, stages) {
  const coverage = stages.length / Object.keys(LIFECYCLE_STAGES).length;
  const dated = progression.filter(e => (e.timestampSeconds ?? e.ts) != null).length;
  const anchoring = progression.length ? dated / progression.length : 0;
  return round2(Math.min(0.9, 0.25 + 0.45 * coverage + 0.3 * anchoring));
}

function timeSpan(progression) {
  const times = progression.map(e => e.timestampSeconds ?? e.ts).filter(t => t != null);
  if (times.length < 2) return null;
  return { from: Math.min(...times), to: Math.max(...times) };
}

function byTime(a, b) {
  const ta = a.timestampSeconds ?? a.ts ?? null;
  const tb = b.timestampSeconds ?? b.ts ?? null;
  // Undated events sort after dated ones rather than pretending to a position.
  if (ta == null && tb == null) return a.stageOrder - b.stageOrder;
  if (ta == null) return 1;
  if (tb == null) return -1;
  return ta - tb;
}

function round2(n) { return Math.round(n * 100) / 100; }

export { MIN_CHAIN_STAGES };
