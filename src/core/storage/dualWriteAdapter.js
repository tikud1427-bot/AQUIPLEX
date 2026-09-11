/**
 * AQUA Storage — dual write
 * Blueprint E3/PR-5
 *
 * Writes to two adapters. Reads from exactly one.
 *
 * THE ASYMMETRY IS THE WHOLE DESIGN
 * ---------------------------------
 *   primary   JSON files. Authoritative. Every read comes from here, every
 *             write must succeed here, and a failure propagates.
 *   shadow    Postgres. Write-only. Failures are counted and logged and NEVER
 *             propagate.
 *
 * Nothing reads from the shadow in this mode — not once. That is what makes
 * shadow mode safe to switch on in production: the worst case for a completely
 * broken Postgres is a log line per write and a non-zero drift counter. The
 * data users depend on is untouched, because the code path that serves them
 * never consults the new store.
 *
 * E3/PR-6 adds the drift job that reads both and compares. E3/PR-7 onward flip
 * the read path one store at a time, and only after drift has been zero for a
 * week. This PR does none of that.
 *
 * WHY A FAILING SHADOW MUST NOT THROW
 * -----------------------------------
 * If a shadow failure propagated, enabling shadow mode would make the engine
 * LESS reliable than leaving it off — a migration step that increases risk
 * before it delivers any benefit is a migration step nobody will turn on. The
 * counter and the log are how it stays visible instead.
 */

/** Store paths are compared by basename — the same key the blob table uses. */
const storeName = key => String(key).split(/[\\/]/).pop();

export function createDualWriteAdapter(primary, shadow, { onShadowError, readFrom = [] } = {}) {
  let shadowFailures = 0;
  let shadowWrites = 0;
  let shadowReads = 0;
  let readFallbacks = 0;

  /**
   * E3/PR-7 — the store keys whose READS come from the shadow.
   *
   * Empty by default, which is PR-5's behaviour exactly. A store only appears
   * here after its drift has been clean, and it is checked per store rather
   * than globally: one store being trustworthy says nothing about another.
   */
  const readShadow = new Set(readFrom);

  const shadowSafely = (label, fn) => {
    try {
      const out = fn();
      if (out && typeof out.then === 'function') {
        return out.then(
          () => { shadowWrites++; },
          err => { record(label, err); },
        );
      }
      shadowWrites++;
      return undefined;
    } catch (err) {
      record(label, err);
      return undefined;
    }
  };

  const record = (label, err) => {
    shadowFailures++;
    const msg = `[STORE] shadow write failed (${label}): ${err?.message ?? err}`;
    if (onShadowError) onShadowError(err, label); else console.error(msg);
  };

  return {
    id: `dual(${primary.id}→${shadow.id})`,

    // The authoritative store decides. A dual-write is exactly as durable on
    // return as its primary, and claiming otherwise would misinform the
    // shutdown drain about whether it still has work to do.
    syncDurable: primary.syncDurable,

    // ── reads: primary, unless this store has been explicitly flipped ──────
    //
    // The fallback is the load-bearing part. A shadow that returns null for a
    // store the primary HAS would otherwise present as an empty store — which
    // to a user is indistinguishable from total data loss, delivered silently.
    // So a null from the shadow is never trusted: the primary answers, the
    // fallback is counted, and the drift job will show why.
    existsSync(key) {
      if (!readShadow.has(storeName(key))) return primary.existsSync(key);
      return shadow.existsSync(key) || primary.existsSync(key);
    },

    readSync(key) {
      const name = storeName(key);
      if (!readShadow.has(name)) return primary.readSync(key);

      let value = null;
      try {
        value = shadow.readSync(key);
      } catch (err) {
        record('readSync', err);
      }
      if (value !== null && value !== undefined) { shadowReads++; return value; }

      const fromPrimary = primary.readSync(key);
      if (fromPrimary !== null) {
        readFallbacks++;
        console.error(`[STORE] ${name}: shadow read was empty, served from JSON — check drift`);
      }
      return fromPrimary;
    },

    // ── writes: primary must succeed, shadow is best effort ────────────────
    async write(key, data) {
      await primary.write(key, data);           // throws → caller sees it
      await shadowSafely('write', () => shadow.write(key, data));
    },

    writeSync(key, data) {
      primary.writeSync(key, data);             // throws → caller sees it
      shadowSafely('writeSync', () => shadow.writeSync(key, data));
    },

    copySync(from, to) {
      primary.copySync(from, to);
      shadowSafely('copySync', () => shadow.copySync(from, to));
    },

    /** Awaited by the SIGTERM drain — the shadow writes behind a cache. */
    async flush() {
      if (typeof shadow.flush !== 'function') return 0;
      try {
        return await shadow.flush();
      } catch (err) {
        record('flush', err);
        return 0;
      }
    },

    stats() { return { shadowWrites, shadowFailures, shadowReads, readFallbacks }; },
    readsFromShadow() { return [...readShadow]; },
    _primary: primary,
    _shadow: shadow,
  };
}
