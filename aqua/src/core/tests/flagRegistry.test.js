/**
 * The flag registry is COMPLETE, and completeness is derived — not listed
 * Blueprint L13 · E4
 *
 * A registry maintained by hand rots the same way a hand-maintained list of
 * test files rots: the next person adds a flag, does not know this file exists,
 * and the registry silently stops describing the system. That failure is
 * indistinguishable from having no registry, except that it looks reassuring.
 *
 * So the test does not compare against a list. It reads the source, extracts
 * every name actually taken from `process.env`, and requires the two sets to
 * match EXACTLY — both directions. Missing entries are dark flags; extra
 * entries are a registry describing code that no longer exists, which is how a
 * boot report ends up confidently reporting a branch that was deleted.
 *
 * BITE, MEASURED (revert the named property → count failures):
 *   a real flag removed from the registry  → 1 fail
 *   a dead flag left in the registry       → 1 fail
 *   a wrong default recorded               → 1 fail
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATES, SETTINGS, REGISTERED, flagReport, flagBootLine } from '../flags.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');
const ROUTER = path.resolve(SRC, '../router.js');
// The platform's rate-limit store reads an AQUA_ setting too (2026-10-04).
const PLATFORM_FILES = [path.resolve(SRC, '../../utils/rateLimitStore.js')];
// The World-Model Lift adapter reads its AQUA_LIFT_* settings outside src/
// (2026-10). Registered so env-doctor accepts them in a .env.
const EVAL_FILES = [path.resolve(SRC, '../eval/adapters/pairedAnswerLift.mjs')];

/** Every .js under src/, excluding tests — tests set flags, they do not define them. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'tests' && entry !== 'node_modules') sourceFiles(p, out);
    } else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Names actually READ from the environment.
 *
 * Two patterns, because the codebase uses two. `process.env.X` is the common
 * one; `envInt('X', default)` in providers/router.js is the other, and a grep
 * for only the first misses four provider timeouts entirely — which is how a
 * flag census goes wrong in the first place.
 *
 * Deliberately NOT `AQUA_[A-Z_]+`. That pattern is what produced the audit's
 * "56 flags": it matches log event labels (`type: 'AQUA_REQUEST'`), markdown
 * filenames cited in comments (`AQUA_DEPENDENCY_SAFETY.md`), and at least one
 * flag that is only ever DISCUSSED (`AQUA_EXTRACT_V2`, named in two headers,
 * read by nothing).
 */
