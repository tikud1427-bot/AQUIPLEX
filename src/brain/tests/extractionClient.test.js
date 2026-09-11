/**
 * E6/PR-5 — the extraction client.
 *
 * No provider runs here, and almost nothing needs one: the transport is
 * injected, so cache behaviour, concurrency, ordering and every failure path
 * are exercised exactly. What genuinely needs a provider is whether a real
 * model returns parseable JSON, and that is E6/PR-11's shadow run.
 *
 * The properties worth more than the rest:
 *
 *   1. a prompt change must MISS the cache. Keying on segment alone turns
 *      every cached entry into a stale answer to a question no longer asked.
 *   2. failures are never cached. One bad minute must not become permanent.
 *   3. results stay in input order under concurrency. A caller matching claims
 *      to spans by position would otherwise mis-attribute provenance, silently
 *      and only under load.
 *   4. an unattributable run says so. `reproducible:false` is a measurement.
 *
 * Run: node --test src/brain/tests/extractionClient.test.js
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSegment, extractSegments, extractionCacheKey,
  __clearExtractionCache, __extractionCacheSize,
  DEFAULT_CONCURRENCY, REQUESTED_TEMPERATURE,
} from '../understanding/extractionClient.js';
import { buildExtractionPrompt, PROMPT_VERSION } from '../understanding/extractionPrompt.js';

const SEG = 'I run product at Nummo.';

/** A transport that returns one valid claim and reports its model. */
const goodTransport = (model = 'pinned-model-1') => {
  const fn = async () => ({
    model,
    text: JSON.stringify({ claims: [{
      subject: 'self', predicate: 'works_at', object: { entity: 'Nummo' },
      polarity: 'asserted', modality: 'fact', timePrecision: 'none',
      statementText: 'I run product at Nummo',
    }] }),
  });
  return Object.assign(fn, { calls: 0 });
};

/** Counts invocations so "did it call the provider?" is measured, not assumed. */
const counting = inner => {
  const fn = async (...a) => { fn.calls++; return inner(...a); };
  fn.calls = 0;
  return fn;
};

beforeEach(() => __clearExtractionCache());

describe('extraction client — the cache key covers everything that changes the answer', () => {
  test('the same segment, prompt and pin produce the same key', () => {
    const a = extractionCacheKey({ segment: SEG, promptVersion: 'v1', modelPin: 'm' });
    const b = extractionCacheKey({ segment: SEG, promptVersion: 'v1', modelPin: 'm' });
    assert.equal(a, b);
  });

  test('a PROMPT VERSION change is a cache MISS', () => {
    // The whole reason the key is not just the segment. A prompt edit that
    // reused cached answers would measure the old prompt and report it as the
    // new one — and the first thing anyone does after editing a prompt is
    // measure it.
    assert.notEqual(
      extractionCacheKey({ segment: SEG, promptVersion: 'v1', modelPin: 'm' }),
      extractionCacheKey({ segment: SEG, promptVersion: 'v2', modelPin: 'm' }));
  });

  test('a MODEL PIN change is a cache MISS', () => {
    assert.notEqual(
      extractionCacheKey({ segment: SEG, promptVersion: 'v1', modelPin: 'a' }),
      extractionCacheKey({ segment: SEG, promptVersion: 'v1', modelPin: 'b' }));
  });

  test('the field separator stops two fields running together', () => {
    // Without a separator, ("ab","c") and ("a","bc") hash identically and two
    // different runs collide. A collision here serves one segment's claims for
    // another segment's text.
    assert.notEqual(
      extractionCacheKey({ segment: 'c', promptVersion: 'ab', modelPin: 'x' }),
      extractionCacheKey({ segment: 'bc', promptVersion: 'a', modelPin: 'x' }));
  });

  test('the key does NOT depend on the prompt text — measured, and deliberate', () => {
    // buildExtractionPrompt mints a fresh UUID nonce per call for injection
    // fencing, so the prompt bytes differ every time. A cache keyed on prompt
    // text would therefore hit 0% forever while looking perfectly reasonable.
    const a = buildExtractionPrompt(SEG), b = buildExtractionPrompt(SEG);
    assert.notEqual(a.system, b.system, 'the nonce really does vary — if this fails, re-examine the key');
    assert.equal(
      extractionCacheKey({ segment: SEG, promptVersion: PROMPT_VERSION, modelPin: null }),
      extractionCacheKey({ segment: SEG, promptVersion: PROMPT_VERSION, modelPin: null }));
  });
});

