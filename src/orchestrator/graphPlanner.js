/**
 * AQUA Graph Planner — Orchestration 2.0
 *
 * Deterministic decomposition of a classified request into an executable
 * task graph. No model calls (the platform's planners are deterministic by
 * design — see planner.js, executionPlanner.js); a model-assisted
 * decomposer can replace planTaskGraph behind the same output contract.
 *
 * Decomposition order (first match wins):
 *   1. EXPLICIT PARTS  — a numbered list in the request (1. … 2. …) becomes
 *      parallel part-nodes; "then / after that"-joined clauses become a
 *      sequential chain (each part depends on the previous — later stages
 *      refine earlier outputs, spec 5).
 *   2. COMPARISON      — "compare X and Y / X vs Y" fans out into two
 *      parallel analyze nodes plus a dependent compare node.
 *   3. PIPELINE        — high/medium complexity falls back to the existing
 *      pipelineRegistry stages (reused, not duplicated) as a sequential
 *      refinement chain, each stage tagged with a specialist capability.
 *   4. SINGLE          — low complexity is one 'answer' node (the runtime
 *      then behaves like a structured single call — cost stays flat).
 *
 * Every multi-node graph ends in one 'synthesize' node depending on all
 * leaves. Capabilities are inferred from stage names + request cues and
 * map to specialistRouter keys; each carries the provider-quality taskType
 * hint the router's QUALITY matrix already understands.
 */
import { createGraph, addNode, leafNodes } from './taskGraph.js';
import { getPipeline } from '../intelligence/pipelineRegistry.js';

const NUMBERED_RE = /^\s*\d+[.)]\s+(.+)$/gm;
const SEQUENCE_SPLIT = /\s*(?:;\s*)?\b(?:and then|then|after that|afterwards|next,)\b\s*/i;
const COMPARE_RE = /\b(?:compare|comparison of)\s+(.{2,60}?)\s+(?:and|with|to|vs\.?|versus)\s+(.{2,60}?)(?:[.?!]|$)/i;
const VS_RE = /\b(.{2,50}?)\s+(?:vs\.?|versus)\s+(.{2,50}?)(?:[.?!]|$)/i;

const MATH_CUE   = /\b(calculate|compute|sum|percentage|equation|integral|derivative|probability|solve for)\b/i;
const CODE_CUE   = /\b(code|function|implement|script|bug|refactor|api|endpoint|class|regex)\b/i;
const SEARCH_CUE = /\b(latest|current|today|news|recent|look up|search the web)\b/i;
const EVIDENCE_CUE = /\b(file|files|upload(ed)?|document|pdf|attachment|report|spreadsheet|the doc)\b/i;
const TRANSLATE_CUE = /\btranslate\b|\bin (hindi|spanish|french|german|japanese|bengali|assamese|tamil)\b/i;
const SUMMARY_CUE = /\b(summari[sz]e|tl;?dr|brief overview)\b/i;

/** capability + provider-quality hint for one unit of work. */
function capabilityFor(text, stageName = '') {
  const s = `${stageName} ${text}`;
  if (CODE_CUE.test(s) && /implement|code|fix|refactor|write/i.test(s)) return { capability: 'code', taskTypeHint: 'coding' };
  if (MATH_CUE.test(s)) return { capability: 'math', taskTypeHint: 'reasoning' };
  if (TRANSLATE_CUE.test(s)) return { capability: 'translate', taskTypeHint: 'conversation' };
  if (SUMMARY_CUE.test(s)) return { capability: 'summarize', taskTypeHint: 'summarization' };
  if (SEARCH_CUE.test(s)) return { capability: 'search', taskTypeHint: 'research' };
  if (EVIDENCE_CUE.test(s)) return { capability: 'evidence', taskTypeHint: 'file_analysis' };
  if (/verify|check|review|validate/i.test(stageName)) return { capability: 'verify', taskTypeHint: 'analysis' };
  return { capability: 'reason', taskTypeHint: null };
}

/**
 * @param {{ userMessage: string, taskType: string, complexity: 'low'|'medium'|'high' }} input
 * @returns {{ graph, strategy: string, parts: number }}
 */
