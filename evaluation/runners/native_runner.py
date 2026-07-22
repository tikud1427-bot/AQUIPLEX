"""Native benchmark runner — the single-command execution path.

Pipeline (spec order): load benchmark → load/verify AQUIPLEX (healthcheck) →
execute → capture raw responses (records.jsonl, verbatim) → score → store
metrics → generate reports.

Officiality: a run is stamped official=true only when it covers the full
split with default parameters on a non-mock adapter. --limit, subject
filters, or the mock adapter force official=false ("smoke") so partial runs
can never be presented as benchmark results.
"""
from __future__ import annotations

import concurrent.futures as cf
import time
import traceback
from pathlib import Path

from ..adapters import ModelAdapter
from ..benchmarks.base import Benchmark, ItemResult
from ..core.common import (RUNS_DIR, append_jsonl, ensure_dir, now_iso,
                           run_stamp, save_json)
from ..core.manifest import build_manifest
from ..datasets.manager import verify_file
from ..scoring.stats import aggregate


def _dataset_check(bench: Benchmark) -> dict:
    missing = bench._missing(bench.dataset_requirements())
    if missing:
        raise SystemExit(
            "Dataset files missing:\n  " + "\n  ".join(missing) +
            f"\nRun:  python3 evaluation/aqeval.py download {bench.name}"
        )
    out = {}
    for label, rel in bench.dataset_requirements().items():
        p = Path(rel)
        if (Path(__file__).resolve().parent.parent / "datasets" / "cache" / rel).is_dir():
            out[label] = {"path": f"datasets/cache/{rel}", "sha256": "directory (per-file pins in checksums.json)"}
        else:
            out[label] = verify_file(rel)
    return out


def run_benchmark(
    bench: Benchmark,
    adapter: ModelAdapter,
    *,
    limit: int | None,
    seed: int,
    concurrency: int,
    tag: str | None,
    skip_healthcheck: bool = False,
) -> Path:
    dataset_files = _dataset_check(bench)

    if not skip_healthcheck:
        ok, msg = adapter.healthcheck()
        if not ok:
            raise SystemExit(msg)
        print(f"✓ adapter '{adapter.name}': {msg}")

    items = bench.load_items(limit=limit, seed=seed)
    for label, info in dataset_files.items():
        info["n_loaded"] = len(items)

    run_id = f"{run_stamp()}_{bench.name}_{adapter.type_name}" + (f"_{tag}" if tag else "")
    run_dir = ensure_dir(RUNS_DIR / run_id)
    raw_path = run_dir / "records.jsonl"
    err_path = run_dir / "errors.log"

    official = (limit is None and adapter.type_name != "mock"
                and not bench.options.get("subjects"))
    run_config = {
        "run_id": run_id,
        "benchmark": bench.name,
        "options": bench.options,
        "limit": limit,
        "seed": seed,
        "concurrency": concurrency,
        "official": official,
        "tag": tag,
        "n_items": len(items),
    }
    manifest = build_manifest(
        benchmark={"name": bench.name, "version": bench.version,
                   "primary_metric": bench.primary_metric},
        adapter_config=adapter.describe(),
        run_config=run_config,
        prompt_template=bench.prompt_template_info(),
        dataset_files=dataset_files,
        seed=seed,
    )
    save_json(run_dir / "manifest.json", manifest)
    save_json(run_dir / "config.json", run_config)

    print(f"▶ {bench.name} — {len(items)} items, concurrency={concurrency}, "
          f"{'OFFICIAL' if official else 'SMOKE (non-reportable)'}")
    t0 = time.perf_counter()
    results: list[ItemResult] = []
    errors = 0

    def one(idx_item):
        idx, item = idx_item
        try:
            resp = adapter.generate(item.prompt, max_tokens=bench.max_tokens,
                                    stop=bench.stop)
            result = bench.score(item, resp.text)
            record = {
                "item_id": item.item_id,
                "prompt": item.prompt,
                "response": resp.text,
                "raw": resp.raw,
                "adapter_meta": resp.meta,
                "latency_ms": round(resp.latency_ms, 1),
                "score": result.score,
                "extracted": result.extracted,
                "gold": result.gold,
                "detail": result.detail,
                "ts": now_iso(),
            }
            return idx, result, record, None
        except Exception as e:  # noqa: BLE001 — captured per item, run continues
            return idx, None, {"item_id": item.item_id, "error": str(e),
                               "ts": now_iso()}, traceback.format_exc()

    with cf.ThreadPoolExecutor(max_workers=max(concurrency, 1)) as ex:
        done = 0
        for idx, result, record, tb in ex.map(one, enumerate(items)):
            append_jsonl(raw_path, record)
            if result is None:
                errors += 1
                with open(err_path, "a", encoding="utf-8") as f:
                    f.write(f"--- {record['item_id']}\n{tb}\n")
            else:
                results.append(result)
            done += 1
            if done % 25 == 0 or done == len(items):
                acc = sum(r.score for r in results) / max(len(results), 1)
                print(f"  {done}/{len(items)}  running {bench.primary_metric}="
                      f"{acc:.3f}  errors={errors}", flush=True)

    runtime_s = round(time.perf_counter() - t0, 1)
    scores = [r.score for r in results]
    primary = aggregate(scores, seed=seed)

    metrics = {
        "run_id": run_id,
        "date_utc": now_iso(),
        "benchmark": {"name": bench.name, "version": bench.version},
        "model": {"adapter_type": adapter.type_name, "name": adapter.name},
        "official": official,
        "runtime_s": runtime_s,
        "scores": {
            "primary_metric": bench.primary_metric,
            bench.primary_metric: primary,
            **bench.aggregate_extra(results),
        },
        "errors": {"count": errors,
                   "rate": round(errors / max(len(items), 1), 4)},
        "notes": ([] if official else
                  ["Non-official run (partial split, filtered subjects, or mock adapter). "
                   "Not a reportable benchmark result."]),
    }
    if not results:  # every item errored — there is no result to report
        metrics["invalid"] = True
        metrics["official"] = False
        metrics["notes"].insert(0,
            "RUN INVALID: 0 items were scored (100% errors). No benchmark "
            "result exists for this run — see errors.log and records.jsonl.")
    save_json(run_dir / "metrics.json", metrics)

    from ..reports.build import build_all_reports
    build_all_reports(run_dir)

    badge = "OFFICIAL" if official else ("MOCK" if adapter.type_name == "mock" else "SMOKE")
    print(f"■ {bench.name} {bench.primary_metric}={primary['mean']:.4f} "
          f"±{primary['stderr']:.4f} (n={primary['n']}, {badge}) in {runtime_s}s")
    print(f"  → {run_dir.relative_to(RUNS_DIR.parent.parent)}")
    return run_dir
