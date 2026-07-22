"""MMLU-Pro (Wang et al., 2024) and GPQA (Rein et al., 2023).

MMLU-Pro
  Dataset: TIGER-Lab/MMLU-Pro (test + validation), exported 1:1 to jsonl by
  datasets/convert_hf.py. Up to 10 options (A–J).
  Prompting: the official 5-shot CoT protocol from the reference repo
  (TIGER-AI-Lab/MMLU-Pro evaluate_from_api.py): per-category header
      "The following are multiple choice questions (with answers) about
       {category}. Think step by step and then output the answer in the
       format of \"The answer is (X)\" at the end."
  with 5 validation-split exemplars of the same category, each shown with its
  official cot_content.
  Scoring: accuracy; extraction regex `answer is \\(?([A-J])`, per the
  reference implementation.

GPQA
  Dataset: Idavidrein/gpqa (diamond default; main/extended selectable),
  exported 1:1 to jsonl.
  Prompting: zero-shot CoT in the paper's response format —
      "What is the correct answer to this question: {q}\\n\\nChoices:\\n(A) …
       \\nFormat your response as follows: \"The correct answer is (insert
       answer here)\". Let's think step by step:"
  Choice order is shuffled deterministically per item from the run seed
  (recorded), with the gold letter tracked — the standard de-biasing used by
  the reference evaluations.
  Scoring: accuracy on the extracted letter.
"""
from __future__ import annotations

import random
import re

from ..core.common import CACHE_DIR, read_jsonl
from ..scoring.stats import aggregate
from .base import Benchmark, Item, ItemResult

MMLU_PRO_LETTERS = "ABCDEFGHIJ"


class MMLUPro(Benchmark):
    name = "mmlu_pro"
    version = "TIGER-Lab/MMLU-Pro (test split, n=12032)"
    primary_metric = "accuracy"

    def __init__(self, options: dict):
        super().__init__(options)
        self.shots = int(options.get("shots", 5))
        self.max_tokens = options.get("max_tokens", 2048)

    def dataset_requirements(self):
        return {"test": "mmlu_pro/test.jsonl", "validation": "mmlu_pro/validation.jsonl"}

    @staticmethod
    def _fmt_q(row: dict, cot: str | None) -> str:
        opts = "\n".join(f"{MMLU_PRO_LETTERS[i]}. {o}" for i, o in enumerate(row["options"]))
        s = f"Question: {row['question']}\nOptions:\n{opts}\nAnswer:"
        if cot is not None:
            body = cot.strip()
            if not body.lower().startswith("let's think step by step"):
                body = "Let's think step by step. " + body
            s += f" {body}\n\n"
        else:
            s += " Let's think step by step."
        return s

    def load_items(self, *, limit, seed):
        test = read_jsonl(CACHE_DIR / "mmlu_pro/test.jsonl")
        val = read_jsonl(CACHE_DIR / "mmlu_pro/validation.jsonl")
        shots_by_cat: dict[str, list[dict]] = {}
        for row in val:
            shots_by_cat.setdefault(row["category"], []).append(row)
        if limit:
            test = test[:limit]
        items = []
        for row in test:
            cat = row["category"]
            header = (f"The following are multiple choice questions (with answers) about "
                      f"{cat}. Think step by step and then output the answer in the format "
                      f"of \"The answer is (X)\" at the end.\n\n")
            fewshot = "".join(self._fmt_q(s, s.get("cot_content") or "")
                              for s in shots_by_cat.get(cat, [])[: self.shots])
            items.append(Item(
                item_id=f"mmlu_pro/{row.get('question_id', row['question'][:24])}",
                prompt=header + fewshot + self._fmt_q(row, None),
                gold=row["answer"].strip(),
                meta={"category": cat},
            ))
        return items

    def score(self, item, response_text):
        m = re.findall(r"answer is \(?([A-J])\)?", response_text)
        letter = m[-1] if m else None
        return ItemResult(item.item_id, 1.0 if letter == item.gold else 0.0,
                          letter, item.gold, {"category": item.meta["category"]})

    def aggregate_extra(self, results):
        by: dict[str, list[float]] = {}
        for r in results:
            by.setdefault(r.detail["category"], []).append(r.score)
        return {"per_category": {k: aggregate(v) for k, v in sorted(by.items())}}

    def prompt_template_info(self):
        return self._template_info("mmlu_pro_official_5shot_cot", "v1",
                                   "TIGER-AI-Lab/MMLU-Pro evaluate_from_api.py format")


class GPQA(Benchmark):
    name = "gpqa"
    version = "Idavidrein/gpqa"
    primary_metric = "accuracy"

    def __init__(self, options: dict):
        super().__init__(options)
        self.subset = options.get("subset", "diamond")
        self.max_tokens = options.get("max_tokens", 2048)
        self.version = f"Idavidrein/gpqa ({self.subset})"

    def dataset_requirements(self):
        return {self.subset: f"gpqa/gpqa_{self.subset}.jsonl"}

    def load_items(self, *, limit, seed):
        rows = read_jsonl(CACHE_DIR / f"gpqa/gpqa_{self.subset}.jsonl")
        if limit:
            rows = rows[:limit]
        items = []
        for i, row in enumerate(rows):
            choices = [row["Correct Answer"], row["Incorrect Answer 1"],
                       row["Incorrect Answer 2"], row["Incorrect Answer 3"]]
            order = list(range(4))
            random.Random(f"{seed}:{i}").shuffle(order)
            shuffled = [choices[j] for j in order]
            gold_letter = "ABCD"[order.index(0)]
            body = "\n".join(f"({'ABCD'[j]}) {c.strip()}" for j, c in enumerate(shuffled))
            prompt = (
                f"What is the correct answer to this question: {row['Question'].strip()}\n\n"
                f"Choices:\n{body}\n\n"
                "Format your response as follows: \"The correct answer is (insert answer here)\".\n"
                "Let's think step by step:"
            )
            items.append(Item(f"gpqa/{self.subset}/{i}", prompt, gold_letter,
                              {"domain": row.get("High-level domain",
                                                 row.get("Subdomain", "unknown"))}))
        return items

    def score(self, item, response_text):
        m = re.findall(r"correct answer is\s*\(?([A-D])\)?", response_text, re.IGNORECASE)
        if not m:
            m = re.findall(r"answer is\s*\(?([A-D])\)?", response_text, re.IGNORECASE)
        letter = m[-1].upper() if m else None
        return ItemResult(item.item_id, 1.0 if letter == item.gold else 0.0,
                          letter, item.gold, {"domain": item.meta["domain"]})

    def aggregate_extra(self, results):
        by: dict[str, list[float]] = {}
        for r in results:
            by.setdefault(str(r.detail["domain"]), []).append(r.score)
        return {"per_domain": {k: aggregate(v) for k, v in sorted(by.items())}}

    def prompt_template_info(self):
        return self._template_info("gpqa_zeroshot_cot", "v1",
                                   "Rein et al. 2023 zero-shot CoT response format; "
                                   "seeded per-item choice shuffle")
