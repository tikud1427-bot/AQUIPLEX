# Aqua Contextual Intelligence Benchmark (ACIB) — design

**Date:** 2026-11-10 · **Status:** proposed, nothing built or run · Part of the [Production Intelligence Audit](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md).

**Purpose:** measure whether Aqua's answers are better *because* it understands the user's world — against a no-memory model and a conventional memory baseline, on the same model — and measure each pipeline change before it ships. No claim that Aqua beats any system is made until Stage B results exist.

## 1. What exists today (audit of evaluation infrastructure)

| Asset | Where | Measures | Gap for ACIB |
|---|---|---|---|
| Component eval suites (25) + gate | `aqua/eval/suites/`, `eval/gate.mjs` | extraction, capture, retrieval (MRR/nDCG, unknown-honesty), contradiction, claim lifecycle, proactive, revision voice | Components, not answers; many target the canonical path production does not run |
| Frozen held-out retrieval set | `aqua/eval/datasets/retrieval-heldout.v1.json` (+ `.FROZEN.sha256`) | retrieval on unseen cases | retrieval only |
| Dev sets (temporal-resolution, current-state, profile-consistency, intent-outcome, vocabulary-continuity, answer-intelligence, c9) | `aqua/eval/datasets/*.dev.v1.json` | context-level correctness on the legacy path (scripts in `aqua/scripts/*-eval.mjs`) | authored alongside the fixes they validate — dev only |
| World-Model Lift (pre-registered) | `aqua/eval/lift/` (PREREG v4, final) | paired answers with vs without the World Model, judged | **never completed** (provider quota, host sleep, launcher death; see memory notes 2026-10-29 → 11-01) |
| Answer validation package | `aqua/eval/answer-validation/2026-11-05*`, `rubric-v2/` | 12 dev questions, HEAD vs DEV contexts, rubric grader, gated runner (`run-answers.v2.mjs --confirm`, stop on any provider error) | 12 questions; rubric v2 written after seeing answers (diagnostic only); no held-out answer set exists |
| Answer harness | `aqua/scripts/answer-eval-harness.mjs` | prepare (one fresh owner per question), grade, sufficiency | reusable as ACIB's runner core |
| Judge | `aqua/eval/lift/liftJudge.mjs` (NVIDIA nemotron-3-ultra; 98% agreement / κ 0.96 vs Gemini, 2026-10-06) | pairwise/absolute judging | reusable |
| Isolation | `aqua/eval/core/isolateDataDir.mjs`, `scripts/run-tests.mjs` | never touch `~/.aquiplex`, never the `.env` DB/Mongo | mandatory for every ACIB script |
| AQEval | `evaluation/` (Python) | public model benchmarks (MMLU, GSM8K…) | unrelated to personal context |

**Missing:** a no-memory arm, a conventional-RAG arm, a production-configuration arm on a pinned model, scenario breadth beyond ~12 answer questions, a held-out answer set, latency/cost capture per arm.

## 2. Dimensions

| # | Dimension | Question it answers |
|---|---|---|
| D1 | Personal understanding | Does it know who the user is, their role, situation, preferences? |
| D2 | Historical understanding | Can it use things said in earlier, different conversations? |
| D3 | Temporal understanding | Does it know what is *current* vs what *was* true, and when things changed? |
| D4 | Relationship understanding | Does it attribute facts to the right person and keep people/orgs/projects connected? |
| D5 | Intent understanding | Does it recognise what the user is trying to achieve with the question? |
| D6 | Context relevance | Does it use what matters and ignore what does not (including on impersonal questions)? |
| D7 | Contradiction resolution | Does it reconcile conflicting statements correctly, or surface the conflict? |
| D8 | Cross-domain reasoning | Does it connect facts from different conversations/files/projects? |
| D9 | Personalised recommendations | Is the advice grounded in the user's actual constraints? |
| D10 | Uncertainty and unknowns | Does it say what it does not know, refuse to invent, and ask when the gap changes the answer? |

## 3. Scenario schema

One scenario = one synthetic user history + one probe question, run on a **fresh owner** (no cross-scenario leakage — the answer-harness rule).

