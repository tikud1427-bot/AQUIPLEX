/**
 * AQUA Web Search — Regression Suite
 *
 * Run: node --test src/search/tests/search.test.js   (aqua/ package)
 *
 * Everything network-shaped is exercised through injected mock providers /
 * env mutation — zero real HTTP. Covers every module's contract plus the
 * orchestrator wiring (web_search capability flips with agent registration
 * + message content) and the fail-open guarantee.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { KeyPool }                       from '../keyPool.js';
import { getSearchConfig }               from '../searchConfig.js';
import { classifySearchError }           from '../searchErrors.js';
import { normalizeQuery, cacheGet, cacheSet, cacheInvalidate, cacheStats, __resetSearchCacheForTests } from '../searchCache.js';
import { rankResults, canonicalUrl }     from '../resultRanker.js';
import { extractSearchContext }          from '../contextExtractor.js';
import { decideWebSearch, buildSearchQuery } from '../searchDecision.js';
import { routedSearch, __resetSearchRouterForTests, getSearchRouterHealth } from '../searchRouter.js';
import { performSearch, getSearchHealth, invalidateSearchCache } from '../searchManager.js';
import { SearchProvider }                from '../providers/searchProvider.js';
import { SerperProvider }                from '../providers/serperProvider.js';
import { TavilyProvider }                from '../providers/tavilyProvider.js';
import '../searchAgent.js';
import { getAgent }                      from '../../intelligence/agentRegistry.js';
import { orchestrate }                   from '../../orchestrator/toolOrchestrator.js';
import { buildSystemPrompt }             from '../../core/promptBuilder.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'SERPER_API_KEY', 'TAVILY_API_KEY',
  ...Array.from({ length: 20 }, (_, i) => `SERPER_API_KEY_${i + 1}`),
  ...Array.from({ length: 20 }, (_, i) => `TAVILY_API_KEY_${i + 1}`),
  'SEARCH_TIMEOUT', 'SEARCH_MAX_RESULTS', 'SEARCH_PROVIDER_PRIORITY',
  'SEARCH_CACHE_TTL', 'SEARCH_ENABLE_CACHE', 'SEARCH_RETRY_LIMIT',
  'SEARCH_CONTEXT_TOKENS', 'SEARCH_CACHE_MAX_ENTRIES',
];

function cleanEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

/** Configurable in-memory provider for router/manager tests. */
class MockProvider extends SearchProvider {
  constructor({ name, keys = 2, behavior }) {
    const prefix = `MOCK_${name.toUpperCase()}`;
    // Env hygiene: clear ALL slots first — a previous test's wider pool must
    // never leak keys into this instance (KeyPool re-reads env every call).
    delete process.env[prefix];
    for (let i = 1; i <= 20; i++) delete process.env[`${prefix}_${i}`];
    const pool = new KeyPool({ name, envPrefix: prefix });
    for (let i = 1; i <= keys; i++) process.env[`${prefix}_${i}`] = `${name}-key-${i}`;
    super({ name, keyPool: pool });
    this.behavior = behavior;    // (query, key, callCount) => result | throws
    this.calls = [];
  }
  supportsNews() { return true; }
  supportsImages() { return true; }
  supportsAcademic() { return this.name === 'serper'; }
  async search(query, { key }) {
    this.calls.push({ query, key });
    return this.behavior(query, key, this.calls.length);
  }
}

function okResults(source, n = 3) {
  return {
    results: Array.from({ length: n }, (_, i) => ({
      title: `${source} result ${i + 1}`,
      url: `https://example.com/${source}/${i + 1}`,
      snippet: `Snippet ${i + 1} about the query topic with enough words to matter for ranking and extraction.`,
      position: i + 1,
      score: null,
      publishedDate: null,
      source,
    })),
    answer: null,
    raw: {},
  };
}

function httpError(status) {
  const e = new Error(`HTTP ${status}`);
  e.status = status;
  return e;
}

