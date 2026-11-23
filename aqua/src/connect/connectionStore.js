/**
 * AQUA Connect — connection store (Phase 1b; Safety Fix 4 + final remediation)
 *
 * A connection = one user's link to one external account through one
 * connector. The record holds metadata, the SEALED credential envelope
 * (credentialVault.js — never plaintext), the sync checkpoint and the last
 * sync status. It does NOT hold knowledge: imported resources live in the
 * existing stores through the Phase 1a.2 lifecycle, keyed by the connection's
 * sourceId.
 *
 * Two adapters, one interface — every call is OWNER-SCOPED: a record is only
 * ever read, changed or deleted through (ownerId, connectionId), so a
 * connection id alone (guessed, leaked, or another user's) reaches nothing.
 *
 *   createMemoryConnectionStore()   tests and local tooling (crossInstance: false)
 *   createMongoConnectionStore()    production: the platform's EXISTING MongoDB
 *                                   connection (mongoose default). No new
 *                                   database. Fails fast when Mongo is not
 *                                   connected; never falls back to files.
 *
 * Interface:
 *   create(doc, {fence}) · get(ownerId, id) · listByOwner(ownerId) · update(ownerId, id, patch, {fence})
 *   remove(ownerId, id, {fence}) · countByConnector(connectorId, statuses?)
 *   stamp(ownerId, fence) · purgeOwner(ownerId) · countByOwner(ownerId) · ownerState(ownerId)
 *
 * ONE DOCUMENT PER OWNER (final remediation). MongoDB is atomic per document
 * and has no cross-document conditional insert; without a (replica-set)
 * transaction, a separate document per connection cannot be made to refuse a
 * delayed insert that arrives after an account purge. So ALL of an owner's
 * connections live in ONE owner document (collection `aqua_connection_sets`):
 *
 *   { _id: ownerId, ownerId, deleted, deletedAt, fenceEpoch, fenceToken,
 *     connections: { <connectionId>: <record> }, updatedAt }
 *
 * Every write is ONE conditional single-document operation on it:
 *   create   updateOne({ _id, deleted ≠ true, connections.<id> absent, FENCE }, $set
 *            connections.<id>, upsert) — no matching document → an upsert; a
 *            document with this _id that does not match (deleted, a newer epoch,
 *            the id taken) → the upsert collides on _id (duplicate key) and NOTHING
 *            is written (OWNER_DELETED / FENCE_STALE / DUPLICATE);
 *   update   findOneAndUpdate({ _id, deleted ≠ true, connections.<id> present, FENCE }, $set …);
 *   remove   updateOne({ … same }, $unset connections.<id>);
 *   stamp    raise the document's epoch below E to (E, T) — every operation's first act;
 *   purge    findOneAndUpdate({ _id }, $set { deleted: true, connections: {} }, upsert) —
 *            ONE atomic step removes every record (credentials, cursors,
 *            checkpoints, pending deletions) AND leaves a TOMBSTONE forever.
 * FENCE = fenceEpoch < E  OR  (fenceEpoch = E AND fenceToken = T)  — a document
 * a NEWER operation stamped or wrote is never overwritten (FENCE_STALE); no
 * epoch at all is never matched (fail closed).
 *
 * Consequences: an insert in progress is one operation on the owner document,
 * ordered entirely before the purge's update (then purged) or after it
 * (refused) — never in between; a delayed insert delivered ANY time after the
 * purge collides with the tombstone and writes nothing; physical absence is a
 * read of ONE document (ownerState). The records keep the per-connection schema
 * (AquaConnection: strict paths, status enum, envelope-only credentials) —
 * every record and patch is validated through it before it is stored.
 *
 * `fence` omitted: an unconditional (but still tombstone-respecting) write —
 * connectService allows that ONLY in local mode (no database, one process).
 */

export const CONNECTION_STATUSES = Object.freeze([
  'active',              // usable
  'needs_reauth',        // credentials expired/refused; knowledge kept, sync refused
  'revoked',             // credentials revoked by the user; knowledge kept, sync refused
  'disconnecting',       // removal in progress (sync refused)
  'disconnect_incomplete', // credentials gone, some knowledge still being removed — retry disconnect
]);

export class ConnectionStoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const clone = v => (v == null ? v : structuredClone(v));

