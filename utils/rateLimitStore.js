/**
 * E12 — rate-limit store behind a backend interface (2026-10-04).
 *
 * express-rate-limit's default MemoryStore keeps counts per process, so with
 * two instances the effective limit doubles (the limitation noted at the
 * limiter definitions in index.js). This module is the seam, and (since
 * 2026-10-04) the shared backend too:
 *
 *   createRateLimitStore({ prefix, backend })  →  an express-rate-limit v8 Store
 *
 *   backend contract (all may be async):
 *     hit(key, windowMs)  → { count, resetAt }   increment within the window
 *     undo(key)                                    one request did not count
 *     reset(key)                                   clear the key
 *
 * `memoryBackend()` matches MemoryStore's fixed-window behaviour exactly
 * (bounded by sweeping expired windows) and is used when nothing is configured.
 * `redisBackend()` shares the window across processes: one atomic Lua script
 * per hit (INCR, PEXPIRE on the first hit, PTTL), dependency-free RESP2 over
 * net/tls. Activated by AQUA_RATE_LIMIT_REDIS_URL (redis:// or rediss://,
 * optional user:password@ and /db). If Redis is unreachable it degrades to
 * per-process memory counting — the previous behaviour — and counts the
 * fallback: a limiter must never take the site down. No key material; IPs are
 * already what the limiter keys on; nothing else is stored.
 */
'use strict';

function memoryBackend({ maxKeys = 50_000 } = {}) {
  const windows = new Map(); // key → { count, resetAt }
  const sweep = now => {
    if (windows.size < maxKeys) return;
    for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    while (windows.size >= maxKeys) windows.delete(windows.keys().next().value);  // G6: hard cap
  };
  return {
    kind: 'memory',
    hit(key, windowMs, now = Date.now()) {
      let w = windows.get(key);
      if (!w || w.resetAt <= now) { sweep(now); w = { count: 0, resetAt: now + windowMs }; windows.set(key, w); }
      w.count += 1;
      return { count: w.count, resetAt: w.resetAt };
    },
    undo(key) { const w = windows.get(key); if (w && w.count > 0) w.count -= 1; },
    reset(key) { windows.delete(key); },
    _size: () => windows.size,
  };
}

// ── Redis backend (shared across processes) ──────────────────────────────────
// Minimal RESP2 client: enough for AUTH / SELECT / EVAL / DEL. One connection,
// commands pipelined in order; replies matched FIFO.
function respEncode(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) { const s = String(a); out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
  return out;
}

/** Parse one RESP2 value from buf at i → [value, next] or null if incomplete. */
function respParse(buf, i = 0) {
  if (i >= buf.length) return null;
  const end = buf.indexOf('\r\n', i);
  if (end < 0) return null;
  const type = String.fromCharCode(buf[i]);
  const line = buf.toString('utf8', i + 1, end);
  const next = end + 2;
  if (type === '+') return [line, next];
  if (type === '-') return [Object.assign(new Error(line), { redis: true }), next];
  if (type === ':') return [Number(line), next];
  if (type === '$') {
    const n = Number(line);
    if (n < 0) return [null, next];
    if (buf.length < next + n + 2) return null;
    return [buf.toString('utf8', next, next + n), next + n + 2];
  }
  if (type === '*') {
    const n = Number(line);
    if (n < 0) return [null, next];
    const arr = [];
    let j = next;
    for (let k = 0; k < n; k++) {
      const r = respParse(buf, j);
      if (!r) return null;
      arr.push(r[0]); j = r[1];
    }
    return [arr, j];
  }
  throw new Error(`RESP: unexpected type ${type}`);
}