// ══════════════════════════════════════════════════════════════════════════════
describe('searchConfig', () => {
  beforeEach(cleanEnv);

  test('defaults are production-safe', () => {
    const c = getSearchConfig();
    assert.equal(c.timeoutMs, 8000);
    assert.equal(c.maxResults, 6);
    assert.deepEqual(c.providerPriority, ['serper', 'tavily']);
    assert.equal(c.cacheEnabled, true);
    assert.equal(c.retryLimit, 3);
  });

  test('env overrides + clamping + unknown provider dropped', () => {
    process.env.SEARCH_TIMEOUT = '100';            // below min 500 → clamped
    process.env.SEARCH_MAX_RESULTS = '50';         // above max 20 → clamped
    process.env.SEARCH_PROVIDER_PRIORITY = 'tavily, bogus ,serper';
    process.env.SEARCH_ENABLE_CACHE = 'false';
    const c = getSearchConfig();
    assert.equal(c.timeoutMs, 500);
    assert.equal(c.maxResults, 20);
    assert.deepEqual(c.providerPriority, ['tavily', 'serper']);
    assert.equal(c.cacheEnabled, false);
  });

  test('garbage numeric env falls back to default', () => {
    process.env.SEARCH_RETRY_LIMIT = 'lots';
    assert.equal(getSearchConfig().retryLimit, 3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('KeyPool', () => {
  beforeEach(cleanEnv);

  test('loads bare + numbered keys, skips empties, dedupes values', () => {
    process.env.TEST_POOL = 'bare';
    process.env.TEST_POOL_1 = 'k1';
    process.env.TEST_POOL_2 = '   ';       // empty → skipped
    process.env.TEST_POOL_3 = 'k1';        // duplicate value → deduped
    process.env.TEST_POOL_4 = 'k4';
    const pool = new KeyPool({ name: 't', envPrefix: 'TEST_POOL' });
    assert.deepEqual(pool.getKeys(), ['bare', 'k1', 'k4']);
    assert.equal(pool.size(), 3);
    assert.equal(pool.hasKeys(), true);
  });

  test('round-robin rotation spreads load', () => {
    process.env.RR_POOL_1 = 'a'; process.env.RR_POOL_2 = 'b'; process.env.RR_POOL_3 = 'c';
    const pool = new KeyPool({ name: 'rr', envPrefix: 'RR_POOL' });
    const seq = [pool.acquire().key, pool.acquire().key, pool.acquire().key, pool.acquire().key];
    assert.deepEqual(seq, ['a', 'b', 'c', 'a']);
  });

  test('cooldown skips failed key; retry-next-key excludes tried', () => {
    process.env.CD_POOL_1 = 'a'; process.env.CD_POOL_2 = 'b';
    const pool = new KeyPool({ name: 'cd', envPrefix: 'CD_POOL' });
    const first = pool.acquire();
    pool.reportFailure(first.key, { kind: 'auth', keyCooldownMs: 60_000 });
    const second = pool.acquire({ exclude: new Set([first.key]) });
    assert.notEqual(second.key, first.key);
    // 'a' cooling → plain acquire keeps returning 'b'
    assert.equal(pool.acquire().key, 'b');
  });

  test('rate_limit cooldown escalates and success resets strikes', () => {
    process.env.RL_POOL_1 = 'only';
    const pool = new KeyPool({ name: 'rl', envPrefix: 'RL_POOL' });
    const { key } = pool.acquire();
    pool.reportFailure(key, { kind: 'rate_limit', keyCooldownMs: 1000 });
    const s = pool.state.get(key);
    const firstCooldown = s.cooldownUntil - Date.now();
    pool.reportFailure(key, { kind: 'rate_limit', keyCooldownMs: 1000 });
    const secondCooldown = s.cooldownUntil - Date.now();
    assert.ok(secondCooldown > firstCooldown, 'escalates');
    pool.reportSuccess(key);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.cooldownUntil, 0);
  });

  test('all-cooling degraded mode still returns a key', () => {
    process.env.DG_POOL_1 = 'x';
    const pool = new KeyPool({ name: 'dg', envPrefix: 'DG_POOL' });
    const { key } = pool.acquire();
    pool.reportFailure(key, { kind: 'auth', keyCooldownMs: 60_000 });
    const again = pool.acquire();
    assert.equal(again.key, 'x', 'degraded attempt beats guaranteed failure');
  });

  test('stats never expose key material', () => {
    process.env.ST_POOL_1 = 'super-secret-key';
    const pool = new KeyPool({ name: 'st', envPrefix: 'ST_POOL' });
    pool.acquire();
    const json = JSON.stringify(pool.stats());
    assert.ok(!json.includes('super-secret-key'));
    assert.ok(json.includes('"slot":1'));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('searchErrors', () => {
  test('classification matrix', () => {
    assert.equal(classifySearchError(httpError(401)).kind, 'auth');
    assert.equal(classifySearchError(httpError(403)).kind, 'auth');
    assert.equal(classifySearchError(httpError(429)).kind, 'rate_limit');
    assert.equal(classifySearchError(httpError(500)).kind, 'server_error');
    assert.equal(classifySearchError(httpError(400)).retryNextKey, false, '400 must not burn keys');
    const abort = new Error('x'); abort.name = 'AbortError';
    assert.equal(classifySearchError(abort).kind, 'timeout');
    const net = new Error('fetch failed'); net.code = 'ECONNRESET';
    assert.equal(classifySearchError(net).kind, 'network');
    assert.equal(classifySearchError(new Error('insufficient credits')).kind, 'quota');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('searchCache', () => {
  beforeEach(__resetSearchCacheForTests);

  test('normalizeQuery is order/punctuation/case insensitive + type-scoped', () => {
    assert.equal(normalizeQuery('Node 22 release date?'), normalizeQuery('release DATE, node 22'));
    assert.notEqual(normalizeQuery('x'), normalizeQuery('x', 'news'));
  });

  test('set/get honors TTL', async () => {
    const k = normalizeQuery('ttl test');
    cacheSet(k, { v: 1 }, { ttlMs: 30, maxEntries: 10 });
    assert.deepEqual(cacheGet(k), { v: 1 });
    await new Promise(r => setTimeout(r, 40));
    assert.equal(cacheGet(k), null, 'expired');
  });

  test('eviction caps size oldest-first', () => {
    for (let i = 0; i < 5; i++) cacheSet(`k${i}`, { i }, { ttlMs: 60_000, maxEntries: 3 });
    assert.equal(cacheGet('k0'), null);
    assert.equal(cacheGet('k1'), null);
    assert.deepEqual(cacheGet('k4'), { i: 4 });
    assert.equal(cacheStats().evictions, 2);
  });

  test('invalidate one phrasing kills all phrasings; clear-all works', () => {
    cacheSet(normalizeQuery('price of gold today'), { v: 1 }, { ttlMs: 60_000, maxEntries: 10 });
    assert.equal(cacheInvalidate('today price of GOLD'), 1);
    assert.equal(cacheGet(normalizeQuery('price of gold today')), null);
    cacheSet('a', 1, { ttlMs: 60_000, maxEntries: 10 });
    cacheSet('b', 2, { ttlMs: 60_000, maxEntries: 10 });
    assert.equal(cacheInvalidate(), 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('resultRanker', () => {
  test('canonicalUrl strips www/utm/fragment/trailing slash', () => {
    assert.equal(
      canonicalUrl('https://www.Example.com/path/?utm_source=x&id=2#frag'),
      canonicalUrl('http://example.com/path?id=2'),
    );
  });

  test('dedupes across providers keeping higher score', () => {
    const dupA = { title: 'Node.js 22 released', url: 'https://nodejs.org/blog/22', snippet: 'node 22 release notes', position: 5, score: null, source: 'serper' };
    const dupB = { ...dupA, url: 'https://www.nodejs.org/blog/22/', score: 0.95, source: 'tavily' };
    const ranked = rankResults([dupA, dupB], 'node 22 release', { maxResults: 5 });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].source, 'tavily', 'higher-scoring copy wins');
  });

  test('term match + authority + freshness reorder deterministically', () => {
    const now = Date.parse('2026-07-11T00:00:00Z');
    const results = [
      { title: 'random blog', url: 'https://blog.random.io/x', snippet: 'unrelated words entirely', position: 1, score: null, publishedDate: null, source: 'serper' },
      { title: 'Express 5 migration guide', url: 'https://expressjs.com/en/guide/migrating-5.html', snippet: 'express 5 migration steps', position: 3, score: null, publishedDate: '2026-07-08', source: 'serper' },
    ];
    const ranked = rankResults(results, 'express 5 migration', { maxResults: 5, now });
    assert.equal(ranked[0].url.includes('expressjs.com'), true, 'relevant+fresh beats position-1 irrelevant');
    // Determinism: same input twice → same order/scores
    const again = rankResults(results, 'express 5 migration', { maxResults: 5, now });
    assert.deepEqual(ranked.map(r => r.rankScore), again.map(r => r.rankScore));
  });

  test('caps to maxResults', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `https://a.com/${i}`, snippet: 's', position: i + 1, source: 'serper' }));
    assert.equal(rankResults(many, 'q', { maxResults: 4 }).length, 4);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('contextExtractor', () => {
  const results = (n) => Array.from({ length: n }, (_, i) => ({
    title: `Source ${i + 1}`, url: `https://site${i + 1}.com/page`,
    snippet: `Unique sentence number ${i + 1} that describes the finding in reasonable detail for testing purposes. `.repeat(3),
    rankScore: 100 - i, publishedDate: null,
  }));

  test('builds numbered block with header + citation instruction', () => {
    const { block, sources } = extractSearchContext(results(3), 'A direct answer.', 'test query', { tokenBudget: 2000 });
    assert.ok(block.includes('LIVE WEB SEARCH RESULTS'));
    assert.ok(block.includes('Direct answer: A direct answer.'));
    assert.ok(block.includes('[1] Source 1'));
    assert.ok(block.includes('[3] Source 3'));
    assert.equal(sources.length, 3);
    assert.ok(block.includes('Cite sources as [n]'));
  });

  test('fits token budget by dropping lowest-ranked sources', () => {
    const { tokens, sources } = extractSearchContext(results(8), null, 'q', { tokenBudget: 300 });
    assert.ok(tokens <= 300, `tokens ${tokens} within budget`);
    assert.ok(sources.length < 8 && sources.length >= 1);
  });

  test('cross-snippet duplicate sentences dropped', () => {
    const dup = 'Aggregators syndicate this exact same paragraph everywhere across the web today.';
    const rs = [
      { title: 'A', url: 'https://a.com', snippet: dup, rankScore: 2 },
      { title: 'B', url: 'https://b.com', snippet: `${dup} Plus one unique closing sentence for source B here.`, rankScore: 1 },
    ];
    const { block } = extractSearchContext(rs, null, 'q', { tokenBudget: 2000 });
    assert.equal(block.split('Aggregators syndicate').length - 1, 1, 'duplicate paragraph appears once');
    assert.ok(block.includes('unique closing sentence'));
  });

  test('empty inputs → empty block', () => {
    const { block, tokens } = extractSearchContext([], null, 'q', { tokenBudget: 500 });
    assert.equal(block, '');
    assert.equal(tokens, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('searchDecision', () => {
  const yes = (msg, taskType = 'simple_qa', extra = {}) => {
    const d = decideWebSearch({ userMessage: msg, taskType, ...extra });
    assert.equal(d.needed, true, `expected YES: "${msg}" → ${d.score} [${d.signals}]`);
  };
  const no = (msg, taskType = 'simple_qa', extra = {}) => {
    const d = decideWebSearch({ userMessage: msg, taskType, ...extra });
    assert.equal(d.needed, false, `expected NO: "${msg}" → ${d.score} [${d.signals}]`);
  };

  test('spec YES cases', () => {
    yes('What is the latest news about OpenAI?');
    yes('Show me the official documentation for Express 5 middleware');
    yes('Find the GitHub repo for tanstack query');
    yes("What's the current pricing of Vercel Pro?");
    yes('Who is the current CEO of Twitter?');
    yes('Compare Bun vs Node in 2026 benchmarks', 'research');
    yes('What is the weather today in Guwahati?');
    yes('Is the Stripe API down right now?');
    yes('best framework for realtime apps', 'research', { profileWantsSearch: true });
  });

  test('spec NO cases', () => {
    no('Write a poem about the ocean', 'creative_writing');
    no('What is 245 * 17?', 'reasoning');
    no('Hey, how are you today?', 'conversation');
    no("What's my favorite language?", 'memory_recall');
    no('Remember that I moved to Berlin', 'memory_update');
    no('Explain this function in my code', 'project_query', { hasWorkspaceId: true });
    no('Summarize the attached PDF', 'file_analysis', { hasWorkspaceId: true });
    no('Refactor the auth middleware in this repo', 'coding', { hasWorkspaceId: true });
    no('Explain the concept of recursion', 'research');   // timeless — profile alone must not force
  });

  test('explicit opt-in/opt-out override everything', () => {
    yes('search the web for anything at all', 'conversation' === 'conversation' ? 'simple_qa' : 'simple_qa');
    const optIn = decideWebSearch({ userMessage: 'google the express docs for me', taskType: 'coding' });
    assert.equal(optIn.needed, true);
    no("what's the latest node version? don't search the web though", 'simple_qa');
  });

  test('workspace grounding yields to freshness', () => {
    yes('Is the express version in this repo still supported upstream?', 'project_query', { hasWorkspaceId: true });
  });

  test('decision is deterministic', () => {
    const a = decideWebSearch({ userMessage: 'latest react release notes', taskType: 'research' });
    const b = decideWebSearch({ userMessage: 'latest react release notes', taskType: 'research' });
    assert.deepEqual(a, b);
  });

  test('buildSearchQuery strips lead-ins and caps length', () => {
    assert.equal(buildSearchQuery('Hey, can you google the latest Node.js LTS version?'), 'the latest Node.js LTS version');
    assert.ok(buildSearchQuery('x'.repeat(500)).length <= 380);
    assert.equal(buildSearchQuery('  plain query  '), 'plain query');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('searchRouter', () => {
  beforeEach(() => { cleanEnv(); __resetSearchRouterForTests(); });

  const baseOpts = { maxResults: 5, timeoutMs: 1000, retryLimit: 3, priority: ['serper', 'tavily'] };

  test('primary provider success — one attempt, correct shape', async () => {
    const serper = new MockProvider({ name: 'serper', behavior: () => okResults('serper') });
    const tavily = new MockProvider({ name: 'tavily', behavior: () => okResults('tavily') });
    const out = await routedSearch('q', { ...baseOpts, providersOverride: { serper, tavily } });
    assert.equal(out.ok, true);
    assert.equal(out.provider, 'serper');
    assert.equal(out.results.length, 3);
    assert.equal(tavily.calls.length, 0, 'fallback never touched');
    assert.equal(out.attempts[0].outcome, 'success');
  });

  test('key rotation within provider: 429 on key1 → key2 succeeds', async () => {
    const serper = new MockProvider({
      name: 'serper', keys: 3,
      behavior: (_q, key) => { if (key === 'serper-key-1') throw httpError(429); return okResults('serper'); },
    });
    const out = await routedSearch('q', { ...baseOpts, priority: ['serper'], providersOverride: { serper } });
    assert.equal(out.ok, true);
    assert.deepEqual(out.attempts.map(a => a.outcome), ['failed', 'success']);
    assert.deepEqual(serper.calls.map(c => c.key), ['serper-key-1', 'serper-key-2']);
  });

  test('spec fallback chain: all Serper keys fail → Tavily serves', async () => {
    const serper = new MockProvider({ name: 'serper', keys: 2, behavior: () => { throw httpError(500); } });
    const tavily = new MockProvider({ name: 'tavily', behavior: () => okResults('tavily') });
    const out = await routedSearch('q', { ...baseOpts, providersOverride: { serper, tavily } });
    assert.equal(out.ok, true);
    assert.equal(out.provider, 'tavily');
    assert.equal(serper.calls.length, 2, 'both serper keys tried');
  });

  test('total failure → ok:false, never throws (continue without search)', async () => {
    const serper = new MockProvider({ name: 'serper', behavior: () => { throw httpError(503); } });
    const tavily = new MockProvider({ name: 'tavily', behavior: () => { throw new Error('fetch failed'); } });
    const out = await routedSearch('q', { ...baseOpts, providersOverride: { serper, tavily } });
    assert.equal(out.ok, false);
    assert.ok(out.attempts.length >= 2);
  });

  test('bad_request stops key burn on that provider', async () => {
    const serper = new MockProvider({ name: 'serper', keys: 4, behavior: () => { throw httpError(400); } });
    const tavily = new MockProvider({ name: 'tavily', behavior: () => okResults('tavily') });
    const out = await routedSearch('q', { ...baseOpts, providersOverride: { serper, tavily } });
    assert.equal(serper.calls.length, 1, '400 must not retry more keys');
    assert.equal(out.provider, 'tavily');
  });

  test('circuit opens after 3 failed queries and skips provider', async () => {
    const serper = new MockProvider({ name: 'serper', keys: 1, behavior: () => { throw httpError(500); } });
    const tavily = new MockProvider({ name: 'tavily', behavior: () => okResults('tavily') });
    const override = { providersOverride: { serper, tavily } };
    await routedSearch('q1', { ...baseOpts, ...override });
    await routedSearch('q2', { ...baseOpts, ...override });
    await routedSearch('q3', { ...baseOpts, ...override });
    const before = serper.calls.length;
    const out = await routedSearch('q4', { ...baseOpts, ...override });
    assert.equal(serper.calls.length, before, 'circuit-open provider skipped');
    assert.equal(out.attempts.find(a => a.provider === 'serper')?.reason, 'circuit_open');
    assert.equal(out.provider, 'tavily');
  });

  test('retryLimit caps distinct keys tried', async () => {
    const serper = new MockProvider({ name: 'serper', keys: 6, behavior: () => { throw httpError(429); } });
    await routedSearch('q', { ...baseOpts, retryLimit: 2, priority: ['serper'], providersOverride: { serper } });
    assert.equal(serper.calls.length, 2);
  });

  test('academic routes only to supporting provider', async () => {
    const serper = new MockProvider({ name: 'serper', behavior: () => okResults('serper') });
    const tavily = new MockProvider({ name: 'tavily', behavior: () => okResults('tavily') });
    const out = await routedSearch('q', { ...baseOpts, type: 'academic', priority: ['tavily', 'serper'], providersOverride: { serper, tavily } });
    assert.equal(out.provider, 'serper', 'tavily lacks academic — skipped');
    assert.equal(out.attempts[0].reason, 'no_academic_support');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('provider adapters (mock fetch)', () => {
  beforeEach(cleanEnv);

  function fetchReturning(json, status = 200) {
    return async () => ({
      ok: status < 400, status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    });
  }

  test('Serper normalizes organic + answerBox; correct auth header + endpoint', async () => {
    let captured;
    const fetchImpl = async (url, init) => { captured = { url, init }; return fetchReturning({
      organic: [{ title: 'T1', link: 'https://a.com', snippet: 'S1', position: 1, date: 'Jul 1, 2026' }],
      answerBox: { answer: '42' },
    })(); };
    process.env.SERPER_API_KEY_1 = 'sk-test';
    const p = new SerperProvider({ keyPool: new KeyPool({ name: 'serper', envPrefix: 'SERPER_API_KEY' }), fetchImpl });
    const out = await p.search('meaning of life', { key: 'sk-test', maxResults: 5, timeoutMs: 1000 });
    assert.equal(captured.url, 'https://google.serper.dev/search');
    assert.equal(captured.init.headers['X-API-KEY'], 'sk-test');
    assert.deepEqual(JSON.parse(captured.init.body), { q: 'meaning of life', num: 5 });
    assert.equal(out.results[0].url, 'https://a.com');
    assert.equal(out.results[0].publishedDate, 'Jul 1, 2026');
    assert.equal(out.answer, '42');
    // news endpoint mapping
    await p.search('q', { key: 'k', maxResults: 3, timeoutMs: 1000, type: 'news' });
    assert.equal(captured.url, 'https://google.serper.dev/news');
  });

  test('Tavily normalizes results/score/answer; Bearer auth', async () => {
    let captured;
    const fetchImpl = async (url, init) => { captured = { url, init }; return fetchReturning({
      answer: 'Direct.', results: [{ title: 'T', url: 'https://b.com', content: 'C', score: 0.91 }],
    })(); };
    const p = new TavilyProvider({ keyPool: new KeyPool({ name: 'tavily', envPrefix: 'TAVILY_API_KEY' }), fetchImpl });
    const out = await p.search('q', { key: 'tvly-x', maxResults: 4, timeoutMs: 1000 });
    assert.equal(captured.url, 'https://api.tavily.com/search');
    assert.equal(captured.init.headers.Authorization, 'Bearer tvly-x');
    assert.equal(JSON.parse(captured.init.body).max_results, 4);
    assert.equal(out.results[0].score, 0.91);
    assert.equal(out.answer, 'Direct.');
  });

  test('HTTP error surfaces status for classification; timeout maps to AbortError', async () => {
    const p = new SerperProvider({
      keyPool: new KeyPool({ name: 'serper', envPrefix: 'SERPER_API_KEY' }),
      fetchImpl: fetchReturning({ message: 'bad key' }, 403),
    });
    await assert.rejects(() => p.search('q', { key: 'k', maxResults: 1, timeoutMs: 1000 }), (e) => e.status === 403);

    const slow = new SerperProvider({
      keyPool: new KeyPool({ name: 'serper', envPrefix: 'SERPER_API_KEY' }),
      fetchImpl: (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })),
    });
    await assert.rejects(() => slow.search('q', { key: 'k', maxResults: 1, timeoutMs: 30 }), (e) => classifySearchError(e).kind === 'timeout');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('SearchManager (end-to-end, mocked providers)', () => {
  beforeEach(() => { cleanEnv(); __resetSearchRouterForTests(); __resetSearchCacheForTests(); });

  test('full pipeline: search → rank → extract → contextBlock + stages', async () => {
    const serper = new MockProvider({ name: 'serper', behavior: () => okResults('serper', 4) });
    const stages = [];
    const out = await performSearch({
      userMessage: 'latest node lts version',
      taskType: 'simple_qa',
      requestId: 't1',
      onStage: (id, label) => stages.push({ id, label }),
      providersOverride: { serper, tavily: new MockProvider({ name: 'tavily', behavior: () => okResults('tavily') }) },
    });
    assert.equal(out.used, true);
    assert.equal(out.provider, 'serper');
    assert.ok(out.contextBlock.includes('[1]'));
    assert.ok(out.contextTokens > 0);
    assert.ok(out.sources.length >= 1);
    assert.deepEqual(stages.map(s => s.id), ['search', 'search_provider', 'search_rank', 'search_context']);
    assert.ok(stages[1].label.includes('Serper'));
    assert.ok(!('raw' in (out.results[0] ?? {})), 'raw payload never leaves manager');
  });

  test('cache: second identical (reworded) query serves from cache, zero provider calls', async () => {
    const serper = new MockProvider({ name: 'serper', behavior: () => okResults('serper') });
    const override = { serper, tavily: new MockProvider({ name: 'tavily', behavior: () => okResults('tavily') }) };
    const a = await performSearch({ userMessage: 'price of bitcoin today', providersOverride: override });
    assert.equal(a.cached, false);
    const callsAfterFirst = serper.calls.length;
    const b = await performSearch({ userMessage: 'today price of Bitcoin', providersOverride: override });
    assert.equal(b.cached, true);
    assert.equal(b.used, true);
    assert.equal(serper.calls.length, callsAfterFirst, 'no new provider call');
    assert.equal(b.contextBlock, a.contextBlock);
  });

  test('SEARCH_ENABLE_CACHE=false bypasses cache', async () => {
    process.env.SEARCH_ENABLE_CACHE = 'false';
    const serper = new MockProvider({ name: 'serper', behavior: () => okResults('serper') });
    const override = { serper, tavily: new MockProvider({ name: 'tavily', behavior: () => okResults('tavily') }) };
    await performSearch({ userMessage: 'same query', providersOverride: override });
    await performSearch({ userMessage: 'same query', providersOverride: override });
    assert.equal(serper.calls.length, 2);
  });

  test('invalidateSearchCache forces refresh', async () => {
    const serper = new MockProvider({ name: 'serper', behavior: () => okResults('serper') });
    const override = { serper, tavily: new MockProvider({ name: 'tavily', behavior: () => okResults('tavily') }) };
    await performSearch({ userMessage: 'cache invalidation test', providersOverride: override });
    assert.equal(invalidateSearchCache('cache invalidation test'), 1);
    await performSearch({ userMessage: 'cache invalidation test', providersOverride: override });
    assert.equal(serper.calls.length, 2);
  });

  test('FAIL OPEN: every provider dead → used:false, no throw, reason set', async () => {
    const dead = () => { throw httpError(500); };
    const out = await performSearch({
      userMessage: 'latest anything',
      providersOverride: {
        serper: new MockProvider({ name: 'serper', behavior: dead }),
        tavily: new MockProvider({ name: 'tavily', behavior: dead }),
      },
    });
    assert.equal(out.used, false);
    assert.equal(out.contextBlock, '');
    assert.ok(out.reason.includes('failed'));
    assert.ok(out.attempts.length >= 2);
  });

  test('FAIL OPEN: internal explosion (ranker fed garbage) still returns used:false', async () => {
    const evil = new MockProvider({ name: 'serper', behavior: () => ({ results: null, answer: null, raw: {} }) });
    const out = await performSearch({ userMessage: 'x', providersOverride: { serper: evil, tavily: evil } });
    assert.equal(out.used, false);
  });

  test('no keys configured (real registry) → clean disabled result', async () => {
    const out = await performSearch({ userMessage: 'latest x' });   // no override, cleanEnv ran
    assert.equal(out.used, false);
    assert.match(out.reason, /no search provider keys/);
  });

  test('getSearchHealth shape', () => {
    const h = getSearchHealth();
    assert.equal(typeof h.enabled, 'boolean');
    assert.ok(h.providers.serper.circuit);
    assert.ok(h.providers.tavily.capabilities);
    assert.ok('hits' in h.cache);
    assert.ok(Array.isArray(h.config.providerPriority));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('orchestrator + prompt wiring', () => {
  test('web_search agent is registered (seam closed)', () => {
    assert.ok(getAgent('web_search'), 'searchAgent.js side-effect registration');
  });

  test('capability enables for live-web message, disables for creative', () => {
    const on = orchestrate({ userMessage: 'What is the latest Node.js LTS release?', taskType: 'simple_qa', confidence: 0.9, hasWorkspaceId: false });
    assert.ok(on.enabled.some(c => c.id === 'web_search'), 'live-web → enabled');
    assert.equal(on.researchUsed, true);

    const off = orchestrate({ userMessage: 'Write a haiku about rain', taskType: 'creative_writing', confidence: 0.9, hasWorkspaceId: false });
    assert.ok(off.skipped.some(c => c.id === 'web_search'), 'creative → skipped');
  });

  test('research profile biases but timeless research stays off', () => {
    const timeless = orchestrate({ userMessage: 'Explain the concept of eventual consistency', taskType: 'research', confidence: 0.9, hasWorkspaceId: false });
    const cap = timeless.capabilities.find(c => c.id === 'web_search');
    assert.equal(cap.enabled, false, 'profile nudge alone must not force search');
  });

  test('orchestrate stays deterministic with search wired in', () => {
    const args = { userMessage: 'compare postgres vs mongo pricing 2026', taskType: 'research', confidence: 0.8, hasWorkspaceId: false };
    const a = orchestrate(args); const b = orchestrate(args);
    assert.deepEqual(
      a.capabilities.map(c => [c.id, c.enabled, c.confidence]),
      b.capabilities.map(c => [c.id, c.enabled, c.confidence]),
    );
  });

  test('buildSystemPrompt injects search block after project context, module tagged', () => {
    const { prompt, modules } = buildSystemPrompt(
      'research', '', '', 'PROJECT_CTX_SENTINEL', '', null, '=== LIVE WEB SEARCH RESULTS ===\nSENTINEL_SEARCH',
    );
    assert.ok(modules.includes('web_search'));
    assert.ok(prompt.indexOf('PROJECT_CTX_SENTINEL') < prompt.indexOf('SENTINEL_SEARCH'), 'repo truth stays foundational');
    // Backward compat: omitted param → unchanged behavior
    const { modules: legacy } = buildSystemPrompt('research', '', '', '', '', null);
    assert.ok(!legacy.includes('web_search'));
  });
});
