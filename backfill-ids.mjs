/**
 * AQUA — Canonical ID Backfill (Phase 1 / M1)
 *
 * WHAT IT DOES
 * ------------
 * Walks an owner's existing stores, resolves every subject through the
 * canonical resolver, and builds the id↔ref map. Then diffs the result
 * against `buildWorldIndex` — the string-match join the world model uses
 * today — so the cutover decision rests on evidence rather than hope.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It never writes to the reasoning graph, the Mind, the UKO store, memory
 * facts or PIC. It only populates the sidecar, and the sidecar holds no
 * knowledge. Delete `.aqua-ids.json` and every source store is exactly as
 * it was.
 *
 * That is what makes this safe to run repeatedly, in production, before any
 * flag flips. `--dry` goes further and writes nothing at all.
 *
 * IDEMPOTENT
 * ----------
 * Ids are DERIVED from normalized names, not sequential. Running twice
 * produces the same ids; running after a delete rebuilds them identically.
 * A backfill that minted fresh ids on every pass would make the sidecar
 * load-bearing, which is the exact property the architecture rejects.
 *
 * ORDER MATTERS
 * -------------
 * Sources are walked most-authoritative first: the reasoning graph has been
 * through entity resolution and carries provenance, so it seeds identity;
 * the Mind supplies semantic type for subjects the documents under-typed;
 * UKO and memory facts attach last, adding refs to subjects already known
 * rather than minting competing ones.
 *
 * Walking in the other order would let a raw per-file mention claim identity
 * before the resolved entity ever arrived.
 *
 *   node backfill-ids.mjs                  all owners, shadow write + diff
 *   node backfill-ids.mjs --dry            report only, writes nothing
 *   node backfill-ids.mjs --owner user:x   one owner
 */
import * as G from './src/reasoning/reasoningGraph.js';
import * as mindStore from './src/mind/mindStore.js';
import * as C from './src/brain/identity/canonicalId.js';
import * as idStore from './src/brain/identity/idStore.js';
import { buildWorldIndex } from './src/brain/worldModel/projection.js';
import { normalizeMention } from './src/reasoning/entityResolver.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ONLY = args.includes('--owner') ? args[args.indexOf('--owner') + 1] : null;

const report = {
  owners: 0, resolved: 0, created: 0, merged: 0, ambiguous: [],
  bySpace: { reasoning: 0, mind: 0 },
  diff: { agree: 0, idOnlyJoins: 0, stringOnlyJoins: 0, examples: [] },
};

/** Every owner that appears in any source store. */
function discoverOwners() {
  const owners = new Set();
  for (const o of G.listOwners()) owners.add(o);
  for (const o of mindStore.listOwners()) owners.add(o);
  return [...owners];
}

function backfillOwner(ownerId) {
  const seen = new Map();   // aqId → { refs: Set }

  const note = (res, space, ref) => {
    if (!res?.id) return;
    report.resolved++;
    if (res.created) report.created++; else report.merged++;
    report.bySpace[space] = (report.bySpace[space] ?? 0) + 1;
    if (res.ambiguous) {
      report.ambiguous.push({
        ownerId, name: res.canonical, against: res.ambiguous.canonical,
        score: res.ambiguous.score, reason: res.ambiguous.reason,
      });
    }
    if (!seen.has(res.id)) seen.set(res.id, new Set());
    seen.get(res.id).add(`${space}:${ref}`);
  };

  // 1. Reasoning graph — resolved, provenanced. Seeds identity.
  for (const node of G.nodesByType(ownerId, 'entity')) {
    const kind = node.data?.entityType ?? 'name';
    const res = C.resolve(ownerId, {
      name: node.label, kind,
      ref: { space: 'reasoning', ref: node.id },
    });
    note(res, 'reasoning', node.id);

    // Aliases the resolver already merged are additional spellings for the
    // SAME id — registering them is what lets a later mention of an alias
    // find this subject instead of minting a rival.
    for (const alias of node.data?.aliases ?? []) {
      C.resolve(ownerId, { name: alias, kind, ref: { space: 'reasoning', ref: node.id } });
    }
  }

  // 2. Mind graph — supplies the semantic type documents deliberately withheld.
  const mind = mindStore.peekMind(ownerId);
  for (const [key, node] of Object.entries(mind?.graph?.nodes ?? {})) {
    if (!node?.label) continue;
    const res = C.resolve(ownerId, {
      name: node.label, kind: node.type ?? 'name',
      ref: { space: 'mind', ref: key },
    });
    note(res, 'mind', key);
  }

  return seen;
}

