/**
 * AQUA Graph Runtime — Orchestration 2.0
 *
 * Executes a validated task graph: topological waves run in parallel
 * (bounded pool), every node's output is checked, scored, and — on failure
 * or low confidence — recovered through a bounded diagnose → adjusted
 * retry → fallback-capability chain. A terminal synthesis combines all
 * results with the injected memory/evidence/search grounding into one
 * final answer.
 *
 * The runtime COMPOSES the existing platform; it owns nothing the
 * platform already owns:
 *   model choice + provider fallback   providers/router.js (generateText)
 *   grounding context                  caller-injected blocks (prepareTurn
 *                                      or the /orchestrate route build them
 *                                      with memory engine + PIC — "inject
 *                                      only relevant context" is theirs)
 *   specialist mapping                 graphSpecialists.js
 *   planning                           graphPlanner.js (or a caller graph)
 *
 * Contracts: fail-open at the caller (runTaskGraph throws only when zero
 * nodes completed — the chat hook then falls back to the legacy single
 * call); AQUA_GRAPH=off disables via the callers; result object is a
 * SUPERSET of generateText's shape so it drops into chat.js §8 unchanged.
 *
 * Confidence (spec 7) — five dimensions, 0..1:
 *   plan       graph validity + how much of the request the plan covers
 *   memory     grounding presence/size of the memory block
 *   evidence   grounding presence/size of the evidence block
 *   reasoning  mean node confidence after recovery
 *   answer     synthesis-node confidence
 *   overall    min(reasoning, answer) blended with plan — a chain is as
 *              strong as its execution, not its intentions
 * Low reasoning confidence changes behavior: the synthesis prompt gains an
 * explicit uncertainty directive, and each low node already consumed its
 * retry budget trying to fix itself.
 */
import { validateGraph, graphSummary } from './taskGraph.js';
import { planTaskGraph } from './graphPlanner.js';
import { executeSpecialist, specialistDirective, fallbackCapability } from './graphSpecialists.js';
import { generateText } from '../providers/router.js';

const PARALLELISM = 3;
const LOW_CONF = 0.55;
const BLOCK_CAP = 1600;   // chars per grounding block in node prompts
const DEP_CAP = 1400;     // chars per dependency output fed forward

// ── Observability (spec 10) ──────────────────────────────────────────────────
const metrics = {
  runs: 0, nodesExecuted: 0, retries: 0, fallbacks: 0, degraded: 0,
  failuresAborted: 0, latency: { runMs: 0, nodeMs: 0 },   // EWMA α=0.2
};
const ewma = (prev, x) => (prev === 0 ? x : Math.round((prev * 0.8 + x * 0.2) * 10) / 10);
export function getGraphMetrics() { return { ...metrics }; }

