"""Self-contained HTML report. No external assets, no JS dependencies —
opens identically offline, in CI artifacts, and in an investor data room.

Visual language ("bench instrument"): abyssal-teal panel palette (AQUA),
monospace data voice, one signature element — a 270° score dial with the
bootstrap 95% CI drawn as a band on the arc. Subscores render as hairline
bars with CI whiskers. OFFICIAL / SMOKE / MOCK badge is unmissable.
"""
from __future__ import annotations

import html
import json
import math

BADGE = {
    "OFFICIAL": ("#2FD6C3", "official run — full split, default parameters"),
    "INVALID": ("#E86A5E", "invalid run — zero items scored; no benchmark result exists"),
    "SMOKE": ("#E8B04B", "smoke run — partial or non-default; not reportable"),
    "MOCK": ("#E86A5E", "mock adapter — framework selftest, not a model result"),
}


def _badge(metrics: dict) -> str:
    if metrics.get("invalid"):
        return "INVALID"
    if metrics["model"]["adapter_type"] == "mock":
        return "MOCK"
    return "OFFICIAL" if metrics.get("official") else "SMOKE"


def _e(x) -> str:
    return html.escape(str(x))


def _arc(cx, cy, r, a0, a1):
    x0, y0 = cx + r * math.cos(a0), cy + r * math.sin(a0)
    x1, y1 = cx + r * math.cos(a1), cy + r * math.sin(a1)
    large = 1 if (a1 - a0) > math.pi else 0
    return f"M {x0:.2f} {y0:.2f} A {r} {r} 0 {large} 1 {x1:.2f} {y1:.2f}"


def _dial(value: float, ci: list[float], metric: str, color: str) -> str:
    """270° dial: track, CI band, value arc, ticks, centred number."""
    start, sweep = math.radians(135), math.radians(270)
    a = lambda v: start + sweep * max(0.0, min(1.0, v))  # noqa: E731
    ticks = "".join(
        f'<line x1="{110 + 86 * math.cos(a(t)):.1f}" y1="{110 + 86 * math.sin(a(t)):.1f}" '
        f'x2="{110 + 94 * math.cos(a(t)):.1f}" y2="{110 + 94 * math.sin(a(t)):.1f}" '
        f'stroke="#1D3440" stroke-width="2"/>'
        for t in (i / 10 for i in range(11))
    )
    ci_arc = ""
    if ci and ci[1] > ci[0]:
        ci_arc = (f'<path d="{_arc(110, 110, 90, a(ci[0]), a(ci[1]))}" fill="none" '
                  f'stroke="{color}" stroke-opacity="0.25" stroke-width="14" '
                  f'stroke-linecap="butt"/>')
    val_arc = ""
    if value > 0:
        val_arc = (f'<path d="{_arc(110, 110, 90, a(0), a(value))}" fill="none" '
                   f'stroke="{color}" stroke-width="7" stroke-linecap="round"/>')
    return f"""
<svg viewBox="0 0 220 200" class="dial" role="img" aria-label="{_e(metric)} {value:.4f}">
  <path d="{_arc(110, 110, 90, a(0), a(1))}" fill="none" stroke="#142832" stroke-width="7"/>
  {ticks}{ci_arc}{val_arc}
  <text x="110" y="104" class="dial-num">{value * 100:.1f}<tspan class="dial-pct">%</tspan></text>
  <text x="110" y="128" class="dial-metric">{_e(metric)}</text>
  <text x="110" y="146" class="dial-ci">95% CI {ci[0] * 100:.1f}–{ci[1] * 100:.1f}</text>
</svg>"""


def _bar_rows(sub: dict) -> str:
    rows = []
    for name, agg in sub.items():
        m, lo, hi = agg["mean"], agg["ci95"][0], agg["ci95"][1]
        rows.append(f"""
<div class="bar-row">
  <div class="bar-label" title="n={agg['n']}">{_e(name)}</div>
  <div class="bar-track">
    <div class="bar-fill" style="width:{m * 100:.2f}%"></div>
    <div class="bar-ci" style="left:{lo * 100:.2f}%;width:{max(hi - lo, 0) * 100:.2f}%"></div>
  </div>
  <div class="bar-val">{m * 100:.1f}%<span class="bar-n"> · n={agg['n']}</span></div>
</div>""")
    return "".join(rows)


def _kv_rows(pairs: list[tuple[str, object]]) -> str:
    return "".join(f"<tr><th>{_e(k)}</th><td>{_e(v)}</td></tr>" for k, v in pairs)


