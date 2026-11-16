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

export const mergeStats = { conflicts: 0, editBeatDelete: 0 };

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

function mergeMap(o = {}, t = {}, b, spec, hasBase) {
  const out = {};
  const keys = new Set([...Object.keys(t ?? {}), ...Object.keys(o ?? {}), ...Object.keys(b ?? {})]);
  for (const k of [...keys].sort()) {
    const v = mergeItem(o?.[k], t?.[k], b?.[k], spec, hasBase);
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

function mergeLink(o, t, b, hasBase) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const out = {};
  for (const k of new Set([...Object.keys(t ?? {}), ...Object.keys(o ?? {}), ...Object.keys(b ?? {})])) {
    const ov = o?.[k]; const tv = t?.[k]; const bv = b?.[k];
    if (ov === undefined && tv === undefined) continue;
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

function mergeRootList(o = [], t = [], b, spec, hasBase) {
  const id = spec.id ?? (x => x?.id);
  const toMap = arr => Object.fromEntries((arr ?? []).map(x => [id(x), x]));
  const m = mergeMap(toMap(o), toMap(t), b ? toMap(b) : undefined, spec, hasBase && Array.isArray(b));
  const time = spec.time ?? defaultTime;
  const list = Object.values(m).sort((x, y) => time(x) - time(y) || (String(id(x)) < String(id(y)) ? -1 : 1));
  return spec.cap ? list.slice(-spec.cap) : list;
}

/**
 * @param {object} ours
 * @param {object|null} theirs   null = no row
 * @param {object|null|undefined} base  undefined = unknown (never loaded here)
 * @param {object} schema
 */
export function mergeEntry(ours, theirs, base, schema = {}) {
  const hasBase = base !== undefined;
  if (theirs == null) return ours;
  if (schema.whole) {
    // The entry is replaced as a unit by its writer (e.g. a full re-ingest):
    // the side that changed it wins; both changed → ours, counted as a conflict.
    if (!hasBase) return ours;
    if (eq(ours, base)) return theirs;
    if (!eq(theirs, base)) mergeStats.conflicts++;
    return ours;
  }
  if (schema.rootList) return mergeRootList(ours, theirs, base ?? undefined, schema.rootList, hasBase);
  if (schema.root) return mergeMap(ours, theirs, base ?? undefined, schema.root, hasBase);
  const out = {};
  const handled = new Set([...Object.keys(schema.collections ?? {}), ...(schema.links ?? []), ...Object.keys(schema.logs ?? {}), ...Object.keys(schema.logMaps ?? {})]);
  for (const [f, spec] of Object.entries(schema.collections ?? {})) out[f] = mergeMap(ours?.[f], theirs?.[f], base?.[f], spec, hasBase && base?.[f] !== undefined);
  for (const f of schema.links ?? []) out[f] = mergeLink(ours?.[f], theirs?.[f], base?.[f], hasBase && base?.[f] !== undefined);
  for (const [f, spec] of Object.entries(schema.logs ?? {})) out[f] = mergeLog(ours?.[f], theirs?.[f], spec);
  // logMaps: key → log (e.g. a subject's version history). A key removed on one
  // side and untouched on the other is removed; otherwise the logs are unioned.
  for (const [f, spec] of Object.entries(schema.logMaps ?? {})) {
    const o = ours?.[f] ?? {}; const t = theirs?.[f] ?? {}; const b = base?.[f];
    const m = {};
    for (const k of new Set([...Object.keys(t), ...Object.keys(o)])) {
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
