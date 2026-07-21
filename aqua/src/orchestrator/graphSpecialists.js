/**
 * AQUA Specialist Router — Orchestration 2.0
 *
 * Binds a task-graph node's CAPABILITY to the best available execution
 * path. Model-backed specialists never name a model: they emit a
 * provider-quality taskType hint and hand off to providers/router.js —
 * which already does the real specialist selection (static QUALITY matrix
 * × runtime health × learned prior, full ranked fallback across every
 * healthy provider, per-model availability via modelRegistry). This layer
 * adds the per-SUBTASK mapping and a per-capability degradation chain, so
 * losing a specialist degrades to a generalist instead of failing.
 *
 * Extension seam mirrors capabilityRegistry/agentRegistry exactly:
 * registerSpecialist(id, def) at module load; nothing else changes. An
 * 'internal' specialist (search lane, evidence lane, OCR service, …) plugs
 * in with kind:'internal' and its own run() — the runtime treats both
 * kinds identically.
 *
 * Specialist definition:
 *   { id, kind: 'model'|'internal', taskTypeHint, directive,
 *     fallback: string|null,                 // next capability if this one fails
 *     run?: async ({ node, prompt, deps }) => { text, provider, score, latency } }
 */

const specialists = new Map();

export function registerSpecialist(id, def) {
  if (!def || (def.kind === 'internal' && typeof def.run !== 'function')) {
    throw new Error(`Specialist "${id}" invalid: internal specialists must implement run()`);
  }
  specialists.set(id, { id, fallback: 'reason', ...def });
}

export function getSpecialist(id) {
  return specialists.get(id) ?? specialists.get('reason');
}

export function listSpecialists() { return [...specialists.keys()]; }

// ── Built-ins (all model-backed; providers/router owns model choice) ─────────

const BUILTINS = [
  ['reason', {
    kind: 'model', taskTypeHint: 'reasoning', fallback: null,
    directive: 'You are the reasoning specialist. Think the subtask through step by step and give a precise, grounded result — no filler.',
  }],
  ['code', {
    kind: 'model', taskTypeHint: 'coding', fallback: 'reason',
    directive: 'You are the coding specialist. Produce correct, minimal, runnable code with brief notes on assumptions.',
  }],
  ['math', {
    kind: 'model', taskTypeHint: 'reasoning', fallback: 'reason',
    directive: 'You are the mathematics specialist. Work the computation explicitly, show intermediate values, and state the final result unambiguously.',
  }],
  ['summarize', {
    kind: 'model', taskTypeHint: 'summarization', fallback: 'reason',
    directive: 'You are the summarization specialist. Compress faithfully: keep every number, name, and decision; cut everything else.',
  }],
  ['verify', {
    kind: 'model', taskTypeHint: 'analysis', fallback: 'reason',
    directive: 'You are the verification specialist. Check the given material for factual consistency, internal contradictions, and unsupported claims. Report issues concretely or state that it checks out.',
  }],
  ['translate', {
    kind: 'model', taskTypeHint: 'conversation', fallback: 'reason',
    directive: 'You are the multilingual specialist. Translate or answer in the requested language, preserving meaning, tone, and technical terms.',
  }],
  ['extract', {
    kind: 'model', taskTypeHint: 'file_analysis', fallback: 'reason',
    directive: 'You are the extraction specialist. Pull out exactly the requested fields/values from the provided material; output structured, nothing invented.',
  }],
  ['search', {
    // Model-backed by default (answers from grounded context + knowledge);
    // a live web-search internal specialist can re-register this id and the
    // planner/runtime change nothing — the seam the spec's "internal
    // capability" clause asks for.
    kind: 'model', taskTypeHint: 'research', fallback: 'reason',
    directive: 'You are the research specialist. Answer from the grounded context provided; where it is insufficient, say precisely what is missing rather than inventing.',
  }],
  ['evidence', {
    kind: 'model', taskTypeHint: 'file_analysis', fallback: 'reason',
    directive: 'You are the evidence specialist. Reason ONLY over the uploaded-file evidence in the grounding context; cite which file/section supports each point; never go beyond the evidence.',
  }],
  ['memory', {
    kind: 'model', taskTypeHint: 'memory_recall', fallback: 'reason',
    directive: 'You are the memory specialist. Answer from the user-memory context provided; if it does not contain the answer, say so plainly.',
  }],
  ['vision', {
    // Vision/OCR analysis happens at INGEST (mediaPipeline → UKO → evidence);
    // at orchestration time the visual content is already text+evidence, so
    // this specialist reasons over that extracted layer.
    kind: 'model', taskTypeHint: 'file_analysis', fallback: 'evidence',
    directive: 'You are the vision/OCR specialist. The image/video content has been pre-analyzed into the grounding context — reason over that extracted content and quote OCR text exactly.',
  }],
  ['synthesize', {
    kind: 'model', taskTypeHint: null, fallback: 'reason', // hint = original taskType (node carries it)
    directive: 'You are the synthesis specialist. Merge the subtask results into one coherent, well-supported final answer. Preserve specifics, resolve overlaps, attribute claims to the steps that produced them, and flag anything unresolved.',
  }],
];

let registered = false;
export function registerBuiltinSpecialists() {
  if (registered) return;
  for (const [id, def] of BUILTINS) registerSpecialist(id, def);
  registered = true;
}
registerBuiltinSpecialists();

/**
 * Execute one node via its specialist. Model-backed specialists call the
 * injected `generate` (defaults wired by the runtime to providers/router's
 * generateText — full ranking + health + learned prior + fallback chain).
 */
export async function executeSpecialist({ node, systemPrompt, userPrompt, generate, plan, ctx, budget }) {
  const spec = getSpecialist(node.capability);
  if (spec.kind === 'internal') {
    return spec.run({ node, systemPrompt, userPrompt, ctx });
  }
  const hint = node.taskTypeHint ?? spec.taskTypeHint ?? 'reasoning';
  const r = await generate(userPrompt, systemPrompt, [], ctx, hint, plan, budget);
  return { text: r.text, provider: r.provider, score: r.score ?? 70, latency: r.latency ?? null, truncated: r.truncated ?? false };
}

export function specialistDirective(capability) {
  return getSpecialist(capability).directive;
}
export function fallbackCapability(capability) {
  const fb = getSpecialist(capability).fallback;
  return fb && fb !== capability ? fb : null;
}
