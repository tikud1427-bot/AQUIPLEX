# AQEval

Standalone evaluation framework that measures **AQUA** (the Aquiplex platform)
on officially recognized AI benchmarks — the same ones frontier labs,
researchers, enterprise buyers, and investors already trust.

AQEval lives entirely under `evaluation/`. It imports nothing from the
production application and modifies nothing in it. The one integration point
is HTTP: AQEval talks to AQUA exactly the way any client does, through
`POST /api/aqua/chat`.

**Requirements:** Python 3.10+ (standard library only — zero pip installs)
and Node 18+ for the AQUA harness. This mirrors the platform's own
zero-new-dependencies discipline.

## Quickstart

```bash
# 1. One-time: install the frozen engine's own dependencies
cd aqua && npm ci && cd ..

# 2. Fetch original benchmark artefacts (checksums pinned on first download)
python3 evaluation/aqeval.py download gsm8k
python3 evaluation/aqeval.py download humaneval
python3 evaluation/aqeval.py download mbpp
python3 evaluation/aqeval.py download mmlu

# 3. Verify the framework itself (mock adapter; produces no model results)
python3 evaluation/aqeval.py selftest

# 4. Start AQUA sessionless, on an isolated data dir, with your provider keys
GROQ_API_KEY=… GEMINI_API_KEY=… OPENROUTER_API_KEY=… \
  node evaluation/runners/aqua-standalone.mjs

# 5. Run a benchmark — one command, all reports
python3 evaluation/aqeval.py run --benchmark gsm8k \
    --adapter evaluation/configs/adapters/aquiplex.json
```

Every run lands in `evaluation/reports/runs/<run_id>/` with:

| artefact        | contents                                                        |
|-----------------|-----------------------------------------------------------------|
| `metrics.json`  | scores, subscores, stderr + bootstrap 95% CI, errors, runtime   |
| `results.csv`   | per-item scores, extractions, latencies, provider used          |
| `report.html`   | self-contained dashboard (score dial, CI bars, run record)      |
| `report.pdf`    | archival snapshot (zero-dependency PDF writer)                  |
| `records.jsonl` | every prompt and raw response, verbatim                         |
| `manifest.json` | git commits, config, environment, hardware, dataset SHA-256s, prompt-template version, seed, timestamp |

## Commands

```bash
python3 evaluation/aqeval.py list                 # benchmarks + dataset status
python3 evaluation/aqeval.py download <name|all>  # original datasets, checksum-pinned
python3 evaluation/aqeval.py run --benchmark <b> --adapter <cfg> [--limit N] [--seed S]
python3 evaluation/aqeval.py report <run_dir>     # rebuild all report formats
python3 evaluation/aqeval.py compare runA/metrics.json runB/metrics.json
python3 evaluation/aqeval.py selftest             # pipeline verification (mock)
python3 evaluation/aqeval.py shim --adapter <cfg> # OpenAI-compatible façade for external harnesses
```

## Benchmarks

Native (executed by AQEval, original methodology — see `docs/METHODOLOGY.md`):
**GSM8K · MMLU · MMLU-Pro · GPQA · MATH-500 · AIME · HumanEval · MBPP**

Recognized and routed through official external harnesses or marked
unsupported with reasons (never simulated): **HLE, LiveCodeBench, SWE-bench,
DocVQA, ChartQA, MMMU, BEIR** — full status and reasons in
`docs/SUPPORT_MATRIX.md`.

## Comparison mode

Adapters are provider-agnostic: `aquiplex`, `anthropic`, `openai_compat`
(covers OpenAI, Gemini's OpenAI-compatible endpoint, and any open-weight
model served by vLLM / Ollama / llama.cpp / TGI). Run the same benchmark
through different adapter configs, then:

```bash
python3 evaluation/aqeval.py compare evaluation/reports/runs/*/metrics.json
```

## Integrity guarantees

These are enforced in code, not just documented:

- **No fabricated numbers.** Scores exist only as the output of an executed
  run; there is no code path that writes a score without records.jsonl
  behind it.
- **Official vs smoke.** `--limit`, subject filters, or the mock adapter
  stamp a run `SMOKE`/`MOCK` in every report format. Only full-split,
  default-parameter runs on a real adapter are marked `OFFICIAL`.
- **Datasets are read-only.** Original artefacts, SHA-256 pinned on first
  download; a changed upstream file refuses to load.
- **Everything reproducible.** The manifest records both git commits,
  the exact config, environment, hardware, prompt-template hash, and seed.

## Documentation

`docs/METHODOLOGY.md` · `docs/SUPPORT_MATRIX.md` ·
`docs/DATASETS_AND_LICENSES.md` · `docs/REPRODUCIBILITY.md` ·
`docs/LIMITATIONS.md` · `docs/HARNESS_INTEGRATION.md` ·
`docs/AQUIPLEX_ADAPTER.md`
