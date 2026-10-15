/**
 * E12 — eval-regression state as a metric (2026-10-04).
 *
 * `eval/gate.mjs` writes eval/out/gate-summary.json at the end of every run:
 * { ranAt, passed, compared, regressions:[suite…] }. /metrics exposes it so an
 * alert can fire on "the last gate failed" or "nobody has run the gate in a
 * week" — L14 enforced by monitoring, not only by CI. Missing file → null
 * (no data), never a fabricated pass.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATE_SUMMARY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval', 'out', 'gate-summary.json');

export function readEvalGateSummary(file = GATE_SUMMARY_PATH, now = Date.now()) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    const ran = Date.parse(s.ranAt);
    if (!Number.isFinite(ran)) return null;
    return {
      passed: s.passed === true,
      regressions: Array.isArray(s.regressions) ? s.regressions.length : 0,
      ageSeconds: Math.max(0, Math.round((now - ran) / 1000)),
    };
  } catch { return null; }
}