/** A connect fence for a connection write, validated (null = unfenced). */
export function fenceOf(fence) {
  if (fence == null) return null;
  const epoch = Number(fence.epoch);
  if (!Number.isSafeInteger(epoch) || epoch <= 0 || typeof fence.token !== 'string' || !fence.token) {
    throw new ConnectionStoreError('FENCE_INVALID', 'a connection write carries a malformed fence (epoch/token)');
  }
  const previousEpoch = fence.previousEpoch == null ? null : Number(fence.previousEpoch);
  if (previousEpoch != null && (!Number.isSafeInteger(previousEpoch) || previousEpoch >= epoch)) {
    throw new ConnectionStoreError('FENCE_INVALID', 'a connection write carries a malformed previous epoch');
  }
  return { epoch, token: fence.token, previousEpoch };
}
/** The conditional-write filter of a fenced write (Mongo query form; the memory adapter evaluates the same rule). */
export const fenceFilter = f => ({ $or: [{ fenceEpoch: { $lt: f.epoch } }, { fenceEpoch: f.epoch, fenceToken: f.token }] });
const fenceAllows = (row, f) => typeof row?.fenceEpoch === 'number'
  && (row.fenceEpoch < f.epoch || (row.fenceEpoch === f.epoch && row.fenceToken === f.token));
const fenceFields = f => (f ? { fenceEpoch: f.epoch, fenceToken: f.token } : {});
const err = (code, message) => new ConnectionStoreError(code, message);
const stale = () => err('FENCE_STALE', 'a newer connect operation owns this connection');
const deletedOwner = () => err('OWNER_DELETED', 'this account was deleted');
const ID = /^[A-Za-z0-9_-]{1,80}$/;   // a connection id is a document key: no dots, no $
const checkId = id => { if (typeof id !== 'string' || !ID.test(id)) throw err('INVALID_ID', 'malformed connection id'); return id; };
/** A record as readers see it: the owner document's epoch/token travel with each record. */
const asRecord = (doc, rec) => (rec ? { ...clone(rec), ownerId: doc.ownerId ?? doc._id, fenceEpoch: doc.fenceEpoch ?? null, fenceToken: doc.fenceToken ?? null } : null);

// Every store an account purge must clear (connectService registers its store).
const purgeStores = new Set();
export function registerConnectionStoreForPurge(store) { if (store) purgeStores.add(store); }
export function connectionStoresForPurge() { return [...purgeStores]; }

// Gmail Phase 2 — before an account purge deletes a store's records, the
// connect service that owns the store revokes the owner's grants at the
// provider (best effort, bounded). One revoker per store (the latest service wins).
const purgeRevokers = new WeakMap();
export function registerGrantRevokerForPurge(store, revokeOwnerGrants) { if (store && typeof revokeOwnerGrants === 'function') purgeRevokers.set(store, revokeOwnerGrants); }
export function grantRevokerForPurge(store) { return store ? purgeRevokers.get(store) ?? null : null; }

// ── In-memory (the same single-document semantics; one process only) ────────

