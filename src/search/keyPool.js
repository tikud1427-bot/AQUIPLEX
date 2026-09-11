/**
 * AQUA Web Search — KeyPool
 *
 * Generic multi-API-key pool. One instance per search provider. The
 * orchestrator, SearchManager, and even the provider adapters never see a
 * raw key index or care which key served a request — the pool owns the
 * entire key lifecycle:
 *
 *   • Load keys automatically   — `${envPrefix}_1..N` plus the bare
 *     `${envPrefix}` (the project's .env carries e.g. SERPER_API_KEY and
 *     SERPER_API_KEY_1..4 — both are honored). Values are deduplicated so
 *     a key pasted into two slots is one key.
 *   • Skip empty keys           — blanks/whitespace slots are ignored.
 *   • Track usage / failures    — per-key counters + last-error metadata.
 *   • Rotate automatically      — round-robin across healthy keys, so load
 *     spreads evenly instead of exhausting key 1's quota first.
 *   • Retry with next key       — acquire() always returns a DIFFERENT
 *     non-cooled key than the last failed one when one exists.
 *   • Cooldown failed keys      — classification-aware durations (auth /
 *     quota long, rate_limit escalating ×2 per consecutive strike capped
 *     at 15 min, transient short). A success resets the strike counter.
 *   • Health monitoring         — stats() snapshot for /provider-health.
 *
 * Env is re-read on every getKeys() call (same convention gemini.js uses)
 * so ops can rotate keys and tests can mutate process.env without a restart.
 *
 * Zero external dependencies. Pure in-memory state.
 */

const MAX_KEY_SLOTS       = 20;                 // `${prefix}_1` … `${prefix}_20`
const RATE_LIMIT_CAP_MS   = 15 * 60 * 1_000;    // escalation ceiling
const DEFAULT_COOLDOWN_MS = 20 * 1_000;

export class KeyPool {
  /**
   * @param {{ name: string, envPrefix: string }} opts
   *   name      — provider name for logs ("serper")
   *   envPrefix — env var base ("SERPER_API_KEY")
   */
  constructor({ name, envPrefix }) {
    this.name      = name;
    this.envPrefix = envPrefix;
    this.cursor    = 0;                 // round-robin pointer
    /** @type {Map<string, {uses:number, successes:number, failures:number, consecutiveFailures:number, cooldownUntil:number, lastError:string|null, lastUsedAt:number}>} */
    this.state     = new Map();         // key value → runtime state
  }

  /** Read + dedupe keys from env. Order: bare key first, then _1.._N. */
  getKeys() {
    const raw = [process.env[this.envPrefix]];
    for (let i = 1; i <= MAX_KEY_SLOTS; i++) raw.push(process.env[`${this.envPrefix}_${i}`]);

    const seen = new Set();
    const keys = [];
    for (const k of raw) {
      const v = typeof k === 'string' ? k.trim() : '';
      if (!v || seen.has(v)) continue;   // skip empty + duplicate values
      seen.add(v);
      keys.push(v);
    }
    return keys;
  }

  hasKeys() { return this.getKeys().length > 0; }
  size()    { return this.getKeys().length; }

  _stateFor(key) {
    if (!this.state.has(key)) {
      this.state.set(key, {
        uses: 0, successes: 0, failures: 0, consecutiveFailures: 0,
        cooldownUntil: 0, lastError: null, lastUsedAt: 0,
      });
    }
    return this.state.get(key);
  }

  _onCooldown(key, now) { return this._stateFor(key).cooldownUntil > now; }

  /**
   * Acquire the next usable key, round-robin, skipping cooled keys.
   *
   * @param {{ exclude?: Set<string> }} [opts]
   *   exclude — key values already tried for THIS query (retry-with-next-key
   *   guarantee: never hand the same failing key back within one query).
   * @returns {{ key: string, index: number } | null}
   *   index is the position in the current env key list — logged (never the
   *   key itself) so ops can correlate failures to a specific slot.
   */
  acquire({ exclude } = {}) {
    const keys = this.getKeys();
    if (!keys.length) return null;
    const now = Date.now();

    for (let step = 0; step < keys.length; step++) {
      const i   = (this.cursor + step) % keys.length;
      const key = keys[i];
      if (exclude?.has(key)) continue;
      if (this._onCooldown(key, now)) continue;

      this.cursor = (i + 1) % keys.length;       // rotate for the next caller
      const s = this._stateFor(key);
      s.uses += 1;
      s.lastUsedAt = now;
      return { key, index: i };
    }

    // Everything cooled/excluded. Last resort: soonest-recovering non-excluded
    // key, ignoring its cooldown — one degraded attempt beats guaranteed
    // failure (mirrors router.js's all-providers-unhealthy degraded mode).
    let best = null;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (exclude?.has(key)) continue;
      const s = this._stateFor(key);
      if (!best || s.cooldownUntil < best.s.cooldownUntil) best = { key, index: i, s };
    }
    if (!best) return null;
    console.warn(`[SEARCH:${this.name}] all keys cooling — degraded attempt on key #${best.index + 1}`);
    best.s.uses += 1;
    best.s.lastUsedAt = Date.now();
    return { key: best.key, index: best.index };
  }

  /** @param {string} key */
  reportSuccess(key) {
    const s = this._stateFor(key);
    s.successes += 1;
    s.consecutiveFailures = 0;
    s.cooldownUntil = 0;
    s.lastError = null;
  }

  /**
   * @param {string} key
   * @param {{ kind: string, keyCooldownMs: number }} classified  from classifySearchError()
   */
  reportFailure(key, classified) {
    const s = this._stateFor(key);
    s.failures += 1;
    s.consecutiveFailures += 1;
    s.lastError = classified.kind;

    let cooldown = classified.keyCooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (classified.kind === 'rate_limit') {
      // Escalate: 60s, 120s, 240s … capped. Reset by any success.
      cooldown = Math.min(RATE_LIMIT_CAP_MS, cooldown * 2 ** (s.consecutiveFailures - 1));
    }
    if (cooldown > 0) s.cooldownUntil = Date.now() + cooldown;
  }

  /** Health snapshot for /provider-health. Never exposes key material. */
  stats() {
    const keys = this.getKeys();
    const now  = Date.now();
    let cooled = 0, uses = 0, failures = 0;
    const perKey = keys.map((key, i) => {
      const s = this._stateFor(key);
      const onCooldown = s.cooldownUntil > now;
      if (onCooldown) cooled += 1;
      uses += s.uses; failures += s.failures;
      return {
        slot: i + 1,
        uses: s.uses,
        successes: s.successes,
        failures: s.failures,
        onCooldown,
        cooldownRemainingMs: onCooldown ? s.cooldownUntil - now : 0,
        lastError: s.lastError,
      };
    });
    return {
      provider: this.name,
      totalKeys: keys.length,
      availableKeys: keys.length - cooled,
      cooledKeys: cooled,
      totalUses: uses,
      totalFailures: failures,
      keys: perKey,
    };
  }

  /** Test hook — wipe runtime state (keys themselves live in env). */
  __resetForTests() { this.state.clear(); this.cursor = 0; }
}
