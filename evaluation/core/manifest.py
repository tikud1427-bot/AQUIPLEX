"""Per-run reproducibility manifest.

Captures everything the spec requires to reproduce a run:
git commit, configuration, environment, model versions, prompt template
version, seed (when applicable), timestamp, dataset checksums, hardware.
"""
from __future__ import annotations

import os
import platform
import subprocess
import sys
from pathlib import Path

from .common import EVAL_ROOT, REPO_ROOT, env_flag_snapshot, now_iso


def _git(cwd: Path) -> dict:
    def run(*args):
        try:
            return subprocess.check_output(
                ["git", *args], cwd=cwd, stderr=subprocess.DEVNULL, text=True
            ).strip()
        except Exception:
            return None

    commit = run("rev-parse", "HEAD")
    if commit is None:
        return {"commit": None, "note": "not a git repository"}
    return {
        "commit": commit,
        "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(run("status", "--porcelain")),
    }


def _mem_gb() -> float | None:
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return round(int(line.split()[1]) / (1024 * 1024), 1)
    except Exception:
        return None
    return None


def build_manifest(
    *,
    benchmark: dict,
    adapter_config: dict,
    run_config: dict,
    prompt_template: dict | None,
    dataset_files: dict,
    seed: int | None,
) -> dict:
    """dataset_files: {label: {path, sha256, n}}."""
    redacted_adapter = {k: v for k, v in adapter_config.items() if "key" not in k.lower()}
    return {
        "aqeval_version": "1.0.0",
        "timestamp_utc": now_iso(),
        "benchmark": benchmark,
        "model": redacted_adapter,
        "run_config": run_config,
        "prompt_template": prompt_template,
        "datasets": dataset_files,
        "seed": seed,
        "git": {
            "aqeval": _git(EVAL_ROOT),
            "platform": _git(REPO_ROOT),
        },
        "environment": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "machine": platform.machine(),
            "cpu_count": os.cpu_count(),
            "mem_gb": _mem_gb(),
            **env_flag_snapshot(),
        },
        "command": " ".join(sys.argv),
    }