export function createMemoryConnectionStore() {
  const owners = new Map();   // ownerId → { _id, ownerId, deleted, fenceEpoch, fenceToken, connections }
  const recOf = (ownerId, id) => { const d = owners.get(ownerId); return d && !d.deleted ? d.connections[id] ?? null : null; };
  return {
    kind: 'memory',
    crossInstance: false,     // one process only — connectService refuses it for multi-instance operation
    async create(doc, { fence = null } = {}) {
      const f = fenceOf(fence);
      const id = checkId(doc.connectionId);
      const d = owners.get(doc.ownerId);
      if (d?.deleted) throw deletedOwner();
      if (d && f && !fenceAllows(d, f)) throw stale();
      if (d?.connections[id]) throw err('DUPLICATE', 'connection id collision');
      const now = Date.now();
      const next = d ?? { _id: doc.ownerId, ownerId: doc.ownerId, deleted: false, connections: {} };
      next.connections[id] = clone({ ...doc, createdAt: doc.createdAt ?? now, updatedAt: now });
      Object.assign(next, { updatedAt: now }, fenceFields(f));
      owners.set(doc.ownerId, next);
      return asRecord(next, next.connections[id]);
    },
    async get(ownerId, id) { const d = owners.get(ownerId); return d && !d.deleted ? asRecord(d, d.connections[id]) : null; },
    async listByOwner(ownerId) { const d = owners.get(ownerId); return d && !d.deleted ? Object.values(d.connections).map(r => asRecord(d, r)) : []; },
    async update(ownerId, id, patch, { fence = null } = {}) {
      const f = fenceOf(fence);
      const d = owners.get(ownerId);
      if (!recOf(ownerId, id)) return null;
      if (f && !fenceAllows(d, f)) throw stale();
      Object.assign(d.connections[id], clone(patch), { updatedAt: Date.now() });
      Object.assign(d, { updatedAt: Date.now() }, fenceFields(f));
      return asRecord(d, d.connections[id]);
    },
    async remove(ownerId, id, { fence = null } = {}) {
      const f = fenceOf(fence);
      const d = owners.get(ownerId);
      if (!recOf(ownerId, id)) return false;
      if (f && !fenceAllows(d, f)) throw stale();
      delete d.connections[id];
      Object.assign(d, { updatedAt: Date.now() }, fenceFields(f));
      return true;
    },
    async stamp(ownerId, fence) {
      const f = fenceOf(fence);
      if (!f) throw err('FENCE_INVALID', 'stamp needs a fence');
      const d = owners.get(ownerId);
      if (!d || d.deleted || typeof d.fenceEpoch !== 'number' || d.fenceEpoch >= f.epoch) return 0;
      Object.assign(d, fenceFields(f));
      return Object.keys(d.connections).length;
    },
    async purgeOwner(ownerId) {
      const d = owners.get(ownerId);
      const n = d && !d.deleted ? Object.keys(d.connections).length : 0;
      owners.set(ownerId, { ...(d ?? { _id: ownerId, ownerId }), deleted: true, deletedAt: Date.now(), connections: {} });
      return n;
    },
    async countByOwner(ownerId) { return Object.keys(owners.get(ownerId)?.connections ?? {}).length; },   // PHYSICAL count (tombstone or not)
    async ownerState(ownerId) { const d = owners.get(ownerId); return { exists: Boolean(d), deleted: Boolean(d?.deleted), connections: Object.keys(d?.connections ?? {}).length }; },
    async countByConnector(connectorId, statuses = null) {
      let n = 0;
      for (const d of owners.values()) if (!d.deleted) for (const r of Object.values(d.connections)) if (r.connectorId === connectorId && (!statuses || statuses.includes(r.status))) n++;
      return n;
    },
    /** Test-only: every stored connection record, as stored (to prove what is — and is not — at rest). */
    _rawForTests() { return [...owners.values()].flatMap(d => Object.values(d.connections).map(r => ({ ...clone(r), ownerId: r.ownerId ?? d.ownerId }))); },
    /** Test-only: the raw per-owner documents (tombstones included). */
    _rawOwnerDocsForTests() { return [...owners.values()].map(clone); },
  };
}

// ── MongoDB (existing platform connection) ───────────────────────────────────

let modelPromise = null;
/** The per-CONNECTION schema: validates every record (strict paths, status enum, envelope-only credentials). */
async function connectionModel(mongooseOverride = null) {
  if (mongooseOverride) return buildModel(mongooseOverride);
  modelPromise ??= import('mongoose').then(m => buildModel(m.default));
  return modelPromise;
}

function buildModel(mongoose) {
  if (mongoose.models.AquaConnection) return mongoose.models.AquaConnection;
  const envelope = new mongoose.Schema({
    v: Number, alg: String, keyId: String, iv: String, tag: String, ct: String,
  }, { _id: false });
  const schema = new mongoose.Schema({
    connectionId: { type: String, required: true, unique: true },
    ownerId:      { type: String, required: true, index: true },
    connectorId:  { type: String, required: true, index: true },
    connectorVersion: String,
    sourceId:     { type: String, required: true },
    status:       { type: String, required: true, enum: CONNECTION_STATUSES },
    account:      { label: String, externalAccountHash: String },
    scopes:       [String],
    credentials:  { type: envelope, default: null },   // SEALED envelope only
    credentialsExpireAt: { type: Number, default: null },
    checkpoint:   { type: mongoose.Schema.Types.Mixed, default: null },
    lastSync:     { type: mongoose.Schema.Types.Mixed, default: null },
    // An unfinished full listing (cursor + held ids seen so far) and a
    // withheld mass deletion (hash + counts only). Without these
    // paths the strict schema would silently drop them.
    fullSync:        { type: mongoose.Schema.Types.Mixed, default: null },
    pendingDeletion: { type: mongoose.Schema.Types.Mixed, default: null },
    syncCount:    { type: Number, default: 0 },
    syncPaused:   { type: Boolean, default: false },   // Gmail Phase 2: user-controlled pause (sync refused while true)
    createdAt:    Number,
    updatedAt:    Number,
  }, {
    collection: 'aqua_connections',   // legacy per-connection collection: only purged (never written now)
    bufferCommands: false,      // fail fast when Mongo is down — no silent queueing
    versionKey: false,
    toJSON:   { transform: (_d, r) => { delete r._id; delete r.credentials; return r; } },
    toObject: { transform: (_d, r) => { delete r._id; return r; } },
  });
  schema.index({ ownerId: 1, connectionId: 1 });
  return mongoose.model('AquaConnection', schema);
}

