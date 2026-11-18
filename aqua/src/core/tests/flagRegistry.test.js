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
const NON_PREFIXED_GATES = ['ARTIFACTS_ENABLED'];

/** Every .js / .cjs under src/, excluding tests — tests set flags, they do not define them.
 *  (.cjs since 2026-10-15: the shared provider key pool is CommonJS so the
 *  platform client can load it; a knob read there must be visible here.) */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'tests' && entry !== 'node_modules') sourceFiles(p, out);
    } else if (/\.c?js$/.test(entry) && !entry.endsWith('.test.js')) {
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
    // Behaviour gates without the AQUA_ prefix (2026-11-10): named explicitly, because
    // a generic process.env scan would pull in every platform setting.
    for (const n of NON_PREFIXED_GATES) if (text.includes(`process.env.${n}`)) found.add(n);
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

  test('the census is what it is — 36 gates, 42 settings, 73 read', () => {
    // Pinned as a NUMBER because the audit's figure was wrong and the wrong
    // figure survived into two reports. If this changes, someone added a flag
    // and should say so; if it changes without a registry edit, the tests above
    // fail first and this one explains why the total moved.
    // +1 gate (2026-10-06): AQUA_PROACTIVE — Phase 4 proactive interventions,
    // off until eval/suites/proactive-core is recorded (L14).
    // +1 gate (2026-10-11): AQUA_WORLD_CORE — the current-world section of the
    // answer context, ON by default (=off is the rollback).
    // +2 gates (2026-10-17): AQUA_CANONICAL_RELEVANCE_GATE (canonical lanes admit only claims
    // about the question) and AQUA_E6_COMPOUND_RETRY (re-ask for an uncovered change clause),
    // both ON by default with =off as the rollback.
    // +1 gate (2026-10-18): AQUA_E6_ACTOR_RETRY — re-ask for a named actor the first reading dropped, ON by default.
    // +1 gate (2026-10-20): AQUA_EPISODIC_RECALL — the user's own matching past messages in the answer context, ON by default.
    // +1 gate (2026-11-05): AQUA_MIND_RELEVANCE — question-aware cognitive-block selection, OFF by default since 2026-11-06.
    // +1 gate (2026-11-05): AQUA_ANSWER_SCAFFOLD_GUARD — reasoning stages kept out of the reply layout, ON by default.
    // +1 gate (2026-11-05): AQUA_SEMANTIC_RECALL — semantic episodic recall, OFF by default.
    // +1 gate (2026-11-05): AQUA_RECALL_FOLLOWUP_V2 — follow-up relevance v2, OFF by default.
    // +1 gate (2026-11-06): AQUA_PROPAGATION — change propagation, OFF by default (only "on" enables it).
    // +2 gates (2026-11-10, Sprint 1): AQUA_LOG_CONTENT (local-only content logging) and
    // ARTIFACTS_ENABLED (read since Day 5, unregistered because the scan only saw AQUA_ names).
    // +1 gate (2026-11-10, Sprint 3): AQUA_INFO_NEEDS — information-needs engine, OFF by default.
    // +1 gate (2026-11-11, Sprint 6): AQUA_HYBRID_CONTEXT — hybrid context (adds after the existing context), OFF by default.
    // +1 gate (2026-11-13, scalability Phase 2b): AQUA_STORE_PARTITIONS — per-owner partition persistence, OFF by default.
    // +1 gate (2026-11-14, scalability Phase 3): AQUA_POST_TURN_DURABLE — durable post-turn learning in workers, OFF by default.
    // +1 gate (2026-11-15, Phase 4B): AQUA_PENDING_CHARGES — pending-charge recovery, OFF by default.
    assert.equal(GATES.length, 54);   // +5 (2026-11-16, conversation recovery): AQUA_CONVERSATION_CONTEXT, AQUA_E8_PERSONAL_SCOPE, AQUA_STRICT_CONVERSATION_IDS, AQUA_CONVERSATION_TURN_LOCK, AQUA_REVIEW_REQUIRE_REASON
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
    // +2 settings (2026-10-12, P0): AQUA_MIRROR_ROLE and AQUA_MIRROR_LEASE_MS —
    // the single-writer lease of the Mongo mirror.
    // +3 settings (2026-10-15, key pools): AQUA_PROVIDER_MAX_KEYS_PER_MODEL,
    // AQUA_PROVIDER_MAX_KEY_ATTEMPTS (per-request key-rotation bounds) and
    // AQUA_PROVIDER_KEY_REJECT_TTL_MS (opt-in expiry of a rejected key).
    // +1 setting (2026-10-18): AQUA_S8_HISTORY (bounded | full | compare).
    // +3 settings (2026-11-11, Sprint 6): AQUA_HYBRID_MAX_TOKENS, AQUA_HYBRID_MAX_MS, AQUA_HYBRID_MAX_SENTENCES (hybrid budgets).
    assert.equal(SETTINGS.length, 71);   // +1 (2026-11-17, Connect Phase 1b): AQUA_CONNECTOR_KEY (secret)   // +3 (2026-11-16, conversation recovery): AQUA_LEDGER_REVISION_BASIS, AQUA_TURN_LOCK_WAIT_MS, AQUA_TURN_LOCK_STALE_MS   // +1 (2026-11-15, PWI Phase 1): AQUA_LOG_PSEUDONYM_KEY   // +2 (2026-11-15, Phase 4B): AQUA_GCS_BUCKET, AQUA_GCS_ENDPOINT   // +3 (2026-11-15, Phase 4B): AQUA_CHARGE_ABANDON_MS, AQUA_CHARGE_RECONCILE_INTERVAL_MS, AQUA_CHARGE_CRASH_AT   // +1 (2026-11-15, Phase 4B): AQUA_JOB_AGING_SECONDS   // +1 (2026-11-15, Phase 4A): AQUA_SHUTDOWN_BUDGET_MS   // +2 (2026-11-14, Phase 3): AQUA_JOB_HEARTBEAT_STALE_MS, AQUA_JOB_LOG   // +3 (2026-11-14, Phase 2c/3 prep): AQUA_ROLE, AQUA_SCHEDULER_LEASE_MS, AQUA_OBJECT_STORE   // +1 (2026-11-13, Phase 2b): AQUA_PARTITION_STORE_OWNERS   // +2 (2026-11-13, scalability Phase 2a): AQUA_PARTITION_CACHE_ENTRIES, AQUA_PARTITION_CACHE_BYTES   // +1 (2026-10-20): AQUA_RECALL_ALL_CHARS; +1 (2026-11-05): AQUA_EMBEDDING_API_KEY; +1 (2026-11-06): AQUA_PROPAGATION_CRASH_AT (test seam)
    // +1 (2026-10-18): AQUA_E6_ACTOR_RETRY. AQUA_S8_HISTORY is a setting-like rollback read in the repository (counted below).
    // +2 (2026-10-17): the two gates above; +2 (2026-10-20) AQUA_EPISODIC_RECALL, AQUA_RECALL_ALL_CHARS;
    // +3 (2026-11-05): AQUA_MIND_RELEVANCE, AQUA_ANSWER_SCAFFOLD_GUARD, AQUA_SEMANTIC_RECALL.
    assert.equal(readFromEnv().size, 125);   // +1 (2026-11-17, Connect Phase 1b): AQUA_CONNECTOR_KEY   // +8 (2026-11-16, conversation recovery): the 5 gates + 3 settings above   // +1 (2026-11-15, PWI Phase 1): AQUA_LOG_PSEUDONYM_KEY   // +2 (2026-11-15, Phase 4B): AQUA_GCS_BUCKET, AQUA_GCS_ENDPOINT   // +4 (2026-11-15, Phase 4B): AQUA_PENDING_CHARGES + 3 charge settings   // +1 (2026-11-15, Phase 4B): AQUA_JOB_AGING_SECONDS   // +1 (2026-11-15, Phase 4A): AQUA_SHUTDOWN_BUDGET_MS   // +3 (2026-11-14, Phase 3): AQUA_POST_TURN_DURABLE, AQUA_JOB_HEARTBEAT_STALE_MS, AQUA_JOB_LOG   // +3 (2026-11-14): AQUA_ROLE, AQUA_SCHEDULER_LEASE_MS, AQUA_OBJECT_STORE   // +1 (2026-11-13): AQUA_PARTITION_STORE_OWNERS   // +1 (2026-11-13): AQUA_STORE_PARTITIONS   // +2 (2026-11-13): AQUA_PARTITION_CACHE_ENTRIES, AQUA_PARTITION_CACHE_BYTES   // +1 (2026-11-12): AQUA_COST_AWARE_REVIEW   // +4 (Sprint 6): AQUA_HYBRID_CONTEXT, AQUA_HYBRID_MAX_TOKENS, AQUA_HYBRID_MAX_MS, AQUA_HYBRID_MAX_SENTENCES
      // +1 (Sprint 3): AQUA_INFO_NEEDS   // +2 (2026-11-10): AQUA_LOG_CONTENT, ARTIFACTS_ENABLED   // +1 (2026-11-05): AQUA_EMBEDDING_API_KEY (setting); +1 (2026-11-05): AQUA_RECALL_FOLLOWUP_V2; +2 (2026-11-06): AQUA_PROPAGATION, AQUA_PROPAGATION_CRASH_AT
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
    // AQUA_MIND_RELEVANCE left 2026-11-06: OFF by default until related-phrase matching exists (mindRelevanceDefault.test.js).
    // AQUA_ANSWER_SCAFFOLD_GUARD joined 2026-11-05 (scaffoldGuard.test.js); =off is the rollback.
    // AQUA_PROPAGATION (registered 2026-11-06) is deliberately NOT here: it was ON by default in
    // memory/propagation.js and is now OFF by default — only exactly "on" enables it.
    // AQUA_CIE and AQUA_GRAPH were ALWAYS on by default at their read sites; the registry said off
    // until 2026-11-10 (audit F-02; flagReadSiteParity.test.js now checks every gate against its
    // read site). ARTIFACTS_ENABLED was registered the same day.
    assert.deepEqual(onByDefault, ['AQUA_ANSWER_SCAFFOLD_GUARD', 'AQUA_BRAIN', 'AQUA_CANONICAL_RELEVANCE_GATE', 'AQUA_CIE', 'AQUA_CONVERSATION_CONTEXT', 'AQUA_CONVERSATION_TURN_LOCK', 'AQUA_COST_AWARE_REVIEW', 'AQUA_E6_ACTOR_RETRY', 'AQUA_E8_PERSONAL_SCOPE', 'AQUA_EMBEDDINGS', 'AQUA_EPISODIC_RECALL', 'AQUA_GRAPH', 'AQUA_PARSE_WORKER', 'AQUA_PIC', 'AQUA_PROACTIVE', 'AQUA_REVISION_VOICE', 'AQUA_STRICT_CONVERSATION_IDS', 'AQUA_WORLD_CORE', 'ARTIFACTS_ENABLED']);   // +4 ON by default (2026-11-16, conversation recovery)
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
    assert.match(line, /54 gates · 71 settings/);   // +1 setting (2026-11-17, Connect Phase 1b): AQUA_CONNECTOR_KEY   // +5 gates, +3 settings (2026-11-16, conversation recovery)   // +1 setting (2026-11-15, PWI Phase 1): AQUA_LOG_PSEUDONYM_KEY   // +1 gate (2026-11-13): AQUA_STORE_PARTITIONS   // +2 settings (2026-11-13): AQUA_PARTITION_CACHE_*   // +1 gate (2026-11-12): AQUA_COST_AWARE_REVIEW   // +1 gate, +3 settings (Sprint 6): AQUA_HYBRID_*   // +2 (2026-11-10): AQUA_LOG_CONTENT, ARTIFACTS_ENABLED   // +3 (2026-11-05): AQUA_MIND_RELEVANCE, AQUA_ANSWER_SCAFFOLD_GUARD, AQUA_SEMANTIC_RECALL
    assert.match(line, /AQUA_E6=on/);
    assert.ok(!line.includes('AQUA_TWIN_V2'), 'a default gate was listed — the line is noise');
  });
});
