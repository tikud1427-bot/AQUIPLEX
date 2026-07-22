"""MATH-500 and AIME.

MATH-500
  Dataset: HuggingFaceH4/MATH-500 — the 500-problem MATH test subset
  introduced by OpenAI's "Let's Verify Step by Step" (Lightman et al., 2023),
  drawn from Hendrycks et al. 2021 MATH. Exported 1:1 to jsonl.
  Prompting: zero-shot, final answer requested in \\boxed{} (the format the
  MATH grading code expects).
  Scoring: the official MATH equivalence check (scoring/math_equiv.py,
  vendored from hendrycks/math) between the last \\boxed{} in the response
  and the dataset's gold `answer` field.

AIME
  Dataset: AIME 2024 / 2025 competition problems as distributed for research
  evaluation (Maxwell-Jia/AIME_2024, yentinglin/aime_2025), exported 1:1.
  Answers are integers 0–999.
  Scoring: exact integer match on the last \\boxed{} (fallback: last integer
  in the response). n=30 per edition — the report's CI makes the tiny sample
  explicit; treat single-run AIME numbers accordingly.
"""
from __future__ import annotations

import re

from ..core.common import CACHE_DIR, read_jsonl
from ..scoring.extract import last_boxed_only_string
from ..scoring.math_equiv import is_equiv
from .base import Benchmark, Item, ItemResult

_INSTR = ("Solve the following math problem. Reason step by step, and put your "
          "final answer within \\boxed{}.\n\nProblem: ")


class MATH500(Benchmark):
    name = "math500"
    version = "HuggingFaceH4/MATH-500 (test, n=500)"
    primary_metric = "accuracy"

    def __init__(self, options: dict):
        super().__init__(options)
        self.max_tokens = options.get("max_tokens", 2048)

    def dataset_requirements(self):
        return {"test": "math500/test.jsonl"}

    def load_items(self, *, limit, seed):
        rows = read_jsonl(CACHE_DIR / "math500/test.jsonl")
        if limit:
            rows = rows[:limit]
        return [Item(f"math500/{r.get('unique_id', i)}", _INSTR + r["problem"],
                     str(r["answer"]),
                     {"subject": r.get("subject", "unknown"), "level": r.get("level")})
                for i, r in enumerate(rows)]

    def score(self, item, response_text):
        boxed = last_boxed_only_string(response_text)
        ok = is_equiv(boxed, item.gold)
        return ItemResult(item.item_id, 1.0 if ok else 0.0, boxed, item.gold,
                          {"subject": item.meta["subject"], "level": item.meta["level"]})

    def aggregate_extra(self, results):
        from ..scoring.stats import aggregate
        by: dict[str, list[float]] = {}
        for r in results:
            by.setdefault(str(r.detail["subject"]), []).append(r.score)
        return {"per_subject": {k: aggregate(v) for k, v in sorted(by.items())}}

    def prompt_template_info(self):
        return self._template_info("math_boxed_zeroshot", "v1", _INSTR)


class AIME(Benchmark):
    name = "aime"
    version = "AIME"
    primary_metric = "accuracy"

    def __init__(self, options: dict):
        super().__init__(options)
        self.edition = str(options.get("edition", "2025"))
        self.max_tokens = options.get("max_tokens", 4096)
        self.version = f"AIME {self.edition} (n=30)"

    def dataset_requirements(self):
        return {self.edition: f"aime/aime_{self.edition}.jsonl"}

    def load_items(self, *, limit, seed):
        rows = read_jsonl(CACHE_DIR / f"aime/aime_{self.edition}.jsonl")
        if limit:
            rows = rows[:limit]
        items = []
        for i, r in enumerate(rows):
            problem = r.get("problem") or r.get("Problem")
            answer = r.get("answer") or r.get("Answer")
            items.append(Item(f"aime{self.edition}/{r.get('id', i)}",
                              _INSTR + str(problem), str(int(str(answer).strip())), {}))
        return items

    def score(self, item, response_text):
        boxed = last_boxed_only_string(response_text)
        cand = boxed
        if cand is None:
            ints = re.findall(r"-?\d+", response_text)
            cand = ints[-1] if ints else None
        try:
            ok = cand is not None and int(re.sub(r"[^\d-]", "", cand)) == int(item.gold)
        except ValueError:
            ok = False
        return ItemResult(item.item_id, 1.0 if ok else 0.0, cand, item.gold, {})

    def prompt_template_info(self):
        return self._template_info("math_boxed_zeroshot", "v1", _INSTR)