export function planTaskGraph({ userMessage, taskType, complexity }) {
  const graph = createGraph();
  const msg = String(userMessage ?? '').trim();

  // ── 1. Explicit numbered parts (parallel fan-out) ──
  const numbered = [...msg.matchAll(NUMBERED_RE)].map(m => m[1].trim()).filter(p => p.length >= 8);
  if (numbered.length >= 2) {
    const ids = numbered.map((part, i) => {
      const { capability, taskTypeHint } = capabilityFor(part);
      return addNode(graph, {
        id: `part-${i + 1}`, capability, taskTypeHint,
        instruction: part, deps: [], critical: false, meta: { part: i + 1 },
      }).id;
    });
    addSynthesis(graph, taskType, ids);
    return { graph, strategy: 'numbered-parts', parts: numbered.length };
  }

  // ── 1b. "then"-joined sequence (refinement chain) ──
  const seq = msg.split(SEQUENCE_SPLIT).map(s => s.trim()).filter(s => s.length >= 12);
  if (seq.length >= 2 && seq.length <= 6) {
    let prev = null;
    for (let i = 0; i < seq.length; i++) {
      const { capability, taskTypeHint } = capabilityFor(seq[i]);
      prev = addNode(graph, {
        id: `step-${i + 1}`, capability, taskTypeHint,
        instruction: seq[i] + (prev ? ' (build directly on the previous step\'s output)' : ''),
        deps: prev ? [prev] : [], critical: true, meta: { step: i + 1 },
      }).id;
    }
    addSynthesis(graph, taskType, [prev]);
    return { graph, strategy: 'sequence', parts: seq.length };
  }

  // ── 2. Comparison fan-out ──
  const cm = msg.match(COMPARE_RE) ?? msg.match(VS_RE);
  if (cm && complexity !== 'low') {
    const [a, b] = [cm[1].trim(), cm[2].trim()];
    addNode(graph, { id: 'analyze-a', capability: 'reason', instruction: `Analyze "${a}" for this request: ${msg}. Cover strengths, weaknesses, and concrete specifics.`, deps: [], critical: true });
    addNode(graph, { id: 'analyze-b', capability: 'reason', instruction: `Analyze "${b}" for this request: ${msg}. Cover strengths, weaknesses, and concrete specifics.`, deps: [], critical: true });
    addNode(graph, { id: 'compare', capability: 'reason', taskTypeHint: 'analysis', instruction: `Compare the two analyses directly: agreements, differences, tradeoffs, and a recommendation with reasoning.`, deps: ['analyze-a', 'analyze-b'], critical: true });
    addSynthesis(graph, taskType, ['compare']);
    return { graph, strategy: 'comparison', parts: 2 };
  }

  // ── 3. Pipeline template chain (reuses pipelineRegistry) ──
  if (complexity === 'high' || complexity === 'medium') {
    const stages = getPipeline(taskType).slice(0, -1); // final stage = our synthesis
    let prev = null;
    for (let i = 0; i < stages.length; i++) {
      const st = stages[i];
      const { capability, taskTypeHint } = capabilityFor(msg, st.name);
      prev = addNode(graph, {
        id: `stage-${i + 1}-${st.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        capability, taskTypeHint: taskTypeHint ?? null,
        instruction: `${st.name}: ${st.focus} Apply this to the request: ${msg}`,
        deps: prev ? [prev] : [], critical: i === 0, meta: { stage: st.name },
      }).id;
    }
    addSynthesis(graph, taskType, [prev]);
    return { graph, strategy: 'pipeline', parts: stages.length };
  }

  // ── 4. Single node ──
  const { capability, taskTypeHint } = capabilityFor(msg);
  addNode(graph, { id: 'answer', capability, taskTypeHint: taskTypeHint ?? taskType, instruction: msg, deps: [], critical: true });
  return { graph, strategy: 'single', parts: 1 };
}

function addSynthesis(graph, taskType, extraDeps = []) {
  const deps = [...new Set([...leafNodes(graph), ...extraDeps])];
  addNode(graph, {
    id: 'synthesize', capability: 'synthesize', taskTypeHint: taskType,
    instruction: 'Combine every subtask result into one coherent, well-supported answer to the original request. Resolve overlaps, keep specifics, and note anything a subtask could not establish.',
    deps, critical: true, meta: { terminal: true },
  });
}
