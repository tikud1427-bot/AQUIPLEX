/**
 * G1-2 — data classes and the egress guard.
 *
 * PROOF STYLE: every outbound path is driven with a SPY in place of the
 * network (SDK client factories, injected router providers, embedding
 * transports, fetch). Inside an `external:gmail` scope the spy must record
 * ZERO calls; the same call inside a `user` scope must reach the spy (the
 * positive control that shows the spy really sits on the path).
 *
 * No real provider, no network, no keys: fake key strings only.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const PROVIDER_ENV = /^(GEMINI_|Gemini_|GROQ_|OPENROUTER_|NVIDIA_|AQUA_PROVIDER_|AQUA_EMBEDDING_API_KEY|HF_TOKEN)/;
const stripEnv = () => { for (const k of Object.keys(process.env)) if (PROVIDER_ENV.test(k)) delete process.env[k]; };
stripEnv();

const DC = await import('../dataClass.js');
const EG = await import('../egressGuard.js');
const GEM = await import('../../providers/gemini.js');
const GROQ = await import('../../providers/groq.js');
const NV = await import('../../providers/nvidia.js');
const OR = await import('../../providers/openrouter.js');
const ROUTER = await import('../../providers/router.js');
const EMB = await import('../../embeddings/embeddingProvider.js');
const DED = await import('../../embeddings/dedicatedEmbedder.js');
const { createHuggingFaceCrossEncoder } = await import('../../brain/contextEngine/crossEncoder.js');
const { SearchProvider } = await import('../../search/providers/searchProvider.js');
const H = await import('../health.js');
const { createConnectorRegistry } = await import('../../connect/registry.js');

const realWarn = console.warn, realLog = console.log;
const logs = [];
console.warn = (...a) => logs.push(a.map(String).join(' '));
console.log = (...a) => logs.push(a.map(String).join(' '));
after(() => { console.warn = realWarn; console.log = realLog; stripEnv(); });

const GMAIL_SECRET = 'GMAIL-BODY: wire 9,400 EUR to account 7731 before Friday';
const gmail = fn => EG.runWithDataClass('external:gmail', fn);
const user = fn => EG.runWithDataClass('user', fn);
const blocked = err => err?.code === 'EGRESS_BLOCKED';

// ── 1. Policy ───────────────────────────────────────────────────────────────
describe('data classes — policy (core/dataClass.js)', () => {
  beforeEach(() => DC._resetConnectorDataPoliciesForTests());

  test('external:gmail has an EMPTY provider allowlist, and nothing can widen it', () => {
    assert.deepEqual([...DC.allowedProvidersFor('external:gmail')], []);
    for (const p of DC.PROVIDERS) assert.equal(DC.providerAllowedFor('external:gmail', p), false, p);
    assert.throws(() => DC.registerConnectorDataPolicy('gmail', { allowedProviders: '*' }), e => e.code === 'FROZEN_POLICY');
    assert.throws(() => DC.registerConnectorDataPolicy('gmail', { allowedProviders: ['gemini'] }), e => e.code === 'FROZEN_POLICY');
    assert.equal(DC.isUnrestricted('external:gmail'), false);
  });

  test('user and upload: every provider (today\'s behaviour)', () => {
    for (const c of ['user', 'upload']) for (const p of DC.PROVIDERS) assert.equal(DC.providerAllowedFor(c, p), true, `${c}/${p}`);
  });

  test('unknown, missing, unparseable and unregistered classes fail closed', () => {
    for (const c of [undefined, null, '', 'unclassified', 'external:', 'external:Gmail', 'External:x', 'admin', 'external:a b', 'external:notion']) {
      for (const p of DC.PROVIDERS) assert.equal(DC.providerAllowedFor(c, p), false, `${String(c)}/${p}`);
      assert.equal(DC.isUnrestricted(c), false, String(c));
    }
    assert.equal(DC.providerAllowedFor('user', 'some-new-vendor'), false, 'an unknown provider is never allowed');
  });

  test('a connector gets exactly what its definition declares; unregistering returns it to none', () => {
    const drop = DC.registerConnectorDataPolicy('notion', { allowedProviders: ['groq'] });
    assert.equal(DC.providerAllowedFor('external:notion', 'groq'), true);
    assert.equal(DC.providerAllowedFor('external:notion', 'gemini'), false);
    assert.equal(DC.isUnrestricted('external:notion'), false);
    drop();
    assert.equal(DC.providerAllowedFor('external:notion', 'groq'), false);
    assert.throws(() => DC.registerConnectorDataPolicy('notion', { allowedProviders: ['made-up'] }), e => e.code === 'INVALID_POLICY');
  });

  test('source ids map to their connector; anything else is unclassified (never user)', () => {
    assert.equal(DC.dataClassOfSource('gmail:conn_9'), 'external:gmail');
    assert.equal(DC.dataClassOfSource('fake:alpha'), 'external:fake');
    for (const s of [null, undefined, '', 'gmail', ':x', 'Gmail:x', '1abc:x']) assert.equal(DC.dataClassOfSource(s), DC.UNCLASSIFIED, String(s));
  });

  test('connector registry: a Gmail definition may not declare a policy; others publish theirs; unregister withdraws it', () => {
    const base = id => ({
      id, version: '1.0.0', displayName: id, auth: { type: 'oauth2', scopes: [] }, capabilities: ['list', 'fetch'],
      resourceTypes: ['document'], permissions: [], connect() {}, disconnect() {}, listResources() {}, fetchResource() {}, normalize() {}, health() {},
    });
    const reg = createConnectorRegistry();
    assert.throws(() => reg.register({ ...base('gmail'), dataPolicy: { allowedProviders: '*' } }), e => e.code === 'INVALID_CONNECTOR');
    reg.register(base('gmail'));                              // registrable — with the frozen empty policy
    assert.deepEqual([...DC.allowedProvidersFor('external:gmail')], []);
    reg.register({ ...base('drive'), dataPolicy: { allowedProviders: ['groq'] } });
    assert.equal(DC.providerAllowedFor('external:drive', 'groq'), true);
    reg.unregister('drive');
    assert.equal(DC.providerAllowedFor('external:drive', 'groq'), false);
    reg.register(base('notes'));                              // declares nothing → none
    assert.equal(DC.providerAllowedFor('external:notes', 'groq'), false);
    assert.throws(() => reg.register({ ...base('bad'), dataPolicy: { allowedProviders: 'groq' } }), e => e.code === 'INVALID_CONNECTOR');
  });
});

// ── 2. The guard ────────────────────────────────────────────────────────────
describe('egress guard (core/egressGuard.js)', () => {
  test('no scope at all → blocked (fail closed)', () => {
    assert.equal(EG.currentDataClasses(), null);
    assert.throws(() => EG.assertEgress('groq', 'generate'), e => blocked(e) && e.reason === 'DATA_CLASS_MISSING');
    assert.equal(EG.egressAllowed('gemini', 'embed'), false);
  });

  test('user scope → allowed; gmail scope → blocked for every provider and operation', async () => {
    await user(async () => { for (const p of DC.PROVIDERS) EG.assertEgress(p, 'generate'); });
    await gmail(async () => {
      for (const p of DC.PROVIDERS) for (const op of ['generate', 'stream', 'embed', 'rerank', 'search', 'media']) {
        assert.throws(() => EG.assertEgress(p, op), e => blocked(e) && e.reason === 'DATA_CLASS_RESTRICTED', `${p}/${op}`);
      }
    });
  });

  test('an unknown class in scope blocks (DATA_CLASS_UNKNOWN)', async () => {
    await EG.runWithDataClass('external:', async () => {
      assert.throws(() => EG.assertEgress('groq', 'generate'), e => e.reason === 'DATA_CLASS_UNKNOWN');
    });
  });

  test('mixed context: Gmail entering a user request taints the WHOLE request — no downgrade through the user class', async () => {
    await user(async () => {
      EG.assertEgress('groq', 'generate');                          // before: fine
      await gmail(async () => { /* e.g. a sync, or a lifecycle read */ });
      assert.deepEqual(EG.currentDataClasses().sort(), ['external:gmail', 'user']);
      assert.throws(() => EG.assertEgress('groq', 'generate'), blocked);
      // … including work spawned later from this request (timers, promises)
      await new Promise(r => setTimeout(r, 5));
      assert.throws(() => EG.assertEgress('gemini', 'embed'), blocked);
    });
    // a separate request is unaffected
    await user(async () => EG.assertEgress('groq', 'generate'));
  });

  test('classified content may not be read where its class cannot be tracked', () => {
    assert.throws(() => EG.noteDataClasses(['external:gmail']), e => e.code === 'DATA_CLASS_SCOPE_MISSING');
  });

  test('observability carries class names and counts, never content', async () => {
    EG._resetEgressStatsForTests();
    logs.length = 0;
    await gmail(async () => { try { EG.assertEgress('groq', 'generate'); } catch { /* expected */ } });
    const s = EG.egressStats();
    assert.deepEqual(s.blocked.map(b => [b.provider, b.operation, b.reason, b.classes, b.count]), [['groq', 'generate', 'DATA_CLASS_RESTRICTED', ['external:gmail'], 1]]);
    assert.ok(logs.some(l => l.includes('[EGRESS] blocked provider=groq')));
    assert.ok(!logs.some(l => l.includes('GMAIL-BODY')));
  });
});

