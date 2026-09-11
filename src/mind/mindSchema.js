/**
 * AQUA Mind Schema v1
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for the persistent cognitive model ("Mind").
 *
 * NOT a replacement for memorySchema.js (flat extractable facts). The Mind
 * layer sits ABOVE it: facts are one evidence source among many; the Mind
 * holds inferred, confidence-weighted BELIEFS plus goals, working memory,
 * episodes, a relationship graph, a timeline and predictions.
 *
 * Every element carries confidence + evidence + privacy metadata.
 * Nothing in the Mind is ever binary-certain.
 */

// ── Belief dimensions ─────────────────────────────────────────────────────────
export const DIMENSIONS = Object.freeze({
  IDENTITY:      'identity',       // slow-moving: founder, engineer, systems thinker…
  PERSONALITY:   'personality',    // traits: analytical, patient, detail-hungry…
  COMMUNICATION: 'communication',  // style: terse, prefers fragments, code-first…
  PREFERENCES:   'preferences',    // implicit + explicit: minimal UI, dark themes…
  KNOWLEDGE:     'knowledge',      // skill proficiency: typescript=advanced…
  BEHAVIOR:      'behavior',       // patterns: iterates fast, tests-after, night work…
  DECISION:      'decision',       // decision style: evidence-first, risk-tolerant…
});

export const DIMENSION_LIST = Object.freeze(Object.values(DIMENSIONS));

// ── Identity trait vocabulary (inferred, never asked) ─────────────────────────
export const IDENTITY_TRAITS = Object.freeze([
  'founder', 'engineer', 'designer', 'manager', 'researcher', 'student',
  'builder', 'creative', 'systems_thinker', 'long_term_planner', 'minimalist',
]);

// ── Per-dimension dynamics ─────────────────────────────────────────────────────
// changeRate: how fast confidence moves on new evidence (identity = slowest).
// decayRate:  confidence lost per stale WEEK at reflection time (0 = permanent
//             once established; working-memory items decay elsewhere, faster).
export const DIMENSION_DYNAMICS = Object.freeze({
  [DIMENSIONS.IDENTITY]:      { changeRate: 0.12, decayRate: 0.000 },
  [DIMENSIONS.PERSONALITY]:   { changeRate: 0.14, decayRate: 0.002 },
  [DIMENSIONS.COMMUNICATION]: { changeRate: 0.18, decayRate: 0.004 },
  [DIMENSIONS.PREFERENCES]:   { changeRate: 0.16, decayRate: 0.003 },
  [DIMENSIONS.KNOWLEDGE]:     { changeRate: 0.15, decayRate: 0.002 },
  [DIMENSIONS.BEHAVIOR]:      { changeRate: 0.15, decayRate: 0.004 },
  [DIMENSIONS.DECISION]:      { changeRate: 0.14, decayRate: 0.002 },
});

// ── Element lifecycle ──────────────────────────────────────────────────────────
export const STATUS = Object.freeze({
  ACTIVE:   'active',
  ARCHIVED: 'archived',   // decayed / superseded — never deleted immediately
  LOCKED:   'locked',     // user-pinned: exempt from decay and inference updates
});

export const GOAL_STATUS = Object.freeze({
  ACTIVE:    'active',
  BLOCKED:   'blocked',
  COMPLETED: 'completed',
  ABANDONED: 'abandoned',
  STALE:     'stale',      // not mentioned for a long time — candidate for archive
});

// ── Graph vocabulary ───────────────────────────────────────────────────────────
export const NODE_TYPES = Object.freeze([
  'person', 'organization', 'project', 'goal', 'technology', 'episode', 'artifact',
]);
export const EDGE_TYPES = Object.freeze([
  'works_on', 'works_with', 'depends_on', 'part_of', 'interested_in',
  'blocks', 'related_to', 'owns', 'uses', 'targets',
]);

// ── Privacy defaults (Layer 19) ────────────────────────────────────────────────
// Every cognitive element embeds this envelope. The user owns the model.
export function defaultPrivacy() {
  return {
    visibility: 'private',      // private | workspace | organization
    retentionDays: null,        // null = indefinite (subject to decay), N = hard TTL
    temporary: false,           // true = never promoted to permanent at reflection
    locked: false,              // true = user-pinned, inference cannot modify
    source: 'inference',        // inference | explicit | correction | fact_bridge
  };
}

