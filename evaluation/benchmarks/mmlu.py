"""MMLU (Hendrycks et al., 2021) — 57-subject multiple choice.

Dataset: the official distribution (hendrycks/test → data.tar), unmodified
CSV layout data/{dev,val,test}/{subject}_{split}.csv. `aqeval download mmlu`
fetches and extracts it.

Prompting: the official few-shot format from the reference implementation
(hendrycks/test, evaluate.py): per-subject header
    "The following are multiple choice questions (with answers) about {subject}."
followed by k=5 dev examples and the test question, each formatted
    {question}\nA. …\nB. …\nC. …\nD. …\nAnswer: {letter}

Scoring: accuracy on the answer letter. The original paper scores base models
by choice log-likelihood; API/chat systems (AQUA included) expose no
logprobs, so AQEval uses the generative variant — the model completes
"Answer:" and the letter is extracted — which is the standard protocol for
API-served systems (see docs/METHODOLOGY.md for the comparability note).
Subscores: per subject and the official four category groups from the
reference repo's categories.py.
"""
from __future__ import annotations

import csv
from pathlib import Path

from ..core.common import CACHE_DIR
from ..scoring.extract import extract_mc_letter
from ..scoring.stats import aggregate
from .base import Benchmark, Item, ItemResult

LETTERS = "ABCD"
TEMPLATE_VERSION = "mmlu_official_5shot/v1"

# Official grouping — hendrycks/test categories.py (subcategory → category).
CATEGORY_OF = {
    "abstract_algebra": "STEM", "anatomy": "other", "astronomy": "STEM",
    "business_ethics": "other", "clinical_knowledge": "other",
    "college_biology": "STEM", "college_chemistry": "STEM",
    "college_computer_science": "STEM", "college_mathematics": "STEM",
    "college_medicine": "other", "college_physics": "STEM",
    "computer_security": "STEM", "conceptual_physics": "STEM",
    "econometrics": "social sciences", "electrical_engineering": "STEM",
    "elementary_mathematics": "STEM", "formal_logic": "humanities",
    "global_facts": "other", "high_school_biology": "STEM",
    "high_school_chemistry": "STEM", "high_school_computer_science": "STEM",
    "high_school_european_history": "humanities", "high_school_geography": "social sciences",
    "high_school_government_and_politics": "social sciences",
    "high_school_macroeconomics": "social sciences", "high_school_mathematics": "STEM",
    "high_school_microeconomics": "social sciences", "high_school_physics": "STEM",
    "high_school_psychology": "social sciences", "high_school_statistics": "STEM",
    "high_school_us_history": "humanities", "high_school_world_history": "humanities",
    "human_aging": "other", "human_sexuality": "social sciences",
    "international_law": "humanities", "jurisprudence": "humanities",
    "logical_fallacies": "humanities", "machine_learning": "STEM",
    "management": "other", "marketing": "other", "medical_genetics": "other",
    "miscellaneous": "other", "moral_disputes": "humanities",
    "moral_scenarios": "humanities", "nutrition": "other", "philosophy": "humanities",
    "prehistory": "humanities", "professional_accounting": "other",
    "professional_law": "humanities", "professional_medicine": "other",
    "professional_psychology": "social sciences", "public_relations": "social sciences",
    "security_studies": "social sciences", "sociology": "social sciences",
    "us_foreign_policy": "social sciences", "virology": "other",
    "world_religions": "humanities",
}


def _fmt_subject(s: str) -> str:
    return s.replace("_", " ")


def _fmt_example(row: list[str], with_answer: bool) -> str:
    q, a, b, c, d = row[0], row[1], row[2], row[3], row[4]
    s = f"{q}\nA. {a}\nB. {b}\nC. {c}\nD. {d}\nAnswer:"
    if with_answer:
        s += f" {row[5].strip()}\n\n"
    return s


class MMLU(Benchmark):
    name = "mmlu"
    version = "hendrycks/test official data.tar (test split, n=14042, 57 subjects)"
    primary_metric = "accuracy"

    def __init__(self, options: dict):
        super().__init__(options)
        self.shots = int(options.get("shots", 5))
        self.max_tokens = options.get("max_tokens", 32)
        self.subjects_filter = options.get("subjects")  # optional list; recorded, marks run non-official

    def dataset_requirements(self):
        return {"data": "mmlu/data"}

    def _data_root(self) -> Path:
        root = CACHE_DIR / "mmlu" / "data"
        return root if root.exists() else CACHE_DIR / "mmlu"

    @staticmethod
    def _read_csv(path: Path) -> list[list[str]]:
        with open(path, newline="", encoding="utf-8") as f:
            return [row for row in csv.reader(f) if row]

    def load_items(self, *, limit, seed):
        root = self._data_root()
        test_dir, dev_dir = root / "test", root / "dev"
        subjects = sorted(p.name[: -len("_test.csv")] for p in test_dir.glob("*_test.csv"))
        if self.subjects_filter:
            subjects = [s for s in subjects if s in set(self.subjects_filter)]
        items: list[Item] = []
        for subject in subjects:
            header = (f"The following are multiple choice questions (with answers) "
                      f"about {_fmt_subject(subject)}.\n\n")
            dev_rows = self._read_csv(dev_dir / f"{subject}_dev.csv")[: self.shots]
            fewshot = "".join(_fmt_example(r, True) for r in dev_rows)
            for i, row in enumerate(self._read_csv(test_dir / f"{subject}_test.csv")):
                items.append(Item(
                    item_id=f"mmlu/{subject}/{i}",
                    prompt=header + fewshot + _fmt_example(row, False),
                    gold=row[5].strip(),
                    meta={"subject": subject, "category": CATEGORY_OF.get(subject, "other")},
                ))
        if limit:
            items = items[:limit]
        return items

    def score(self, item, response_text):
        letter = extract_mc_letter(response_text, LETTERS)
        return ItemResult(item.item_id, 1.0 if letter == item.gold else 0.0,
                          letter, item.gold, {"subject": item.meta["subject"],
                                              "category": item.meta["category"]})

    def aggregate_extra(self, results):
        by = {"subject": {}, "category": {}}
        for r in results:
            by["subject"].setdefault(r.detail["subject"], []).append(r.score)
            by["category"].setdefault(r.detail["category"], []).append(r.score)
        return {
            "per_category": {k: aggregate(v) for k, v in sorted(by["category"].items())},
            "per_subject": {k: aggregate(v) for k, v in sorted(by["subject"].items())},
        }

    def prompt_template_info(self):
        sample = ("The following are multiple choice questions (with answers) about {subject}.\n\n"
                  "{k dev examples}{question}\nA. …\nB. …\nC. …\nD. …\nAnswer:")
        return self._template_info("mmlu_official_5shot", TEMPLATE_VERSION, sample)