```json
{
  "id": "acib-dec-001",
  "dimensions": ["D5", "D9", "D3", "D10"],
  "category": "decision_with_changed_state",
  "history": [
    { "conv": "c1", "day": 0,  "user": "I'm the founder of Tidewell… We have 3 engineers: Priya, Marco and Sam." },
    { "conv": "c1", "day": 0,  "user": "Our runway is 9 months and we raised $1.2M in March." },
    { "conv": "c2", "day": 9,  "user": "My goal is to launch the mobile app by January 15." },
    { "conv": "c3", "day": 20, "user": "Actually Marco left the company last week, so we are down to 2 engineers." }
  ],
  "files": [],
  "padding": { "turns": 60, "seed": 7, "profile": "realistic-founder-noise.v1" },
  "question": { "conv": "q", "day": 30, "text": "Should I hire another developer?" },
  "needs": {
    "team":        { "required": true,  "evidence": ["c1#0", "c3#0"], "current": "2 engineers (Priya, Sam); Marco left" },
    "finances":    { "required": true,  "evidence": ["c1#1"],         "current": "9 months runway; $1.2M raised" },
    "commitments": { "required": true,  "evidence": ["c2#0"],         "current": "mobile launch Jan 15" },
    "burn_rate":   { "required": false, "evidence": [],               "current": null }
  },
  "expected_answer": {
    "must_include": ["team is 2 engineers after Marco left", "Jan 15 launch", "9-month runway"],
    "should_include": ["asks or flags unknown burn rate / hiring cost"],
    "must_not_include": ["3 engineers as current", "invented salary or burn figures", "Marco as current team member"]
  },
  "forbidden_assumptions": ["team size is 3", "burn rate known", "the designer hire is decided"],
  "scoring": "rubric:acib-v1"
}
```

`padding` inserts deterministic, irrelevant but realistic turns so the history crosses the 8,000-char recall window (the long-history regime real users reach — [F-05](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-05)). Every scenario runs in **both** regimes: `short` (no padding) and `long` (padded).

## 4. Scenario catalogue (v1 targets)

Counts are for v1; each category gets dev and held-out cases written by different people where possible.

| Category | Dims | Example probe | What it catches | Dev / held-out |
|---|---|---|---|---|
| Simple factual recall | D1, D2 | "What's my company called?" | baseline capture/retrieval | 4 / 8 |
| Multi-conversation synthesis | D2, D8 | "What's left before launch?" (blockers in c2, deadline in c4) | lane fusion | 5 / 10 |
| Multiple files | D8 | "Do the pricing doc and the board memo agree on price?" | file evidence + contradiction | 4 / 8 |
| Multiple projects | D4, D8 | "Which of my projects is behind?" | project attribution | 4 / 8 |
| Historical vs current | D3 | "Where do I work?" after a job change | stale-as-current | 6 / 12 |
| Contradictory statements | D7 | budget stated as 50k then 40k with no "changed" cue | surfacing vs silently choosing | 5 / 10 |
| Changed goals | D3, D5 | marathon goal → injury → swimming goal; "plan my week" | goal supersession | 4 / 8 |
| User corrections | D3, D7 | "No, I said Kim, not Kate" | correction propagation (all stores) | 5 / 10 |
| Ambiguous relationships | D4, D10 | two people named Alex; "What did Alex say about the deal?" | asks which Alex | 4 / 8 |
| Missing information | D10 | "Can I afford a second hire?" with no burn rate ever stated | "not known", asks once | 6 / 12 |
| Similar but unrelated entities | D4, D6 | "Atlas" the project vs "Atlas" the gym | entity disambiguation | 4 / 8 |
| Facts belonging to another person | D4 | "My sister Ana works at Stripe"; "Where do I work?" | attribution ([F-04](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-04)) | 4 / 8 |
| Sensitive information | D6 | mood/health mentioned without opt-in; later unrelated question | sensitivity policy in prompt **and logs** | 4 / 8 |
| Explicit forgetting / deletion | D6, D10 | "Forget my address" then "Where do I live?" | forget across stores and recall | 4 / 8 |
| Impersonal questions | D6 | "At what temperature does water boil?" with rich history | context noise, token waste | 4 / 8 |
| Decisions with changed state | D5, D9, D3 | the schema example above | the flagship case ([Context §3](AQUA_CONTEXT_ENGINE_AUDIT.md)) | 6 / 12 |
| Hedged / hypothetical / negated | D3, D10 | "I might move to Berlin"; "I'm not taking the Lisbon offer" | uncertain ≠ fact | 4 / 8 |
| **Total** | | | | **76 / 152** |

## 5. Arms (controlled comparison)

All arms: **one pinned model** (provider + model id + version recorded), temperature 0 (or the lowest the provider supports), identical max tokens, identical final user message, identical current-conversation window, identical non-personal system scaffolding where the arm does not define its own. Model routing is bypassed (`AQUA_LIFT_PROVIDER` / `AQUA_LIFT_MODEL` already exist for this — [F-16](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-16)).

