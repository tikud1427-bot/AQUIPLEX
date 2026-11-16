/**
 * Sprint 6 (2026-11-11) — the answer-evaluation runner: spend ledger, provider
 * client (bounded retries), judge runner (validation, re-ask, resume, review
 * queues) and the two CLIs in dry-run mode. No provider is ever contacted: the
 * transports are fakes, and the CLI tests run with a preloaded fetch guard that
 * counts any non-loopback request.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLedger, DEFAULT_CAP_USD, SpendCapReached, PricesMissing } from '../answer/spendLedger.mjs';
import { createClient, mockTransport, httpTransport, NonRetryableProviderError, MOCK_JUDGEMENT } from '../answer/providerClient.mjs';
import { runJudge, parseJudgement, mergeJudgements, aggregateJudge, judgePrompt } from '../answer/judgeRunner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.join(HERE, '../..');
const PRICES = { m: { inputPerMTok: 1, outputPerMTok: 2 } };   // test prices: arbitrary units, not real prices
const noSleep = async () => {};
const fake = (statuses, usage = { prompt_tokens: 100, completion_tokens: 50 }) => {
  const calls = [];
  const t = async body => { calls.push(body); const s = statuses[Math.min(calls.length - 1, statuses.length - 1)]; if (s === 'throw') throw new Error('ECONNRESET'); return { status: s, json: s === 200 ? { model: 'm-1', choices: [{ message: { content: 'ok' } }], usage } : { error: 'x' } }; };
  t.calls = calls; return t;
};

describe('spend ledger', () => {
  test('default pilot cap is $25', () => assert.equal(DEFAULT_CAP_USD, 25));
  test('a request whose worst case would cross the cap is refused before sending', () => {
    const l = createLedger({ capUsd: 0.001, prices: PRICES });
    // worst = (1000*1 + 1000*2)/1e6 = 0.003 > 0.001
    assert.throws(() => l.authorise({ model: 'm', estInputTokens: 1000, maxOutputTokens: 1000 }), SpendCapReached);
    assert.equal(l.snapshot().refused, 1);
  });
  test('no price → no request (prices are never assumed)', () => {
    const l = createLedger({ capUsd: 25, prices: {} });
    assert.throws(() => l.authorise({ model: 'unknown-model', estInputTokens: 1, maxOutputTokens: 1 }), PricesMissing);
  });
  test('an attempt without usage is charged its worst case; with usage, its actual cost', () => {
    const l = createLedger({ capUsd: 25, prices: PRICES });
    assert.equal(l.record({ model: 'm', usage: null, worstUsd: 0.5 }), 0.5);
    assert.equal(l.record({ model: 'm', usage: { prompt_tokens: 1e6, completion_tokens: 0 }, worstUsd: 9 }), 1);
    assert.equal(l.snapshot().spentUsd, 1.5);
  });
});

describe('provider client', () => {
  test('retries 503 then succeeds; every attempt is authorised and charged', async () => {
    const t = fake([503, 200]);
    const l = createLedger({ capUsd: 25, prices: PRICES });
    const c = createClient({ transport: t, ledger: l, model: 'm', maxRetries: 2, sleep: noSleep });
    const r = await c.chat({ messages: [{ role: 'user', content: 'hi' }], settings: { max_tokens: 100 } });
    assert.equal(r.attempts, 2); assert.equal(t.calls.length, 2);
    assert.equal(l.snapshot().requests, 2, 'the failed attempt is charged too (conservative)');
  });
  test('bounded: after maxRetries+1 failures it stops', async () => {
    const t = fake([429]);
    const c = createClient({ transport: t, ledger: null, model: 'm', maxRetries: 2, sleep: noSleep });
    await assert.rejects(c.chat({ messages: [{ role: 'user', content: 'x' }] }), e => e.name === 'RetriesExhausted');
    assert.equal(t.calls.length, 3);
  });
  test('network errors are retried; non-retryable 4xx stops immediately', async () => {
    const t1 = fake(['throw', 200]);
    assert.equal((await createClient({ transport: t1, model: 'm', sleep: noSleep }).chat({ messages: [{ role: 'user', content: 'x' }] })).attempts, 2);
    const t2 = fake([400]);
    await assert.rejects(createClient({ transport: t2, model: 'm', sleep: noSleep }).chat({ messages: [{ role: 'user', content: 'x' }] }), NonRetryableProviderError);
    assert.equal(t2.calls.length, 1);
  });
  test('the cap stops a retry loop BEFORE the next attempt is sent', async () => {
    const t = fake([503]);
    // each attempt's worst case ≈ (est input + 1000 out*2)/1e6 ≈ 0.002; cap allows one attempt only
    const l = createLedger({ capUsd: 0.0025, prices: PRICES });
    const c = createClient({ transport: t, ledger: l, model: 'm', maxRetries: 5, sleep: noSleep });
    await assert.rejects(c.chat({ messages: [{ role: 'user', content: 'x' }], settings: { max_tokens: 1000 } }), SpendCapReached);
    assert.equal(t.calls.length, 1, 'only the attempt that fit under the cap was sent');
  });
  test('httpTransport refuses to exist without endpoint and key', () => {
    assert.throws(() => httpTransport({ baseUrl: '', apiKey: '' }));
  });
});

describe('judge runner', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-judge-')), 'judgements.jsonl');
  const REQS = [{ id: 'j0', history: 'I live in Leeds.', question: 'Where do I live?', answer: 'Leeds.' }, { id: 'j1', history: 'x', question: 'y', answer: 'z' }];

  test('the judge prompt carries no arm or context, and asks for confidence', () => {
    const p = judgePrompt(REQS[0]);
    assert.doesNotMatch(p, /\barm\b|INFORMATION NEEDS|NEEDS CHECK|system prompt/i);
    assert.match(p, /"confidence":0-1/);
  });
  test('parseJudgement validates ranges and types', () => {
    assert.equal(parseJudgement(JSON.stringify(MOCK_JUDGEMENT)).ok, true);
    assert.equal(parseJudgement('{"factual_correctness":3}').ok, false);
    assert.equal(parseJudgement('not json').ok, false);
    assert.equal(parseJudgement(JSON.stringify({ ...MOCK_JUDGEMENT, confidence: 2 })).ok, false);
  });
  test('malformed output is re-asked once, then queued for review (never dropped)', async () => {
    const out = tmp();
    const c = createClient({ transport: mockTransport({ judgeReply: 'I think it is fine.' }), model: 'mock', sleep: noSleep });
    const r = await runJudge({ requests: REQS.slice(0, 1), outFile: out, client: c });
    assert.equal(r.malformed, 1);
    const row = JSON.parse(fs.readFileSync(out, 'utf8').trim());
    assert.equal(row.status, 'malformed'); assert.equal(row.attempts, 2); assert.equal(row.review, 'malformed-json');
  });
  test('resume: ids already judged are skipped', async () => {
    const out = tmp();
    const c = createClient({ transport: mockTransport(), model: 'mock' });
    assert.equal((await runJudge({ requests: REQS, outFile: out, client: c })).judged, 2);
    const again = await runJudge({ requests: REQS, outFile: out, client: c });
    assert.deepEqual([again.judged, again.skipped], [0, 2]);
  });
  test('the cap stops the judge cleanly mid-run, keeping what was judged', async () => {
    const out = tmp();
    // Each reply reports 1000 in / 300 out = (1000·1 + 300·2)/1e6 = $0.0016 (test prices).
    const billed = async () => ({ status: 200, json: { model: 'mock', choices: [{ message: { content: JSON.stringify(MOCK_JUDGEMENT) } }], usage: { prompt_tokens: 1000, completion_tokens: 300 } } });
    const l = createLedger({ capUsd: 0.0025, prices: { mock: { inputPerMTok: 1, outputPerMTok: 2 } } });   // $0.0016 spent + next worst case (≥ $0.0008 for its 400 output tokens, plus input) > $0.0025
    const c = createClient({ transport: billed, ledger: l, model: 'mock' });
    const r = await runJudge({ requests: REQS, outFile: out, client: c });
    assert.equal(r.status, 'stopped-cap');
    assert.equal(r.judged, 1, 'the first fit under the cap; the second would not');
    assert.equal(fs.readFileSync(out, 'utf8').trim().split('\n').length, 1, 'what was judged is on disk');
    assert.ok(l.snapshot().spentUsd <= 0.0025);
  });

  test('a cap below one request stops before anything is sent', async () => {
    const out = tmp();
    let sent = 0;
    const t = async () => { sent++; return { status: 200, json: {} }; };
    const l = createLedger({ capUsd: 0.0001, prices: { mock: { inputPerMTok: 1, outputPerMTok: 2 } } });
    const r = await runJudge({ requests: REQS, outFile: out, client: createClient({ transport: t, ledger: l, model: 'mock' }) });
    assert.deepEqual([r.status, r.judged, sent], ['stopped-cap', 0, 0]);
  });
  test('merge: un-blinds with the key and queues low confidence, judge disagreement and judge-vs-deterministic gaps', () => {
    const j = (id, judge, over = {}) => ({ id, judge, status: 'ok', judgement: { ...MOCK_JUDGEMENT, confidence: 0.9, ...over } });
    const judgements = [j('j0', 'judge-1', { factual_correctness: 0 }), j('j0', 'judge-2', { factual_correctness: 2 }), j('j1', 'judge-1', { confidence: 0.3 })];
    const key = { j0: { scenario: 's0', arm: 'A', regime: 'long' }, j1: { scenario: 's1', arm: 'H', regime: 'long' } };
    const rows = [{ scenario: 's0', arm: 'A', regime: 'long', grades: { factual_correctness: 1 } }, { scenario: 's1', arm: 'H', regime: 'long', grades: {} }];
    const { merged, review } = mergeJudgements({ judgements, key, rows });
    assert.equal(merged.length, 2);
    const reasons = review.map(r => r.reason);
    assert.ok(reasons.includes('low-confidence'));
    assert.ok(reasons.includes('judges-disagree:factual_correctness'));
    assert.ok(reasons.includes('judge-vs-deterministic:factual_correctness'));
    assert.deepEqual(Object.keys(aggregateJudge(merged)).sort(), ['A', 'H']);
  });
});

describe('CLIs in dry-run mode make no external calls', () => {
  const guard = pathToFileURL(path.join(HERE, 'fixtures/fetchGuard.mjs')).href;
  const label = `test-dry-${process.pid}`;
  const results = path.join(AQUA, 'eval/answer/results');
  const cleanup = () => { for (const f of fs.readdirSync(results)) if (f.startsWith(label)) fs.rmSync(path.join(results, f)); };
  const run = (script, extra) => {
    const out = path.join(os.tmpdir(), `fetch-guard-${process.pid}-${script.replace(/\W/g, '')}.txt`);
    const r = spawnSync(process.execPath, ['--import', guard, path.join(AQUA, 'scripts', script), ...extra], {
      cwd: AQUA, encoding: 'utf8', timeout: 240_000,
      env: { ...process.env, FETCH_GUARD_OUT: out, AQUA_ANSWER_EVAL_APPROVED: '', ANSWER_EVAL_API_KEY: '', JUDGE_API_KEY: '' },
    });
    return { ...r, external: Number(fs.readFileSync(out, 'utf8')) };
  };

  test('answer-eval (arms A,H) and answer-judge (+ merge): complete, 0 external requests', () => {
    try {
      const a = run('answer-eval.mjs', ['--limit', '2', '--arms', 'A,H', '--label', label]);
      assert.equal(a.status, 0, a.stderr);
      assert.equal(a.external, 0, 'answer-eval made no external request');
      const j = run('answer-judge.mjs', ['--label', label]);
      assert.equal(j.status, 0, j.stderr);
      assert.equal(j.external, 0, 'answer-judge made no external request');
      const m = run('answer-judge.mjs', ['--label', label, '--merge']);
      assert.equal(m.status, 0, m.stderr);
      // Zero-budget integration (2026-11-11): the pair store replaces judge-requests/judge-key files;
      // the judge still never receives an arm (asserted in evalProviderIntegration.test.js).
      const merged = JSON.parse(fs.readFileSync(path.join(results, `${label}.merged.json`), 'utf8'));
      assert.deepEqual([merged.counts.answers, merged.counts.judgements], [4, 4]);
      assert.deepEqual(Object.keys(merged.aggregates).sort(), ['A', 'H']);
    } finally { cleanup(); }
  });

  test('--execute without approval, credentials or prices is refused (exit 2), before any request', () => {
    const a = run('answer-eval.mjs', ['--execute', '--limit', '1', '--label', label]);
    assert.equal(a.status, 2); assert.equal(a.external, 0);
    const j = run('answer-judge.mjs', ['--execute', '--label', label]);
    assert.equal(j.status, 2); assert.equal(j.external, 0);
    cleanup();
  });
});