// ── 3. Every transport, with spies ──────────────────────────────────────────
const msgs = [{ role: 'user', content: GMAIL_SECRET }];

function geminiSpy() {
  const calls = [];
  GEM.__setClientFactoryForTests(() => ({ models: {
    generateContent: async req => { calls.push(JSON.stringify(req)); return { text: 'ok', candidates: [{ finishReason: 'STOP' }], usageMetadata: {} }; },
    generateContentStream: async req => { calls.push(JSON.stringify(req)); return (async function* () { yield { text: 'ok', candidates: [{}] }; })(); },
  } }));
  return calls;
}
function groqSpy() {
  const calls = [];
  GROQ.__setClientFactoryForTests(() => ({ chat: { completions: { create: async body => {
    calls.push(JSON.stringify(body));
    if (body.stream) return (async function* () { yield { choices: [{ delta: { content: 'ok' }, finish_reason: null }] }; })();
    return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  } } } }));
  return calls;
}
/** NVIDIA/OpenRouter use the OpenAI SDK, whose only exit is fetch. */
function fetchSpy() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: String(init?.body ?? '') }); throw Object.assign(new Error('spy: network disabled'), { status: 503 }); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const sent = calls => calls.some(c => JSON.stringify(c).includes('GMAIL-BODY'));

describe('transports — Gmail content never reaches a spy; user content does (positive control)', () => {
  beforeEach(() => {
    stripEnv();
    GEM.__resetForTests(); GROQ.__resetForTests(); NV.__resetForTests(); OR.__resetForTests(); H.__resetForTests?.();
    process.env.GEMINI_KEY_1 = 'gm-SECRET-1';
    process.env.GROQ_API_KEY_1 = 'gq-SECRET-1';
    process.env.NVIDIA_API_KEY_1 = 'nv-SECRET-1';
    process.env.OPENROUTER_API_KEY_1 = 'or-SECRET-1';
  });

  test('Gemini: generate, stream and media analysis', async () => {
    const calls = geminiSpy();
    await gmail(async () => {
      await assert.rejects(GEM.generateGemini('sys', msgs), blocked);
      await assert.rejects(GEM.streamGemini('sys', msgs, undefined, undefined, () => {}), blocked);
      await assert.rejects(GEM.analyzeMediaWithGemini([{ text: GMAIL_SECRET }], {}), blocked);
    });
    assert.equal(calls.length, 0);
    await user(async () => { await GEM.generateGemini('sys', [{ role: 'user', content: 'hello' }]); });
    assert.equal(calls.length, 1, 'positive control: the spy is on the path');
  });

  test('Groq: generate and stream', async () => {
    const calls = groqSpy();
    await gmail(async () => {
      await assert.rejects(GROQ.generateGroq('sys', msgs), blocked);
      await assert.rejects(GROQ.streamGroq('sys', msgs, undefined, undefined, () => {}), blocked);
    });
    assert.equal(calls.length, 0);
    await user(async () => { await GROQ.generateGroq('sys', [{ role: 'user', content: 'hello' }]); });
    assert.equal(calls.length, 1);
  });

  test('NVIDIA and OpenRouter: generate and stream (OpenAI SDK → fetch)', async () => {
    const f = fetchSpy();
    try {
      await gmail(async () => {
        await assert.rejects(NV.generateNvidia('sys', msgs), blocked);
        await assert.rejects(NV.streamNvidia('sys', msgs, undefined, undefined, () => {}), blocked);
        await assert.rejects(OR.generateOpenRouter('sys', msgs), blocked);
        await assert.rejects(OR.streamOpenRouter('sys', msgs, undefined, undefined, () => {}), blocked);
      });
      assert.equal(f.calls.length, 0);
      await user(async () => {
        await OR.generateOpenRouter('sys', [{ role: 'user', content: 'hello' }]).catch(e => assert.ok(!blocked(e), 'user content was blocked'));
      });
      assert.ok(f.calls.length >= 1, 'positive control: OpenRouter reached fetch');
    } finally { f.restore(); }
  });

  test('router: every ranked provider, fallback and retry round — injected providers never called; fails at once, no health penalty', async () => {
    const calls = [];
    const spy = name => async () => { calls.push(name); return { text: 'A complete answer from the spy provider, long enough to pass validation.', truncated: false, finishReason: 'stop', model: name }; };
    const deps = { gemini: spy('gemini'), groq: spy('groq'), openrouter: spy('openrouter'), nvidia: spy('nvidia'),
      sleep: async () => {}, config: { maxRounds: 3, retryBudgetMs: 60_000 } };
    const before = JSON.stringify(["gemini","groq","openrouter","nvidia"].map(p => H.getProviderState(p)));
    const t0 = Date.now();
    await gmail(async () => {
      await assert.rejects(ROUTER.generateText(GMAIL_SECRET, 'sys', msgs, {}, 'chat', undefined, undefined, deps), blocked);
    });
    assert.deepEqual(calls, []);
    assert.ok(Date.now() - t0 < 2000, 'no retry rounds / backoff for a blocked call');
    assert.equal(JSON.stringify(["gemini","groq","openrouter","nvidia"].map(p => H.getProviderState(p))), before, 'a blocked provider must not be marked failed');
    // mixed scope (user request that touched Gmail) is just as blocked
    await user(async () => { await gmail(async () => {}); await assert.rejects(ROUTER.generateText('hi', 'sys', msgs, {}, 'chat', undefined, undefined, deps), blocked); });
    assert.deepEqual(calls, []);
    await user(async () => { await ROUTER.generateText('hello', 'sys', [{ role: 'user', content: 'hello' }], {}, 'chat', undefined, undefined, deps); });
    assert.equal(calls.length, 1, 'positive control');
  });

  test('router with a PARTIAL allowlist: only allowed providers are tried; the others are not attempted or penalised', async () => {
    // allow ONLY the provider the router would try LAST, so every other one is in the way
    const ranked = ROUTER.rankProviders('chat').map(r => r.provider);
    const last = ranked.at(-1);
    const drop = DC.registerConnectorDataPolicy('partial', { allowedProviders: [last] });
    try {
      const calls = [];
      const spy = name => async () => { calls.push(name); return { text: 'A complete answer from the spy provider, long enough to pass validation.', truncated: false, finishReason: 'stop', model: name }; };
      const deps = { gemini: spy('gemini'), groq: spy('groq'), openrouter: spy('openrouter'), nvidia: spy('nvidia'), sleep: async () => {} };
      const states = () => JSON.stringify(ranked.filter(p => p !== last).map(p => H.getProviderState(p)));
      const before = states();
      const r = await EG.runWithDataClass('external:partial', () => ROUTER.generateText('q', 'sys', [{ role: 'user', content: 'q' }], {}, 'chat', undefined, undefined, deps));
      assert.deepEqual(calls, [last]);
      assert.equal(states(), before, 'a provider the class does not allow was attempted (and penalised)');
      assert.ok(!(r.fallbackChain ?? []).some(f => f.provider !== last), JSON.stringify(r.fallbackChain));
    } finally { drop(); }
  });

  test('router streaming: no stream provider is called', async () => {
    const calls = [];
    const s = name => async (_sys, _m, _sig, _max, onDelta) => { calls.push(name); onDelta('ok'); return { text: 'ok', model: name, finishReason: 'stop' }; };
    const deps = { stream: { gemini: s('gemini'), groq: s('groq'), openrouter: s('openrouter'), nvidia: s('nvidia') } };
    await gmail(async () => {
      await assert.rejects(ROUTER.generateTextStream({ userMessage: GMAIL_SECRET, systemPrompt: 'sys', messages: msgs, ctx: {}, preTaskType: 'chat', onEvent: () => {}, deps }), blocked);
    });
    assert.deepEqual(calls, []);
    await user(async () => {
      await ROUTER.generateTextStream({ userMessage: 'hi', systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }], ctx: {}, preTaskType: 'chat', onEvent: () => {}, deps });
    });
    assert.equal(calls.length, 1, 'positive control');
  });

  test('embeddings (file memory / recall): no vector requested; keyword fallback (nulls)', async () => {
    const seen = [];
    EMB.__setEmbedderForTests(async texts => { seen.push(...texts); return texts.map(() => [1, 0]); });
    try {
      const out = await gmail(() => EMB.embed([GMAIL_SECRET, 'other']));
      assert.deepEqual(out, [null, null]);
      assert.equal(await gmail(() => EMB.embedOne(GMAIL_SECRET)), null);
      assert.deepEqual(seen, []);
      assert.deepEqual(await user(() => EMB.embed(['hello'])), [[1, 0]], 'positive control');
    } finally { EMB.__clearEmbedderForTests(); }
  });

  test('dedicated recall embedder: transport never called', async () => {
    process.env.AQUA_EMBEDDING_API_KEY = 'emb-SECRET-1';
    DED.__resetDedicatedForTests();
    const seen = [];
    DED.__setDedicatedTransportForTests(async (_key, texts) => { seen.push(...texts); return texts.map(() => [0.5]); });
    try {
      assert.deepEqual(await gmail(() => DED.dedicatedEmbed([GMAIL_SECRET])), [null]);
      assert.deepEqual(seen, []);
      await user(() => DED.dedicatedEmbed(['hello']));
      assert.equal(seen.length, 1, 'positive control: the transport is on the path');
    } finally { DED.__clearDedicatedTransportForTests(); delete process.env.AQUA_EMBEDDING_API_KEY; }
  });

  test('reranking (cross-encoder): fetch never called', async () => {
    const seen = [];
    const ce = createHuggingFaceCrossEncoder({ token: 'hf-SECRET', fetchImpl: async (u, init) => { seen.push(init.body); return { ok: true, json: async () => [{ label: 'relevant', score: 0.9 }] }; } });
    await gmail(async () => { await assert.rejects(ce.scorePair('q', { text: GMAIL_SECRET }), blocked); });
    assert.deepEqual(seen, []);
    assert.equal(await user(() => ce.scorePair('q', { text: 'hello' })), 0.9, 'positive control');
  });

  test('web search: a query is egress too — fetch never called', async () => {
    const seen = [];
    class Spy extends SearchProvider { async search(q, o) { return this._post('https://example.invalid/search', { key: 'k', headers: {}, body: { q }, timeoutMs: 1000, signal: o?.signal }); } }
    const sp = new Spy({ name: 'serper', keyPool: { hasKeys: () => true, stats: () => ({}) }, fetchImpl: async (u, init) => { seen.push(init.body); return { ok: true, json: async () => ({ organic: [] }) }; } });
    await gmail(async () => { await assert.rejects(sp.search(GMAIL_SECRET), blocked); });
    assert.deepEqual(seen, []);
    await user(() => sp.search('hello'));
    assert.equal(seen.length, 1, 'positive control');
    const rogue = new Spy({ name: 'brave', keyPool: { hasKeys: () => true, stats: () => ({}) }, fetchImpl: async () => { seen.push('rogue'); return { ok: true, json: async () => ({}) }; } });
    await user(async () => { await assert.rejects(rogue.search('hello'), blocked, 'an unlisted vendor is never allowed'); });
  });

  test('no scope: every transport refuses (fail closed) and no spy is reached', async () => {
    const g = geminiSpy(), q = groqSpy();
    await assert.rejects(GEM.generateGemini('sys', msgs), e => e.reason === 'DATA_CLASS_MISSING');
    await assert.rejects(GROQ.generateGroq('sys', msgs), e => e.reason === 'DATA_CLASS_MISSING');
    EMB.__setEmbedderForTests(async t => t.map(() => [1]));
    try { assert.deepEqual(await EMB.embed([GMAIL_SECRET]), [null]); } finally { EMB.__clearEmbedderForTests(); }
    assert.equal(g.length + q.length, 0);
  });
});

