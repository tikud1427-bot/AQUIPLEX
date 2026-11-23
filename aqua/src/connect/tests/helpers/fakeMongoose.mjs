/**
 * A minimal, faithful stand-in for the parts of mongoose that
 * connect/connectionStore.createMongoConnectionStore uses — so the REAL
 * adapter code, with its REAL conditional-write filters, runs in tests without
 * any MongoDB deployment (Safety Fix 4 and its final remediation).
 *
 *   createFakeMongoose({ file })   file omitted: in-process collections
 *                                  file given:   one JSON file PER MODEL
 *                                  (<file>.<Model>.json) shared by separate
 *                                  processes; every operation is atomic under a
 *                                  cross-process lock (mkdir), like a single-
 *                                  document Mongo operation.
 *
 * MongoDB semantics implemented for exactly what the adapter uses:
 *   query   equality (a missing field equals null), $lt, $lte, $ne, $in,
 *           $exists, $or; dotted paths (connections.<id>.<field>)
 *   update  $set, $unset, $setOnInsert (dotted paths create nested objects)
 *   upsert  no document matches → insert one built from the filter's top-level
 *           equality fields + $setOnInsert + $set; a document with the same
 *           _id already exists (it did not match the filter) → E11000
 *           duplicate key error and NOTHING is written (MongoDB's behaviour)
 *   _id     unique per collection
 * Every filter received is recorded (`calls`). `delayNextWrite(ms)`: the next
 * mutating operation waits before it applies (a slow server / a request in flight);
 * `onApplied(fn)` is called with (op, result) when a delayed write applies.
 */
import fs from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = v => (v == null ? v : structuredClone(v));
const isOp = v => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).some(k => k.startsWith('$'));

function getPath(doc, p) {
  let cur = doc;
  for (const part of p.split('.')) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[part]; }
  return cur;
}
function setPath(doc, p, v) {
  const parts = p.split('.');
  let cur = doc;
  for (const part of parts.slice(0, -1)) { if (cur[part] == null || typeof cur[part] !== 'object') cur[part] = {}; cur = cur[part]; }
  cur[parts.at(-1)] = clone(v);
}
function unsetPath(doc, p) {
  const parts = p.split('.');
  let cur = doc;
  for (const part of parts.slice(0, -1)) { if (cur == null || typeof cur !== 'object') return; cur = cur[part]; }
  if (cur && typeof cur === 'object') delete cur[parts.at(-1)];
}

function valueMatches(v, cond) {
  if (isOp(cond)) {
    for (const [op, arg] of Object.entries(cond)) {
      if (op === '$lt') { if (!(v !== undefined && v !== null && typeof v === typeof arg && v < arg)) return false; }
      else if (op === '$lte') { if (!(v !== undefined && v !== null && typeof v === typeof arg && v <= arg)) return false; }
      else if (op === '$ne') { if (arg === null ? v == null : v === arg) return false; }
      else if (op === '$in') { if (!arg.some(a => (a === null ? v == null : v === a))) return false; }
      else if (op === '$exists') { if ((v !== undefined) !== Boolean(arg)) return false; }
      else throw new Error(`fakeMongoose: unsupported operator ${op}`);
    }
    return true;
  }
  if (cond === null) return v === null || v === undefined;
  return v === cond;
}
export function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter ?? {})) {
    if (k === '$or') { if (!cond.some(sub => matches(doc, sub))) return false; continue; }
    if (k.startsWith('$')) throw new Error(`fakeMongoose: unsupported top-level ${k}`);
    if (!valueMatches(getPath(doc, k), cond)) return false;
  }
  return true;
}
function applyUpdate(doc, update, { inserting = false } = {}) {
  for (const [op, fields] of Object.entries(update)) {
    if (op === '$set') for (const [k, v] of Object.entries(fields)) setPath(doc, k, v);
    else if (op === '$unset') for (const k of Object.keys(fields)) unsetPath(doc, k);
    else if (op === '$setOnInsert') { if (inserting) for (const [k, v] of Object.entries(fields)) setPath(doc, k, v); }
    else throw new Error(`fakeMongoose: unsupported update ${op}`);
  }
}
/** The document an upsert inserts: the filter's top-level equality fields, then the update. */
function upsertDoc(filter, update) {
  const doc = {};
  for (const [k, v] of Object.entries(filter)) if (!k.startsWith('$') && !k.includes('.') && !isOp(v)) doc[k] = clone(v);
  applyUpdate(doc, update, { inserting: true });
  return doc;
}
const dupKey = () => Object.assign(new Error('E11000 duplicate key error collection'), { code: 11000 });

function memoryBackend() {
  let docs = [];
  return { async atomic(fn) { const r = fn(docs); docs = r.docs ?? docs; return r.result; }, read: () => clone(docs) };
}
function fileBackend(file) {
  const lock = `${file}.lock`;
  const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '[]') : []);
  return {
    async atomic(fn) {
      for (let i = 0; ; i++) {                      // cross-process mutex
        try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== 'EEXIST') throw e; if (i > 5000) throw new Error('fakeMongoose lock timeout'); await sleep(2); }
      }
      try {
        const docs = load();
        const r = fn(docs);
        if (r.docs) { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(r.docs)); fs.renameSync(tmp, file); }
        return r.result;
      } finally { fs.rmdirSync(lock); }
    },
    read: load,
  };
}