describe('extraction client — caching', () => {
  test('a repeat segment is served from cache without calling the provider', async () => {
    const callModel = counting(goodTransport());
    const first = await extractSegment(SEG, { callModel });
    const second = await extractSegment(SEG, { callModel });

    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(callModel.calls, 1, 'the second call must not reach the provider');
    assert.deepEqual(second.claims, first.claims);
  });

  test('an UNPARSEABLE response is NOT cached', async () => {
    // Caching a failure makes one transient provider problem permanent for the
    // life of the process, and the segment can never be extracted again.
    const callModel = counting(async () => ({ model: 'm', text: 'not json at all' }));
    const a = await extractSegment(SEG, { callModel });
    assert.ok(a.error, 'the failure is reported');
    assert.equal(__extractionCacheSize(), 0, 'nothing was cached');

    await extractSegment(SEG, { callModel });
    assert.equal(callModel.calls, 2, 'the segment is retried rather than serving a cached failure');
  });

  test('a TRANSPORT THROW is not cached and does not propagate', async () => {
    const callModel = counting(async () => { throw new Error('ECONNRESET'); });
    const r = await extractSegment(SEG, { callModel });
    assert.deepEqual(r.claims, []);
    assert.match(r.error, /^transport:/);
    assert.equal(__extractionCacheSize(), 0);
  });

  test('no transport → an empty result with a reason, never a throw', async () => {
    // Extraction runs in deferred post-turn work. A throw here would take down
    // a turn for a cost optimisation.
    const r = await extractSegment(SEG, {});
    assert.deepEqual(r.claims, []);
    assert.equal(r.error, 'no-transport');
    assert.equal(__extractionCacheSize(), 0);
  });

  test('a caller-supplied cache is used instead of the module one', async () => {
    const cache = new Map();
    const callModel = counting(goodTransport());
    await extractSegment(SEG, { callModel, cache });
    assert.equal(cache.size, 1);
    assert.equal(__extractionCacheSize(), 0, 'the module cache stayed untouched');
  });
});

describe('extraction client — an unattributable run says so', () => {
  test('temperature is null when the transport does not confirm the model', async () => {
    // The shipped adapters return { text, truncated, finishReason } and never
    // say which model answered. Recording REQUESTED_TEMPERATURE anyway would
    // turn an unverified ask into a measurement — exactly how an
    // irreproducible run comes to look reproducible.
    const callModel = async () => ({ text: JSON.stringify({ claims: [] }) });   // no model field
    const r = await extractSegment(SEG, { callModel });
    assert.equal(r.model, null);
    assert.equal(r.temperature, null, 'an unconfirmed temperature is null, not 0');
  });

  test('temperature is recorded once the transport confirms a model', async () => {
    const r = await extractSegment(SEG, { callModel: goodTransport('m1') });
    assert.equal(r.model, 'm1');
    assert.equal(r.temperature, REQUESTED_TEMPERATURE);
  });

  test('stats.reproducible is FALSE when any result lacks a model id', async () => {
    const callModel = async () => ({ text: JSON.stringify({ claims: [] }) });
    const { stats } = await extractSegments([SEG, 'I work at Zeta.'], { callModel });
    assert.equal(stats.reproducible, false,
      'PR-11 must not publish a comparison built from unattributable runs');
  });

  test('stats.reproducible is TRUE when every result is attributable', async () => {
    const { stats } = await extractSegments([SEG, 'I work at Zeta.'], { callModel: goodTransport('m1') });
    assert.equal(stats.reproducible, true);
  });

  test('an EMPTY input is not reported as reproducible', async () => {
    // 0/0 is vacuously "every result has a model". Reporting that as
    // reproducible would let a run that extracted nothing look like a clean
    // one — the same divide-by-zero shape the eval harness guards against.
    const { stats } = await extractSegments([], { callModel: goodTransport() });
    assert.equal(stats.reproducible, false);
    assert.equal(stats.segments, 0);
  });
});