// ── 4. Entry points ─────────────────────────────────────────────────────────
describe('entry points open a scope', () => {
  test('aqua/router.js runs every AQUA route inside a `user` scope (mounted before any route)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../../router.js', import.meta.url), 'utf8');
    const scopeAt = src.indexOf("router.use(dataClassScope('user'));");
    const firstRoute = src.search(/router\.use\("\/chat"/);
    assert.ok(scopeAt > 0 && firstRoute > scopeAt, 'the data-class scope must be mounted before the routes');
  });

  test('dataClassScope: a request handler and its async continuations see the scope', async () => {
    const express = (await import('express')).default;
    const app = express();
    app.use(EG.dataClassScope('user'));
    app.get('/x', async (_req, res) => { await new Promise(r => setTimeout(r, 2)); res.json({ classes: EG.currentDataClasses(), allowed: EG.wouldAllowEgress('groq') }); });
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const realFetch = globalThis.fetch;
      const body = await (await realFetch(`http://127.0.0.1:${server.address().port}/x`)).json();
      assert.deepEqual(body, { classes: ['user'], allowed: true });
    } finally { server.close(); }
  });

  test('worker: each job runs in its own scope (document jobs: upload; external: their resource class)', async () => {
    const W = await import('../jobs/workerRuntime.js');
    const src = (await import('node:fs')).readFileSync(new URL('../jobs/workerRuntime.js', import.meta.url), 'utf8');
    assert.match(src, /const outcome = await runWithDataClass\(/);
    assert.ok(W.HANDLERS);
  });
});
