# Orchestration 2.0 — Task-Graph Runtime (spec gap closure)

Full-repo survey (2026-07-21) vs the "frontier orchestration engine" brief.
**7/12 requirements were already live**: memory integration (memory engine
lanes + PIC knowledge-first retrieval + CIE evidence posture — spec 3),
evidence integration (evidenceContext grounding contract — spec 4),
verification (verificationAgent bounded convergence + debatePanel
multi-candidate resolution + verificationStrategy + CIE monitor escalation
— spec 6), confidence (confidenceEngine + cognitiveConfidence 7-dim —
spec 7), synthesis (synthesizer brief + prompt composition — spec 9),
observability (core/observability + [ORCHESTRATOR]/[PIC]/[CIE] logs +
learningLedger — spec 10), and the hard half of spec 2: providers/router
already IS specialist selection per call — static QUALITY matrix × runtime
health × learned prior, ranked fallback across every healthy provider,
per-model availability via modelRegistry, no model hard-coding.

**The one true gap**: nothing EXECUTED a plan. executionPlanner emits a
complexity tier + descriptive steps; planner.js/pipelineRegistry emit a
prompting brief; CIE plans how to think — all feed ONE generate call.
Specs 1 (directed task graph), 2-per-subtask, 5 (iterative refinement),
8 (stage-level diagnose→retry→alternate), and 11 (central runtime) all
thread through that missing executor. Orchestration 2.0 closes exactly it.
Zero new deps; all additive; chat path byte-identical unless triggered.

## Modules (src/orchestrator/)
| Module | Owns |
|---|---|
| `taskGraph.js` | Pure graph model: nodes {id, capability, instruction, deps, critical, taskTypeHint}; validation (unique ids, deps exist, Kahn cycle check) → parallel execution layers; leaf detection. |
| `graphPlanner.js` | Deterministic request → graph (platform's deterministic-planner philosophy; a model-assisted decomposer slots in behind the same contract): numbered lists → parallel part fan-out; "then"-chains → sequential refinement (later stages receive earlier outputs — spec 5); compare/vs → dual-analyze + compare; else the EXISTING pipelineRegistry stages as a chain (reused, not duplicated); low complexity → single node. Every multi-node graph ends in one `synthesize` node over all leaves. Capabilities + provider-quality hints inferred from stage names/cues. |
| `graphSpecialists.js` | Capability → executor registry (mirrors capabilityRegistry/agentRegistry): 12 built-ins (reason/code/math/summarize/verify/translate/extract/search/evidence/memory/vision/synthesize), each a directive + taskType hint handed to providers/router — model choice, health, learned priors, and full fallback remain the router's. Per-capability degradation chain (`fallback`); `registerSpecialist()` lets an internal tool (live search, OCR service) replace any id with kind:'internal' + run() — nothing else changes. Vision note: media is pre-analyzed at ingest (mediaPipeline → UKO → evidence); the specialist reasons over that extracted layer. |
| `graphRuntime.js` | Executes validated graphs: Kahn waves in a bounded parallel pool (3); per node — grounded prompt (specialist directive + capped memory/evidence/search blocks + dep outputs) → execute → deterministic quality check (empty/too-short/echo/low-relevance) → confidence (0.55·check + 0.25·provider score + 0.2·dep floor). Failure or conf<0.55 → **diagnose → adjusted retry** (diagnosis injected into the prompt) → **fallback capability** → degrade-and-continue when non-critical, keeping the best partial; critical death with zero completions throws (caller falls back). Terminal synthesis merges everything; low mean reasoning confidence adds an explicit uncertainty directive. Result = generateText-SUPERSET (`provider:'orchestrator'`, text, latency, score, fallbackChain per node) + `orchestration2` {strategy, graph, layers, per-node trace, degraded, providersUsed, 5-dim confidence {plan, memory, evidence, reasoning, answer, overall}}. Module metrics (runs/nodes/retries/fallbacks/degraded/EWMA latency) via `getGraphMetrics()` + [GRAPH] logs. |

## Integration (spec 11) — composition, not replacement
- **chat.js §8 (non-stream)**: eligible turns (`agent_task`, or high-complexity with an explicit numbered list; never identity self-questions) swap `result = runTaskGraph(...)` in place of the single `generateText` call — grounding blocks come from the SAME prepareTurn (memory engine, PIC knowledge, evidence context, search). Because the result shape is a superset, the CIE monitor, verification pass, identity guard, payload builder, and learning ledger downstream are untouched. ANY runtime error → legacy single call (fail-open). Streaming path deliberately untouched. prepareTurn additively exposes `memoryBlock`/`searchContext`.
- **`POST /intelligence/orchestrate`** { message, conversationId? } — standalone runtime endpoint: classify → plan → memory + PIC grounding → execute; returns answer + full graph trace + metrics.
- **Kill switch** `AQUA_GRAPH=off` disables both (route 503s; chat guard short-circuits) — same pattern as AQUA_PIC/AQUA_CIE.

## Decisions
- Planner stays deterministic (no LLM planning call) — consistent with every
  existing planner; the seam for model-assisted decomposition is
  `runTaskGraph({ graph })` accepting caller graphs.
- Specialists never name models. "Best available model" = the router's
  existing quality/health/learned-prior ranking, steered per subtask by the
  taskType hint — extending the proven mechanism instead of a parallel one.
- Recovery is bounded (initial + 1 adjusted retry + 1 capability fallback)
  and diagnosis-driven; recovered-via-fallback keeps honest confidence
  (marked degraded, not tanked).
- Conservative chat trigger by design: broad routing of ordinary turns
  through multi-call graphs would multiply cost/latency for no quality win
  ("avoid unnecessary complexity"). Widening eligibility is one guard edit.

## Tests (spec 12) — `npm run test:orchestrator` → **68/68**
57 prior (orchestrator+providers) + 11 new (`graphRuntime.test.js`): graph
validation/cycles/layers; planner shapes (numbered fan-out w/ per-part
specialist routing, then-chains, comparison, pipeline reuse, single); runtime
e2e with the documented injected-`generate` seam — per-subtask hint routing +
5-dim confidence, transient TIMEOUT → diagnosed retry recovery, persistent
bad node → capability fallback → degraded-continue, critical failure →
throw → caller fallback, sequential refinement actually forwards outputs,
internal-specialist registration, 6-way parallel wave + perf guard (<400ms).
Full battery green: files 128 · memory 135 · pic 38 · cognition 55 · mind 34
· identity 31 · upload 16 · search 52. Route guards + chat eligibility
truth-table smoked live.