describe('extraction client — batching is concurrency, not prompt-stuffing', () => {
  test('ONE segment per provider call', async () => {
    // Several segments in one prompt would force the model to track which
    // evidence span belongs to which segment. Its mistakes there look like
    // correct output, and they corrupt provenance rather than losing it.
    const seen = [];
    const callModel = async ({ user }) => { seen.push(user); return { model: 'm', text: JSON.stringify({ claims: [] }) }; };
    const segs = ['I work at Nummo.', 'Dev runs engineering.', 'Churn is our problem.'];
    await extractSegments(segs, { callModel, concurrency: 3 });

    assert.equal(seen.length, 3, 'one call per segment');
    for (const [i, s] of segs.entries()) {
      const others = segs.filter((_, j) => j !== i);
      assert.ok(seen.some(u => u.includes(s)), `${s} was sent`);
      assert.ok(!seen.some(u => others.every(o => u.includes(o))),
        'no single prompt carried every segment');
    }
  });

  test('results stay in INPUT order regardless of completion order', async () => {
    // Deliberately finish backwards. A caller matching claims to segments by
    // index would otherwise attribute them to the wrong text, only under load.
    const delays = { a: 30, b: 20, c: 1 };
    const callModel = async ({ user }) => {
      const which = ['a', 'b', 'c'].find(k => user.includes(`seg-${k}`));
      await new Promise(r => setTimeout(r, delays[which]));
      return { model: 'm', text: JSON.stringify({ claims: [{
        subject: 'self', predicate: 'uses', object: { literal: which },
        polarity: 'asserted', modality: 'fact', timePrecision: 'none',
        statementText: `seg-${which}`,
      }] }) };
    };
    const { results } = await extractSegments(
      ['seg-a is here.', 'seg-b is here.', 'seg-c is here.'], { callModel, concurrency: 3 });

    assert.deepEqual(results.map(r => r.claims[0]?.object?.literal), ['a', 'b', 'c']);
  });

  test('concurrency is BOUNDED — never more in flight than the limit', async () => {
    let inFlight = 0, peak = 0;
    const callModel = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return { model: 'm', text: JSON.stringify({ claims: [] }) };
    };
    await extractSegments(Array.from({ length: 12 }, (_, i) => `Segment number ${i} here.`),
      { callModel, concurrency: 3 });
    assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit of 3`);
    assert.ok(peak > 1, `peak concurrency ${peak} — the work ran serially, so the limit was not exercised`);
  });

  test('the default concurrency is bounded and sane', () => {
    assert.ok(DEFAULT_CONCURRENCY >= 1 && DEFAULT_CONCURRENCY <= 8,
      'an unbounded default would open a socket per segment on a long message');
  });

  test('stats count calls and cache hits separately', async () => {
    const callModel = counting(goodTransport());
    const { stats } = await extractSegments([SEG, SEG, 'I work at Zeta Systems.'], { callModel, concurrency: 1 });
    assert.equal(stats.segments, 3);
    assert.equal(stats.cacheHits, 1, 'the repeated segment hit the cache');
    assert.equal(stats.calls, 2);
    assert.equal(callModel.calls, 2);
  });

  test('a non-array input yields nothing and does not throw', async () => {
    for (const bad of [null, undefined, 'text', 42, {}]) {
      const { results, stats } = await extractSegments(bad, { callModel: goodTransport() });
      assert.deepEqual(results, []);
      assert.equal(stats.segments, 0);
    }
  });
});
