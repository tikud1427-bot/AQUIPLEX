# AQEval — Executive Summary
**Evaluation session: 2026-07-21 · Target: frozen AQUIPLEX build (AQUA engine) · AQEval 1.0**

## Verdict

**Benchmarks executed officially: 0 of 15. Scores reported: none.**

This environment cannot perform model inference: its network egress policy
returns `403 host_not_allowed` for every provider AQUA routes to
(OpenRouter, Groq, Google Gemini, Together) and for every gated-dataset
host. This was verified empirically, not assumed (see Evidence). Provider
API keys are present in the frozen build's configuration but were
deliberately not loaded — no endpoint is reachable, so loading them would
only pass secrets through a denying proxy for zero benefit.

Per the evaluation rules, no score was fabricated, estimated, or
substituted. Every target benchmark is reported **NOT EXECUTED** with its
exact reason (`benchmark_status.json` / `.csv`).

## What was executed and verified (none of it is a model score)

1. **Framework verification (selftest, PASS).** Official pass@k estimator
   validated against hand-computed values; official MATH equivalence
   checker validated on known pairs; answer extractors validated; the
   sandboxed code executor validated on **official HumanEval canonical
   solutions** (all pass), a deliberately wrong solution (fails), and an
   infinite loop (times out). Ground-truth validation, not model output.
2. **Real runtime connection (STEP 2, verified live).** The frozen
   `aqua/router.js` was booted sessionless on an isolated data directory —
   zero platform modifications. `/provider-health` reported healthy. The
   real `aquiplex` adapter (not mock) then queried the live engine with 4
   GSM8K items: every request was accepted, walked the engine's full
   provider fallback chain (gemini → openrouter → groq), and failed only at
   the provider stage. That run is stamped **INVALID** (0 items scored) and
   presents no score; it exists as evidence of the exact failure point.
3. **Dataset acquisition (STEP 4, partial).** Three original artefacts
   acquired from canonical sources and SHA-256-pinned: GSM8K (test,
   n=1,319), HumanEval (n=164), MBPP (n=974; paper test split n=500). All
   other datasets: not acquirable here (egress/gating) — provenance table
   records source, licence, split, and published size for each.
4. **One integrity fix (STEP 1, the only code change).** Runs with zero
   scored items are now stamped `INVALID`, never `OFFICIAL`, in all four
   report formats — an all-errors run can no longer be misread as a 0.0%
   score. No architectural changes were made.

## Benchmarks skipped and why

All 15. One environment-level reason applies to every benchmark — **no
reachable inference provider** — plus benchmark-specific blockers:

| Category | Benchmark | Additional blockers beyond inference |
|---|---|---|
| Reasoning | MMLU | dataset host blocked (Berkeley data.tar) |
| Reasoning | MMLU-Pro | dataset on Hugging Face (blocked) |
| Reasoning | GPQA | gated dataset + HF blocked; the official zip's anti-contamination password is deliberately not automated |
| Reasoning | Humanity's Last Exam | gated dataset; official protocol scores answers with an external LLM judge (GPT-4o per the HLE paper; o3-mini per the Scale leaderboard) — no judge endpoint reachable |
| Coding | HumanEval | none — dataset acquired + scoring validated; inference only |
| Coding | MBPP | none — dataset acquired; inference only |
| Coding | LiveCodeBench | current release_v6 (1,055 problems, May 2023–Apr 2025); official harness + HF dataset required |
| Coding | SWE-bench | official Docker-based harness infrastructure unavailable |
| Math | GSM8K | none — dataset acquired; inference only |
| Math | MATH-500 | dataset on Hugging Face (blocked) |
| Math | AIME | dataset on Hugging Face (blocked); n=30 → plan multiple seeds |
| Multimodal | MMMU / DocVQA / ChartQA | image-input adapter not yet wired (AQUA upload pipeline exists; chat contract is text-only) + dataset access |
| Retrieval | BEIR | AQUA exposes no embeddings/retrieval endpoint — precondition independent of environment |

## Strengths observed (evaluation readiness — not capability claims)

- The frozen engine boots cleanly sessionless with an isolated data
  directory, making contamination-free, closed-book evaluation practical
  without touching production state.
- Per-request diagnostics (requestId, provider, fallbackChain, latency)
  give unusually good per-item traceability for an API system — every
  future score will be attributable to the provider that produced it.
- Health endpoint + structured failure payloads made the exact failure
  point provable rather than guessed.

## Weaknesses / risks observed

- **No performance statement is possible.** Nothing here says AQUA is good
  or bad at anything; that requires the runs below.
- The frozen chat contract exposes no decoding controls (temperature, max
  tokens, stop) per request; answers cut short will surface as extraction
  misses. Documented in `evaluation/docs/LIMITATIONS.md`.
- Full official runs are large: MMLU alone is 14,042 chat requests through
  the full pipeline; budget provider quota and wall-clock accordingly.
- AQUA routes across hosted third-party models that change over time —
  reproducibility target is statistical (within reported CIs), not
  bit-identical outputs.

## Recommendations

1. Execute on a machine with open egress and the build's provider keys —
   exact commands in `RUNBOOK.md`. Start closed-book (no Serper/Tavily
   keys in the harness environment).
2. Order: GSM8K → HumanEval → MBPP (data already pinned), then MMLU /
   MMLU-Pro / GPQA / MATH-500 / AIME after one-time dataset export
   (`datasets/convert_hf.py`), then LiveCodeBench + SWE-bench via their
   official harnesses through the AQEval shim.
3. Run AIME with multiple seeds; treat any single AIME number as ±wide.
4. To unblock the remaining categories: wire the image-input adapter
   (multimodal trio) and expose a read-only embeddings route in a future,
   unfrozen build (BEIR).
5. Publish nothing from this session as a performance number. The first
   citable artefacts will be runs stamped `OFFICIAL`.

## Evidence

`evidence/egress-probes.txt` · `evidence/harness-boot.log` ·
`evidence/engine-error-sample.txt` ·
`evaluation/reports/runs/20260721-130720_gsm8k_aquiplex_connectivity-attempt/`
(INVALID) · `validation_report.md` · `dataset_provenance.{json,csv}` ·
`benchmark_status.{json,csv}` · `environment_manifest.json`

*Scientific honesty over impressive numbers: this report contains no model
performance figures because none were legitimately produced.*
