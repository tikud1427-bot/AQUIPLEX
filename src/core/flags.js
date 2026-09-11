/**
 * AQUA — Flag & setting registry
 * Blueprint L13 (no dark flags) · G5 (observable) · E4
 *
 * WHAT THIS IS FOR
 * ----------------
 * A flag that changes behaviour and is not reported anywhere is a branch in
 * production nobody can see. Boot reported 11; the code reads 42. The other 31
 * were decided at import time by an environment variable, and the only way to
 * learn which way they went was to read the source and guess at the deploy.
 *
 * 🔴 A CORRECTION TO THE AUDIT, WHICH THIS FILE EXISTS TO MAKE PERMANENT.
 *
 * The audit reported "56 AQUA_* flags, 11 reported" and the Phase 0 inspection
 * repeated it at 57. Both were produced by grepping for `AQUA_[A-Z_]+` across
 * `src/`, and that pattern does not match flags. It matches:
 *
 *   · LOG EVENT LABELS — `AQUA_REQUEST`, `AQUA_MEMORY`, `AQUA_PLAN`,
 *     `AQUA_SEARCH`, `AQUA_COGNITION`, `AQUA_INTELLIGENCE`, `AQUA_ORCHESTRATOR`,
 *     `AQUA_VERIFICATION` are `type:` fields in observability.js. Eight of them.
 *   · MARKDOWN FILENAMES — `AQUA_INDEXED_NOT_SCAN.md`, `AQUA_PARSE_ISOLATION.md`,
 *     `AQUA_DEPENDENCY_SAFETY.md`, `AQUA_PHASE6_NOTES.md` cited in comments.
 *   · A FLAG THAT DOES NOT EXIST — `AQUA_EXTRACT_V2` is named in two headers as
 *     the flag a capability WILL ship behind. Nothing reads it.
 *
 * So the real figure is 42 read, 11 reported, 31 dark — a third smaller than the
 * headline, and still an L13 violation. The reason to write this down rather
 * than quietly use the better number: a count that overstates the problem gets
 * corrected the moment someone tries to fix it, and then the whole audit reads
 * as unreliable. It was one bad regex, and the finding underneath it is real.
 *
 * THE REGISTRY IS NOT THE COMPLETENESS TEST.
 * A hand-maintained list of flags rots exactly like a hand-maintained list of
 * test files. `flagRegistry.test.js` derives the truth from the source — every
 * name read from `process.env` must appear here, and every name here must be
 * read somewhere. Both directions, because a registry with stale entries lies
 * as confidently as one with missing entries.
 *
 * GATES vs SETTINGS. A gate changes which code path runs and belongs in the
 * boot report. A setting tunes a path that runs either way — a timeout, a model
 * name, a directory. Reporting all 42 on every boot would bury the 26 that
 * matter under 16 that do not.
 */

/** How a gate reads its variable. Recorded because they are NOT uniform. */
const ON = "=== 'on'";
const ONE = "=== '1'";

/**
 * Behaviour gates — these decide which code path runs.
 *
 * `dflt` is what the branch does with the variable UNSET, verified against the
 * read site rather than assumed. Three of these are on-by-default and two are
 * inverted (the variable turns something OFF), which is precisely the kind of
 * thing a reader guesses wrong.
 */
