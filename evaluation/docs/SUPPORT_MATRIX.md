# Benchmark Support Matrix

Status values
- **NATIVE** — executed end-to-end by AQEval with original methodology.
- **HARNESS** — executed through the benchmark's official harness pointed at the AQEval shim (`aqeval shim`); AQEval never re-implements it.
- **NEEDS-DATA** — implementation ready; dataset must be exported once via `datasets/convert_hf.py` (Hugging Face distribution) in an environment with `pip install datasets`.
- **GATED / MANUAL** — licence, registration, or terms acceptance required before the data can exist locally.
- **BLOCKED** — a technical precondition is missing; the precondition is named. Never simulated.

| Benchmark | Status | Detail |
|---|---|---|
| GSM8K | NATIVE | `aqeval download gsm8k` (official GitHub artefact, pinned) |
| MMLU | NATIVE | `aqeval download mmlu` (official data.tar) |
| MMLU-Pro | NATIVE + NEEDS-DATA | `convert_hf.py mmlu_pro` once, then native |
| GPQA | NATIVE + GATED | accept terms on HF (`convert_hf.py gpqa`), or use the official GitHub zip — its password is published in that repo's README as an anti-crawler measure; AQEval never embeds or automates it |
| MATH-500 | NATIVE + NEEDS-DATA | `convert_hf.py math500` once, then native |
| AIME 2024/2025 | NATIVE + NEEDS-DATA | `convert_hf.py aime`; n=30 → wide CI, see METHODOLOGY |
| HumanEval | NATIVE | `aqeval download humaneval`; official test+check scoring, pass@k estimator |
| MBPP | NATIVE | `aqeval download mbpp`; paper split 11–510, official 3-shot format |
| Humanity's Last Exam | GATED + BLOCKED | dataset gated (`cais/hle`, terms acceptance); official protocol scores free-form answers with a judge model per the HLE paper — requires configuring a judge endpoint. Marked unsupported until both exist; no synthetic substitute. |
| LiveCodeBench | HARNESS | rolling, release-tagged dataset; run the official LiveCodeBench harness against the shim and archive its outputs under `reports/harness/` with the release tag recorded |
| SWE-bench | HARNESS + INFRA | requires the official `swebench` evaluation harness with per-instance Docker images and substantial disk/CPU; integration steps in HARNESS_INTEGRATION.md. Infra-bound, not licence-bound. |
| DocVQA | GATED + BLOCKED | dataset behind RRC portal registration; additionally needs the AQUA image-input adapter (below) |
| ChartQA | MANUAL + BLOCKED | dataset from the official repo; same image-input dependency |
| MMMU | HARNESS + BLOCKED | run via lmms-eval once image input is wired |
| BEIR | BLOCKED | retrieval benchmark requires an embeddings/retrieval endpoint. AQUA's embedding layer (`AQUA_EMBEDDINGS`) is internal and not exposed over HTTP; exposing a read-only embeddings route (in a future, unfrozen build) unblocks BEIR via the `beir` package. |

## The image-input precondition (DocVQA / ChartQA / MMMU)

AQUA's multimodal path exists (`/api/aqua/upload` → attachment store →
Gemini multimodal pipeline), but the frozen chat contract takes text only.
A multimodal adapter needs to: upload the image, then send the question in
the same conversation with the attachment bound. That is an adapter-side
addition (`adapters/`), planned; until it lands these three are BLOCKED, not
faked.
