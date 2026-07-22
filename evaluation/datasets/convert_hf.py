#!/usr/bin/env python3
"""One-to-one export of Hugging Face-hosted benchmark datasets to jsonl.

Run OUTSIDE the sandbox, in any environment with:  pip install datasets
Gated sets (GPQA, HLE) additionally need `huggingface-cli login` after
accepting the dataset terms on huggingface.co.

Every record is written verbatim — no filtering, no field edits, no
re-ordering beyond the source's own order. AQEval pins the sha256 of the
produced files on first use.

Usage:
    python3 evaluation/datasets/convert_hf.py mmlu_pro
    python3 evaluation/datasets/convert_hf.py gpqa
    python3 evaluation/datasets/convert_hf.py math500
    python3 evaluation/datasets/convert_hf.py aime
    python3 evaluation/datasets/convert_hf.py hle
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

CACHE = Path(__file__).resolve().parent / "cache"

JOBS = {
    "mmlu_pro": [("TIGER-Lab/MMLU-Pro", None, "test", "mmlu_pro/test.jsonl"),
                 ("TIGER-Lab/MMLU-Pro", None, "validation", "mmlu_pro/validation.jsonl")],
    "gpqa":     [("Idavidrein/gpqa", "gpqa_diamond", "train", "gpqa/gpqa_diamond.jsonl"),
                 ("Idavidrein/gpqa", "gpqa_main", "train", "gpqa/gpqa_main.jsonl"),
                 ("Idavidrein/gpqa", "gpqa_extended", "train", "gpqa/gpqa_extended.jsonl")],
    "math500":  [("HuggingFaceH4/MATH-500", None, "test", "math500/test.jsonl")],
    "aime":     [("yentinglin/aime_2025", None, "train", "aime/aime_2025.jsonl"),
                 ("Maxwell-Jia/AIME_2024", None, "train", "aime/aime_2024.jsonl")],
    "hle":      [("cais/hle", None, "test", "hle/test.jsonl")],
}


def export(hf_id: str, config: str | None, split: str, rel: str) -> None:
    from datasets import load_dataset  # imported lazily; not needed inside AQEval

    ds = load_dataset(hf_id, config, split=split) if config else load_dataset(hf_id, split=split)
    out = CACHE / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        for row in ds:
            f.write(json.dumps(dict(row), ensure_ascii=False, default=str) + "\n")
    print(f"wrote {len(ds):>6} rows → datasets/cache/{rel}")


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in JOBS:
        print(__doc__)
        sys.exit(2)
    for job in JOBS[sys.argv[1]]:
        try:
            export(*job)
        except Exception as e:  # noqa: BLE001 — per-config failures shouldn't kill the rest
            print(f"skip {job[0]} [{job[1]}/{job[2]}]: {e}")


if __name__ == "__main__":
    main()
