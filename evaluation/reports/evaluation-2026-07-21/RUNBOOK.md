# RUNBOOK — Producing the OFFICIAL numbers

Environment needed: open network egress, the frozen build's `.env` provider
keys, Python 3.10+, Node 18+. Everything below runs from the repo root.

## 0. One-time setup
```bash
cd aqua && npm ci && cd ..
python3 evaluation/aqeval.py selftest          # must PASS before any official run
```

## 1. Datasets
```bash
python3 evaluation/aqeval.py download gsm8k humaneval mbpp mmlu   # direct, pinned
# HF-hosted sets — one-time export (any env with: pip install datasets):
python3 evaluation/datasets/convert_hf.py mmlu_pro math500 aime gpqa
python3 evaluation/aqeval.py list              # confirm cache status
```
GPQA requires accepting terms on Hugging Face first. HLE additionally
requires terms acceptance **and** a judge-model endpoint per the official
protocol — configure both before attempting it; otherwise leave it
NOT EXECUTED.

## 2. Start AQUA — closed-book posture
```bash
# provider keys IN the environment; Serper/Tavily keys OUT of it
env -u SERPER_API_KEY -u TAVILY_API_KEY_1 -u TAVILY_API_KEY_2 \
    GEMINI_KEY_1=... GROQ_API_KEY_1=... OPENROUTER_API_KEY_1=... \
    node evaluation/runners/aqua-standalone.mjs
```
Startup log must show: web_search capability disabled. The manifest records
key-presence booleans — keep them honest.

## 3. Official runs (full split, default parameters, no --limit)
```bash
A=evaluation/configs/adapters/aquiplex.json
python3 evaluation/aqeval.py run --benchmark gsm8k     --adapter $A
python3 evaluation/aqeval.py run --benchmark humaneval --adapter $A
python3 evaluation/aqeval.py run --benchmark mbpp      --adapter $A
python3 evaluation/aqeval.py run --benchmark mmlu      --adapter $A --concurrency 8
python3 evaluation/aqeval.py run --benchmark mmlu_pro  --adapter $A --concurrency 8
python3 evaluation/aqeval.py run --benchmark gpqa      --adapter $A
python3 evaluation/aqeval.py run --benchmark math500   --adapter $A
for s in 1234 2345 3456; do
  python3 evaluation/aqeval.py run --benchmark aime --adapter $A --seed $s --tag seed$s
done
```
Reports (JSON/CSV/HTML/PDF + raw records + manifest) appear per run under
`evaluation/reports/runs/`. Only runs badged **OFFICIAL** are citable.
Anything badged SMOKE/MOCK/INVALID is not a result.

Budget note: MMLU = 14,042 requests, MMLU-Pro = 12,032 — check provider
quotas; a `--limit 25` smoke first is fine (it will be stamped SMOKE).

## 4. Harness-bound benchmarks
```bash
python3 evaluation/aqeval.py shim --adapter $A          # OpenAI-compatible façade :8799
# lm-evaluation-harness cross-checks, LiveCodeBench (record the release tag,
# currently release_v6), SWE-bench (official docker harness) — exact
# invocations in evaluation/docs/HARNESS_INTEGRATION.md. Archive raw harness
# output under evaluation/reports/harness/<tool>/.
```

## 5. Comparison (only under equivalent conditions)
Run the identical benchmark + protocol through other adapters
(`configs/adapters/anthropic.json`, `openai.json`, …), then:
```bash
python3 evaluation/aqeval.py compare evaluation/reports/runs/*/metrics.json
```
The comparison page flags non-official runs; the equivalent-conditions rule
means: same dataset pins, same prompt-template version, same closed-book
posture, all runs OFFICIAL.

## 6. Refresh this evaluation report
Re-run STEP-style deliverables after real runs exist: the executive summary
and status tables in this directory describe the 2026-07-21 session only
and must be superseded, not edited, once official numbers exist.
