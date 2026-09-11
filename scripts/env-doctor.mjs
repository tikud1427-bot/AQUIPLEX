#!/usr/bin/env node
/**
 * AQUA — deployment env linter
 * Blueprint L13 (no dark flags) · E4
 *
 *   node scripts/env-doctor.mjs              # lints ../.env
 *   node scripts/env-doctor.mjs path/to/.env
 *
 * 🔴 WHY THIS EXISTS: `AQUA_E6_SHADOW=on`.
 *
 * That line sat in production for months. Nothing in the codebase reads it —
 * the real gate is `AQUA_E6` — so the understanding pipeline had never run,
 * while the deployment said it was on and every report about E6's behaviour was
 * about a stage that was switched off. The flag name was invented in a
 * conversation and typed straight into an env file.
 *
 * The flag registry added in E4/PR-1 cannot catch this. It compares the
 * REGISTRY to the SOURCE, in both directions, and a variable set in `.env` and
 * read by nothing is absent from both — invisible to a test that only knows
 * about code. The gap is between the deployment and the registry, and only
 * something that reads the actual env file can stand in it.
 *
 * WHAT IT REFUSES
 *   · an `AQUA_*` key that no source file reads      (the AQUA_E6_SHADOW case)
 *   · a gate set to a value its read site never matches — `AQUA_E6=true` is
 *     OFF, because the read is `=== 'on'`, and nothing anywhere says so
 *   · the same key assigned twice, where the LAST one silently wins
 *
 * WHAT IT DOES NOT DO
 *   · validate credentials, formats or reachability. A previous session
 *     declared a set of live API keys invalid by pattern-matching their prefix
 *     and was wrong. Shape is not validity, and this tool does not guess.
 *   · warn about registered flags that are absent — absent means default, and
 *     defaults are the normal case.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATES, REGISTERED, flagReport } from '../src/core/flags.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parse a dotenv file into ordered entries — ORDERED, because a duplicate key
 * is one of the faults being looked for and a plain object would hide it by
 * keeping only the winner.
 */
export function parseEnvFile(text) {
  const out = [];
  for (const [i, line] of String(text).split(/\r?\n/).entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out.push({ key, value, line: i + 1 });
  }
  return out;
}

/**
 * Faults in a parsed env, worst first.
 *
 * Pure: takes entries, returns findings. The file reading and the exit code
 * live in main() so the judgement can be tested without a fixture on disk.
 */
export function lintEnv(entries) {
  const findings = [];
  const aqua = entries.filter(e => e.key.startsWith('AQUA_'));

  for (const e of aqua) {
    if (!REGISTERED.includes(e.key)) {
      findings.push({
        level: 'error', key: e.key, line: e.line,
        message: 'no source file reads this — it does nothing',
        hint: nearest(e.key),
      });
    }
  }

  // A gate whose value its read site will never match. `AQUA_E6=true` is off.
  const byKey = new Map(aqua.map(e => [e.key, e]));
  for (const f of flagReport(Object.fromEntries(aqua.map(e => [e.key, e.value])))) {
    if (!f.overridden) continue;
    const g = GATES.find(x => x.name === f.name);
    if (f.value === f.default) {
      findings.push({
        level: 'error', key: f.name, line: byKey.get(f.name)?.line ?? 0,
        message: `set to "${f.raw}" but resolves to ${f.value}, the default — the read is \`${g.reads}\``,
        hint: `the value that changes behaviour is ${g.dflt === 'on' ? 'off' : 'on'}`,
      });
    }
  }

  // Last assignment wins, silently.
  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.key)) {
      findings.push({
        level: 'warn', key: e.key, line: e.line,
        message: `assigned again — line ${seen.get(e.key)} is dead, this one wins`,
      });
    }
    seen.set(e.key, e.line);
  }

  return findings;
}

/** Closest registered name, for a typo. Cheap edit distance, good enough. */
function nearest(key) {
  let best = null; let bestD = Infinity;
  for (const r of REGISTERED) {
    const d = distance(key, r);
    if (d < bestD) { bestD = d; best = r; }
  }
  return bestD <= Math.max(3, Math.round(key.length * 0.35)) ? `did you mean ${best}?` : null;
}

function distance(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return m[a.length][b.length];
}

async function main() {
  const target = process.argv[2] ?? path.join(HERE, '..', '..', '.env');
  if (!existsSync(target)) {
    console.error(`\n✗ no env file at ${target}`);
    console.error('  Pass a path: node scripts/env-doctor.mjs path/to/.env\n');
    process.exit(1);
  }

  const entries = parseEnvFile(readFileSync(target, 'utf8'));
  const findings = lintEnv(entries);
  const aqua = entries.filter(e => e.key.startsWith('AQUA_')).length;

  console.log(`\nENV DOCTOR · ${target}`);
  console.log(`  ${entries.length} assignments · ${aqua} AQUA_* · ${REGISTERED.length} registered\n`);

  if (!findings.length) {
    console.log('  ✓ every AQUA_* key is read by the code and set to a value that reaches it\n');
    process.exit(0);
  }

  for (const f of findings.filter(x => x.level === 'error')) {
    console.log(`  ✗ line ${f.line}  ${f.key}`);
    console.log(`      ${f.message}`);
    if (f.hint) console.log(`      ${f.hint}`);
  }
  for (const f of findings.filter(x => x.level === 'warn')) {
    console.log(`  ⚠ line ${f.line}  ${f.key} — ${f.message}`);
  }

  const errors = findings.filter(x => x.level === 'error').length;
  console.log(`\n  ${errors} error(s), ${findings.length - errors} warning(s)`);
  console.log('  A flag the code never reads is a deployment saying something that is not true.\n');
  process.exit(errors ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('env-doctor.mjs')) {
  await main();
}
