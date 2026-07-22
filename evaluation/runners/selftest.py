"""Framework selftest.

Three layers, none of which produce (or could be mistaken for) a model score:

1. Scoring-math checks — pass@k estimator against hand-computed values,
   MATH equivalence on known pairs, extractor unit cases.
2. Executor validation — the OFFICIAL HumanEval canonical solutions must all
   pass under our sandboxed runner, and a deliberately wrong solution must
   fail. This proves the execution+scoring path is faithful to the official
   semantics using known-ground-truth code, not model output.
3. Pipeline drill — the mock adapter runs through gsm8k + humaneval end to
   end; the run must be stamped non-official/MOCK and all four report
   artefacts (JSON, CSV, HTML, PDF) must be produced.
"""
from __future__ import annotations

from ..adapters import create_adapter
from ..benchmarks import create_benchmark
from ..core.common import CACHE_DIR, EVAL_ROOT, load_json, read_jsonl
from ..runners.code_exec import run_program
from ..runners.native_runner import run_benchmark
from ..scoring.extract import extract_answer_is, extract_mc_letter, last_boxed_only_string
from ..scoring.math_equiv import is_equiv
from ..scoring.stats import pass_at_k

MOCK_CONFIG = EVAL_ROOT / "configs" / "adapters" / "mock.json"


def _check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  [{'ok' if ok else 'FAIL'}] {label}" + (f" — {detail}" if detail and not ok else ""))
    return ok


def run_selftest(limit: int = 8) -> int:
    print("AQEval selftest — verifies plumbing only; produces no model results.\n")
    ok = True

    print("1) scoring math")
    ok &= _check("pass@1 (n=1,c=1) == 1.0", pass_at_k(1, 1, 1) == 1.0)
    ok &= _check("pass@1 (n=1,c=0) == 0.0", pass_at_k(1, 0, 1) == 0.0)
    ok &= _check("pass@10 (n=20,c=3) ≈ 0.8947", abs(pass_at_k(20, 3, 10) - 0.894737) < 1e-4)
    ok &= _check("MATH is_equiv 1/2 vs \\frac{1}{2}", is_equiv("\\frac{1}{2}", "1/2"))
    ok &= _check("MATH is_equiv rejects 3 vs 4", not is_equiv("3", "4"))
    ok &= _check("boxed extraction", last_boxed_only_string(r"so \boxed{42}.") == "42")
    ok &= _check("gsm8k strict extraction", extract_answer_is("The answer is 39.") == "39")
    ok &= _check("mc letter extraction", extract_mc_letter("Answer: C") == "C")

    print("\n2) executor validation (official HumanEval canonical solutions)")
    he_path = CACHE_DIR / "humaneval" / "HumanEval.jsonl.gz"
    if not he_path.exists():
        ok &= _check("HumanEval dataset present", False,
                     "run: python3 evaluation/aqeval.py download humaneval")
    else:
        tasks = read_jsonl(he_path)[:5]
        for t in tasks:
            program = (t["prompt"] + t["canonical_solution"] + "\n" + t["test"]
                       + f"\ncheck({t['entry_point']})\n")
            res = run_program(program, timeout_s=6.0)
            ok &= _check(f"{t['task_id']} canonical passes", res["passed"], res["detail"])
        bad = (tasks[0]["prompt"] + "    return None\n\n" + tasks[0]["test"]
               + f"\ncheck({tasks[0]['entry_point']})\n")
        ok &= _check("wrong solution fails", not run_program(bad, timeout_s=6.0)["passed"])
        loop = "while True:\n    pass\n"
        ok &= _check("infinite loop times out",
                     run_program(loop, timeout_s=2.0)["status"] in ("timeout", "failed"))

    print("\n3) pipeline drill (mock adapter — stamped MOCK, never a result)")
    adapter = create_adapter(MOCK_CONFIG)
    for bench_name in ("gsm8k", "humaneval"):
        req_ok = True
        bench = create_benchmark(bench_name,
                                 load_json(EVAL_ROOT / "configs" / "benchmarks.json")[bench_name])
        missing = bench._missing(bench.dataset_requirements())
        if missing:
            ok &= _check(f"{bench_name} dataset present", False, "; ".join(missing))
            continue
        run_dir = run_benchmark(bench, adapter, limit=limit, seed=1234,
                                concurrency=4, tag="selftest", skip_healthcheck=True)
        metrics = load_json(run_dir / "metrics.json")
        req_ok &= metrics["official"] is False
        req_ok &= metrics["model"]["adapter_type"] == "mock"
        for artefact in ("metrics.json", "results.csv", "report.html",
                         "report.pdf", "records.jsonl", "manifest.json"):
            req_ok &= (run_dir / artefact).exists()
        req_ok &= "MOCK" in (run_dir / "report.html").read_text(encoding="utf-8")
        ok &= _check(f"{bench_name} pipeline + 4 report formats + MOCK stamp", req_ok)

    print(f"\nselftest: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1
