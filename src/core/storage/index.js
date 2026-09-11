/**
 * AQUA Storage — the adapter seam
 * Blueprint E3/PR-3
 *
 * `atomicStore.js` has carried this line in its header since Phase 3b:
 *
 *   "all six stores now persist through ONE interface, so a Postgres/Mongo
 *    adapter is a change here, not in six places."
 *
 * That claim was true and unexercised. This module makes it real: every byte
 * that leaves or enters a store now passes through an adapter, and there is
 * exactly one implementation.
 *
 * THIS PR CHANGES NO BEHAVIOUR
 * ----------------------------
 * The JSON adapter is the same filesystem code that was inline, moved. The
 * public API of `atomicStore` is untouched, all 19 consumers are untouched,
 * and the proof is the existing battery passing unchanged — which is why this
 * PR ships alone rather than alongside a second implementation.
 *
 * `setAdapter` exists for tests and for E3/PR-5's dual-write. It is NOT an
 * env-driven switch: swapping the substrate of every store on a string in a
 * `.env` is precisely the kind of change that should be a deliberate code path
 * with its own flag and its own drift job.
 */
import { createJsonFileAdapter } from './jsonFileAdapter.js';
import { createDualWriteAdapter } from './dualWriteAdapter.js';

const REQUIRED = ['id', 'existsSync', 'readSync', 'write', 'writeSync', 'copySync'];

/**
 * Every adapter must declare whether `writeSync` is durable on return.
 *
 * The file adapter is (temp-then-rename completes). The Postgres adapter is
 * not — Node has no synchronous Postgres client, so it writes behind a cache.
 * That is a real difference in guarantee, and an interface that let it go
 * undeclared would hide it until the first SIGTERM lost a store.
 */
const REQUIRED_FLAGS = ['syncDurable'];

let adapter = createJsonFileAdapter();

/** Throws unless the object implements the whole interface. */
export function assertAdapter(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('storage adapter must be an object');
  }
  for (const flag of REQUIRED_FLAGS) {
    if (typeof candidate[flag] !== 'boolean') {
      throw new TypeError(`storage adapter must declare ${flag} as a boolean — a durability guarantee cannot be implicit`);
    }
  }
  for (const member of REQUIRED) {
    if (member === 'id') {
      if (typeof candidate.id !== 'string' || !candidate.id) {
        throw new TypeError('storage adapter needs a non-empty string id — it goes in the boot line');
      }
      continue;
    }
    if (typeof candidate[member] !== 'function') {
      throw new TypeError(`storage adapter is missing ${member}()`);
    }
  }
  return true;
}

export function getAdapter() { return adapter; }

export function setAdapter(next) {
  assertAdapter(next);
  const previous = adapter;
  adapter = next;
  return previous;
}

export function resetAdapter() { adapter = createJsonFileAdapter(); }

export const ADAPTER_MEMBERS = Object.freeze([...REQUIRED]);
export const ADAPTER_FLAGS = Object.freeze([...REQUIRED_FLAGS]);


// ── E3/PR-5 — shadow mode ────────────────────────────────────────────────────
//
// `AQUA_STORE_PG=shadow` turns on dual-write: JSON stays authoritative and
// serves every read, Postgres receives a copy of every write. Off by default.
//
// This is a code path with its own flag rather than a silent env switch on the
// adapter itself, because swapping the substrate of every store is not the
// kind of change that should be one string away from happening by accident.

export const storeModeFromEnv = () =>
  String(process.env.AQUA_STORE_PG ?? 'off').toLowerCase() === 'shadow' ? 'shadow' : 'off';

/**
 * E3/PR-7 — which stores READ from Postgres.
 *
 * `AQUA_STORE_PG_READ=artifacts,attachments` — bare names, normalised to the
 * store filename. A list rather than a boolean because the epic flips one
 * store per PR: one store being trustworthy says nothing about another, and a
 * single global switch would make the careful ordering meaningless.
 */
