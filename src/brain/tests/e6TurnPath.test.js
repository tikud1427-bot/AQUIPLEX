/**
 * E6 on the real turn path — blueprint §8's non-negotiable, finally closed.
 *
 * §8: "Do not leave the new understanding system as beautiful code + unit tests
 * + zero production consumers." It had zero for its entire life —
 * `grep runUnderstandingPipeline src/ routes/` returned its own module and its
 * own tests, nothing else.
 *
 * 🔴 WIRED, NOT PROMOTED, AND THE DIFFERENCE IS THE POINT.
 * E6 fails its own gate: negation detection reads 85% against a 95% bar on both
 * valid full shadow runs. Everything else it clears, over 200 labelled cases —
 * overall strict accuracy 0.18 → 0.495, predicate accuracy 0.00 → 0.473,
 * silence on negatives 0.90 → 0.975. Off by default makes it reachable for a
 * shadow run against real traffic without claiming it is ready.
 *
 * BITE, MEASURED (revert the named change → count failures):
 *   AQUA_E6 defaults to off        → 2 fail
 *   understandTurn refuses when off → 2 fail
 *   post-turn call is deferred      → 1 fail
 *   post-turn call is fail-open     → 1 fail
 *   the seam does not COMMIT claims → 1 fail
 */
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Brain from '../index.js';
import { runPostTurn, _internals } from '../../routes/turnPostProcess.js';
import { getMetrics, logE6Turn, _resetE6Metrics } from '../../core/observability.js';
import * as canonicalIds from '../identity/canonicalId.js';
import { putEntry as putIdEntry, _resetIdsForTests } from '../identity/idStore.js';
import { SELF_CANONICAL_ID, SELF_KIND, SELF_LABEL } from '../identity/selfEntity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const POST = readFileSync(path.join(ROOT, 'src/routes/turnPostProcess.js'), 'utf8');
const FACADE = readFileSync(path.join(ROOT, 'src/brain/index.js'), 'utf8');

const original = process.env.AQUA_E6;
afterEach(() => {
  if (original === undefined) delete process.env.AQUA_E6;
  else process.env.AQUA_E6 = original;
});

/** A post-turn deps stub: nothing real runs, and `defer` is made synchronous. */
function stubDeps(over = {}) {
  return {
    memoryAfterTurn: () => {},
    getConversation: () => [],
    observeConversationTurn: () => {},
    observeTwin: () => {},
    reflectTurn: () => {},
    consolidate: () => {},
    consolidateEnabled: () => false,
    defer: fn => fn(),
    ...over,
  };
}

// ── Shared observability helpers (used by the E6 output and S6 blocks) ──────

/**
 * Run the seam and collect what it printed.
 *
 * ASYNC ON PURPOSE. The reporter is three `.then` hops downstream of the
 * deferred block, so it lands on a microtask AFTER `runPostTurn` returns. A
 * synchronous capture restores `console` first and records nothing — which
 * reads exactly like the defect this file is here to catch, from a test bug.
 * `setImmediate` drains the microtask queue; the deferred jobs are collected
 * and awaited rather than fired, so nothing escapes the capture window.
 */
async function capture(args, over = {}) {
  const jobs = [];
  const lines = [];
  const log = console.log; const warn = console.warn;
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    runPostTurn(args, { ...stubDeps(over), defer: fn => jobs.push(fn) });
    for (const j of jobs) await j();
    await new Promise(r => setImmediate(r));
  } finally { console.log = log; console.warn = warn; }
  return lines;
}

/** The same, but with every dependency except `defer` left at production default. */
async function captureReal(args) {
  const jobs = [];
  const lines = [];
  const log = console.log; const warn = console.warn;
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    runPostTurn(args, { defer: fn => jobs.push(fn) });
    for (const j of jobs) await j();
    await new Promise(r => setImmediate(r));
  } finally { console.log = log; console.warn = warn; }
  return lines;
}

const TURN = { ownerId: 'u1', conversationId: 'c1', userMessage: 'hi', assistantMessage: 'ok' };
const e6Lines = lines => lines.filter(l => l.startsWith('[E6]'));