| Arm | Definition | Implementation |
|---|---|---|
| **A — Base LLM** | the question + current conversation only; Aqua's non-personal scaffolding | eval adapter; no stores read |
| **B — Conventional memory** | top-k (k=8) embedding retrieval over all past user messages, same embedding model as Aqua, rendered as a dated bullet list | eval adapter (not product code), ~100 lines |
| **C — Aqua production** | real `prepareTurn()` under **code defaults, no Postgres** (the documented prod config); reasoning pass and verification **on** as in prod | answer harness (`answer-eval-harness.mjs`), isolated data dir |
| **C2 — Aqua canonical** *(diagnostic)* | same with Postgres + `AQUA_E6=on` + `AQUA_BRAIN_INGEST(_FACTS)=on` + `AQUA_CONTEXT_V2=on` (≈ local `.env`) | needs disposable test DB (`:55432`) and an E6 provider; informs decision D-1 |
| **D — Aqua improved** | C plus the change under test (e.g. information-needs model, [Roadmap R-5](AQUIPLEX_ENGINEERING_ROADMAP.md)) | same harness, different code snapshot |

C vs D differ only in code; A/B/C differ only in context construction. Record the commit hash and a `CODE.sha256` of each snapshot.

## 6. Stages

**Stage A — context-level, model-free (cheap, run on every change).** For arms B, C, C2, D: build the prompt only, then score against `needs[*].evidence`:
- *Context recall* = required evidence items present in the prompt / required items (evidence matched by message id → normalised span or derived fact).
- *Context precision* = prompt items labelled relevant / prompt items (items = lines of identity/profile/cognitive/graph/knowledge blocks + recall excerpts; relevance labels per scenario).
- *Stale-as-current* = superseded value rendered without a current marker.
- *Unknown detection* = required needs with no evidence that the prompt marks as unknown / such needs.
- *Prompt tokens* and *personal-context tokens*.
Reuses the regime machinery of `scripts/temporal-resolution-eval.mjs` and the recorded-context approach of `scripts/authority-recompute.mjs`. Deterministic; no provider; runs in CI.

**Stage B — answer-level (gated, budgeted).** Generate answers for all arms; grade:
- *Answer correctness* — rubric `acib-v1`: every `must_include` present (partial credit), any `must_not_include` → fail; graded by an LLM judge of a **different model family** than the answer model, with 20% human adjudication and reported agreement (κ).
- *Evidence support* — share of personal claims in the answer that are supported by the history (judge, per claim).
- *Hallucination rate* — personal claims not supported by the history / personal claims.
- *Temporal accuracy* — current-state questions answered with the current value.
- *Contradiction handling* — conflict surfaced or correctly resolved (category-specific rubric).
- *Unknown handling* — says not known / asks once when a required need has no evidence; never invents.
- *Personalisation quality* — 0–2 judge score on whether the advice uses the user's constraints (D9), blind to arm.
- *Latency* — time to first token and total (from the harness, not the provider).
- *Tokens and cost* — prompt + completion tokens across **all** calls of the turn (reasoning pass, verification, search, embeddings) × list price of the pinned model; LLM calls per turn.

## 7. Protocol

1. Freeze dev and held-out JSON with SHA-256 before any arm runs; held-out authored by someone who has not read the improvement's code where possible.
2. Pre-register per run: arms, model, judge, primary metrics, stop rules (stop on any provider error, as `run-answers.v2.mjs` does), and the analysis (paired per scenario; bootstrap 95% CIs; McNemar for pass/fail).
3. Primary metrics (decided now so they cannot be chosen after): **answer correctness**, **hallucination rate**, **stale-as-current rate**, **unknown handling** — on held-out, long regime.
4. One fresh owner per scenario; isolated data dir; never the `.env` DB or Mongo.
5. Results committed with raw prompts, answers and judgments; summaries are generated from them, never hand-written.

## 8. Cost and blockers

- Stage A: zero provider cost.
- Stage B, v1 held-out: 152 scenarios × 2 regimes × 4 arms ≈ 1,216 answer turns; arm C adds a reasoning pass + verification on many turns (≈3 calls), so ≈ 2,400 answer-side calls + ≈ 1,216 judge calls, ≈ 6–8M tokens. That is **beyond free-tier quotas** in any reasonable time (measured: Groq ≈ 200k tokens/day/org; Gemini 20 req/day/project).
- **Blocker (decision D-3):** Stage B needs a dedicated, authorised key (not the product's, not Lift's) or an approved local model. Until then, only Stage A runs.
