/**
 * AQUA Connect — connection store (Phase 1b)
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
 *   createMemoryConnectionStore()   tests and local tooling
 *   createMongoConnectionStore()    production: the platform's EXISTING MongoDB
 *                                   connection (mongoose default), collection
 *                                   `aqua_connections`. No new database. Fails
 *                                   fast when Mongo is not connected instead of
 *                                   buffering, and never falls back to files.
 *
 * Interface:
 *   create(doc) · get(ownerId, id) · listByOwner(ownerId) · update(ownerId, id, patch)
 *   remove(ownerId, id) · countByConnector(connectorId, statuses?)
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

// ── In-memory ────────────────────────────────────────────────────────────────

export function createMemoryConnectionStore() {
  const rows = new Map();   // connectionId → doc
  const owned = (ownerId, id) => {
    const r = rows.get(id);
    return r && r.ownerId === ownerId ? r : null;
  };
  return {
    kind: 'memory',
    async create(doc) {
      if (rows.has(doc.connectionId)) throw new ConnectionStoreError('DUPLICATE', 'connection id collision');
      rows.set(doc.connectionId, clone({ ...doc, createdAt: doc.createdAt ?? Date.now(), updatedAt: Date.now() }));
      return clone(rows.get(doc.connectionId));
    },
    async get(ownerId, id) { return clone(owned(ownerId, id)); },
    async listByOwner(ownerId) { return [...rows.values()].filter(r => r.ownerId === ownerId).map(clone); },
    async update(ownerId, id, patch) {
      const r = owned(ownerId, id);
      if (!r) return null;
      Object.assign(r, clone(patch), { updatedAt: Date.now() });
      return clone(r);
    },
    async remove(ownerId, id) { return owned(ownerId, id) ? rows.delete(id) : false; },
    async countByConnector(connectorId, statuses = null) {
      return [...rows.values()].filter(r => r.connectorId === connectorId && (!statuses || statuses.includes(r.status))).length;
    },
    /** Test-only: the raw stored rows (to prove what is — and is not — at rest). */
    _rawForTests() { return [...rows.values()].map(clone); },
  };
}

// ── MongoDB (existing platform connection) ───────────────────────────────────

let modelPromise = null;
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
    createdAt:    Number,
    updatedAt:    Number,
  }, {
    collection: 'aqua_connections',
    bufferCommands: false,      // fail fast when Mongo is down — no silent queueing
    versionKey: false,
    toJSON:   { transform: (_d, r) => { delete r._id; delete r.credentials; return r; } },
    toObject: { transform: (_d, r) => { delete r._id; return r; } },
  });
  schema.index({ ownerId: 1, connectionId: 1 });
  return mongoose.model('AquaConnection', schema);
}

/**
 * @param {{ mongoose?: object }} [opts]  inject a mongoose instance (tests); default
 *        is the platform's shared default connection.
 */
export function createMongoConnectionStore({ mongoose: injected = null } = {}) {
  const ready = async () => {
    const mongoose = injected ?? (await import('mongoose')).default;
    if (mongoose.connection?.readyState !== 1) {
      throw new ConnectionStoreError('STORE_UNAVAILABLE', 'connection store unavailable (MongoDB not connected)');
    }
    return connectionModel(injected);
  };
  const plain = d => (d ? d.toObject() : null);
  return {
    kind: 'mongo',
    async create(doc) {
      const M = await ready();
      const now = Date.now();
      return plain(await M.create({ ...doc, createdAt: doc.createdAt ?? now, updatedAt: now }));
    },
    async get(ownerId, id) {
      const M = await ready();
      return plain(await M.findOne({ ownerId, connectionId: id }));
    },
    async listByOwner(ownerId) {
      const M = await ready();
      return (await M.find({ ownerId })).map(plain);
    },
    async update(ownerId, id, patch) {
      const M = await ready();
      return plain(await M.findOneAndUpdate({ ownerId, connectionId: id }, { $set: { ...patch, updatedAt: Date.now() } }, { new: true }));
    },
    async remove(ownerId, id) {
      const M = await ready();
      return (await M.deleteOne({ ownerId, connectionId: id })).deletedCount > 0;
    },
    async countByConnector(connectorId, statuses = null) {
      const M = await ready();
      return M.countDocuments(statuses ? { connectorId, status: { $in: statuses } } : { connectorId });
    },
  };
}

/** Exposed for the schema tests (no database needed to validate a document). */
export { connectionModel as _connectionModelForTests };
