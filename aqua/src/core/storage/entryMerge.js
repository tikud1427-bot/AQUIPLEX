/**
 * AQUA Storage — schema-driven three-way merge of one store entry (Phase 2c)
 *
 * PURE. Merges `ours` (this process's entry) with `theirs` (the database row)
 * against `base` (the entry as this process last loaded or wrote it).
 *
 * Why three-way: with the base, "who changed what" is a FACT, not a guess.
 *   item unchanged on one side          → the other side's version (edit or delete) wins
 *   item changed on both sides          → a real conflict: newer item time wins
 *                                         (counter fields: theirs + (ours − base))
 *   item missing on one side, present
 *   in base                             → that side DELETED it — no tombstone, no clock
 *   delete on one side, edit on other   → the edit wins (never lose a change silently)
 * Without a base (an entry this process never loaded) it degrades to a union
 * where the newer item wins; deletions are then not inferable, which is safe
 * because a process cannot delete what it never held.
 *
 * Schema (all optional):
 *   root:        { time, counters }            the entry IS an id → item map
 *   rootList:    { id, time, cap }             the entry IS an array of items with ids
 *   collections: { field: { time, counters } } id → item maps inside the entry
 *   links:       [field]                       key → array (or { sub: array }) id sets
 *   logs:        { field: { id, time, cap } }  append-mostly arrays, union by id
 *   finalize:    (merged) => merged            fix-ups (e.g. drop links to deleted items)
 * Any other field: three-way on the whole value, ours on a double change.
 *
 * EXTERNAL-ORIGIN ITEMS (Safety Fix 2). An item spec (root / collections /
 * logMaps entries) or `linkExternal[field]` may declare `external(id, item, ctx)`
 * — true for data derived from a connected external source. For those items:
 *   · present in the base, missing on EITHER side → DELETED, whatever the other
 *     side did to it (a disconnect wins over a concurrent edit, archive,
 *     consolidation or re-touch on another instance);
 *   · not in the base, present only on OUR side → an ADDITION, kept only when
 *     `opts.allowExternalAdditions` (the writer holds a valid connect fence;
 *     the write transaction re-checks that fence). Otherwise refused — a stale
 *     or unfenced process cannot re-create a deleted external item.
 *   · present on both sides → the ordinary three-way merge — but only for a
 *     write that may write external data (`opts.allowExternalWrites`, Safety
 *     Fix 3: it carries a valid origin fence). Any other write keeps THE
 *     DATABASE'S version: a stale or plain process cannot update external items.
 * Items without an `external` predicate merge exactly as before.
 */

/** Deterministic JSON (sorted keys) — equality must not depend on key order. */
export function stable(v) {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}
const eq = (a, b) => stable(a) === stable(b);
const defaultTime = x => Number(x?.updatedAt ?? x?.lastAt ?? x?.at ?? x?.ts ?? x?.uploadedAt ?? x?.createdAt ?? 0) || 0;

export const mergeStats = { conflicts: 0, editBeatDelete: 0, externalDeleteWins: 0, externalAdditionsRefused: 0, externalUpdatesRefused: 0 };

/** Pick the newer of two conflicting items, deterministically. */
function newer(o, t, time) {
  const a = time(o); const b = time(t);
  if (a !== b) return a > b ? o : t;
  return stable(o) >= stable(t) ? o : t;
}

/** Three-way merge of ONE item. `hasBase` false → base unknown for the whole entry. */
export function mergeItem(o, t, b, { time = defaultTime, counters = [] } = {}, hasBase = true) {
  if (!hasBase || b === undefined) {
    if (o === undefined) return t;
    if (t === undefined) return o;
    if (eq(o, t)) return o;
    mergeStats.conflicts++;
    return newer(o, t, time);
  }
  const oc = !eq(o, b);
  const tc = !eq(t, b);
  if (!oc) return t;
  if (!tc) return o;
  mergeStats.conflicts++;
  if (o === undefined) { mergeStats.editBeatDelete++; return t; }
  if (t === undefined) { mergeStats.editBeatDelete++; return o; }
  const win = { ...newer(o, t, time) };
  for (const c of counters) {
    const sum = (Number(t[c]) || 0) + (Number(o[c]) || 0) - (Number(b?.[c]) || 0);
    win[c] = Math.max(0, sum);
  }
  return win;
}

/**
 * One EXTERNAL-ORIGIN item (see the header). `undefined` = absent afterwards.
 */
export function mergeExternalItem(o, t, b, spec, hasBase, allowAdd) {
  if (o === undefined && t === undefined) return undefined;
  if (hasBase && b !== undefined) {
    if (o === undefined || t === undefined) {
      // Deleted on one side: gone. Counted when the other side had changed it.
      const other = o === undefined ? t : o;
      if (!eq(other, b)) mergeStats.externalDeleteWins++;
      return undefined;
    }
    if (!allowAdd) { if (!eq(o, t)) mergeStats.externalUpdatesRefused++; return t; }   // no valid origin: the database's version
    return mergeItem(o, t, b, spec, true);
  }
  if (t === undefined) {                       // ours only, no base: our addition
    if (allowAdd) return o;
    mergeStats.externalAdditionsRefused++;
    return undefined;
  }
  if (o === undefined) return t;               // in the database already
  if (!allowAdd) { if (!eq(o, t)) mergeStats.externalUpdatesRefused++; return t; }
  return mergeItem(o, t, b, spec, hasBase);
}

