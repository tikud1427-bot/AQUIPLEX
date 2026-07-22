"""Benchmark interface.

A Benchmark owns: dataset loading (original artefacts only), prompt
construction (original methodology, versioned templates), per-item scoring,
and aggregation. It never talks to a model — the runner does that — so every
benchmark is adapter-agnostic by construction.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from ..core.common import EVAL_ROOT, sha256_text


@dataclass
class Item:
    item_id: str
    prompt: str
    gold: object
    meta: dict = field(default_factory=dict)


@dataclass
class ItemResult:
    item_id: str
    score: float                    # 1.0 / 0.0 for accuracy-style metrics
    extracted: object
    gold: object
    detail: dict = field(default_factory=dict)


class Benchmark:
    name = "base"
    version = "unversioned"          # benchmark release identifier
    primary_metric = "accuracy"
    max_tokens: int | None = None
    stop: list[str] | None = None

    def __init__(self, options: dict):
        self.options = options

    # -- required ------------------------------------------------------------
    def dataset_requirements(self) -> dict:
        """{label: relative path under datasets/cache} — used for availability
        checks, checksum recording, and `aqeval download` hints."""
        raise NotImplementedError

    def load_items(self, *, limit: int | None, seed: int) -> list[Item]:
        raise NotImplementedError

    def score(self, item: Item, response_text: str) -> ItemResult:
        raise NotImplementedError

    # -- optional ------------------------------------------------------------
    def aggregate_extra(self, results: list[ItemResult]) -> dict:
        """Benchmark-specific subscores (e.g. per-subject accuracy)."""
        return {}

    def prompt_template_info(self) -> dict | None:
        return None

    # -- helpers -------------------------------------------------------------
    @staticmethod
    def _template_info(template_id: str, version: str, text: str) -> dict:
        return {"id": template_id, "version": version, "sha256": sha256_text(text)}

    @staticmethod
    def _prompt_file(name: str) -> str:
        return (EVAL_ROOT / "benchmarks" / "prompts" / name).read_text(encoding="utf-8")

    @staticmethod
    def _missing(paths: dict) -> list[str]:
        from ..core.common import CACHE_DIR
        return [f"{label}: datasets/cache/{rel}" for label, rel in paths.items()
                if not (CACHE_DIR / rel).exists()]
