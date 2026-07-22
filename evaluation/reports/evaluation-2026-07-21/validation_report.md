# Validation Report — Evaluation Session 2026-07-21

Checklist required before any final report. Each item verified in this
session; evidence paths are relative to this directory unless noted.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Benchmark integrity — original methodology, unmodified | PASS | `evaluation/docs/METHODOLOGY.md`; no benchmark code changed this session |
| 2 | Dataset integrity — checksums verified against pins | PASS (3/3 acquired sets) | `dataset_provenance.json`; pins in `evaluation/datasets/checksums.json`; GSM8K n=1319, HumanEval n=164, MBPP n=974 (test split 500) re-verified |
| 3 | Scoring verified against ground truth | PASS | selftest: official pass@k estimator vs hand computation; official MATH `is_equiv`; sandboxed executor runs 5 official HumanEval **canonical solutions → all pass**, deliberately wrong solution → fails, infinite loop → timeout |
| 4 | Reproducibility machinery | PASS | per-run `manifest.json` (config, environment, hardware, prompt-template SHA-256, dataset SHA-256, seed, timestamp); `environment_manifest.json`; platform sentinel hashes recorded (no git metadata in tarball) |
| 5 | No mock adapter behind any reported result | PASS | **Zero benchmark results reported.** Mock adapter used only inside the clearly-labelled framework selftest (every artefact stamped `MOCK — framework selftest, not a model result`) |
| 6 | Every reported score from a real execution | PASS (vacuously) | No scores exist to report. The one real-adapter run is stamped `INVALID` (0 items scored, 100% errors) and presents no score |
| 7 | Real runtime connection verified | PASS | frozen `aqua/router.js` booted sessionless (`evidence/harness-boot.log`); `/provider-health` OK; real `aquiplex` adapter queried the live engine 4×; each request walked the full provider fallback chain (gemini → openrouter → groq) and failed only at the provider stage (`evidence/engine-error-sample.txt`) |
| 8 | Environment blocker verified empirically | PASS | `evidence/egress-probes.txt`: OpenRouter, Groq, Google Gemini, Together, Hugging Face, and the MMLU host all return **HTTP 403, x-deny-reason: host_not_allowed** |

## Run-invalidity handling

An integrity fix was applied this session (the only code change):
`runners/native_runner.py` now stamps any run with **zero scored items** as
`invalid: true, official: false`, with an explicit note, and the HTML/PDF
reports render an `INVALID` badge. This prevents an all-errors run from
being misread as a 0.0% benchmark score. Verified live on run
`20260721-130720_gsm8k_aquiplex_connectivity-attempt`.

## Verdict

The evaluation **session** is valid and honestly reported. The evaluation
**results** are: none — every target benchmark is `NOT EXECUTED` for the
reasons in `benchmark_status.json`. No number in any deliverable is a model
performance claim.
