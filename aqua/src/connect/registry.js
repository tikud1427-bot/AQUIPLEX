/**
 * AQUA Connect — connector registry (Phase 1b)
 *
 * One place that knows which connectors exist, what each declares, and how
 * healthy each is. A connector is a plain object that satisfies the contract
 * in ./contract.js; registering it validates that contract up front so a
 * malformed connector fails at load time, not in the middle of a user's sync.
 *
 * Registries are INSTANCES (createConnectorRegistry). The production default
 * (defaultRegistry) refuses connectors marked `testOnly`, so the deterministic
 * fake connector used by the test suite can never be registered — let alone
 * executed — in a running server. Tests build their own registry with
 * { allowTestOnly: true }.
 *
 * Health is tracked per connector from real outcomes (recordOutcome) plus the
 * connector's own health() probe: ok → degraded (consecutive failures) → down.
 */
import { validateConnectorDefinition } from './contract.js';
import { registerConnectorDataPolicy, isFrozenDataClass, externalDataClass } from '../core/dataClass.js';

const DEGRADED_AFTER = 1;
const DOWN_AFTER = 3;

export class ConnectorRegistryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function createConnectorRegistry({ allowTestOnly = false } = {}) {
  const connectors = new Map();   // id → frozen definition
  const health = new Map();       // id → { state, consecutiveFailures, lastError, lastOkAt, lastFailureAt }
  const dropPolicies = new Map(); // id → unregister fn of its data policy (G1-2)

  function register(definition) {
    const problems = validateConnectorDefinition(definition);
    if (problems.length) throw new ConnectorRegistryError('INVALID_CONNECTOR', `connector rejected: ${problems.join('; ')}`);
    if (definition.testOnly && !allowTestOnly) {
      throw new ConnectorRegistryError('TEST_ONLY_CONNECTOR', `connector "${definition.id}" is test-only and cannot be registered here`);
    }
    if (connectors.has(definition.id)) {
      throw new ConnectorRegistryError('DUPLICATE_CONNECTOR', `connector "${definition.id}" is already registered`);
    }
    // G1-2 — publish the connector's data policy. A frozen class (Gmail) keeps
    // the policy fixed in core/dataClass.js; a definition may not declare one.
    let dropPolicy = null;
    if (isFrozenDataClass(externalDataClass(definition.id))) {
      if (definition.dataPolicy !== undefined) {
        throw new ConnectorRegistryError('INVALID_CONNECTOR', `connector "${definition.id}": its data policy is fixed in code and cannot be declared`);
      }
    } else {
      try { dropPolicy = registerConnectorDataPolicy(definition.id, definition.dataPolicy ?? {}); }
      catch (err) { throw new ConnectorRegistryError('INVALID_CONNECTOR', `connector rejected: ${err.message}`); }
    }
    dropPolicies.set(definition.id, dropPolicy);
    connectors.set(definition.id, Object.freeze({ ...definition }));
    health.set(definition.id, { state: 'unknown', consecutiveFailures: 0, lastError: null, lastOkAt: null, lastFailureAt: null });
    return describe(definition.id);
  }

  /**
   * Remove a connector. Refused while it still has live connections (the
   * caller passes the count it read from the connection store) unless forced —
   * an unregistered connector could no longer revoke its credentials or have
   * its knowledge deleted through the normal disconnect path.
   */
  function unregister(id, { activeConnections = 0, force = false } = {}) {
    if (!connectors.has(id)) return false;
    if (activeConnections > 0 && !force) {
      throw new ConnectorRegistryError('CONNECTOR_IN_USE', `connector "${id}" still has ${activeConnections} connection(s); disconnect them first`);
    }
    connectors.delete(id);
    health.delete(id);
    dropPolicies.get(id)?.();      // its content becomes unclassified → no provider (fail closed)
    dropPolicies.delete(id);
    return true;
  }

  /** The definition, for the engine only. Throws for an unknown id. */
  function get(id) {
    const c = connectors.get(id);
    if (!c) throw new ConnectorRegistryError('UNKNOWN_CONNECTOR', `no connector "${String(id).slice(0, 60)}" is registered`);
    return c;
  }

  const has = id => connectors.has(id);

  /** Public, credential-free description (safe to show a user or log). */
  function describe(id) {
    const c = get(id);
    return {
      id: c.id, displayName: c.displayName, version: c.version,
      auth: { type: c.auth.type, scopes: [...(c.auth.scopes ?? [])] },
      capabilities: [...c.capabilities], resourceTypes: [...c.resourceTypes],
      permissions: [...c.permissions], testOnly: Boolean(c.testOnly),
      health: { ...health.get(id) },
    };
  }

  const list = () => [...connectors.keys()].map(describe);

  function recordOutcome(id, ok, error = null) {
    const h = health.get(id);
    if (!h) return;
    if (ok) {
      Object.assign(h, { state: 'ok', consecutiveFailures: 0, lastOkAt: Date.now() });
    } else {
      h.consecutiveFailures += 1;
      h.lastFailureAt = Date.now();
      h.lastError = error ? String(error).slice(0, 200) : null;
      h.state = h.consecutiveFailures >= DOWN_AFTER ? 'down' : h.consecutiveFailures >= DEGRADED_AFTER ? 'degraded' : h.state;
    }
  }

  /** Ask the connector itself (fail-safe: a throwing probe reports down). */
  async function probe(id) {
    const c = get(id);
    try {
      const r = await c.health();
      recordOutcome(id, Boolean(r?.ok), r?.ok ? null : r?.detail ?? 'unhealthy');
      return { ok: Boolean(r?.ok), detail: r?.detail ?? null };
    } catch (err) {
      recordOutcome(id, false, err?.message);
      return { ok: false, detail: 'health probe failed' };
    }
  }

  return { register, unregister, get, has, describe, list, recordOutcome, probe, allowTestOnly };
}

/** The production registry. Real connectors register here in later phases; none do yet. */
export const defaultRegistry = createConnectorRegistry({ allowTestOnly: false });