function redisClient(urlString, { connectTimeoutMs = 2000, commandTimeoutMs = 1000 } = {}) {
  const url = new URL(urlString);
  const secure = url.protocol === 'rediss:';
  const net = require(secure ? 'tls' : 'net');
  let socket = null;
  let ready = null;
  let buf = Buffer.alloc(0);
  const pending = [];

  function failAll(err) {
    while (pending.length) pending.shift().reject(err);
    socket = null; ready = null; buf = Buffer.alloc(0);
  }
  function raw(args) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('redis command timeout')); socket?.destroy(); }, commandTimeoutMs);
      pending.push({
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      socket.write(respEncode(args));
    });
  }
  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const opts = { host: url.hostname, port: Number(url.port) || 6379, ...(secure ? { servername: url.hostname } : {}) };
      socket = net.connect(opts);
      socket.setNoDelay?.(true);
      const timer = setTimeout(() => { socket.destroy(new Error('redis connect timeout')); }, connectTimeoutMs);
      socket.once(secure ? 'secureConnect' : 'connect', async () => {
        clearTimeout(timer);
        try {
          const user = decodeURIComponent(url.username || '');
          const pass = decodeURIComponent(url.password || '');
          if (pass) await raw(user ? ['AUTH', user, pass] : ['AUTH', pass]);
          const db = Number(url.pathname.replace('/', '')) || 0;
          if (db) await raw(['SELECT', db]);
          resolve();
        } catch (e) { reject(e); socket.destroy(); }
      });
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const r = respParse(buf);
          if (!r) break;
          buf = buf.subarray(r[1]);
          const p = pending.shift();
          if (!p) continue;
          if (r[0] instanceof Error) p.reject(r[0]); else p.resolve(r[0]);
        }
      });
      socket.on('error', err => { clearTimeout(timer); reject(err); failAll(err); });
      socket.on('close', () => failAll(new Error('redis connection closed')));
    });
    ready.catch(() => { ready = null; });
    return ready;
  }
  return {
    async command(args) { await connect(); return raw(args); },
    close() { socket?.end(); socket = null; ready = null; },
  };
}

const HIT_LUA = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end local t = redis.call('PTTL', KEYS[1]) if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) t = tonumber(ARGV[1]) end return {c, t}";
const UNDO_LUA = "local c = tonumber(redis.call('GET', KEYS[1])) if c and c > 0 then return redis.call('DECR', KEYS[1]) end return 0";

function redisBackend({ url, client = null, fallback = memoryBackend(), onFallback = () => {} } = {}) {
  const c = client ?? redisClient(url);
  const stats = { fallbacks: 0 };
  const degrade = (err, fn) => { stats.fallbacks++; try { onFallback(err); } catch { /* never */ } return fn(); };
  return {
    kind: 'redis',
    stats,
    async hit(key, windowMs, now = Date.now()) {
      try {
        const [count, ttl] = await c.command(['EVAL', HIT_LUA, 1, key, windowMs]);
        return { count: Number(count), resetAt: now + Number(ttl) };
      } catch (err) { return degrade(err, () => fallback.hit(key, windowMs, now)); }
    },
    async undo(key) {
      try { await c.command(['EVAL', UNDO_LUA, 1, key]); } catch (err) { degrade(err, () => fallback.undo(key)); }
    },
    async reset(key) {
      try { await c.command(['DEL', key]); } catch (err) { degrade(err, () => fallback.reset(key)); }
    },
    close: () => c.close(),
  };
}

/** The backend the environment asks for: Redis when AQUA_RATE_LIMIT_REDIS_URL is set, else memory. */
function backendFromEnv(env = process.env) {
  const url = env.AQUA_RATE_LIMIT_REDIS_URL;
  if (!url) return memoryBackend();
  return redisBackend({ url, onFallback: err => console.warn(`[RATE-LIMIT] redis unavailable, per-process fallback: ${err?.message ?? err}`) });
}

function createRateLimitStore({ prefix = 'rl', backend = backendFromEnv() } = {}) {
  let windowMs = 60_000;
  const k = key => `${prefix}:${key}`;
  return {
    backendKind: backend.kind ?? 'custom',
    // express-rate-limit v8 Store interface
    init(options) { windowMs = Number(options?.windowMs) || windowMs; },
    async increment(key) {
      const { count, resetAt } = await backend.hit(k(key), windowMs);
      return { totalHits: count, resetTime: new Date(resetAt) };
    },
    async decrement(key) { await backend.undo(k(key)); },
    async resetKey(key) { await backend.reset(k(key)); },
    localKeys: backend.kind === 'memory',
  };
}

module.exports = { createRateLimitStore, memoryBackend, redisBackend, backendFromEnv };
