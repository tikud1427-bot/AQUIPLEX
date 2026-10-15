#!/usr/bin/env node
/**
 * AQUA — provider key-pool doctor.
 *
 *   node scripts/provider-keys-doctor.mjs                  # OFFLINE: what is configured (../.env)
 *   node scripts/provider-keys-doctor.mjs path/to/.env
 *   node scripts/provider-keys-doctor.mjs --process-env    # inspect this process's env instead
 *   node scripts/provider-keys-doctor.mjs --probe          # OPT-IN live auth check, one read-only call per slot
 *   node scripts/provider-keys-doctor.mjs --probe --provider gemini --json
 *
 * OFFLINE (default) makes NO network call. It reports, per provider, the slots
 * discovered, distinct credentials, duplicate and blank slots ignored, and any
 * slot whose value does not have the provider's documented key shape. Shape is
 * NOT validity — a non-standard value is flagged "validity unknown", never
 * called invalid (scripts/env-doctor.mjs records why).
 *
 * --probe sends ONE read-only, authenticated, non-generating request per slot,
 * sequentially, 10 s timeout each — the only way to know whether a credential
 * works the way the app uses it:
 *   gemini      GET  generativelanguage.googleapis.com/v1beta/models?pageSize=1  (x-goog-api-key)
 *   groq        GET  api.groq.com/openai/v1/models                               (Bearer)
 *   openrouter  GET  openrouter.ai/api/v1/key                                    (Bearer) — also
 *               reports free-tier status and remaining credit limit (non-secret)
 *   nvidia      not probed: its model list is public, so no read-only call proves
 *               a key. `npm run smoke:nvidia` makes a real (billed) completion.
 * Nothing it learns is written anywhere; the running app keeps its own state.
 *
 * Output names slots ("#3", "#bare") and HTTP statuses only. It never prints a
 * key, a fragment or hash of one, a header, or a response body.
 *
 * Safe to run next to production config: it imports ONLY the dependency-free
 * key pool (src/providers/keyPool.cjs) — no app module, no database, no mirror.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KeyPool, MemoryStateStore, PROVIDERS, SPECS, classifyKeyFailure } = require('../src/providers/keyPool.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_TIMEOUT_MS = 10_000;

export function parseEnvText(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value; // last assignment wins, as dotenv does
  }
  return out;
}

const PROBES = {
  gemini: key => ({
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: { 'x-goog-api-key': key },
  }),
  groq: key => ({ url: 'https://api.groq.com/openai/v1/models', headers: { Authorization: `Bearer ${key}` } }),
  openrouter: key => ({ url: 'https://openrouter.ai/api/v1/key', headers: { Authorization: `Bearer ${key}` }, readQuota: true }),
};

/**
 * One probe. Returns { result, status, quota? } — never a body.
 * @param {(url: string, init: object) => Promise<Response>} fetchFn  injectable (tests)
 */
export async function probeOne(provider, key, fetchFn = fetch) {
  const p = PROBES[provider]?.(key);
  if (!p) return { result: 'not_probed', status: null };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(p.url, { method: 'GET', headers: p.headers, signal: ac.signal });
    let quota;
    let bodyText = '';
    try { bodyText = await res.text(); } catch { /* ignore */ }
    if (res.ok) {
      if (p.readQuota) {
        try {
          const d = JSON.parse(bodyText)?.data ?? {};
          quota = {
            freeTier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
            limit: Number.isFinite(d.limit) ? d.limit : null,                     // null = unlimited / unknown
            limitRemaining: Number.isFinite(d.limit_remaining) ? d.limit_remaining : null,
            usage: Number.isFinite(d.usage) ? d.usage : null,
          };
        } catch { quota = null; }
      }
      return { result: 'authenticated', status: res.status, ...(quota !== undefined ? { quota } : {}) };
    }
    // Classify with the same rules the app uses; the body is read, never printed.
    const k = classifyKeyFailure({ status: res.status, message: bodyText.slice(0, 2000) });
    const result = k.kind === 'auth' ? 'rejected'
      : k.kind === 'billing' ? 'billing'
        : k.kind === 'rate_limit' ? 'rate_limited (credential accepted)'
          : 'error';
    return { result, status: res.status };
  } catch (err) {
    return { result: err?.name === 'AbortError' ? 'timeout' : 'network_error', status: null };
  } finally {
    clearTimeout(t);
  }
}

