#!/usr/bin/env python3
"""AQEval — benchmark evaluation framework for AQUA (Aquiplex).

Single-command execution, per the framework spec:

    python3 evaluation/aqeval.py run --benchmark gsm8k \\
        --adapter evaluation/configs/adapters/aquiplex.json

Commands
    list                       benchmarks (native + recognised-unsupported) and dataset status
    download <name|all>        fetch/verify original datasets (direct sources)
    run                        execute a benchmark end-to-end and emit all reports
    report <run_dir>           rebuild JSON/CSV/HTML/PDF reports for a past run
    compare <metrics.json …>   provider-agnostic comparison dashboard + CSV
    selftest                   verify the pipeline with the mock adapter (never a model result)
    shim                       OpenAI-compatible façade over any adapter (for lm-eval etc.)

Python 3.10+ · stdlib only.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # repo root

from evaluation.adapters import create_adapter                      # noqa: E402
from evaluation.benchmarks import REGISTRY, UNSUPPORTED, create_benchmark  # noqa: E402
from evaluation.core.common import EVAL_ROOT, load_json             # noqa: E402
from evaluation.datasets import manager                             # noqa: E402
from evaluation.runners.native_runner import run_benchmark          # noqa: E402


def cmd_list(_args) -> None:
    print("NATIVE benchmarks (executable by AQEval):")
    for name in sorted(REGISTRY):
        print(f"  {name}")
    print("\nRECOGNISED, not executable natively (see docs/SUPPORT_MATRIX.md):")
    for name, reason in UNSUPPORTED.items():
        print(f"  {name:14s} — {reason}")
    print("\nDataset cache status:")
    for name, kind, state in manager.status():
        print(f"  {name:10s} [{kind:10s}] {state}")


def cmd_download(args) -> None:
    names = sorted(manager.SOURCES) if args.name == "all" else [args.name]
    for n in names:
        manager.download_dataset(n)
        print()


def _bench_options(name: str, args) -> dict:
    defaults = load_json(EVAL_ROOT / "configs" / "benchmarks.json").get(name, {})
    opts = dict(defaults)
    if args.shots is not None:
        opts["shots"] = args.shots
    if args.subset:
        opts["subset"] = args.subset
    if args.edition:
        opts["edition"] = args.edition
    return opts


def cmd_run(args) -> None:
    bench = create_benchmark(args.benchmark, _bench_options(args.benchmark, args))
    adapter = create_adapter(args.adapter)
    run_benchmark(bench, adapter, limit=args.limit, seed=args.seed,
                  concurrency=args.concurrency, tag=args.tag,
                  skip_healthcheck=args.skip_healthcheck)


def cmd_report(args) -> None:
    from evaluation.reports.build import build_all_reports
    paths = build_all_reports(Path(args.run_dir))
    for kind, p in paths.items():
        print(f"{kind:5s} {p}")


def cmd_compare(args) -> None:
    from evaluation.reports.html_report import (compare_csv_rows, load_metrics,
                                                render_compare_html)
    runs = load_metrics(args.metrics)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "compare.html").write_text(render_compare_html(runs), encoding="utf-8")
    with open(out_dir / "compare.csv", "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(compare_csv_rows(runs))
    print(f"→ {out_dir / 'compare.html'}\n→ {out_dir / 'compare.csv'}")


def cmd_selftest(args) -> None:
    """Pipeline verification with the mock adapter. Scores are ~0 by design and
    are stamped MOCK everywhere — this exists to prove plumbing, not ability."""
    from evaluation.runners.selftest import run_selftest
    sys.exit(run_selftest(limit=args.limit))


def cmd_shim(args) -> None:
    from evaluation.adapters.shim_server import serve
    serve(create_adapter(args.adapter), host=args.host, port=args.port)


def main() -> None:
    p = argparse.ArgumentParser(prog="aqeval", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list").set_defaults(fn=cmd_list)

    d = sub.add_parser("download")
    d.add_argument("name")
    d.set_defaults(fn=cmd_download)

    r = sub.add_parser("run")
    r.add_argument("--benchmark", required=True, choices=sorted(REGISTRY) + sorted(UNSUPPORTED))
    r.add_argument("--adapter", required=True, help="path to an adapter config JSON")
    r.add_argument("--limit", type=int, default=None,
                   help="run only the first N items (marks the run SMOKE / non-official)")
    r.add_argument("--seed", type=int, default=1234)
    r.add_argument("--concurrency", type=int, default=4)
    r.add_argument("--shots", type=int, default=None)
    r.add_argument("--subset", default=None, help="gpqa: diamond|main|extended")
    r.add_argument("--edition", default=None, help="aime: 2024|2025")
    r.add_argument("--tag", default=None)
    r.add_argument("--skip-healthcheck", action="store_true")
    r.set_defaults(fn=cmd_run)

    rep = sub.add_parser("report")
    rep.add_argument("run_dir")
    rep.set_defaults(fn=cmd_report)

    c = sub.add_parser("compare")
    c.add_argument("metrics", nargs="+", help="paths to metrics.json files")
    c.add_argument("--out", default=str(EVAL_ROOT / "dashboards" / "comparison"))
    c.set_defaults(fn=cmd_compare)

    st = sub.add_parser("selftest")
    st.add_argument("--limit", type=int, default=8)
    st.set_defaults(fn=cmd_selftest)

    sh = sub.add_parser("shim")
    sh.add_argument("--adapter", required=True)
    sh.add_argument("--host", default="127.0.0.1")
    sh.add_argument("--port", type=int, default=8799)
    sh.set_defaults(fn=cmd_shim)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