export function createFakeMongoose({ file = null } = {}) {
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  const calls = [];
  let delay = 0;
  let applied = null;
  const wrap = d => (d ? Object.assign(clone(d), { toObject() { const c = { ...this }; delete c.toObject; return clone(c); } }) : null);

  function makeModel(name) {
    const backend = file ? fileBackend(`${file.replace(/\.json$/, '')}.${name}.json`) : memoryBackend();
    /** Run one mutating operation, after an injected delay if any (the request is "in flight"). */
    const write = async (op, fn) => {
      const d = delay; delay = 0;
      if (d) await sleep(d);
      try { const r = await backend.atomic(fn); if (d) applied?.(op, { ok: true, result: r }); return r; }
      catch (e) { if (d) applied?.(op, { ok: false, error: e }); throw e; }
    };
    const updateOneDoc = (filter, update, options) => docs => {
      const i = docs.findIndex(x => matches(x, filter));
      if (i >= 0) {
        const next = [...docs]; next[i] = clone(docs[i]); applyUpdate(next[i], update);
        return { docs: next, result: { matched: 1, before: docs[i], after: next[i], upserted: false } };
      }
      if (!options.upsert) return { result: { matched: 0, before: null, after: null, upserted: false } };
      const ins = upsertDoc(filter, update);
      if (ins._id !== undefined && docs.some(x => x._id === ins._id)) throw dupKey();   // exists but did not match
      return { docs: [...docs, ins], result: { matched: 0, before: null, after: ins, upserted: true } };
    };
    return {
      async create(input, options = {}) {
        calls.push({ model: name, op: 'create', options });
        const list = (Array.isArray(input) ? input : [input]).map(clone);
        const created = await write('create', docs => {
          for (const d of list) if ((d._id !== undefined && docs.some(x => x._id === d._id)) || (d.connectionId && docs.some(x => x.connectionId === d.connectionId))) throw dupKey();
          return { docs: [...docs, ...list], result: list };
        });
        return Array.isArray(input) ? created.map(wrap) : wrap(created[0]);
      },
      async findOne(filter) { calls.push({ model: name, op: 'findOne', filter: clone(filter) }); return wrap(backend.read().find(d => matches(d, filter)) ?? null); },
      async find(filter) { calls.push({ model: name, op: 'find', filter: clone(filter) }); return backend.read().filter(d => matches(d, filter)).map(wrap); },
      async findOneAndUpdate(filter, update, options = {}) {
        calls.push({ model: name, op: 'findOneAndUpdate', filter: clone(filter), update: clone(update), options });
        const r = await write('findOneAndUpdate', updateOneDoc(filter, update, options));
        return wrap(options.new ? r.after : r.before);
      },
      async updateOne(filter, update, options = {}) {
        calls.push({ model: name, op: 'updateOne', filter: clone(filter), update: clone(update), options });
        const r = await write('updateOne', updateOneDoc(filter, update, options));
        return { matchedCount: r.matched, modifiedCount: r.matched, upsertedCount: r.upserted ? 1 : 0 };
      },
      async deleteOne(filter, options = {}) {
        calls.push({ model: name, op: 'deleteOne', filter: clone(filter), options });
        return write('deleteOne', docs => {
          const i = docs.findIndex(d => matches(d, filter));
          return i < 0 ? { result: { deletedCount: 0 } } : { docs: docs.filter((_, j) => j !== i), result: { deletedCount: 1 } };
        });
      },
      async updateMany(filter, update, options = {}) {
        calls.push({ model: name, op: 'updateMany', filter: clone(filter), update: clone(update), options });
        return write('updateMany', docs => {
          let n = 0;
          const next = docs.map(d => { if (!matches(d, filter)) return d; const c = clone(d); applyUpdate(c, update); n++; return c; });
          return { docs: next, result: { modifiedCount: n, matchedCount: n } };
        });
      },
      async deleteMany(filter, options = {}) {
        calls.push({ model: name, op: 'deleteMany', filter: clone(filter), options });
        return write('deleteMany', docs => {
          const keep = docs.filter(d => !matches(d, filter));
          return { docs: keep, result: { deletedCount: docs.length - keep.length } };
        });
      },
      async countDocuments(filter) { calls.push({ model: name, op: 'countDocuments', filter: clone(filter) }); return backend.read().filter(d => matches(d, filter)).length; },
      raw: () => backend.read(),
    };
  }

  class Schema { constructor(def, opts) { this.def = def; this.opts = opts; } index() {} }
  Schema.Types = { Mixed: 'Mixed' };
  const models = {};
  return {
    connection: { readyState: 1 },
    models,
    Schema,
    model(name) { models[name] ??= makeModel(name); return models[name]; },
    calls,
    delayNextWrite(ms) { delay = ms; },
    onApplied(fn) { applied = fn; },
    /** Raw documents of a model's collection (default: the per-owner connection documents). */
    raw: (name = 'AquaConnectionSet') => (models[name] ?? makeModel(name)).raw(),
  };
}