def render_run_html(metrics: dict, manifest: dict) -> str:
    badge = _badge(metrics)
    color, badge_note = BADGE[badge]
    scores = metrics["scores"]
    metric = scores["primary_metric"]
    primary = scores[metric]

    subscore_sections = []
    for key, val in scores.items():
        if key in ("primary_metric", metric):
            continue
        if isinstance(val, dict) and "mean" in val:            # sibling scalar metric
            subscore_sections.append(
                f'<section class="panel"><h2>{_e(key)}</h2>{_bar_rows({key: val})}</section>')
        elif isinstance(val, dict):                            # grouped subscores
            subscore_sections.append(
                f'<section class="panel"><h2>{_e(key.replace("_", " "))}</h2>{_bar_rows(val)}</section>')

    env = manifest["environment"]
    git = manifest["git"]
    ds_rows = _kv_rows([(label, f"{d.get('path')} · sha256 {str(d.get('sha256'))[:16]}… · n={d.get('n_loaded', '?')}")
                        for label, d in manifest["datasets"].items()])
    tmpl = manifest.get("prompt_template") or {}
    meta_rows = _kv_rows([
        ("Run ID", metrics["run_id"]),
        ("Date (UTC)", metrics["date_utc"]),
        ("Benchmark", f"{metrics['benchmark']['name']} — {metrics['benchmark']['version']}"),
        ("System under test", f"{metrics['model']['name']} ({metrics['model']['adapter_type']} adapter)"),
        ("Runtime", f"{metrics['runtime_s']} s"),
        ("Seed", manifest.get("seed")),
        ("Prompt template", f"{tmpl.get('id', '—')} {tmpl.get('version', '')} · sha256 {str(tmpl.get('sha256', ''))[:16]}…" if tmpl else "—"),
        ("AQEval commit", (git["aqeval"].get("commit") or "n/a")),
        ("Platform commit", (git["platform"].get("commit") or "n/a")),
        ("Hardware", f"{env['platform']} · {env['cpu_count']} vCPU · {env.get('mem_gb', '?')} GB RAM"),
        ("Python", env["python"]),
        ("Errors", f"{metrics['errors']['count']} ({metrics['errors']['rate'] * 100:.2f}%)"),
    ])
    notes = "".join(f'<p class="note">◈ {_e(n)}</p>' for n in metrics.get("notes", []))
    repro = (f"python3 evaluation/aqeval.py run --benchmark {metrics['benchmark']['name']} "
             f"--adapter configs/adapters/&lt;adapter&gt;.json --seed {manifest.get('seed')}")

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AQEval · {_e(metrics['benchmark']['name'])} · {_e(metrics['run_id'])}</title>
<style>
:root {{
  --bg:#0A1418; --panel:#10202A; --panel-2:#0D1A22; --ink:#E8F1F4; --muted:#7C97A6;
  --hair:#1D3440; --accent:{color};
}}
* {{ box-sizing:border-box; margin:0; }}
body {{ background:var(--bg); color:var(--ink); font:15px/1.55 ui-monospace,"SF Mono","Cascadia Code",Consolas,Menlo,monospace;
       padding:32px 20px 64px; }}
.wrap {{ max-width:920px; margin:0 auto; display:grid; gap:18px; }}
.masthead {{ display:flex; align-items:baseline; gap:14px; flex-wrap:wrap;
  border-bottom:1px solid var(--hair); padding-bottom:14px; }}
.masthead .brand {{ font-family:Georgia,"Times New Roman",serif; font-variant:small-caps;
  letter-spacing:.22em; font-size:20px; }}
.masthead .bench {{ color:var(--muted); }}
.badge {{ margin-left:auto; border:1px solid var(--accent); color:var(--accent);
  padding:3px 12px; letter-spacing:.18em; font-size:12px; }}
.badge-note {{ color:var(--muted); font-size:12.5px; }}
.hero {{ display:grid; grid-template-columns:250px 1fr; gap:18px; }}
.panel {{ background:var(--panel); border:1px solid var(--hair); padding:20px; }}
.panel h2 {{ font-size:12px; letter-spacing:.2em; text-transform:uppercase;
  color:var(--muted); margin-bottom:14px; font-weight:600; }}
