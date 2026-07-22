"""HumanEval (Chen et al., 2021) and MBPP (Austin et al., 2021).

HumanEval
  Dataset: official openai/human-eval HumanEval.jsonl.gz (164 problems),
  unmodified. Scoring is the official semantics: candidate program +
  official `test` + `check(entry_point)` must run clean within the timeout
  (official default 3.0 s). pass@k uses the paper's unbiased estimator
  (scoring/stats.py).
  Prompt modes (recorded in the manifest):
    completion — the raw function prompt, exactly as the original evaluation
                 feeds base models.
    chat (default) — the documented instruct wrapper for chat systems: the
                 model is asked to return the complete function in one code
                 block. AQUA is a chat system; the mode keeps its results
                 comparable to other chat-model reports, which use the same
                 convention.

MBPP
  Dataset: official google-research mbpp.jsonl (974 tasks), unmodified.
  Split: the paper's test split, task_ids 11–510 (n=500); few-shot prompts
  are the paper's convention, task_ids 2–4.
  Prompt: the official format from the reference README —
      "You are an expert Python programmer, and here is your task: {text}
       Your code should pass these tests:\n\n{tests}\n[BEGIN]\n"
  with [BEGIN]/[DONE] delimiting code in the exemplars.
  Scoring: candidate + test_setup_code + the three official assert
  statements must run clean within the timeout. pass@k as above.
"""
from __future__ import annotations

import re

from ..core.common import CACHE_DIR, read_jsonl
from ..runners.code_exec import run_program
from ..scoring.extract import extract_code_block
from ..scoring.stats import aggregate, pass_at_k
from .base import Benchmark, Item, ItemResult


class HumanEval(Benchmark):
    name = "humaneval"
    version = "openai/human-eval HumanEval.jsonl.gz (n=164)"
    primary_metric = "pass@1"

    def __init__(self, options: dict):
        super().__init__(options)
        self.mode = options.get("prompt_mode", "chat")
        self.timeout = float(options.get("exec_timeout_s", 3.0))
        self.ks = options.get("k", [1])
        self.max_tokens = options.get("max_tokens", 2048)

    def dataset_requirements(self):
        return {"problems": "humaneval/HumanEval.jsonl.gz"}

    def load_items(self, *, limit, seed):
        rows = read_jsonl(CACHE_DIR / "humaneval/HumanEval.jsonl.gz")
        if limit:
            rows = rows[:limit]
        items = []
        for r in rows:
            if self.mode == "chat":
                prompt = (
                    "Complete the following Python function. Return the complete "
                    "function — signature included — inside a single ```python code "
                    "block. Do not include tests or example usage.\n\n"
                    f"```python\n{r['prompt']}```"
                )
            else:
                prompt = r["prompt"]
            items.append(Item(r["task_id"], prompt, None,
                              {"task": r, "entry_point": r["entry_point"]}))
        return items

    def _assemble(self, task: dict, response_text: str) -> str:
        entry = task["entry_point"]
        code = extract_code_block(response_text)
        if code is None:
            code = response_text
        if re.search(rf"def\s+{re.escape(entry)}\s*\(", code):
            body = code                     # model returned the full function
        else:
            body = task["prompt"] + code    # completion-style continuation
        return f"{body}\n\n{task['test']}\n\ncheck({entry})\n"

    def score(self, item, response_text):
        program = self._assemble(item.meta["task"], response_text)
        res = run_program(program, timeout_s=self.timeout)
        return ItemResult(item.item_id, 1.0 if res["passed"] else 0.0,
                          None, "unit tests pass",
                          {"status": res["status"], "exec_detail": res["detail"]})

    def aggregate_extra(self, results):
        # n_samples=1 per item in v1 → pass@1 equals mean; the estimator keeps
        # the aggregation correct if n_samples is raised later.
        by_task: dict[str, list[float]] = {}
        for r in results:
            by_task.setdefault(r.item_id, []).append(r.score)
        out = {}
        for k in self.ks:
            vals = [pass_at_k(len(s), int(sum(s)), k) for s in by_task.values()
                    if len(s) >= k]
            if vals:
                out[f"pass@{k}"] = aggregate(vals)
        return out

    def prompt_template_info(self):
        return self._template_info("humaneval", f"{self.mode}/v1",
                                   f"mode={self.mode}; official test+check scoring")


class MBPP(Benchmark):
    name = "mbpp"
    version = "google-research mbpp.jsonl, paper test split task_id 11-510 (n=500)"
    primary_metric = "pass@1"
    FEWSHOT_IDS = (2, 3, 4)
    TEST_RANGE = range(11, 511)

    def __init__(self, options: dict):
        super().__init__(options)
        self.timeout = float(options.get("exec_timeout_s", 3.0))
        self.ks = options.get("k", [1])
        self.shots = int(options.get("shots", 3))
        self.max_tokens = options.get("max_tokens", 1024)

    def dataset_requirements(self):
        return {"tasks": "mbpp/mbpp.jsonl"}

    @staticmethod
    def _task_prompt(r: dict, with_code: bool) -> str:
        tests = "\n".join(r["test_list"])
        s = (f"You are an expert Python programmer, and here is your task: "
             f"{r['text']} Your code should pass these tests:\n\n{tests}\n[BEGIN]\n")
        if with_code:
            s += f"{r['code']}\n[DONE]\n\n"
        return s

    def load_items(self, *, limit, seed):
        rows = {r["task_id"]: r for r in read_jsonl(CACHE_DIR / "mbpp/mbpp.jsonl")}
        fewshot = "".join(self._task_prompt(rows[i], True)
                          for i in self.FEWSHOT_IDS[: self.shots] if i in rows)
        ids = [i for i in self.TEST_RANGE if i in rows]
        if limit:
            ids = ids[:limit]
        return [Item(f"mbpp/{i}", fewshot + self._task_prompt(rows[i], False),
                     None, {"task": rows[i]}) for i in ids]

    def score(self, item, response_text):
        task = item.meta["task"]
        code = extract_code_block(response_text)
        if code is None:
            code = response_text.split("[DONE]")[0]
        setup = task.get("test_setup_code") or ""
        program = f"{code}\n\n{setup}\n\n" + "\n".join(task["test_list"]) + "\n"
        res = run_program(program, timeout_s=self.timeout)
        return ItemResult(item.item_id, 1.0 if res["passed"] else 0.0,
                          None, "unit tests pass",
                          {"status": res["status"], "exec_detail": res["detail"]})

    def aggregate_extra(self, results):
        by_task: dict[str, list[float]] = {}
        for r in results:
            by_task.setdefault(r.item_id, []).append(r.score)
        out = {}
        for k in self.ks:
            vals = [pass_at_k(len(s), int(sum(s)), k) for s in by_task.values()
                    if len(s) >= k]
            if vals:
                out[f"pass@{k}"] = aggregate(vals)
        return out

    def prompt_template_info(self):
        return self._template_info("mbpp_official_3shot", "v1",
                                   "google-research mbpp README format, shots 2-4")