const isExternalKey = (spec, k, o, t, b, ctx) =>
  typeof spec?.external === 'function' && Boolean(spec.external(k, o ?? t ?? b, ctx));

function mergeMap(o = {}, t = {}, b, spec, hasBase, x = {}) {
  const out = {};
  const keys = new Set([...Object.keys(t ?? {}), ...Object.keys(o ?? {}), ...Object.keys(b ?? {})]);
  for (const k of [...keys].sort()) {
    const v = isExternalKey(spec, k, o?.[k], t?.[k], b?.[k], x.ctx)
      ? mergeExternalItem(o?.[k], t?.[k], b?.[k], spec, hasBase, x.allowExternalAdditions !== false)
      : mergeItem(o?.[k], t?.[k], b?.[k], spec, hasBase);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Three-way set merge: kept by both, plus each side's additions; removed by either → gone. */
export function mergeSet(o = [], t = [], b, hasBase = true) {
  const O = new Set(o); const T = new Set(t);
  if (!hasBase || !b) return [...new Set([...t, ...o])];
  const B = new Set(b);
  const out = [];
  for (const x of new Set([...t, ...o])) {
    const inO = O.has(x); const inT = T.has(x); const inB = B.has(x);
    if (inB ? (inO && inT) : (inO || inT)) out.push(x);
  }
  return out;
}

function mergeLink(o, t, b, hasBase, external = null, x = {}) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const out = {};
  for (const k of new Set([...Object.keys(t ?? {}), ...Object.keys(o ?? {}), ...Object.keys(b ?? {})])) {
    const ov = o?.[k]; const tv = t?.[k]; const bv = b?.[k];
    if (ov === undefined && tv === undefined) continue;
    if (external && external(k, x.ctx)) {
      // An external link key (e.g. byFile[ext_…]): deletion on either side wins;
      // an unfenced addition is refused (see EXTERNAL-ORIGIN ITEMS).
      if (hasBase && bv !== undefined && (ov === undefined || tv === undefined)) {
        if (!eq(ov === undefined ? tv : ov, bv)) mergeStats.externalDeleteWins++;
        continue;
      }
      if (!(hasBase && bv !== undefined) && tv === undefined && x.allowExternalAdditions === false) {
        mergeStats.externalAdditionsRefused++;
        continue;
      }
      if (x.allowExternalAdditions === false && ov !== undefined && tv !== undefined) {
        if (!eq(ov, tv)) mergeStats.externalUpdatesRefused++;
        out[k] = tv;                                  // no valid origin: the database's version
        continue;
      }
    }
    if (hasBase && bv !== undefined) {
      if (ov === undefined && eq(tv, bv)) continue;   // removed here, untouched there
      if (tv === undefined && eq(ov, bv)) continue;   // removed there, untouched here
    }
    if ([ov, tv, bv].some(isObj)) {
      const sub = {};
      for (const s of new Set([...Object.keys(tv ?? {}), ...Object.keys(ov ?? {})])) sub[s] = mergeSet(ov?.[s] ?? [], tv?.[s] ?? [], bv?.[s], hasBase && bv !== undefined);
      out[k] = sub;
    } else {
      out[k] = mergeSet(ov ?? [], tv ?? [], bv, hasBase && bv !== undefined);
    }
  }
  return out;
}

function mergeLog(o = [], t = [], spec) {
  const id = spec.id ?? stable;
  const time = spec.time ?? defaultTime;
  const byId = new Map();
  for (const x of [...t, ...o]) byId.set(id(x), x);
  const all = [...byId.values()].sort((a, b) => time(a) - time(b) || (stable(a) < stable(b) ? -1 : 1));
  return spec.cap ? all.slice(-spec.cap) : all;
}

function mergeRootList(o = [], t = [], b, spec, hasBase, x = {}) {
  const id = spec.id ?? (x => x?.id);
  const toMap = arr => Object.fromEntries((arr ?? []).map(x => [id(x), x]));
  const m = mergeMap(toMap(o), toMap(t), b ? toMap(b) : undefined, spec, hasBase && Array.isArray(b), x);
  const time = spec.time ?? defaultTime;
  const list = Object.values(m).sort((x, y) => time(x) - time(y) || (String(id(x)) < String(id(y)) ? -1 : 1));
  return spec.cap ? list.slice(-spec.cap) : list;
}

/** Does this schema declare any external-origin items? */
export const schemaHasExternal = s => Boolean(s && (
  typeof s.root?.external === 'function' || typeof s.rootList?.external === 'function'
  || Object.values(s.collections ?? {}).some(c => typeof c?.external === 'function')
  || Object.values(s.logMaps ?? {}).some(c => typeof c?.external === 'function')
  || Object.keys(s.linkExternal ?? {}).length > 0));

/**
 * Safety Fix 3: an entry about to be written with NO database row to merge
 * with (first write, or re-creation over a tombstone) by a write that may not
 * write external data — every external item in it would be an unfenced
 * ADDITION: drop them all. Non-external content is returned unchanged.
 */
export function withoutExternal(entry, schema = {}, opts = {}) {
  if (entry == null || !schemaHasExternal(schema)) return entry;
  return mergeEntry(entry, schema.rootList ? [] : {}, undefined, schema, { ...opts, allowExternalWrites: false, allowExternalAdditions: false });
}

/**
 * @param {object} ours
 * @param {object|null} theirs   null = no row
 * @param {object|null|undefined} base  undefined = unknown (never loaded here)
 * @param {object} schema
 * @param {{ allowExternalWrites?: boolean, allowExternalAdditions?: boolean, key?: string }} [opts]
 *        allowExternalWrites (Step 2 name: allowExternalAdditions) — may this
 *        write ADD or UPDATE external items? Default true (callers that do not
 *        opt in keep the previous behaviour); the partition bindings pass
 *        whether the write carries a valid origin fence. key — the entry's key.
 */
export function mergeEntry(ours, theirs, base, schema = {}, opts = {}) {
  const hasBase = base !== undefined;
  const allow = opts.allowExternalWrites ?? opts.allowExternalAdditions;
  const x = { allowExternalAdditions: allow !== false, ctx: { ours, theirs, base, key: opts.key ?? null } };
  if (theirs == null) return ours;
  if (schema.whole) {
    // The entry is replaced as a unit by its writer (e.g. a full re-ingest):
    // the side that changed it wins; both changed → ours, counted as a conflict.
    if (!hasBase) return ours;
    if (eq(ours, base)) return theirs;
    if (!eq(theirs, base)) mergeStats.conflicts++;
    return ours;
  }
  if (schema.rootList) return mergeRootList(ours, theirs, base ?? undefined, schema.rootList, hasBase, x);
  if (schema.root) return mergeMap(ours, theirs, base ?? undefined, schema.root, hasBase, x);
  const out = {};
  const handled = new Set([...Object.keys(schema.collections ?? {}), ...(schema.links ?? []), ...Object.keys(schema.logs ?? {}), ...Object.keys(schema.logMaps ?? {})]);
  for (const [f, spec] of Object.entries(schema.collections ?? {})) out[f] = mergeMap(ours?.[f], theirs?.[f], base?.[f], spec, hasBase && base?.[f] !== undefined, x);
  for (const f of schema.links ?? []) out[f] = mergeLink(ours?.[f], theirs?.[f], base?.[f], hasBase && base?.[f] !== undefined, schema.linkExternal?.[f] ?? null, x);
  for (const [f, spec] of Object.entries(schema.logs ?? {})) out[f] = mergeLog(ours?.[f], theirs?.[f], spec);
  // logMaps: key → log (e.g. a subject's version history). A key removed on one
  // side and untouched on the other is removed; otherwise the logs are unioned.
  for (const [f, spec] of Object.entries(schema.logMaps ?? {})) {
    const o = ours?.[f] ?? {}; const t = theirs?.[f] ?? {}; const b = base?.[f];
    const m = {};
    for (const k of new Set([...Object.keys(t), ...Object.keys(o)])) {
      if (isExternalKey(spec, k, o[k], t[k], b?.[k], x.ctx)) {
        // External subject: deletion on either side wins; unfenced addition refused.
        if (hasBase && b?.[k] !== undefined && (o[k] === undefined || t[k] === undefined)) { mergeStats.externalDeleteWins++; continue; }
        if (!(hasBase && b?.[k] !== undefined) && t[k] === undefined && !x.allowExternalAdditions) { mergeStats.externalAdditionsRefused++; continue; }
        if (!x.allowExternalAdditions && o[k] !== undefined && t[k] !== undefined) {
          if (!eq(o[k], t[k])) mergeStats.externalUpdatesRefused++;
          m[k] = t[k];                                // no valid origin: the database's version
          continue;
        }
      }
      if (hasBase && b?.[k] !== undefined) {
        if (o[k] === undefined && eq(t[k], b[k])) continue;
        if (t[k] === undefined && eq(o[k], b[k])) continue;
      }
      m[k] = mergeLog(o[k] ?? [], t[k] ?? [], spec);
    }
    out[f] = m;
  }
  for (const k of new Set([...Object.keys(theirs ?? {}), ...Object.keys(ours ?? {})])) {
    if (handled.has(k)) continue;
    const o = ours?.[k]; const t = theirs?.[k]; const b = base?.[k];
    const v = hasBase ? (eq(o, b) ? t : eq(t, b) ? o : o) : (o !== undefined ? o : t);
    if (v !== undefined) out[k] = v;
  }
  return schema.finalize ? schema.finalize(out) : out;
}