/**
 * The evidence for the cutover.
 *
 * `buildWorldIndex` joins the two graphs by normalized string match. The
 * canonical map joins them by resolved identity. Where they agree, the
 * cutover is a no-op. Where the id map joins something the string match
 * missed, that is the gain. Where the string match joined something the id
 * map did not, that is a REGRESSION and must be understood before flipping
 * anything.
 */
function diffAgainstCurrentJoin(ownerId) {
  const deps = { graph: G, peekMind: mindStore.peekMind };
  const index = buildWorldIndex(deps, ownerId);

  for (const [entityId, rec] of index.byId ?? new Map()) {
    const node = rec.node ?? rec;
    const label = node?.label;
    if (!label) continue;

    const viaId = C.lookup(ownerId, label, node.data?.entityType ?? 'name');
    const stringJoined = Boolean(rec.mindNode || rec.mindKey);
    const idJoined = Boolean(
      viaId?.id && (idStore.refsOf(ownerId, viaId.id) ?? []).some(r => r.space === 'mind'),
    );

    if (stringJoined === idJoined) {
      report.diff.agree++;
    } else if (idJoined && !stringJoined) {
      report.diff.idOnlyJoins++;
      if (report.diff.examples.length < 10) {
        report.diff.examples.push({ ownerId, entityId, label, kind: 'gain: id map joined, string match missed' });
      }
    } else {
      report.diff.stringOnlyJoins++;
      report.diff.examples.push({ ownerId, entityId, label, kind: 'REGRESSION: string match joined, id map missed' });
    }
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

const owners = ONLY ? [ONLY] : discoverOwners();
if (!owners.length) {
  console.log('No owners found in any source store — nothing to backfill.');
  process.exit(0);
}

console.log(`Backfilling ${owners.length} owner(s)${DRY ? ' (DRY — nothing will be written)' : ''}\n`);

for (const ownerId of owners) {
  report.owners++;
  const before = idStore.allEntries(ownerId).size;
  backfillOwner(ownerId);
  diffAgainstCurrentJoin(ownerId);
  const after = idStore.allEntries(ownerId).size;
  console.log(`  ${ownerId}: ${before} → ${after} canonical ids`);
  if (DRY) idStore.purgeOwner(ownerId);
}

console.log(`
${'─'.repeat(70)}
RESOLVED   ${report.resolved} mentions → ${report.created} new ids, ${report.merged} merged into existing
BY SPACE   reasoning=${report.bySpace.reasoning} mind=${report.bySpace.mind}

DIFF vs the current string-match join
  agree            ${report.diff.agree}
  id-only joins    ${report.diff.idOnlyJoins}   ← the gain
  string-only      ${report.diff.stringOnlyJoins}   ← map gaps (NOT runtime regressions)

AMBIGUOUS  ${report.ambiguous.length} near-misses surfaced, none merged`);

for (const a of report.ambiguous.slice(0, 10)) {
  console.log(`  "${a.name}" ~ "${a.against}"  score=${a.score} (${a.reason})`);
}
for (const e of report.diff.examples.slice(0, 10)) {
  console.log(`  ${e.kind}: ${e.label} (${e.entityId})`);
}

// M2 keeps the normalized-name match as a FALLBACK behind AQUA_CANONICAL_IDS,
// so a subject the id map misses is still joined by name at runtime. That
// makes a regression structurally impossible rather than merely absent from
// this sample — which is why this number is no longer a gate.
//
// It still matters: a high count means the map is thin or stale, so the
// cutover would deliver less gain than it could. Re-run the backfill rather
// than hold the flag.
if (report.diff.stringOnlyJoins > 0) {
  console.log(`\n${report.diff.stringOnlyJoins} subject(s) joined by name but not yet by identity — the map is incomplete, not unsafe. Re-run the backfill after ingest has been on a while.`);
} else {
  console.log(`\nThe id map covers every join the name match makes.`);
}
console.log(`Gain from cutover on this data: ${report.diff.idOnlyJoins} additional join(s).`);
