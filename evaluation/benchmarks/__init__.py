"""Benchmark registry.

NATIVE benchmarks run inside AQEval against the original artefacts.
Benchmarks that are recognised but not executable here (harness-, infra-, or
licence-bound) are declared in docs/SUPPORT_MATRIX.md and surfaced by
`aqeval list` — never silently faked.
"""
from __future__ import annotations

from .code_bench import MBPP, HumanEval
from .gsm8k import GSM8K
from .math_bench import AIME, MATH500
from .mmlu import MMLU
from .mmlu_pro import GPQA, MMLUPro

REGISTRY = {
    "gsm8k": GSM8K,
    "mmlu": MMLU,
    "mmlu_pro": MMLUPro,
    "gpqa": GPQA,
    "math500": MATH500,
    "aime": AIME,
    "humaneval": HumanEval,
    "mbpp": MBPP,
}

# Recognised but not runnable natively — reason strings shown by `aqeval list`.
UNSUPPORTED = {
    "hle":          "Gated dataset (cais/hle) + official protocol requires an external judge model. See docs/SUPPORT_MATRIX.md.",
    "livecodebench": "Rolling release-tagged dataset + official harness required (LiveCodeBench repo). Run via the harness against the AQEval shim.",
    "swe-bench":    "Requires the official swebench harness with per-instance Docker images. Runner integration documented; infra-bound.",
    "docvqa":       "Registration-gated dataset (RRC portal) + AQUA image-input adapter not yet wired (upload pipeline exists; see SUPPORT_MATRIX).",
    "chartqa":      "Multimodal; same image-input adapter dependency as DocVQA.",
    "mmmu":         "Multimodal; run via lmms-eval against the AQEval shim once image input is wired.",
    "beir":         "Retrieval benchmark needs an embeddings/retrieval endpoint; AQUA does not expose one publicly (AQUA_EMBEDDINGS is internal).",
}


def create_benchmark(name: str, options: dict):
    if name in UNSUPPORTED:
        raise SystemExit(f"'{name}' is recognised but not executable natively: {UNSUPPORTED[name]}")
    if name not in REGISTRY:
        raise SystemExit(f"Unknown benchmark '{name}'. Native: {', '.join(sorted(REGISTRY))}")
    return REGISTRY[name](options)