export function offlineReport(env) {
  const out = {};
  for (const provider of PROVIDERS) {
    const pool = new KeyPool(provider, { env: () => env, store: new MemoryStateStore() });
    const snap = pool.snapshot();
    out[provider] = {
      summary: snap.summary,
      discoveredSlots: snap.discoveredSlots,
      distinctCredentials: snap.distinctCredentials,
      duplicateSlotsIgnored: snap.duplicateSlotsIgnored,
      blankSlotsIgnored: snap.blankSlotsIgnored,
      slots: snap.slots.map(s => ({ slot: s.slot, envName: s.envName, format: s.format === 'recognized' ? 'standard' : 'non-standard (validity unknown)' })),
      expectedFormat: SPECS[provider].formatName,
    };
  }
  return out;
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = f => args.includes(f);
  const valueOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const only = valueOf('--provider');
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--provider');

  let env, source;
  if (flag('--process-env')) { env = process.env; source = 'process environment'; }
  else {
    const file = positional[0] ?? path.join(HERE, '..', '..', '.env');
    if (!existsSync(file)) { console.error(`✗ env file not found: ${file}`); process.exit(2); }
    env = parseEnvText(readFileSync(file, 'utf8'));
    source = path.relative(process.cwd(), file) || file;
  }

  const report = { source, offline: offlineReport(env), probe: null };

  if (flag('--probe')) {
    report.probe = {};
    for (const provider of PROVIDERS) {
      if (only && provider !== only) continue;
      const pool = new KeyPool(provider, { env: () => env, store: new MemoryStateStore() });
      const rows = [];
      for (const e of pool.entries()) {
        const r = PROBES[provider] ? await probeOne(provider, e.key) : { result: 'not_probed', status: null };
        rows.push({ slot: e.slot, ...r });
      }
      report.probe[provider] = rows;
    }
  }

  if (flag('--json')) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log(`Provider key pools — source: ${report.source}${report.probe ? ' — LIVE PROBE' : ' — offline (no network calls)'}\n`);
  for (const [provider, r] of Object.entries(report.offline)) {
    if (only && provider !== only) continue;
    console.log(`■ ${r.summary}`);
    if (r.slots.length) {
      const odd = r.slots.some(s => s.format !== 'standard');
      console.log(`    slots: ${r.slots.map(s => `${s.slot}${s.format === 'standard' ? '' : '*'}`).join(' ')}${odd ? `   (* = not shaped like a ${r.expectedFormat}; validity unknown until probed)` : ''}`);
    }
    if (r.blankSlotsIgnored.length) console.log(`    blank slots ignored: ${r.blankSlotsIgnored.join(' ')}`);
    const probed = report.probe?.[provider];
    if (probed) {
      if (!probed.length) console.log('    probe: nothing to probe');
      for (const p of probed) {
        const q = p.quota ? ` — freeTier=${p.quota.freeTier ?? 'unknown'} limitRemaining=${p.quota.limitRemaining ?? 'unknown/unlimited'}` : '';
        console.log(`    probe ${p.slot.padEnd(8)} ${p.result}${p.status ? ` (HTTP ${p.status})` : ''}${q}`);
      }
      if (provider === 'nvidia' && probed.length) console.log('    (NVIDIA has no read-only authenticated endpoint; `npm run smoke:nvidia` makes a real billed call)');
    }
    console.log('');
  }
  if (!report.probe) console.log('Credential health: unknown until a real call succeeds. Run with --probe for a read-only live check.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).catch(err => { console.error(`✗ ${err.message}`); process.exit(1); });
}
