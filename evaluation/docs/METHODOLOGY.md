# Methodology

AQEval executes each benchmark with its **original methodology**: original
datasets, published prompt protocols, and reference scoring code. Nothing is
simplified, re-scored, or subset unless the run is explicitly stamped
non-official. Where a documented, field-standard adaptation is required to
evaluate an API/chat system at all (no logprobs, chat-format code prompts),
the adaptation is named here, versioned in the manifest, and applied
identically to every system in a comparison.

## Per-benchmark protocol

### GSM8K — Cobbe et al., 2021
- Data: official `openai/grade-school-math` test split (n = 1,319), unmodified.
- Prompt: the canonical 8-shot chain-of-thought exemplars from Wei et al.,
  2022 (*Chain-of-Thought Prompting Elicits Reasoning in Large Language
  Models*), stored verbatim in `benchmarks/prompts/gsm8k_cot_8shot.txt`
  (`gsm8k_cot_8shot/v1`, SHA-256 in every manifest).
- Metric: exact match on the final numeric answer. Two extractions are
  reported, mirroring lm-evaluation-harness: **strict** (final "The answer is
  N", primary) and **flexible** (last number in the response).

### MMLU — Hendrycks et al., 2021
- Data: the official `data.tar` distribution (57 subjects, test n = 14,042).
- Prompt: the reference implementation's 5-shot format (`hendrycks/test`,
  `evaluate.py`): per-subject header, five dev exemplars, `Answer:` cue.
- Scoring: accuracy on the extracted answer letter. The original paper
  scores open-weight models by choice log-likelihood; API systems expose no
  logprobs, so AQEval uses the **generative-letter** protocol that published
  API evaluations use. This is a like-for-like protocol across all API
  systems in a comparison, and it is declared in the manifest
  (`mmlu_official_5shot/v1`).
- Subscores: per subject and the official four category groups
  (STEM / humanities / social sciences / other) from `categories.py`.

### MMLU-Pro — Wang et al., 2024
- Data: `TIGER-Lab/MMLU-Pro` test split (n = 12,032; up to 10 options).
- Prompt: the official 5-shot CoT protocol from the reference repo
  (`evaluate_from_api.py`), with validation-split exemplars of the same
  category and their official `cot_content`.
- Scoring: accuracy; extraction regex `answer is \(?([A-J])`, per the
  reference implementation. Per-category subscores.

### GPQA — Rein et al., 2023
- Data: `Idavidrein/gpqa` (diamond by default; main/extended via `--subset`).
- Prompt: the paper's zero-shot CoT response format ("The correct answer is
  (…)"). Choice order is shuffled deterministically per item from the run
  seed and recorded — the standard position-bias control.
- Scoring: accuracy on the extracted letter; per-domain subscores.

### MATH-500 — Lightman et al., 2023 subset of Hendrycks et al., 2021
- Data: `HuggingFaceH4/MATH-500` (n = 500), the widely reported MATH test
  subset.
- Prompt: zero-shot, final answer in `\boxed{}` (`math_boxed_zeroshot/v1`).
- Scoring: the **official MATH equivalence check**, vendored 1:1 from
  `hendrycks/math` (`scoring/math_equiv.py`, MIT) on the last `\boxed{}`.

### AIME 2024 / 2025
- Data: the 30 competition problems per edition as distributed for research
  evaluation (sources in `datasets/manager.py`). Answers are integers 0–999.
- Scoring: exact integer match on the last `\boxed{}` (fallback: last
  integer). n = 30 means single-run scores move in 3.3-point steps — the
  report's CI makes this explicit; prefer multiple seeds/runs before citing.

### HumanEval — Chen et al., 2021
- Data: official `HumanEval.jsonl.gz` (n = 164), unmodified.
- Scoring: the official semantics — candidate program + official `test` +
  `check(entry_point)` must run clean within the timeout (official default
  3.0 s). **pass@k** uses the paper's unbiased estimator
  (`scoring/stats.py::pass_at_k`).
- Prompt modes, recorded in the manifest:
  - `completion` — the raw function prompt, exactly as the original
    evaluation feeds base models;
  - `chat` (default for AQUA) — the standard instruct wrapper used by
    chat-model reports: return the complete function in one code block.

### MBPP — Austin et al., 2021
- Data: official `mbpp.jsonl` (n = 974). Test split is the paper's
  task_ids 11–510 (n = 500); few-shot exemplars are the paper's convention,
  task_ids 2–4, in the official `[BEGIN]/[DONE]` format.
- Scoring: candidate + `test_setup_code` + the three official asserts must
  run clean; pass@k as above.

## Closed-book policy (integrity of knowledge benchmarks)

AQUA can consult the web (Serper/Tavily subsystem). Looking answers up
mid-question invalidates closed-book benchmarks (MMLU, GPQA, GSM8K, …).

- **Closed-book runs (default, comparable to published numbers):** start the
  harness *without* `SERPER_API_KEY*` / `TAVILY_API_KEY*` in the
  environment. The engine's startup log confirms "web_search capability
  disabled; chat works unchanged", and the manifest records key presence.
- **Open-book runs (system capability measurement):** allowed, but the
  manifest's `provider_keys_present` makes the configuration explicit —
  report such numbers only as "with web access", never alongside closed-book
  comparisons without saying so.

The same logic applies to AQUA's persistent memory: the standalone harness
uses a fresh, isolated `AQUA_DATA_DIR`, and every item runs in a brand-new
conversation, so no state flows between questions.

## Statistics

Every reported score carries: n, binomial standard error, and a seeded
nonparametric bootstrap 95% CI (1,000 resamples) — the `confidence` field
required by the framework spec. Subscores carry the same.

## Sandboxing generated code

HumanEval/MBPP execute untrusted model output. Each candidate runs in a
fresh `python3 -I` subprocess with POSIX rlimits (CPU, address space, file
size, no core dumps), an empty environment, a throwaway working directory,
and a wall-clock timeout — the same subprocess isolation the official repos
use. As those repos warn: run full code evaluations on a machine/container
that holds no secrets.

## What AQEval never does

No invented scoring. No simplified or "easier" variants. No dataset edits.
No cherry-picking (partial runs are stamped SMOKE and excluded from official
reporting). No estimated or extrapolated results: if a benchmark cannot run,
it is listed as unsupported with the reason (`docs/SUPPORT_MATRIX.md`), and
`aqeval list` says so.