// ── Constructors ──────────────────────────────────────────────────────────────
let _seq = 0;
export function mindId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${(_seq++ & 0xffff).toString(36)}`;
}

/**
 * A Belief: one inferred statement about the user with confidence + evidence.
 * key is stable within a dimension (e.g. knowledge:typescript, preferences:ui_density).
 */
export function createBelief({ dimension, key, value, confidence = 0.3, source = 'inference' }) {
  const now = Date.now();
  return {
    id: mindId('bel'),
    dimension,
    key,
    value,                       // string | number | object — the belief content
    confidence,                  // 0..1, never assumed 1.0
    evidence: [],                // [{ ts, conversationId, signal, note, delta }] capped
    evidenceCount: 0,            // total observations ever (evidence[] is a window)
    contradictions: 0,
    createdAt: now,
    updatedAt: now,
    lastEvidenceAt: now,
    status: STATUS.ACTIVE,
    established: false,          // set once by reflection when confidence+evidence bar crossed
    history: [],                 // prior values — never overwritten, superseded
    privacy: { ...defaultPrivacy(), source },
  };
}

export function createGoal({ title, priority = 5, source = 'inference', confidence = 0.5 }) {
  const now = Date.now();
  return {
    id: mindId('goal'),
    title,
    priority,                    // 1..10
    progress: 0,                 // 0..1 heuristic
    deadline: null,              // ts | null
    dependencies: [],            // goal ids
    blockers: [],                // strings
    relatedProjects: [],         // workspaceIds / project names
    relatedPeople: [],
    status: GOAL_STATUS.ACTIVE,
    confidence,
    mentions: 1,
    createdAt: now,
    updatedAt: now,
    lastMentionedAt: now,
    history: [],
    privacy: { ...defaultPrivacy(), source },
  };
}

export function createEpisode({ title, conversationId }) {
  const now = Date.now();
  return {
    id: mindId('ep'),
    title,                        // "Preparing investor demo", "Debugging deploy"
    startedAt: now,
    endedAt: null,
    conversationIds: conversationId ? [conversationId] : [],
    participants: [],
    objectives: [],
    outcome: null,
    lessons: [],
    importance: 5,
    lastActivityAt: now,
    status: STATUS.ACTIVE,
    privacy: defaultPrivacy(),
  };
}

export function createNode({ type, label }) {
  return { id: mindId('nd'), type, label, createdAt: Date.now(), weight: 1, privacy: defaultPrivacy() };
}

export function createEdge({ from, to, type, note = '' }) {
  return { id: mindId('eg'), from, to, type, note, weight: 1, createdAt: Date.now(), lastSeenAt: Date.now() };
}

export function createTimelineEvent({ kind, subject, detail = '', importance = 5 }) {
  return { id: mindId('tl'), ts: Date.now(), kind, subject, detail, importance };
}

/** Empty per-user Mind. Modular sections — each subsystem owns exactly one. */
export function createEmptyMind(ownerId) {
  const now = Date.now();
  return {
    version: 2,
    ownerId,
    createdAt: now,
    updatedAt: now,
    turnCount: 0,                 // total observed turns (drives reflection cadence)
    facts: {},                    // key → Fact (schema facts — UNIFIED, was .aqua-memory.json)
    files: {},                    // fileKey → FileMemory (uploads + workspaces — Req 10)
    beliefs: {},                  // `${dimension}:${key}` → Belief
    goals: {},                    // id → Goal
    episodes: {},                 // id → Episode
    graph: { nodes: {}, edges: {} },
    timeline: [],                 // capped ring of TimelineEvents
    working: {                    // Layer 9 — volatile mental state
      focus: [],                  // [{ topic, weight, lastSeenAt }]
      blockers: [],
      deadlines: [],              // [{ label, ts, source }]
      recentDiscoveries: [],
      openQuestions: [],
      updatedAt: now,
    },
    predictions: [],              // ephemeral, rebuilt — persisted only for Mind View
    reflections: [],              // [{ ts, turnCount, learned, weakened, promoted, archived }]
    lastReflectionAt: null,
    lastReflectionTurn: 0,
  };
}

// ── Caps (avoid unbounded growth; reflection enforces) ────────────────────────
export const CAPS = Object.freeze({
  EVIDENCE_WINDOW: 12,     // evidence entries kept per belief (count is unbounded)
  HISTORY_PER_ITEM: 10,
  TIMELINE: 300,
  WORKING_FOCUS: 8,
  WORKING_LIST: 6,
  REFLECTIONS: 40,
  GOALS_ACTIVE: 25,
  GRAPH_NODES: 400,
  PREDICTIONS: 5,
});

export function beliefKey(dimension, key) {
  return `${dimension}:${key}`;
}
