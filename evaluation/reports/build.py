"""Report generation for a completed run: results.csv, report.html, report.pdf.
metrics.json is written by the runner; this module derives the rest from the
run directory alone, so reports can always be rebuilt (`aqeval report <dir>`).
"""
from __future__ import annotations

import csv
from pathlib import Path

from ..core.common import load_json, read_jsonl
from .html_report import render_run_html
from .pdf_writer import render_run_pdf


def _flatten_meta(record: dict) -> dict:
    meta = record.get("adapter_meta") or {}
    return {
        "provider": meta.get("provider", ""),
        "engine_latency_ms": meta.get("engineLatencyMs", ""),
        "finish": meta.get("finishReason") or meta.get("finish_reason") or "",
    }


def write_results_csv(run_dir: Path) -> Path:
    records = read_jsonl(run_dir / "records.jsonl")
    out = run_dir / "results.csv"
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["item_id", "score", "extracted", "gold", "latency_ms",
                    "provider", "engine_latency_ms", "finish", "error"])
        for r in records:
            m = _flatten_meta(r)
            w.writerow([
                r.get("item_id", ""),
                r.get("score", ""),
                str(r.get("extracted", ""))[:200],
                str(r.get("gold", ""))[:200],
                r.get("latency_ms", ""),
                m["provider"], m["engine_latency_ms"], m["finish"],
                r.get("error", ""),
            ])
    return out


def build_all_reports(run_dir: Path) -> dict:
    run_dir = Path(run_dir)
    metrics = load_json(run_dir / "metrics.json")
    manifest = load_json(run_dir / "manifest.json")
    csv_path = write_results_csv(run_dir)
    html_path = run_dir / "report.html"
    html_path.write_text(render_run_html(metrics, manifest), encoding="utf-8")
    pdf_path = run_dir / "report.pdf"
    render_run_pdf(pdf_path, metrics, manifest)
    return {"csv": csv_path, "html": html_path, "pdf": pdf_path,
            "json": run_dir / "metrics.json"}