describe('the flag defaults to the honest answer', () => {
  test('AQUA_E6 is off unless explicitly turned on', () => {
    delete process.env.AQUA_E6;
    assert.equal(Brain.e6Enabled(), false);
    process.env.AQUA_E6 = 'on';
    assert.equal(Brain.e6Enabled(), true);
  });

  test('it is read per call, not captured at import', () => {
    // A rollback should be a restart, not a redeploy. Capturing at module load
    // would make the flag a lie the first time someone needed it.
    delete process.env.AQUA_E6;
    assert.equal(Brain.e6Enabled(), false);
    process.env.AQUA_E6 = 'on';
    assert.equal(Brain.e6Enabled(), true, 'the flag was captured at import');
  });

  test('understandTurn returns null when off, without touching a provider', async () => {
    delete process.env.AQUA_E6;
    assert.equal(await Brain.understandTurn({ ownerId: 'u', userMessage: 'I work at Nummo.' }), null);
  });

  test('it also refuses on missing input', async () => {
    process.env.AQUA_E6 = 'on';
    assert.equal(await Brain.understandTurn({ ownerId: 'u' }), null);
    assert.equal(await Brain.understandTurn({ userMessage: 'x' }), null);
  });
});

describe('the post-turn seam exists and is shaped like its siblings', () => {
  test('runPostTurn calls understandTurn when the flag is on', async () => {
    let called = null;
    runPostTurn(
      { ownerId: 'u1', conversationId: 'c1', userMessage: 'I work at Nummo.', assistantMessage: 'ok' },
      stubDeps({ e6Enabled: () => true, understandTurn: a => { called = a; return Promise.resolve({}); } }),
    );
    // The seam starts from `Promise.resolve().then(...)`, so the call lands a
    // microtask later even with a synchronous `defer`. Asserting immediately
    // read `null` and looked exactly like an unwired seam — which is the thing
    // this test exists to detect, so it must not be able to say so falsely.
    await Promise.resolve();
    assert.ok(called, 'E6 was never reached from the turn path — §8 is still open');
    assert.equal(called.ownerId, 'u1');
    assert.equal(called.userMessage, 'I work at Nummo.');
  });

  test('it does NOT call it when the flag is off', async () => {
    let called = false;
    runPostTurn(
      { ownerId: 'u1', conversationId: 'c1', userMessage: 'hi', assistantMessage: 'ok' },
      stubDeps({ e6Enabled: () => false, understandTurn: () => { called = true; } }),
    );
    await Promise.resolve();
    assert.equal(called, false);
  });

  test('a throwing extractor does not take the turn with it', () => {
    // Every sibling in this file is fail-open for the same reason: enrichment
    // must never cost the user their reply.
    assert.doesNotThrow(() => runPostTurn(
      { ownerId: 'u1', conversationId: 'c1', userMessage: 'hi', assistantMessage: 'ok' },
      stubDeps({ e6Enabled: () => true, understandTurn: () => { throw new Error('provider down'); } }),
    ));
  });

  test('a REJECTING extractor does not surface an unhandled rejection', () => {
    // The pipeline is async, so the throw arrives as a rejected promise. A bare
    // try/catch would miss it and crash the process on the next tick.
    assert.doesNotThrow(() => runPostTurn(
      { ownerId: 'u1', conversationId: 'c1', userMessage: 'hi', assistantMessage: 'ok' },
      stubDeps({ e6Enabled: () => true, understandTurn: () => Promise.reject(new Error('timeout')) }),
    ));
    assert.match(POST, /\.catch\(\(\) => \{ \/\* fail-open/, 'the promise rejection path is unguarded');
  });

  test('the call is DEFERRED, never on the response path', () => {
    // One provider call per segment. The user must not wait on it.
    let deferred = false;
    runPostTurn(
      { ownerId: 'u1', conversationId: 'c1', userMessage: 'hi', assistantMessage: 'ok' },
      stubDeps({ defer: fn => { deferred = true; fn(); }, e6Enabled: () => true, understandTurn: () => Promise.resolve({}) }),
    );
    assert.ok(deferred);
  });
});

describe('wired is not promoted', () => {
  test('the seam extracts and returns — it does not commit claims', () => {
    // An extractor that fails its own negation gate must not be writing into
    // the world model on the way to being evaluated. Shadow first.
    assert.match(FACADE, /IT EXTRACTS AND RETURNS; IT DOES NOT COMMIT/);
    const fn = FACADE.slice(FACADE.indexOf('export async function understandTurn'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    for (const writer of ['recordClaim', 'commitPlan', 'saveFact', 'attachEvidence']) {
      assert.ok(!body.includes(writer), `understandTurn calls ${writer} — that is promotion, not wiring`);
    }
  });

  test('the default keeps production behaviour identical', async () => {
    // The whole safety argument. Flag off, nothing runs, nothing changes.
    delete process.env.AQUA_E6;
    let called = false;
    runPostTurn(
      { ownerId: 'u1', conversationId: 'c1', userMessage: 'hi', assistantMessage: 'ok' },
      stubDeps({ understandTurn: () => { called = true; } }),
    );
    await Promise.resolve();
    assert.equal(called, false);
  });
});

// ── The seam must actually EXTRACT, not merely be reachable ──────────────────

describe('wired is not the same as working', () => {
  /**
   * 🔴 THE FIRST VERSION OF THIS SEAM WAS WIRED AND DEAD, AND EVERY TEST ABOVE
   * PASSED ANYWAY.
   *
   * `runUnderstandingPipeline` takes `callModel` from its caller and has NO
   * default — its own docs say "without it S3 yields nothing". `understandTurn`
   * did not pass one, so `AQUA_E6=on` produced this on every turn:
   *
   *     segments 1 · gated 1 · called 1 · errors 1 · admitted 0
   *
   * Silently, because the post-turn seam is fail-open by design. The tests
   * above could not see it: they stub `understandTurn` at the DEPS level to
   * check the wiring, so the real function was never once executed. Testing
   * that a seam is REACHED is not testing that it WORKS, and the gap between
   * those two claims is where this hid.
   */
  test('a turn with a working transport yields admitted claims', async () => {
    process.env.AQUA_E6 = 'on';
    const stub = async () => ({
      text: JSON.stringify({ claims: [{
        subject: 'self', predicate: 'works_at', object: { entity: 'Nummo' },
        polarity: 'asserted', modality: 'fact', timePrecision: 'none',
        statementText: 'I work at Nummo', confidenceExtraction: 0.9,
      }] }),
      model: 'stub/model',
    });
    const r = await Brain.understandTurn({
      ownerId: 'u-seam', conversationId: 'c-seam',
      userMessage: 'I work at Nummo.', callModel: stub,
    });
    assert.ok(r, 'the pipeline returned nothing');
    assert.equal(r.stats.errors, 0, `transport errored: ${JSON.stringify(r.stats)}`);
    assert.equal(r.claims.length, 1, 'S3 yielded no claims — is a transport being passed?');
  });

  test('e6Transport returns a usable callable', async () => {
    const t = await Brain.e6Transport();
    assert.equal(typeof t, 'function');
  });

  test('understandTurn supplies that transport when the caller does not', () => {
    // ⚠️ A SOURCE ASSERTION, BECAUSE THE RUNTIME ONE DOES NOT DISCRIMINATE.
    //
    // The obvious test — call it with no transport and assert `stats.called`
    // — was written, and the bite check exposed it as worthless: with the
    // transport REMOVED the stats are `called 1 · errors 1`, and with the
    // transport present but no provider key they are also `called 1 ·
    // errors 1`. Identical. The pipeline counts the attempt before it
    // discovers what went wrong, so no runtime signal separates "no transport
    // was supplied" from "the transport had no keys" in this environment.
    //
    // Verifying the wiring at the source is weaker, and it is what can
    // actually fail when the defect returns.
    assert.match(FACADE, /callModel: callModel \?\? \(await e6Transport\(\)\)/,
      'understandTurn no longer supplies a transport — S3 will yield nothing, silently');
  });

  test('the transport matches what the shadow numbers describe', () => {
    // strict accuracy 0.495 and predicate 0.473 were measured with generateGroq,
    // openai/gpt-oss-120b pinned, 1024 tokens. A production transport that
    // differs in any of those is not the thing that was measured.
    const fn = FACADE.slice(FACADE.indexOf('export async function e6Transport'));
    assert.match(fn, /openai\/gpt-oss-120b/, 'the pinned model changed — the shadow result no longer transfers');
    assert.match(fn, /undefined, 1024,/, 'the token budget changed');
    assert.match(fn, /generateGroq/);
  });

  test('the model is PINNED, not left to rotate', () => {
    // `getCandidateModels` cycles for both providers. Unpinned, a metric change
    // could be the prompt or could be a different model, and nothing would
    // distinguish them — the NOT PUBLISHABLE guard e6-shadow raises.
    const fn = FACADE.slice(FACADE.indexOf('export async function e6Transport'));
    assert.match(fn, /model: perCall \?\? model/);
  });
});

// ── The stage has an output ──────────────────────────────────────────────────

/**
 * 🔴 THE SEAM WAS WIRED, WORKING, AND STILL DARK.
 *
 * Every test above proves E6 is REACHED and that it EXTRACTS. None of them
 * could see the third failure: `turnPostProcess` called `understandTurn` inside
 * `.then(() => …)` — an arrow taking no parameter — so the result was
 * unreachable. With `AQUA_E6=on` production bought one provider call per
 * segment and emitted nothing at all. A turn that admitted zero claims and a
 * turn whose transport threw produced the same observable output: none.
 *
 * That is the ambiguity `e6-shadow.mjs` exists to refuse. It was reintroduced
 * in production, by default, behind a fail-open catch. L13: a dark stage with a
 * bill attached.
 *
 * BITE, MEASURED (revert the named change → count failures):
 *   result is bound (`.then(result => …)`)  → 6 fail
 *   a failure logs FAILED instead of silence → 3 fail
 *   flag off emits nothing                   → 1 fail
 */
describe('E6 reports what it did', () => {

  beforeEach(() => { _resetE6Metrics(); });

  test('THE WIRING TEST: production default deps produce a line and move a counter', async () => {
    // Only `defer` is overridden, and only to make the deferred job awaitable.
    // `understandTurn`, `e6Enabled` and `reportE6` are all REAL_DEPS — the real
    // facade, the real pipeline, the real reporter. There is no provider key in
    // a test environment, so S3 errors; that is the point. The historical
    // silent failure was EXACTLY this shape, and it is now a printed line.
    process.env.AQUA_E6 = 'on';
    // A SENTENCE NO OTHER TEST IN THIS FILE USES. S3 caches by segment text,
    // and the transport test above already extracted "I work at Nummo." —
    // reusing it turns this into a cache-hit assertion, which measures the
    // cache rather than the seam.
    const lines = await captureReal({
      ownerId: 'u-obs', conversationId: 'c-obs',
      userMessage: 'Chhanda moved the deploy to Tuesday.', assistantMessage: 'ok',
    });

    const emitted = e6Lines(lines);
    assert.equal(emitted.length, 1, `expected exactly one [E6] line, got ${emitted.length}`);
    for (const field of ['segments=', 'gated=', 'called=', 'errors=', 'admitted=', 'ms=', 'stages=']) {
      assert.ok(emitted[0].includes(field), `the line does not carry ${field}: ${emitted[0]}`);
    }

    // Observable COLLABORATOR state, not just a string — L12's actual bar.
    const m = getMetrics().e6;
    assert.equal(m.turns, 1, 'the production reporter did not record the turn');
    assert.equal(m.segments, 1, 'S1 did not segment through the production path');
    // Cache-independent: S3 either called the transport or served a cached
    // segment. Which one is not the claim being made here — that the stage ran
    // and said so, is.
    assert.equal(m.called + m.cached, 1, 'S3 neither called nor cached — did the pipeline reach it?');
  });

  test('the production default reporter is the real one, not a stub', () => {
    // A seam whose default is a no-op passes every test above and reports
    // nothing in production — the same class of gap this whole block exists for.
    assert.equal(_internals.REAL_DEPS.reportE6, logE6Turn);
  });

  test('THE FIX ITSELF: the returned stats reach the counters', async () => {
    // Binding the result is the entire change. Feed known numbers through the
    // seam and assert they arrive; with `.then(() => …)` restored they cannot.
    process.env.AQUA_E6 = 'on';
    await capture(TURN, {
      understandTurn: () => ({
        claims: [], proposals: [], stagesRun: ['S0'], entityResolution: 'unresolved',
        stats: { segments: 3, gated: 2, called: 2, cached: 0, errors: 0, parsed: 5, admitted: 4, proposed: 1, discarded: 0 },
      }),
    });
    const m = getMetrics().e6;
    assert.equal(m.segments, 3);
    assert.equal(m.admitted, 4);
    assert.equal(m.proposed, 1);
    assert.equal(m.emptyTurns, 0, 'a turn that admitted 4 claims was counted as empty');
  });

  test('A ZERO-CLAIM RUN AND AN ERROR RUN ARE DIFFERENT LINES', async () => {
    // The single most important assertion here. These two were byte-identical
    // — both silent — and telling them apart is why the stage is worth running.
    process.env.AQUA_E6 = 'on';
    const quiet = await capture(TURN, {
      understandTurn: () => ({
        claims: [], proposals: [], stagesRun: ['S0', 'S1'], entityResolution: 'unresolved',
        stats: { segments: 1, gated: 0, called: 0, errors: 0, admitted: 0 },
      }),
    });

    _resetE6Metrics();
    const broken = await capture(TURN, {
      understandTurn: () => { throw new Error('transport exploded'); },
    });

    const a = e6Lines(quiet); const b = e6Lines(broken);
    assert.equal(a.length, 1, 'a zero-claim run emitted nothing — that is the defect');
    assert.equal(b.length, 1, 'a failing run emitted nothing — that is the defect');
    assert.notEqual(a[0], b[0], 'a silent run and a broken run produced the same line');
    assert.match(b[0], /FAILED reason=transport exploded/);
    assert.ok(!a[0].includes('FAILED'), 'a clean zero-claim run was reported as a failure');
  });

  test('a REJECTED promise is reported as a failure, not as silence', async () => {
    process.env.AQUA_E6 = 'on';
    const lines = await capture(TURN, {
      understandTurn: () => Promise.reject(new Error('provider 429')),
    });

    assert.match(e6Lines(lines)[0] ?? '', /FAILED reason=provider 429/);
    assert.equal(getMetrics().e6.failures, 1);
    assert.equal(getMetrics().e6.emptyTurns, 0, 'a failure was counted as a measured silence');
  });

  test('the flag off emits nothing — silence is correct when the stage did not run', async () => {
    // The one case where no line IS the honest output. A stage that never ran
    // must not appear in the counters at all, or `turns` stops being a
    // denominator anyone can reason about.
    delete process.env.AQUA_E6;
    const lines = await capture(TURN, { understandTurn: () => ({ stats: { segments: 9 } }) });
    assert.deepEqual(e6Lines(lines), []);
    assert.equal(getMetrics().e6.turns, 0);
  });

  test('a THROWING reporter does not take the turn with it', async () => {
    // Fail-open floor. Observability is enrichment (L11); a broken reporter
    // must not become the thing that breaks the stage it observes.
    process.env.AQUA_E6 = 'on';
    await assert.doesNotReject(() => capture(TURN, {
      understandTurn: () => ({ stats: {} }),
      reportE6: () => { throw new Error('reporter is broken'); },
    }));
  });

  test('the counters are bounded — no open key space accumulates', async () => {
    // G6. `byGate` is keyed by gate × reason, which is open-ended; it rides the
    // per-turn line and is deliberately NOT accumulated. Every retained field
    // is a scalar, so the metrics object cannot grow with traffic.
    process.env.AQUA_E6 = 'on';
    await capture(TURN, {
      understandTurn: () => ({
        stats: { segments: 1, admitted: 0, byGate: { '2:object-missing': 1, '3:not-in-quote': 2 } },
      }),
    });
    for (const [k, v] of Object.entries(getMetrics().e6)) {
      assert.equal(typeof v, 'number', `e6.${k} is not a scalar — the metrics shape can grow with traffic`);
    }
  });

  test('byGate still reaches the LINE — bounded is not the same as discarded', async () => {
    process.env.AQUA_E6 = 'on';
    const lines = await capture(TURN, {
      understandTurn: () => ({ stats: { segments: 1, discarded: 1, byGate: { '2:object-missing': 1 } } }),
    });
    // Why a claim died is the diagnostic the first shadow run was missing.
    assert.match(e6Lines(lines)[0], /byGate=.*object-missing/);
  });
});

// ── S6 — reachable from production at last (PR-3) ────────────────────────────

/**
 * 🔴 S6 WAS BUILT, TESTED, AND STRUCTURALLY UNREACHABLE.
 *
 * `pipeline.js` returns at its own guard — `entityResolution: 'unresolved'`,
 * `stagesRun: STAGES` — when no `entityStore` is supplied. `understandTurn`
 * supplied none, so the resolver could not execute on a real turn no matter
 * what `AQUA_E6` said. `src/brain/tests/entityResolution.test.js` and
 * `pipeline.test.js` both pass a FIXTURE store, which is exactly why neither
 * could see it: they prove the stage works, not that anything reaches it.
 *
 * The fix passes a READ VIEW over the canonical identity map that already
 * exists — no fourth identity space. See `identity/entityStoreView.js`.
 *
 * BITE, MEASURED (revert the named change → count failures):
 *   entityStore passed into the pipeline    → 4 fail
 *   selfEntityId passed                     → 1 fail
 *   entity-store lookup is fail-open        → 1 fail
 */
describe('S6 is reachable from the production path', () => {
  const originalSelf = process.env.AQUA_SELF_ENTITY;
  beforeEach(() => { _resetE6Metrics(); _resetIdsForTests(); });
  afterEach(() => {
    if (originalSelf === undefined) delete process.env.AQUA_SELF_ENTITY;
    else process.env.AQUA_SELF_ENTITY = originalSelf;
  });

  /** A stub transport that yields one claim with a first-person subject. */
  const worksAtNummo = async () => ({
    text: JSON.stringify({ claims: [{
      subject: 'I', predicate: 'works_at', object: { entity: 'Nummo' },
      polarity: 'asserted', modality: 'fact', timePrecision: 'none',
      statementText: 'I work at Nummo', confidenceExtraction: 0.9,
    }] }),
    model: 'stub/model',
  });

  test('THE WIRING: the production seam reports stages through S6', async () => {
    // Only `defer` is overridden. `understandTurn`, `entityStoreFor`,
    // `selfEntityIdFor` and `reportE6` are all production defaults. There is no
    // provider key, so S3 errors — and S6 still runs, because resolution does
    // not depend on extraction having produced anything. `entities=resolved` is
    // the observable difference: before this change it read `unresolved` on
    // every turn, forever.
    process.env.AQUA_E6 = 'on';
    canonicalIds.resolve('u-s6-wire', { name: 'Nummo', kind: 'org' });

    const lines = await captureReal({
      ownerId: 'u-s6-wire', conversationId: 'c-s6-wire',
      userMessage: 'Priya shipped the billing rewrite.', assistantMessage: 'ok',
    });
    const line = e6Lines(lines)[0] ?? '';

    assert.match(line, /stages=S0,S1,S2,S3,S4,S5,S6/, `S6 did not run: ${line}`);
    assert.match(line, /entities=resolved/, `the store never arrived: ${line}`);
  });

  test('S6 ACTUALLY RESOLVES — real ids off the real identity map', async () => {
    // The claim that matters. `stages` proves the argument arrived; this proves
    // the stage did work against production state. A transport is injected
    // because `runPostTurn` cannot pass one and a keyless environment yields no
    // claims — every other dependency is REAL_DEPS.
    process.env.AQUA_E6 = 'on';
    const { id } = canonicalIds.resolve('u-s6-res', { name: 'Nummo', kind: 'org' });

    const r = await Brain.understandTurn({
      ownerId: 'u-s6-res', conversationId: 'c', userMessage: 'I work at Nummo.',
      callModel: worksAtNummo,
    });

    assert.equal(r.entityResolution, 'resolved');
    assert.equal(r.claims[0].objectEntityId, id, 'the object did not resolve to the stored entity');
    assert.equal(r.stats.s6.byTier['exact-normalized'], 1, 'tier ① did not fire');
    assert.equal(r.stats.s6.byTier['self-grammar'], 1, 'deixis did not resolve by grammar');
  });

  test('deixis resolves to the owner self entity when the owner HAS one', async () => {
    // Criterion 4: existing self-entity behaviour is unchanged. The entry is
    // registered exactly as `ensureSelfEntity` does — with NO norms, so it is
    // reachable by id and never by name.
    process.env.AQUA_E6 = 'on';
    canonicalIds.resolve('u-s6-self', { name: 'Nummo', kind: 'org' });
    putIdEntry('u-s6-self', SELF_CANONICAL_ID, {
      kind: SELF_KIND, canonical: SELF_LABEL, norms: [], refs: [],
    });

    const r = await Brain.understandTurn({
      ownerId: 'u-s6-self', conversationId: 'c', userMessage: 'I work at Nummo.',
      callModel: worksAtNummo,
    });

    assert.equal(r.claims[0].subjectEntityId, SELF_CANONICAL_ID);
    assert.equal(r.stats.s6.ready, 1);
    assert.equal(r.readyForS7.length, 1);
  });

  test('no self entity is reported HONESTLY, not invented', async () => {
    // `SELF_CANONICAL_ID` is one constant shared by every owner. Handing it to
    // S6 unconditionally would assert an identity for owners who have none —
    // AQUA_SELF_ENTITY is off by default and nothing has created it.
    process.env.AQUA_E6 = 'on';
    canonicalIds.resolve('u-s6-noself', { name: 'Nummo', kind: 'org' });

    const r = await Brain.understandTurn({
      ownerId: 'u-s6-noself', conversationId: 'c', userMessage: 'I work at Nummo.',
      callModel: worksAtNummo,
    });

    assert.equal(r.claims[0].subjectEntityId, null);
    assert.equal(r.claims[0].resolution.subject.reason, 'no-self-entity');
    assert.equal(r.readyForS7.length, 0, 'an unresolved subject reached S7-ready');
  });

  test('E6 DISABLED: S6 does not execute', async () => {
    delete process.env.AQUA_E6;
    canonicalIds.resolve('u-s6-off', { name: 'Nummo', kind: 'org' });

    const r = await Brain.understandTurn({
      ownerId: 'u-s6-off', conversationId: 'c', userMessage: 'I work at Nummo.',
      callModel: worksAtNummo,
    });
    assert.equal(r, null, 'the pipeline ran with the flag off');

    const lines = await capture(TURN, { understandTurn: Brain.understandTurn });
    assert.deepEqual(e6Lines(lines), []);
  });

  test('A FAILING ENTITY STORE IS FAIL-OPEN: S0–S5 still complete', async () => {
    // L11. Resolution is enrichment on top of extraction, never a precondition.
    // A throwing store view must leave the turn exactly as it was before PR-3.
    process.env.AQUA_E6 = 'on';
    const r = await Brain.understandTurn(
      { ownerId: 'u-s6-boom', conversationId: 'c', userMessage: 'I work at Nummo.', callModel: worksAtNummo },
      { deps: { entityStoreFor: () => { throw new Error('store exploded'); } } },
    );

    assert.ok(r, 'a broken store took the whole turn with it');
    assert.equal(r.entityResolution, 'unresolved');
    assert.equal(r.stagesRun.includes('S6'), false);
    assert.equal(r.claims.length, 1, 'extraction was lost to a resolution failure');
  });

  test('S7, S8 and S9 still do not run — reachable is not promoted', async () => {
    process.env.AQUA_E6 = 'on';
    canonicalIds.resolve('u-s6-shadow', { name: 'Nummo', kind: 'org' });
    const r = await Brain.understandTurn({
      ownerId: 'u-s6-shadow', conversationId: 'c', userMessage: 'I work at Nummo.',
      callModel: worksAtNummo,
    });
    for (const s of ['S7', 'S8', 'S9']) assert.equal(r.stagesRun.includes(s), false);
    assert.equal('edges' in r, false);
    assert.equal('commitPlan' in r, false);
  });

  test('the S6 statistics reach the [E6] line', async () => {
    process.env.AQUA_E6 = 'on';
    const lines = await capture(TURN, {
      understandTurn: () => ({
        stagesRun: ['S0', 'S6'], entityResolution: 'resolved', claims: [],
        stats: { segments: 1, s6: { ready: 1, ambiguous: 0, provisional: 2, byTier: { 'exact-normalized': 3 } } },
      }),
    });
    assert.match(e6Lines(lines)[0], /s6\.ready=1 s6\.ambiguous=0 s6\.provisional=2/);
    assert.match(e6Lines(lines)[0], /s6\.byTier=.*exact-normalized/);
  });

  test('an UNRUN S6 prints no s6 field — absence is not a measured zero', async () => {
    process.env.AQUA_E6 = 'on';
    const lines = await capture(TURN, {
      understandTurn: () => ({ stagesRun: ['S0'], entityResolution: 'unresolved', stats: { segments: 1 } }),
    });
    assert.ok(!e6Lines(lines)[0].includes('s6.'), 'an unrun stage reported zeros as if it had run');
  });
});