export const readStoresFromEnv = () =>
  String(process.env.AQUA_STORE_PG_READ ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (s.startsWith('.aqua-') ? s : `.aqua-${s}`))
    .map(s => (s.endsWith('.json') ? s : `${s}.json`));

let mode = 'off';

/**
 * Install the adapter the environment asks for. Called once at boot.
 * Fails OPEN: if the Postgres side cannot be constructed, JSON keeps working
 * and the reason is printed. A migration step that can break startup is a
 * migration step nobody will enable.
 */
export async function configureStorageFromEnv() {
  mode = storeModeFromEnv();
  if (mode !== 'shadow') { resetAdapter(); return { mode: 'off', adapter: getAdapter().id }; }

  try {
    const { isConfigured } = await import('../db/pool.js');
    if (!isConfigured()) {
      mode = 'off';
      return { mode: 'off', adapter: getAdapter().id, reason: 'AQUA_STORE_PG=shadow but DATABASE_URL is not set' };
    }
    const { createPgBlobAdapter } = await import('./pgBlobAdapter.js');
    const shadow = createPgBlobAdapter();
    const requested = readStoresFromEnv();
    const notes = [];
    let readFrom = [];

    if (requested.length) {
      // 1 — HYDRATE FIRST. The Postgres adapter serves reads from a cache. An
      //     unhydrated cache answers null for everything, which the fallback
      //     would paper over on every single read — working, but with the new
      //     substrate contributing nothing and nobody noticing.
      await shadow.hydrate();

      // 2 — CHECK DRIFT PER STORE. A store whose two sides disagree does not
      //     flip, however loudly the env asked. This is the gate that makes
      //     the flip safe to attempt at all: the evidence is checked at the
      //     moment of the decision, not remembered from a report last week.
      const { primaryManifest, shadowManifest, diffManifests } = await import('../db/drift.js');
      const diff = diffManifests(primaryManifest(), await shadowManifest());
      const dirty = new Set([
        ...diff.mismatched.map(m => m.key),
        ...diff.missingShadow,
      ]);
      for (const store of requested) {
        if (dirty.has(store)) notes.push(`${store} still drifts — reads stay on JSON`);
        else readFrom.push(store);
      }
    }

    setAdapter(createDualWriteAdapter(createJsonFileAdapter(), shadow, { readFrom }));
    return { mode: 'shadow', adapter: getAdapter().id, readFrom, requested, notes };
  } catch (err) {
    mode = 'off';
    resetAdapter();
    return { mode: 'off', adapter: getAdapter().id, reason: `shadow mode unavailable: ${err.message}` };
  }
}

export const storeMode = () => mode;

/**
 * Await any deferred writes. The SIGTERM drain calls this because the Postgres
 * adapter reports `syncDurable: false` — its writeSync has only reached memory
 * when it returns.
 */
export async function flushStorage(timeoutMs = 5_000) {
  const a = getAdapter();
  if (typeof a.flush !== 'function') return 0;
  return Promise.race([
    a.flush(),
    new Promise(resolve => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]).catch(() => 0);
}

/** One boot line, always — L13, no dark stages. */
export function storageBootLine(result) {
  const r = result ?? { mode, adapter: getAdapter().id };
  if (r.mode !== 'shadow') {
    return `[STORE] backend=json-file shadow=off${r.reason ? ` (${r.reason})` : ''}`;
  }
  if (!r.readFrom?.length) {
    const why = r.notes?.length ? ` — ${r.notes.join('; ')}` : '';
    return `[STORE] backend=json-file shadow=postgres (JSON remains authoritative; no read comes from Postgres)${why}`;
  }
  const why = r.notes?.length ? ` · ${r.notes.join('; ')}` : '';
  return `[STORE] backend=json-file shadow=postgres reads=[${r.readFrom.join(', ')}] (all writes still go to both)${why}`;
}
