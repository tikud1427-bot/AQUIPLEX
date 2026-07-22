"""Minimal PDF 1.4 writer — Python stdlib only.

Deliberately mirrors the platform's zero-new-dependencies discipline (cf. the
zero-dep ustar writer in the Artifact Engine). Produces clean multi-page
Helvetica documents: headings, key/value tables, rule lines. The archival
counterpart to the HTML dashboard; ASCII-safe (WinAnsi) output.
"""
from __future__ import annotations

from pathlib import Path

PAGE_W, PAGE_H = 595, 842  # A4 points
MARGIN = 56
LINE = 15


def _esc(s: str) -> str:
    s = s.encode("latin-1", "replace").decode("latin-1")
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


class Pdf:
    def __init__(self):
        self.pages: list[list[str]] = []
        self._new_page()

    def _new_page(self):
        self.stream: list[str] = []
        self.pages.append(self.stream)
        self.y = PAGE_H - MARGIN

    def _need(self, h: float):
        if self.y - h < MARGIN:
            self._new_page()

    def text(self, s: str, *, size=10, bold=False, x=MARGIN, gray=0.0, dy=LINE):
        self._need(dy)
        font = "F2" if bold else "F1"
        self.stream.append(
            f"BT /{font} {size} Tf {gray:.2f} g {x} {self.y:.1f} Td ({_esc(s)}) Tj ET"
        )
        self.y -= dy

    def rule(self, gap=8):
        self._need(gap)
        self.stream.append(
            f"0.55 G 0.8 w {MARGIN} {self.y:.1f} m {PAGE_W - MARGIN} {self.y:.1f} l S 0 G"
        )
        self.y -= gap

    def heading(self, s: str, size=13):
        self.y -= 6
        self.text(s.upper(), size=size, bold=True, dy=size + 6)
        self.rule()

    def kv(self, k: str, v: str):
        self._need(LINE)
        self.stream.append(
            f"BT /F2 9 Tf 0.35 g {MARGIN} {self.y:.1f} Td ({_esc(k)}) Tj ET"
        )
        for i, chunk in enumerate([v[j:j + 78] for j in range(0, max(len(v), 1), 78)]):
            self._need(LINE)
            self.stream.append(
                f"BT /F1 9.5 Tf 0 g {MARGIN + 165} {self.y:.1f} Td ({_esc(chunk)}) Tj ET"
            )
            self.y -= LINE - 2
        self.y -= 3

    def spacer(self, h=8):
        self.y -= h

    def save(self, path: Path):
        objs: list[bytes] = []

        def add(body: bytes) -> int:
            objs.append(body)
            return len(objs)

        f1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        f2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
        content_ids, page_ids = [], []
        for stream in self.pages:
            data = ("\n".join(stream)).encode("latin-1", "replace")
            content_ids.append(add(b"<< /Length %d >>\nstream\n%s\nendstream"
                                   % (len(data), data)))
        pages_id = len(objs) + len(self.pages) + 1
        for cid in content_ids:
            page_ids.append(add(
                (f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
                 f"/Resources << /Font << /F1 {f1} 0 R /F2 {f2} 0 R >> >> "
                 f"/Contents {cid} 0 R >>").encode()))
        kids = " ".join(f"{p} 0 R" for p in page_ids)
        assert add((f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>").encode()) == pages_id
        catalog = add((f"<< /Type /Catalog /Pages {pages_id} 0 R >>").encode())

        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for i, body in enumerate(objs, 1):
            offsets.append(len(out))
            out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
        xref = len(out)
        out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
        for off in offsets[1:]:
            out += f"{off:010d} 00000 n \n".encode()
        out += (f"trailer\n<< /Size {len(objs) + 1} /Root {catalog} 0 R >>\n"
                f"startxref\n{xref}\n%%EOF\n").encode()
        Path(path).write_bytes(bytes(out))


def render_run_pdf(path: Path, metrics: dict, manifest: dict) -> None:
    badge = ("INVALID RUN — ZERO ITEMS SCORED, NO BENCHMARK RESULT"
             if metrics.get("invalid")
             else "MOCK — FRAMEWORK SELFTEST, NOT A MODEL RESULT"
             if metrics["model"]["adapter_type"] == "mock"
             else ("OFFICIAL RUN" if metrics.get("official")
                   else "SMOKE RUN — PARTIAL / NON-DEFAULT, NOT REPORTABLE"))
    metric = metrics["scores"]["primary_metric"]
    primary = metrics["scores"][metric]
    env, git = manifest["environment"], manifest["git"]
    tmpl = manifest.get("prompt_template") or {}

    pdf = Pdf()
    pdf.text("AQEVAL  ·  BENCHMARK RUN REPORT", size=16, bold=True, dy=24)
    pdf.text(f"{metrics['benchmark']['name']}  —  {metrics['model']['name']}", size=12, dy=18)
    pdf.text(badge, size=10, bold=True, gray=0.25, dy=18)
    pdf.rule()
    pdf.spacer(4)
    pdf.text(f"{metric}: {primary['mean'] * 100:.2f}%", size=22, bold=True, dy=26)
    pdf.text(f"stderr ±{primary['stderr'] * 100:.2f} · 95% CI "
             f"[{primary['ci95'][0] * 100:.1f}, {primary['ci95'][1] * 100:.1f}] · n={primary['n']}",
             size=10, gray=0.3, dy=18)

    pdf.heading("Run record")
    for k, v in [
        ("Run ID", metrics["run_id"]),
        ("Date (UTC)", metrics["date_utc"]),
        ("Benchmark version", metrics["benchmark"]["version"]),
        ("Adapter", metrics["model"]["adapter_type"]),
        ("Runtime", f"{metrics['runtime_s']} s"),
        ("Seed", str(manifest.get("seed"))),
        ("Prompt template", f"{tmpl.get('id', '-')} {tmpl.get('version', '')} "
                            f"sha256 {str(tmpl.get('sha256', ''))[:16]}"),
        ("AQEval commit", str(git["aqeval"].get("commit") or "n/a")),
        ("Platform commit", str(git["platform"].get("commit") or "n/a")),
        ("Hardware", f"{env['platform']} / {env['cpu_count']} vCPU / {env.get('mem_gb', '?')} GB"),
        ("Python", env["python"]),
        ("Errors", f"{metrics['errors']['count']} ({metrics['errors']['rate'] * 100:.2f}%)"),
    ]:
        pdf.kv(k, str(v))

    pdf.heading("Datasets")
    for label, d in manifest["datasets"].items():
        pdf.kv(label, f"{d.get('path')}  sha256 {str(d.get('sha256'))[:24]}")

    subs = {k: v for k, v in metrics["scores"].items()
            if k not in ("primary_metric", metric)}
    if subs:
        pdf.heading("Subscores")
        for group, val in subs.items():
            if isinstance(val, dict) and "mean" in val:
                pdf.kv(group, f"{val['mean'] * 100:.2f}%  (n={val['n']})")
            elif isinstance(val, dict):
                pdf.text(group.replace("_", " "), bold=True, size=10, dy=16)
                for name, agg in val.items():
                    pdf.kv("  " + str(name)[:34], f"{agg['mean'] * 100:.2f}%  "
                           f"CI [{agg['ci95'][0] * 100:.1f}, {agg['ci95'][1] * 100:.1f}]  n={agg['n']}")

    for n in metrics.get("notes", []):
        pdf.spacer(6)
        pdf.text("NOTE: " + n, size=9, gray=0.3, dy=13)
    pdf.spacer(10)
    pdf.text("Raw responses: records.jsonl · Full manifest: manifest.json · "
             "Generated by AQEval 1.0", size=8.5, gray=0.45)
    pdf.save(path)