.dial {{ width:100%; display:block; }}
.dial-num {{ fill:var(--ink); font:600 40px ui-monospace,Consolas,monospace; text-anchor:middle; }}
.dial-pct {{ font-size:20px; fill:var(--muted); }}
.dial-metric {{ fill:var(--accent); font-size:12px; letter-spacing:.14em; text-anchor:middle; text-transform:uppercase; }}
.dial-ci {{ fill:var(--muted); font-size:10.5px; text-anchor:middle; }}
.facts {{ display:grid; grid-template-columns:1fr 1fr; gap:0 18px; align-content:start; }}
.fact {{ border-bottom:1px dashed var(--hair); padding:9px 0; }}
.fact b {{ display:block; color:var(--muted); font-size:11px; letter-spacing:.14em;
  text-transform:uppercase; font-weight:600; }}
.bar-row {{ display:grid; grid-template-columns:220px 1fr 130px; gap:12px; align-items:center;
  padding:5px 0; }}
.bar-label {{ color:var(--ink); font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
.bar-track {{ position:relative; height:10px; background:var(--panel-2); border:1px solid var(--hair); }}
.bar-fill {{ position:absolute; inset:0 auto 0 0; background:var(--accent); opacity:.85; }}
.bar-ci {{ position:absolute; top:-3px; height:16px; border-left:1px solid var(--ink);
  border-right:1px solid var(--ink); opacity:.5; }}
.bar-val {{ text-align:right; font-size:13px; }}
.bar-n {{ color:var(--muted); font-size:11px; }}
table {{ width:100%; border-collapse:collapse; font-size:13.5px; }}
th {{ text-align:left; color:var(--muted); font-weight:600; padding:7px 14px 7px 0;
  white-space:nowrap; vertical-align:top; border-bottom:1px solid var(--hair); width:200px; }}
td {{ padding:7px 0; border-bottom:1px solid var(--hair); word-break:break-word; }}
.note {{ color:#E8B04B; font-size:13px; margin-top:6px; }}
code {{ background:var(--panel-2); border:1px solid var(--hair); padding:10px 12px;
  display:block; font-size:12.5px; overflow-x:auto; color:var(--muted); }}
footer {{ color:var(--muted); font-size:12px; text-align:center; }}
@media (max-width:720px) {{ .hero {{ grid-template-columns:1fr; }}
  .facts {{ grid-template-columns:1fr; }}
  .bar-row {{ grid-template-columns:1fr; gap:4px; }} .bar-val {{ text-align:left; }} }}
@media (prefers-reduced-motion:no-preference) {{
  .bar-fill {{ transition:width .5s ease; }} }}
</style></head><body><div class="wrap">
<header class="masthead">
  <span class="brand">AQEval</span>
  <span class="bench">{_e(metrics['benchmark']['name'])} · {_e(metrics['model']['name'])}</span>
  <span class="badge">{badge}</span>
</header>
<div class="badge-note">{_e(badge_note)}</div>
{notes}
<div class="hero">
  <section class="panel">{_dial(primary['mean'], primary['ci95'], metric, color)}</section>
  <section class="panel facts">
    <div class="fact"><b>{_e(metric)}</b>{primary['mean'] * 100:.2f}% ± {primary['stderr'] * 100:.2f}</div>
    <div class="fact"><b>Items scored</b>{primary['n']}</div>
    <div class="fact"><b>Errors</b>{metrics['errors']['count']} ({metrics['errors']['rate'] * 100:.2f}%)</div>
    <div class="fact"><b>Runtime</b>{metrics['runtime_s']} s</div>
    <div class="fact"><b>Benchmark version</b>{_e(metrics['benchmark']['version'])}</div>
    <div class="fact"><b>Adapter</b>{_e(metrics['model']['adapter_type'])}</div>
  </section>
</div>
{''.join(subscore_sections)}
<section class="panel"><h2>Run record</h2><table>{meta_rows}</table></section>
<section class="panel"><h2>Datasets</h2><table>{ds_rows}</table></section>
<section class="panel"><h2>Reproduce</h2><code>{repro}</code></section>
<footer>Generated by AQEval 1.0 · raw responses in records.jsonl · full manifest in manifest.json</footer>
</div></body></html>"""


def render_compare_html(runs: list[dict]) -> str:
    """Provider-agnostic comparison across metrics.json payloads."""
    benches = sorted({r["benchmark"]["name"] for r in runs})
    models = []
    for r in runs:
        label = r["model"]["name"]
        if label not in models:
            models.append(label)
    palette = ["#2FD6C3", "#E8B04B", "#7FA8E8", "#E86A5E", "#B48EE8", "#8CD17D"]
    color_of = {m: palette[i % len(palette)] for i, m in enumerate(models)}

    groups = []
    for b in benches:
        bars = []
        for r in runs:
            if r["benchmark"]["name"] != b:
                continue
            metric = r["scores"]["primary_metric"]
            agg = r["scores"][metric]
            label = r["model"]["name"]
            official = "" if r.get("official") else " ◈smoke"
            bars.append(f"""
<div class="bar-row">
  <div class="bar-label">{_e(label)}{official}</div>
  <div class="bar-track"><div class="bar-fill" style="width:{agg['mean'] * 100:.2f}%;background:{color_of[label]}"></div>
    <div class="bar-ci" style="left:{agg['ci95'][0] * 100:.2f}%;width:{max(agg['ci95'][1] - agg['ci95'][0], 0) * 100:.2f}%"></div></div>
  <div class="bar-val">{agg['mean'] * 100:.1f}%<span class="bar-n"> {_e(metric)} · n={agg['n']}</span></div>
</div>""")
        groups.append(f'<section class="panel"><h2>{_e(b)}</h2>{"".join(bars)}</section>')

    head_rows = "".join(
        f"<tr><td>{_e(r['benchmark']['name'])}</td><td>{_e(r['model']['name'])}</td>"
        f"<td>{_e(r['scores']['primary_metric'])}</td>"
        f"<td>{r['scores'][r['scores']['primary_metric']]['mean'] * 100:.2f}%</td>"
        f"<td>{'yes' if r.get('official') else 'no'}</td><td>{_e(r['run_id'])}</td></tr>"
        for r in runs)

    style = render_run_html.__doc__ and ""  # noqa: F841 — style inlined below
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AQEval · comparison</title>
<style>
:root {{ --bg:#0A1418; --panel:#10202A; --panel-2:#0D1A22; --ink:#E8F1F4; --muted:#7C97A6; --hair:#1D3440; }}
* {{ box-sizing:border-box; margin:0; }}
body {{ background:var(--bg); color:var(--ink); font:15px/1.55 ui-monospace,"SF Mono",Consolas,Menlo,monospace; padding:32px 20px 64px; }}
.wrap {{ max-width:920px; margin:0 auto; display:grid; gap:18px; }}
.masthead {{ font-family:Georgia,serif; font-variant:small-caps; letter-spacing:.22em; font-size:20px;
  border-bottom:1px solid var(--hair); padding-bottom:14px; }}
.panel {{ background:var(--panel); border:1px solid var(--hair); padding:20px; }}
.panel h2 {{ font-size:12px; letter-spacing:.2em; text-transform:uppercase; color:var(--muted); margin-bottom:14px; }}
.bar-row {{ display:grid; grid-template-columns:220px 1fr 190px; gap:12px; align-items:center; padding:5px 0; }}
.bar-track {{ position:relative; height:10px; background:var(--panel-2); border:1px solid var(--hair); }}
.bar-fill {{ position:absolute; inset:0 auto 0 0; }}
.bar-ci {{ position:absolute; top:-3px; height:16px; border-left:1px solid var(--ink); border-right:1px solid var(--ink); opacity:.5; }}
.bar-val {{ text-align:right; font-size:13px; }} .bar-n {{ color:var(--muted); font-size:11px; }}
table {{ width:100%; border-collapse:collapse; font-size:13px; }}
td, th {{ padding:6px 10px 6px 0; border-bottom:1px solid var(--hair); text-align:left; }}
th {{ color:var(--muted); }}
@media (max-width:720px) {{ .bar-row {{ grid-template-columns:1fr; gap:4px; }} .bar-val {{ text-align:left; }} }}
</style></head><body><div class="wrap">
<header class="masthead">AQEval · Comparison</header>
{''.join(groups)}
<section class="panel"><h2>All runs</h2><table>
<tr><th>benchmark</th><th>system</th><th>metric</th><th>score</th><th>official</th><th>run</th></tr>
{head_rows}</table></section>
<footer style="color:var(--muted);font-size:12px;text-align:center">Smoke runs shown for context only — compare official runs.</footer>
</div></body></html>"""


def compare_csv_rows(runs: list[dict]) -> list[list[str]]:
    rows = [["benchmark", "system", "adapter", "metric", "score", "stderr",
             "ci95_lo", "ci95_hi", "n", "official", "run_id", "date_utc"]]
    for r in runs:
        metric = r["scores"]["primary_metric"]
        a = r["scores"][metric]
        rows.append([r["benchmark"]["name"], r["model"]["name"],
                     r["model"]["adapter_type"], metric, a["mean"], a["stderr"],
                     a["ci95"][0], a["ci95"][1], a["n"],
                     r.get("official"), r["run_id"], r["date_utc"]])
    return rows


def load_metrics(paths) -> list[dict]:
    out = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            out.append(json.load(f))
    return out
