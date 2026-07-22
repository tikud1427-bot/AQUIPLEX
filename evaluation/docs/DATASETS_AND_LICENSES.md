# Datasets & Licences

Acquisition rules: original artefacts only, downloaded from the canonical
source, never modified, SHA-256 pinned on first use (`datasets/cache/checksums.json`).
A pin mismatch aborts the run. `datasets/convert_hf.py` exports Hugging Face
distributions 1:1 to jsonl — every record verbatim, source order preserved.

| Dataset | Canonical source | Licence / access |
|---|---|---|
| GSM8K | github.com/openai/grade-school-math | MIT |
| MMLU | official data.tar (hendrycks/test) | MIT |
| MMLU-Pro | huggingface.co/datasets/TIGER-Lab/MMLU-Pro | MIT |
| GPQA | huggingface.co/datasets/Idavidrein/gpqa (gated) · github.com/idavidrein/gpqa | CC-BY-4.0, access-controlled to limit contamination — respect the authors' request not to republish items in plain text |
| MATH-500 | huggingface.co/datasets/HuggingFaceH4/MATH-500 | MIT (subset of hendrycks/MATH) |
| AIME 2024/2025 | HF research mirrors (Maxwell-Jia/AIME_2024, yentinglin/aime_2025) | problems © MAA; used for research evaluation |
| HumanEval | github.com/openai/human-eval | MIT |
| MBPP | github.com/google-research/google-research/tree/master/mbpp | dataset CC-BY-4.0; repo code Apache-2.0 |
| HLE | huggingface.co/datasets/cais/hle | MIT, gated (terms acceptance) |
| DocVQA | rrc.cvc.uab.es (challenge portal) | registration required |
| ChartQA | github.com/vis-nlp/ChartQA | research use; repo GPL-3.0 code |
| MMMU | huggingface.co/datasets/MMMU/MMMU | Apache-2.0 |
| BEIR | github.com/beir-cellar/beir | Apache-2.0 harness; per-corpus licences vary |

Vendored scoring code: `scoring/math_equiv.py` is a faithful port of the
official MATH grading (`hendrycks/math`, MIT) with attribution in-file.

Handling notes
- Benchmark items are evaluation material: keep `datasets/cache/` and
  `records.jsonl` out of anything public (both are git-ignored) to avoid
  contributing to contamination.
- GPQA specifically: never publish raw items; report aggregates only.
- Investor materials should cite benchmark *scores + manifests*, not
  dataset content.