function readFromEnv() {
  const found = new Set();
  const files = [...sourceFiles(SRC), ROUTER, ...PLATFORM_FILES, ...EVAL_FILES];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/process\.env\.(AQUA_[A-Z0-9_]+)/g)) found.add(m[1]);
    for (const m of text.matchAll(/process\.env\[['"](AQUA_[A-Z0-9_]+)['"]\]/g)) found.add(m[1]);
    for (const m of text.matchAll(/env[A-Za-z]*\(\s*['"](AQUA_[A-Z0-9_]+)['"]/g)) found.add(m[1]);
    // An injectable env object (`env = process.env`) read as env.AQUA_X — the
    // telemetry/rate-limit adapters take one so tests need not mutate process.env.
    for (const m of text.matchAll(/\benv\.(AQUA_[A-Z0-9_]+)/g)) found.add(m[1]);
  }
  return found;
}

describe('the flag registry matches the source, in both directions', () => {
  test('EVERY flag the code reads is registered — no dark flags (L13)', () => {
    const missing = [...readFromEnv()].filter(n => !REGISTERED.includes(n)).sort();
    assert.deepEqual(missing, [],
      `unregistered flags decide behaviour invisibly: ${missing.join(', ')}`);
  });

  test('EVERY registered flag is actually read — no stale entries', () => {
    // The direction people forget. A registry entry for a deleted branch makes
    // the boot report describe a system that does not exist.
    const read = readFromEnv();
    const dead = REGISTERED.filter(n => !read.has(n));
    assert.deepEqual(dead, [],
      `registered but never read: ${dead.join(', ')}`);
  });

  test('gates and settings are disjoint, and nothing is registered twice', () => {
    const names = [...GATES, ...SETTINGS].map(f => f.name);
    assert.equal(new Set(names).size, names.length, 'a flag is registered twice');
  });

  test('the census is what it is — 32 gates, 39 settings, 71 read', () => {
    // Pinned as a NUMBER because the audit's figure was wrong and the wrong
    // figure survived into two reports. If this changes, someone added a flag
    // and should say so; if it changes without a registry edit, the tests above
    // fail first and this one explains why the total moved.
    // +1 gate (2026-10-06): AQUA_PROACTIVE — Phase 4 proactive interventions,
    // off until eval/suites/proactive-core is recorded (L14).
    // +1 gate (2026-10-11): AQUA_WORLD_CORE — the current-world section of the
    // answer context, ON by default (=off is the rollback).
    assert.equal(GATES.length, 32);
    // +2 settings, 0 gates (Sep 30): AQUA_E6_MINT and AQUA_E6_SINGLE_VALUED. Both
    // are SETTINGS because neither opens a subsystem — they tune one stage of an
    // already-gated one.
    // +4 settings (2026-10-04): the error webhook URL/token and the shared
    // rate-limit Redis URL (env-activated E12 backends), and AQUA_TEST_DATABASE_URL —
    // read since 10-03 through an injected env object, which the scan did not see
    // until it learned the `env.AQUA_X` pattern.
    // +1 setting (2026-10-04): AQUA_CONSOLIDATION_INTERVAL_MS, the J3 scheduler interval.
    // +4 settings (2026-10, NVIDIA provider): AQUA_PROVIDER_PREFER (router
    // ranking override for controlled rollout) and the three eval-only
    // AQUA_LIFT_* settings, which were read but unregistered before.
    // +1 setting (2026-10-05): AQUA_METRICS_TOKEN, the bearer token of the
    // Prometheus machine scrape (routes/metricsScrape.js).
    // +1 setting (2026-10-06): AQUA_PROACTIVE_INTERVAL_MS, the worker's periodic
    // proactive scan interval.
    assert.equal(SETTINGS.length, 39);
    assert.equal(readFromEnv().size, 71);
  });
});

describe('the registry records how each gate actually reads its variable', () => {
  test('a recorded default matches what the read site does with the variable unset', () => {
    // Four gates are ON by default and several read something other than 'on'.
    // Getting one wrong turns the boot report into confident misinformation.
    //
    // An EMPTY env object, not a deleted process.env. The first version cleared
    // all 27 variables globally; node runs test files concurrently, and the
    // suite that spawns the runner as a subprocess inherited that env mid-
    // deletion and reported 26 test files missing. The battery failed in a file
    // neither test touches.
    for (const f of flagReport({})) {
      const g = GATES.find(x => x.name === f.name);
      assert.equal(f.value, g.dflt, `${f.name}: registry says ${g.dflt}, resolves to ${f.value} unset`);
    }
  });

  test('the ON-by-default gates are named, because they are the surprising ones', () => {
    const onByDefault = GATES.filter(g => g.dflt === 'on').map(g => g.name).sort();
    // AQUA_REVISION_VOICE joined 2026-10-04 after its L14 eval (revision-voice suite);
    // the legacy-ledger voice it can also run stays opt-in (=on).
    // AQUA_PROACTIVE joined 2026-10-06 after its L14 eval (proactive-core suite,
    // baseline recorded) and the live production-path test.
    // AQUA_WORLD_CORE joined 2026-10-11: measured on the World-Model Lift (held-out v3).
    assert.deepEqual(onByDefault, ['AQUA_BRAIN', 'AQUA_EMBEDDINGS', 'AQUA_PARSE_WORKER', 'AQUA_PIC', 'AQUA_PROACTIVE', 'AQUA_REVISION_VOICE', 'AQUA_WORLD_CORE']);
  });

  test('an overridden gate reports its RAW value, not just the resolved one', () => {
    // `AQUA_E6=true` is off. So is `AQUA_E6=1`, and `AQUA_E6=yes`. Every gate
    // matches an exact string, so a plausible-looking value silently means off
    // and the resolved value alone cannot show that.
    const e6 = flagReport({ AQUA_E6: 'true' }).find(f => f.name === 'AQUA_E6');
    assert.equal(e6.value, 'off', 'AQUA_E6=true reads as ON — the resolver disagrees with the read site');
    assert.equal(e6.raw, 'true');
    assert.equal(e6.overridden, true);
  });
});

describe('the boot line is worth printing', () => {
  test('it names the overridden gates, not all 29', () => {
    const line = flagBootLine({ AQUA_E6: 'on' });
    assert.match(line, /32 gates · 39 settings/);
    assert.match(line, /AQUA_E6=on/);
    assert.ok(!line.includes('AQUA_TWIN_V2'), 'a default gate was listed — the line is noise');
  });
});