export const GATES = Object.freeze([
  { name: 'AQUA_BRAIN', subsystem: 'brain', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'master kill switch — ON by default, set to off to disable' },
  { name: 'AQUA_BRAIN_INGEST', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_BRAIN_INGEST_FACTS', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_CANONICAL_IDS', subsystem: 'identity', dflt: 'off', reads: ON },
  { name: 'AQUA_CIE', subsystem: 'cognition', dflt: 'off', reads: ON },
  { name: 'AQUA_CLAIM_STRICT_PREDICATES', subsystem: 'claims', dflt: 'off', reads: ONE },
  { name: 'AQUA_CLAIMS_SHADOW', subsystem: 'claims', dflt: 'off', reads: ON,
    note: 'E5/PR-5 — degrades to off with a stated reason when DATABASE_URL is absent' },
  { name: 'AQUA_CONSOLIDATE', subsystem: 'pic', dflt: 'off', reads: ON },
  { name: 'AQUA_CONTEXT_V2', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_CORRECTION_PHRASES', subsystem: 'memory', dflt: 'off', reads: ON },
  { name: 'AQUA_DISABLE_MONGO_MIRROR', subsystem: 'store', dflt: 'off', reads: ONE, inverted: true,
    note: 'set to 1 to DISABLE the mirror — the variable turns something off' },
  { name: 'AQUA_E6', subsystem: 'brain', dflt: 'off', reads: ON,
    note: 'understanding pipeline; fails its own negation gate at 85/95' },
  { name: 'AQUA_EMBEDDINGS', subsystem: 'embeddings', dflt: 'on', reads: "=== 'off'", inverted: true,
    note: 'ON by default — set to off to disable' },
  { name: 'AQUA_GRAPH', subsystem: 'orchestrator', dflt: 'off', reads: ON,
    note: 'gates POST /chat graph path AND POST /intelligence/orchestrate' },
  { name: 'AQUA_GRAPH_STRICT_TYPES', subsystem: 'reasoning', dflt: 'off', reads: ONE },
  { name: 'AQUA_MIND_VIEW', subsystem: 'mind', dflt: 'off', reads: ONE },
  { name: 'AQUA_PARSE_WORKER', subsystem: 'upload', dflt: 'on', reads: "!== 'off'", inverted: true,
    note: 'ON by default' },
  { name: 'AQUA_PIC', subsystem: 'pic', dflt: 'on', reads: "!== 'off'", inverted: true, note: 'ON by default' },
  { name: 'AQUA_PROVIDER_LOG', subsystem: 'providers', dflt: 'off', reads: "=== 'debug'" },
  { name: 'AQUA_REFLECT_V2', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_REL_EVOLVE', subsystem: 'reasoning', dflt: 'off', reads: ON },
  { name: 'AQUA_REVISION_VOICE', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_SELF_ENTITY', subsystem: 'identity', dflt: 'off', reads: ON,
    note: 'decides whether E6/S6 can resolve first person at all' },
  { name: 'AQUA_STORE_PG', subsystem: 'store', dflt: 'off', reads: "=== 'shadow'" },
  { name: 'AQUA_STORE_PG_READ', subsystem: 'store', dflt: 'off', reads: ON },
  { name: 'AQUA_TWIN_V2', subsystem: 'brain', dflt: 'off', reads: ON },
  { name: 'AQUA_UUS', subsystem: 'uus', dflt: 'off', reads: ON },
]);

/** Settings — values that tune a path which runs either way. */
export const SETTINGS = Object.freeze([
  { name: 'AQUA_ARTIFACTS_DIR', subsystem: 'artifacts' },
  { name: 'AQUA_CONSOLIDATE_EVERY', subsystem: 'pic' },
  { name: 'AQUA_DATA_DIR', subsystem: 'store', note: 'eval isolation depends on this' },
  { name: 'AQUA_E6_MODEL', subsystem: 'brain' },
  { name: 'AQUA_E6_PROVIDER', subsystem: 'brain' },
  { name: 'AQUA_EMBED_DIM', subsystem: 'embeddings' },
  { name: 'AQUA_EMBED_MODEL', subsystem: 'embeddings' },
  { name: 'AQUA_MIRROR_CHUNK_BYTES', subsystem: 'store' },
  { name: 'AQUA_MIRROR_RETRY_BASE_MS', subsystem: 'store' },
  { name: 'AQUA_MIRROR_RETRY_CAP_MS', subsystem: 'store' },
  { name: 'AQUA_MIRROR_STALE_FAILS', subsystem: 'store' },
  { name: 'AQUA_MIRROR_STALE_MS', subsystem: 'store' },
  { name: 'AQUA_PROVIDER_BACKOFF_CAP_MS', subsystem: 'providers' },
  { name: 'AQUA_PROVIDER_BACKOFF_MS', subsystem: 'providers' },
  { name: 'AQUA_PROVIDER_MAX_ROUNDS', subsystem: 'providers' },
  { name: 'AQUA_PROVIDER_RETRY_BUDGET_MS', subsystem: 'providers' },
]);

/** Every registered name, gates and settings alike. */
export const REGISTERED = Object.freeze(
  [...GATES, ...SETTINGS].map(f => f.name).sort(),
);

/**
 * Current state of every gate.
 *
 * Takes an env object rather than always reading `process.env`, because the
 * first version of the default-check test deleted all 27 variables globally to
 * see what unset resolved to. Node's test runner executes files concurrently
 * and `testCoverage.test.js` spawns the runner as a subprocess — which inherited
 * the mutated environment mid-deletion and discovered 26 fewer test files. The
 * full battery failed somewhere unrelated to either test. A pure parameter
 * removes the shared mutable state instead of sequencing around it.
 *
 * Reports the RAW value alongside the resolved one. "off" because the variable
 * is unset and "off" because someone typed `AQUA_E6=false` are the same boot
 * line and very different mistakes, and the second is invisible without the raw
 * value — every gate here matches an exact string, so `false`, `true`, `yes`
 * and `1` all silently mean off for most of them.
 */
export function flagReport(env = process.env) {
  return GATES.map(g => {
    const raw = env[g.name];
    const set = raw !== undefined && raw !== '';
    return {
      name: g.name,
      subsystem: g.subsystem,
      value: resolveGate(g, raw),
      default: g.dflt,
      raw: set ? raw : null,
      overridden: set,
    };
  });
}

/** Resolve one gate the way its own read site does. */
function resolveGate(g, raw) {
  const v = String(raw ?? '').toLowerCase();
  switch (g.reads) {
    case ON: return v === 'on' ? 'on' : 'off';
    case ONE: return v === '1' ? 'on' : 'off';
    case "=== 'debug'": return v === 'debug' ? 'on' : 'off';
    case "=== 'shadow'": return v === 'shadow' ? 'shadow' : 'off';
    case "=== 'off'": return v === 'off' ? 'off' : 'on';   // inverted, on by default
    case "!== 'off'": return v === 'off' ? 'off' : 'on';   // inverted, on by default
    default: return 'off';
  }
}

/**
 * One boot line. Gates only, and the non-default ones named explicitly.
 *
 * Listing 26 gates on every boot is the same failure as listing none: nobody
 * reads it. What matters is which ones differ from the default, because that is
 * the deploy's actual configuration and the thing an incident starts from.
 */
export function flagBootLine(env = process.env) {
  const report = flagReport(env);
  const changed = report.filter(f => f.overridden);
  const suffix = changed.length
    ? changed.map(f => `${f.name}=${f.value}`).join(' ')
    : '(all default)';
  return `[FLAGS] ${GATES.length} gates · ${SETTINGS.length} settings · ${changed.length} overridden — ${suffix}`;
}