/** The per-OWNER document (all of an owner's connections; the purge tombstone). */
function buildSetModel(mongoose) {
  if (mongoose.models.AquaConnectionSet) return mongoose.models.AquaConnectionSet;
  const schema = new mongoose.Schema({
    _id:         { type: String, required: true },          // = ownerId
    ownerId:     { type: String, required: true },
    deleted:     { type: Boolean, default: false },
    deletedAt:   { type: Number, default: null },
    fenceEpoch:  { type: Number, default: null },
    fenceToken:  { type: String, default: null },
    connections: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },   // records validated through AquaConnection
    updatedAt:   Number,
  }, { collection: 'aqua_connection_sets', bufferCommands: false, versionKey: false, minimize: false, _id: false });
  return mongoose.model('AquaConnectionSet', schema);
}

/**
 * @param {{ mongoose?: object, maxTimeMS?: number }} [opts]  inject a mongoose instance (tests); default
 *        is the platform's shared default connection. maxTimeMS: the server-side bound of every write.
 */
export function createMongoConnectionStore({ mongoose: injected = null, maxTimeMS = 5_000 } = {}) {
  const ready = async () => {
    const mongoose = injected ?? (await import('mongoose')).default;
    if (mongoose.connection?.readyState !== 1) {
      throw new ConnectionStoreError('STORE_UNAVAILABLE', 'connection store unavailable (MongoDB not connected)');
    }
    return { Set: buildSetModel(mongoose), Rec: await connectionModel(injected) };
  };
  const opts = { maxTimeMS };
  const plainDoc = d => (d ? (typeof d.toObject === 'function' ? d.toObject() : d) : null);
  // Every record / patch goes through the per-connection schema (strict, enum, envelope-only).
  const sanitizeRecord = (Rec, rec) => {
    if (typeof Rec !== 'function') return clone(rec);                 // a test double without document validation
    const d = new Rec(rec);
    const bad = d.validateSync();
    if (bad) throw err('INVALID_RECORD', `connection record rejected by the schema: ${Object.keys(bad.errors ?? {}).join(', ')}`);
    const o = d.toObject(); delete o._id; return o;
  };
  const sanitizePatch = (Rec, patch) => {
    if (typeof Rec !== 'function') return clone(patch);
    const probe = new Rec({ connectionId: 'conn_probe', ownerId: 'probe', connectorId: 'probe', sourceId: 'probe', status: 'active', ...patch });
    const bad = probe.validateSync(Object.keys(patch));
    if (bad) throw err('INVALID_RECORD', `connection update rejected by the schema: ${Object.keys(bad.errors ?? {}).join(', ')}`);
    const o = probe.toObject();
    return Object.fromEntries(Object.keys(patch).filter(k => k in o).map(k => [k, o[k]]));
  };
  const isDup = e => e?.code === 11000 || /E11000|duplicate key/i.test(String(e?.message ?? ''));
  /** Why a conditional write matched nothing on an existing owner document. */
  const refusal = async (Set, ownerId, id, { forCreate = false } = {}) => {
    const d = plainDoc(await Set.findOne({ _id: ownerId }));
    if (d?.deleted) return deletedOwner();
    if (forCreate && d?.connections?.[id]) return err('DUPLICATE', 'connection id collision');
    return stale();
  };
  const live = ownerId => ({ _id: ownerId, deleted: { $ne: true } });
  const cond = f => (f ? fenceFilter(f) : {});

  return {
    kind: 'mongo',
    crossInstance: true,
    async create(doc, { fence = null } = {}) {
      const f = fenceOf(fence);
      const { Set, Rec } = await ready();
      const id = checkId(doc.connectionId);
      const now = Date.now();
      const rec = sanitizeRecord(Rec, { ...doc, createdAt: doc.createdAt ?? now, updatedAt: now });
      try {
        await Set.updateOne(
          { ...live(doc.ownerId), [`connections.${id}`]: { $exists: false }, ...cond(f) },
          { $set: { [`connections.${id}`]: rec, updatedAt: now, ...fenceFields(f) }, $setOnInsert: { ownerId: doc.ownerId, deleted: false } },
          { upsert: true, ...opts });
      } catch (e) {
        if (isDup(e)) throw await refusal(Set, doc.ownerId, id, { forCreate: true });
        throw e;
      }
      return this.get(doc.ownerId, id);
    },
    async get(ownerId, id) {
      const { Set } = await ready();
      const d = plainDoc(await Set.findOne({ _id: ownerId }));
      return d && !d.deleted ? asRecord(d, d.connections?.[id]) : null;
    },
    async listByOwner(ownerId) {
      const { Set } = await ready();
      const d = plainDoc(await Set.findOne({ _id: ownerId }));
      return d && !d.deleted ? Object.values(d.connections ?? {}).map(r => asRecord(d, r)) : [];
    },
    async update(ownerId, id, patch, { fence = null } = {}) {
      const f = fenceOf(fence);
      const { Set, Rec } = await ready();
      checkId(id);
      const now = Date.now();
      const clean = sanitizePatch(Rec, patch);
      const $set = { [`connections.${id}.updatedAt`]: now, updatedAt: now, ...fenceFields(f) };
      for (const [k, v] of Object.entries(clean)) $set[`connections.${id}.${k}`] = v;
      const r = plainDoc(await Set.findOneAndUpdate({ ...live(ownerId), [`connections.${id}`]: { $exists: true }, ...cond(f) }, { $set }, { new: true, ...opts }));
      if (r) return asRecord(r, r.connections?.[id]);
      const d = plainDoc(await Set.findOne({ _id: ownerId }));
      if (!d || d.deleted || !d.connections?.[id]) return null;   // not (or no longer) there
      throw stale();
    },
    async remove(ownerId, id, { fence = null } = {}) {
      const f = fenceOf(fence);
      const { Set } = await ready();
      checkId(id);
      const r = await Set.updateOne({ ...live(ownerId), [`connections.${id}`]: { $exists: true }, ...cond(f) },
        { $unset: { [`connections.${id}`]: '' }, $set: { updatedAt: Date.now(), ...fenceFields(f) } }, opts);
      if ((r.matchedCount ?? r.modifiedCount ?? 0) > 0) return true;
      const d = plainDoc(await Set.findOne({ _id: ownerId }));
      if (!d || d.deleted || !d.connections?.[id]) return false;
      throw stale();
    },
    async stamp(ownerId, fence) {
      const f = fenceOf(fence);
      if (!f) throw err('FENCE_INVALID', 'stamp needs a fence');
      const { Set } = await ready();
      const r = plainDoc(await Set.findOneAndUpdate({ ...live(ownerId), fenceEpoch: { $lt: f.epoch } }, { $set: fenceFields(f) }, { new: true, ...opts }));
      return r ? Object.keys(r.connections ?? {}).length : 0;
    },
    /**
     * Account purge: ONE atomic step on the owner document — every record goes
     * and a TOMBSTONE stays (upsert: even an owner with no document gets one, so
     * a delayed first insert is refused too). Plus the legacy per-connection
     * collection (records written before the owner-document design).
     */
    async purgeOwner(ownerId) {
      const { Set, Rec } = await ready();
      const before = plainDoc(await Set.findOneAndUpdate({ _id: ownerId },
        { $set: { deleted: true, deletedAt: Date.now(), connections: {}, updatedAt: Date.now() }, $setOnInsert: { ownerId } },
        { upsert: true, new: false, ...opts }));
      const legacy = (await Rec.deleteMany({ ownerId }, opts)).deletedCount ?? 0;
      return (before && !before.deleted ? Object.keys(before.connections ?? {}).length : 0) + legacy;
    },
    /** PHYSICAL count: records in the owner document (tombstone or not) + legacy records. */
    async countByOwner(ownerId) {
      const { Set, Rec } = await ready();
      const d = plainDoc(await Set.findOne({ _id: ownerId }));
      return Object.keys(d?.connections ?? {}).length + await Rec.countDocuments({ ownerId });
    },
    async ownerState(ownerId) {
      const { Set } = await ready();
      const d = plainDoc(await Set.findOne({ _id: ownerId }));
      return { exists: Boolean(d), deleted: Boolean(d?.deleted), connections: Object.keys(d?.connections ?? {}).length };
    },
    async countByConnector(connectorId, statuses = null) {
      const { Set } = await ready();
      let n = 0;
      for (const raw of await Set.find({ deleted: { $ne: true } })) {
        const d = plainDoc(raw);
        for (const r of Object.values(d.connections ?? {})) if (r.connectorId === connectorId && (!statuses || statuses.includes(r.status))) n++;
      }
      return n;
    },
  };
}

/** Exposed for the schema tests (no database needed to validate a document). */
export { connectionModel as _connectionModelForTests };