// ── Node quality check (deterministic — the cheap gate before retries) ───────
function checkNode(node, text, userMessage) {
  if (!text || !text.trim()) return { ok: false, score: 0, diagnosis: 'empty_output' };
  const t = text.trim();
  if (t.length < 25) return { ok: false, score: 0.2, diagnosis: 'too_short' };
  const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ');
  if (norm(t).startsWith(norm(node.instruction).slice(0, 60)) && t.length < node.instruction.length + 60) {
    return { ok: false, score: 0.25, diagnosis: 'echoed_instruction' };
  }
  const anchor = new Set((node.instruction + ' ' + userMessage).toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const outTokens = t.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  const hits = outTokens.filter(x => anchor.has(x)).length;
  const relevance = outTokens.length ? hits / outTokens.length : 0;
  if (relevance < 0.05 && anchor.size > 5) return { ok: false, score: 0.35, diagnosis: 'low_relevance' };
  return { ok: true, score: Math.min(1, 0.6 + relevance), diagnosis: null };
}

function nodeConfidence(check, providerScore, depConfs) {
  const depFloor = depConfs.length ? Math.min(...depConfs) : 1;
  return +(0.55 * check.score + 0.25 * Math.min(1, (providerScore ?? 70) / 100) + 0.2 * depFloor).toFixed(2);
}

// ── Prompt assembly ──────────────────────────────────────────────────────────
function nodeSystemPrompt(node, context) {
  const parts = [specialistDirective(node.capability)];
  const add = (label, block) => {
    if (block && block.trim()) parts.push(`--- ${label} ---\n${block.trim().slice(0, BLOCK_CAP)}\n--- END ${label} ---`);
  };
  if (['memory', 'synthesize', 'reason', 'search'].includes(node.capability)) add('USER MEMORY', context.memory);
  if (['evidence', 'vision', 'extract', 'synthesize', 'search', 'verify'].includes(node.capability)) add('UPLOADED-FILE EVIDENCE', context.evidence);
  if (['search', 'synthesize'].includes(node.capability)) add('WEB SEARCH RESULTS', context.search);
  parts.push('Produce ONLY this subtask\'s result. Be specific and grounded; no meta-commentary.');
  return parts.join('\n\n');
}

function nodeUserPrompt(node, results, userMessage, retryNote) {
  const parts = [`Subtask: ${node.instruction}`];
  if (node.deps.length) {
    const inputs = node.deps
      .map(d => results.get(d))
      .filter(Boolean)
      .map(r => `[${r.id} · ${r.capability}${r.degraded ? ' · DEGRADED' : ''}]\n${r.text.slice(0, DEP_CAP)}`);
    if (inputs.length) parts.push(`Inputs from earlier steps:\n${inputs.join('\n\n')}`);
  }
  parts.push(`Original user request (for grounding): ${userMessage}`);
  if (retryNote) parts.push(`IMPORTANT — previous attempt was rejected (${retryNote}). Fix that specifically: be concrete, on-topic, and complete.`);
  return parts.join('\n\n');
}

// ── Execution ────────────────────────────────────────────────────────────────
/**
 * @param {object} args
 * @param {string}  args.userMessage
 * @param {string}  args.taskType
 * @param {object}  [args.plan]        executionPlanner plan ({ complexity }) — biases provider order/timeouts
 * @param {object}  [args.graph]       prebuilt task graph; defaults to planTaskGraph()
 * @param {object}  [args.context]     { memory, evidence, search } grounding blocks (strings)
 * @param {object}  [args.budget]      orchestration.budget (response token budget)
 * @param {object}  [args.deps]        { generate } — test injection; defaults to providers/router generateText
 * @param {object}  [args.ctx]         observability context (requestId, attempts[])
 * @returns generateText-superset result (see module docblock)
 */
export async function runTaskGraph({
  userMessage, taskType, plan = null, graph = null,
  context = {}, budget = null, deps = {}, ctx = {},
}) {
  const started = Date.now();
  const generate = deps.generate ?? generateText;
  const complexity = plan?.complexity ?? 'high';

  const planned = graph ? { graph, strategy: 'caller', parts: graph.nodes.size } : planTaskGraph({ userMessage, taskType, complexity });
  const g = planned.graph;
  const { valid, problems, layers } = validateGraph(g);
  if (!valid) throw new Error(`invalid task graph: ${problems.join('; ')}`);

  // plan confidence: validity + request coverage by node instructions
  const msgTokens = new Set(String(userMessage).toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const instrText = [...g.nodes.values()].map(n => n.instruction).join(' ').toLowerCase();
  const covered = [...msgTokens].filter(t => instrText.includes(t)).length;
  const planConf = +(Math.min(1, 0.5 + 0.5 * (msgTokens.size ? covered / msgTokens.size : 1))).toFixed(2);

  console.log(`[GRAPH] plan strategy=${planned.strategy} nodes=${g.nodes.size} layers=${layers.length} planConf=${planConf} req=${ctx.requestId ?? 'n/a'}`);

  const results = new Map();  // id → { id, capability, text, provider, confidence, degraded, attempts, latencyMs, diagnosis }
  const providersUsed = new Set();
  const degraded = [];
  let synthesisResult = null;

  for (const layer of layers) {
    const queue = [...layer];
    const lanes = Array.from({ length: Math.min(PARALLELISM, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift();
        const node = g.nodes.get(id);
        const isSynthesis = node.capability === 'synthesize';
        const lowReasoning = isSynthesis && meanConf(results, ['synthesize']) < 0.6;

        const r = await executeNodeWithRecovery({
          node, results, userMessage, context, generate, plan, ctx, budget,
          extraDirective: lowReasoning
            ? 'Some subtask results carry LOW confidence — state conclusions with matching caution and say which points are least certain.'
            : null,
        });
        results.set(id, r);
        if (r.degraded) { degraded.push(id); metrics.degraded += 1; }
        for (const p of r.providers) providersUsed.add(p);
        if (isSynthesis) synthesisResult = r;

        if (!r.text && node.critical && !isSynthesis) {
          throw Object.assign(new Error(`critical node "${id}" failed after recovery (${r.diagnosis})`), { nodeId: id });
        }
      }
    });
    try {
      await Promise.all(lanes);
    } catch (err) {
      // A critical node died. If nothing at all completed, the caller falls
      // back to the legacy path; otherwise continue safe execution is NOT
      // possible for downstream deps — abort with what we have.
      metrics.failuresAborted += 1;
      if (![...results.values()].some(r => r.text)) throw err;
      console.warn(`[GRAPH] aborting remaining layers: ${err.message}`);
      break;
    }
  }

  // If the synthesis node never ran (abort) or graph was single-node, derive the answer.
  const nodeList = [...results.values()];
  const answerNode = synthesisResult ?? nodeList[nodeList.length - 1];
  if (!answerNode?.text) throw new Error('task graph produced no answer');

  const reasoningConf = meanConf(results, ['synthesize']);
  const confidence = {
    plan: planConf,
    memory: blockConf(context.memory),
    evidence: blockConf(context.evidence),
    reasoning: +reasoningConf.toFixed(2),
    answer: answerNode.confidence,
    overall: +Math.max(0.1, Math.min(reasoningConf, answerNode.confidence) * 0.7 + planConf * 0.3).toFixed(2),
  };

  const latency = Date.now() - started;
  metrics.runs += 1;
  metrics.latency.runMs = ewma(metrics.latency.runMs, latency);
  console.log(`[GRAPH] ✓ nodes=${results.size} degraded=${degraded.length} conf=${confidence.overall} latency=${latency}ms req=${ctx.requestId ?? 'n/a'}`);

  return {
    // generateText-compatible surface (drops into chat.js §8 unchanged):
    provider: 'orchestrator', text: answerNode.text, taskType,
    latency, score: Math.round(confidence.overall * 100),
    confidence: confidence.overall, labels: [taskType],
    fallbackChain: nodeList.map(r => ({ provider: r.providers.join('+') || 'internal', outcome: r.degraded ? 'degraded' : 'success', node: r.id, latencyMs: r.latencyMs })),
    truncated: false, finishReason: 'stop',
    // Orchestration 2.0 surface:
    orchestration2: {
      strategy: planned.strategy,
      graph: graphSummary(g), layers,
      nodes: nodeList.map(({ text, ...rest }) => ({ ...rest, chars: text.length })),
      degraded, providersUsed: [...providersUsed],
      confidence,
    },
  };
}

async function executeNodeWithRecovery({ node, results, userMessage, context, generate, plan, ctx, budget, extraDirective }) {
  const t0 = Date.now();
  const providers = [];
  let attempts = 0, lastDiag = null, retryNote = null, best = null;
  let capability = node.capability;

  // attempt 1 (as planned) → attempt 2 (adjusted, same specialist) →
  // attempt 3 (fallback capability, where one exists)
  for (let phase = 0; phase < 3; phase++) {
    if (phase === 2) {
      const fb = fallbackCapability(capability);
      if (!fb) break;
      capability = fb;
      metrics.fallbacks += 1;
      console.log(`[GRAPH] node=${node.id} falling back capability → ${fb} (${lastDiag})`);
    }
    attempts += 1;
    metrics.nodesExecuted += 1;
    try {
      const effNode = { ...node, capability };
      let sys = nodeSystemPrompt(effNode, context);
      if (extraDirective) sys += `\n\n${extraDirective}`;
      const usr = nodeUserPrompt(effNode, results, userMessage, retryNote);
      const r = await executeSpecialist({ node: effNode, systemPrompt: sys, userPrompt: usr, generate, plan, ctx, budget });
      if (r.provider) providers.push(r.provider);

      const check = checkNode(node, r.text, userMessage);
      const depConfs = node.deps.map(d => results.get(d)?.confidence).filter(c => typeof c === 'number');
      const conf = nodeConfidence(check, r.score, depConfs);

      if (check.ok && conf >= LOW_CONF) {
        metrics.latency.nodeMs = ewma(metrics.latency.nodeMs, Date.now() - t0);
        return { id: node.id, capability, text: r.text, providers, confidence: conf, degraded: capability !== node.capability, attempts, latencyMs: Date.now() - t0, diagnosis: null };
      }
      // Diagnose → adjusted retry (spec 8): the check's diagnosis (or plain
      // low confidence) becomes the correction fed into the next attempt.
      lastDiag = check.diagnosis ?? `low_confidence(${conf})`;
      retryNote = lastDiag;
      metrics.retries += 1;
      console.log(`[GRAPH] node=${node.id} attempt=${attempts} rejected (${lastDiag}) — retrying`);
      // Keep the best-so-far output in case every retry is worse.
      if (!best || conf > best.confidence) best = { text: r.text, confidence: conf, providers: [...providers] };
    } catch (err) {
      lastDiag = /timeout/i.test(err.message) ? 'timeout' : /exhausted/i.test(err.message) ? 'providers_exhausted' : err.message.slice(0, 60);
      retryNote = lastDiag;
      metrics.retries += 1;
      console.warn(`[GRAPH] node=${node.id} attempt=${attempts} failed (${lastDiag})`);
    }
  }

  // Recovery exhausted — degrade with the best partial (continue when safe).
  return {
    id: node.id, capability, text: best?.text ?? '', providers: best?.providers ?? providers,
    confidence: best?.confidence ?? 0.2, degraded: true, attempts,
    latencyMs: Date.now() - t0, diagnosis: lastDiag,
  };
}

function meanConf(results, excludeCaps = []) {
  const list = [...results.values()].filter(r => !excludeCaps.includes(r.capability));
  if (!list.length) return 1;
  return list.reduce((a, r) => a + (r.confidence ?? 0), 0) / list.length;
}
function blockConf(block) {
  if (!block || !block.trim()) return 0.3;                 // absent grounding — neutral-low, not zero
  return +Math.min(0.95, 0.5 + Math.min(0.45, block.length / 4000)).toFixed(2);
}
