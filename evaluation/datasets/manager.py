"""Dataset acquisition. Original artefacts only — never modified, never
regenerated, never filtered at download time.

Three acquisition classes:
  direct   — public canonical file, fetched and checksum-pinned here
  hf       — canonical distribution on Hugging Face; converted 1:1 to jsonl by
             datasets/convert_hf.py in an environment with `datasets` installed
  manual   — registration / licence gate; user places files per instructions

`aqeval download <name|all>` handles the `direct` class and prints exact
instructions for the rest. Checksums: first successful download records the
sha256 into datasets/cache/checksums.json; later downloads and every run
verify against it, so a silent upstream change can never alter results.
"""
from __future__ import annotations

import json
import tarfile
from pathlib import Path

from ..core.common import CACHE_DIR, download, ensure_dir, load_json, save_json, sha256_file

SOURCES: dict[str, dict] = {
    "gsm8k": {
        "kind": "direct",
        "license": "MIT",
        "files": {
            "test.jsonl": "https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/test.jsonl",
        },
        "home": "https://github.com/openai/grade-school-math",
    },
    "humaneval": {
        "kind": "direct",
        "license": "MIT",
        "files": {
            "HumanEval.jsonl.gz": "https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz",
        },
        "home": "https://github.com/openai/human-eval",
    },
    "mbpp": {
        "kind": "direct",
        "license": "CC-BY-4.0 (dataset); Apache-2.0 (repo code)",
        "files": {
            "mbpp.jsonl": "https://raw.githubusercontent.com/google-research/google-research/master/mbpp/mbpp.jsonl",
        },
        "home": "https://github.com/google-research/google-research/tree/master/mbpp",
    },
    "mmlu": {
        "kind": "direct-tar",
        "license": "MIT",
        "tar_url": "https://people.eecs.berkeley.edu/~hendrycks/data.tar",
        "home": "https://github.com/hendrycks/test",
        "note": "Official distribution. Extracts to datasets/cache/mmlu/data/{dev,val,test}/*.csv",
    },
    "mmlu_pro": {
        "kind": "hf",
        "license": "MIT",
        "hf_id": "TIGER-Lab/MMLU-Pro",
        "expect": ["mmlu_pro/test.jsonl", "mmlu_pro/validation.jsonl"],
    },
    "gpqa": {
        "kind": "hf",
        "license": "CC-BY-4.0 (gated: accept terms on HF, or use the official "
                   "GitHub zip — its password is published in that repo's README "
                   "to keep crawlers out; AQEval never embeds it)",
        "hf_id": "Idavidrein/gpqa",
        "expect": ["gpqa/gpqa_diamond.jsonl", "gpqa/gpqa_main.jsonl"],
        "home": "https://github.com/idavidrein/gpqa",
    },
    "math500": {
        "kind": "hf",
        "license": "MIT (subset of hendrycks/MATH; OpenAI 'Let's Verify Step by Step' 500-problem split)",
        "hf_id": "HuggingFaceH4/MATH-500",
        "expect": ["math500/test.jsonl"],
    },
    "aime": {
        "kind": "hf",
        "license": "problems © MAA; distributed for research evaluation",
        "hf_id": "yentinglin/aime_2025 (2025) / Maxwell-Jia/AIME_2024 (2024)",
        "expect": ["aime/aime_2025.jsonl"],
    },
    "hle": {
        "kind": "manual",
        "license": "MIT, gated — accept terms at https://huggingface.co/datasets/cais/hle",
        "expect": ["hle/test.jsonl"],
        "note": "Also requires the official judge-model protocol; see docs/SUPPORT_MATRIX.md.",
    },
    "docvqa": {
        "kind": "manual",
        "license": "registration required at https://rrc.cvc.uab.es/?ch=17",
        "expect": ["docvqa/"],
    },
    "chartqa": {
        "kind": "manual",
        "license": "GPL-3.0 (code) / research use — https://github.com/vis-nlp/ChartQA",
        "expect": ["chartqa/"],
    },
}


def _checksums_path() -> Path:
    return CACHE_DIR.parent / "checksums.json"


def _load_checksums() -> dict:
    p = _checksums_path()
    return load_json(p) if p.exists() else {}


def record_checksum(rel: str, digest: str) -> None:
    ensure_dir(CACHE_DIR)
    sums = _load_checksums()
    if sums.get(rel) not in (None, digest):
        raise RuntimeError(
            f"Dataset file {rel} hash changed (pinned {sums[rel][:12]}…, got {digest[:12]}…). "
            "Delete the pin only if you have verified the upstream change is legitimate."
        )
    sums[rel] = digest
    save_json(_checksums_path(), sums)


def verify_file(rel: str) -> dict:
    path = CACHE_DIR / rel
    digest = sha256_file(path)
    record_checksum(rel, digest)
    return {"path": f"datasets/cache/{rel}", "sha256": digest}


def download_dataset(name: str) -> None:
    src = SOURCES.get(name)
    if src is None:
        raise SystemExit(f"Unknown dataset '{name}'. Known: {', '.join(sorted(SOURCES))}")
    kind = src["kind"]
    if kind == "direct":
        for fname, url in src["files"].items():
            rel = f"{name}/{fname}"
            dest = CACHE_DIR / rel
            print(f"↓ {url}")
            download(url, dest)
            info = verify_file(rel)
            print(f"  ok  sha256={info['sha256'][:16]}…  → {info['path']}")
    elif kind == "direct-tar":
        rel = f"{name}/data.tar"
        dest = CACHE_DIR / rel
        print(f"↓ {src['tar_url']}")
        download(src["tar_url"], dest)
        info = verify_file(rel)
        print(f"  ok  sha256={info['sha256'][:16]}…")
        with tarfile.open(dest) as tf:
            tf.extractall(CACHE_DIR / name)
        print(f"  extracted → datasets/cache/{name}/data/")
    elif kind == "hf":
        print(f"'{name}' is distributed via Hugging Face ({src['hf_id']}).")
        print("Run in an environment with `pip install datasets`:")
        print(f"    python3 evaluation/datasets/convert_hf.py {name}")
        print(f"Expected output: {', '.join('datasets/cache/' + e for e in src['expect'])}")
    else:
        print(f"'{name}' needs manual acquisition — {src['license']}")
        if src.get("note"):
            print(f"  {src['note']}")
        print(f"  Place files under: {', '.join('datasets/cache/' + e for e in src['expect'])}")


def status() -> list[tuple[str, str, str]]:
    rows = []
    for name, src in sorted(SOURCES.items()):
        expect = (list(src.get("files", {}).keys()) and
                  [f"{name}/{f}" for f in src["files"]]) or src.get("expect", [])
        if src["kind"] == "direct-tar":
            expect = [f"{name}/data"]
        present = all((CACHE_DIR / e).exists() for e in expect) if expect else False
        rows.append((name, src["kind"], "ready" if present else "missing"))
    return rows
