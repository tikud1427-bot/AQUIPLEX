"""GSM8K (Cobbe et al., 2021) — grade-school math word problems.

Dataset: official openai/grade-school-math test split (1,319 problems),
unmodified. Gold answers are the '#### <number>' terminals in the original
answer strings.

Prompting: the canonical 8-shot chain-of-thought exemplars from Wei et al.
2022 ("Chain-of-Thought Prompting Elicits Reasoning in Large Language
Models"), stored verbatim and version-pinned in prompts/gsm8k_cot_8shot.txt.

Metric: exact match on the final numeric answer. Both extraction rules used
across the literature are reported, mirroring lm-evaluation-harness:
  * strict  — final "The answer is N" (the exemplar format)   → primary
  * flexible — last number anywhere in the response
"""
from __future__ import annotations

from ..core.common import CACHE_DIR, read_jsonl
from ..scoring.extract import (extract_answer_is, extract_hash_answer,
                               extract_last_number, numbers_equal)
from ..scoring.stats import aggregate
from .base import Benchmark, Item, ItemResult

TEMPLATE_VERSION = "gsm8k_cot_8shot/v1"


class GSM8K(Benchmark):
    name = "gsm8k"
    version = "openai/grade-school-math @ master (test split, n=1319)"
    primary_metric = "exact_match_strict"
    stop = ["\nQ:", "\n\nQ:"]

    def __init__(self, options: dict):
        super().__init__(options)
        self.max_tokens = options.get("max_tokens", 1024)
        self._fewshot = self._prompt_file("gsm8k_cot_8shot.txt").rstrip() + "\n\n"

    def dataset_requirements(self):
        return {"test": "gsm8k/test.jsonl"}

    def load_items(self, *, limit, seed):
        rows = read_jsonl(CACHE_DIR / "gsm8k/test.jsonl")
        if limit:
            rows = rows[:limit]
        items = []
        for i, row in enumerate(rows):
            gold = extract_hash_answer(row["answer"])
            items.append(Item(
                item_id=f"gsm8k/test/{i}",
                prompt=f"{self._fewshot}Q: {row['question']}\nA:",
                gold=gold,
                meta={"question": row["question"]},
            ))
        return items

    def score(self, item, response_text):
        strict = extract_answer_is(response_text)
        flexible = extract_last_number(response_text)
        s_ok = numbers_equal(strict, item.gold)
        f_ok = numbers_equal(flexible, item.gold)
        return ItemResult(
            item_id=item.item_id,
            score=1.0 if s_ok else 0.0,
            extracted=strict,
            gold=item.gold,
            detail={"flexible_extracted": flexible, "flexible_correct": f_ok},
        )

    def aggregate_extra(self, results):
        flex = [1.0 if r.detail.get("flexible_correct") else 0.0 for r in results]
        return {"exact_match_flexible": aggregate(flex)}

    def prompt_template_info(self):
        return self._template_info("gsm8k_cot_8shot", TEMPLATE_VERSION, self._fewshot)
