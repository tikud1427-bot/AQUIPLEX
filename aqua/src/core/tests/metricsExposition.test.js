/** E12 — Prometheus exposition. BITE (measured): emit NaN as 0 → 2 fail; skip quote escaping → 1 fail. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrometheus } from '../metricsExposition.js';

describe('renderPrometheus', () => {
  test('renders counters, per-provider labels, queue state and DLQ level', () => {
    const txt = renderPrometheus({
      metrics: { totalRequests: 10, totalFailures: 2, byProvider: { groq: { requests: 7, failures: 1, avgLatencyMs: 120 } } },
      queue: { queued: 4, running: 1, done: 90, dead: 3 },
      dlq: { level: 'warn', oldestDeadAgeMs: 90000 },
    });
    assert.match(txt, /# TYPE aqua_requests_total counter\naqua_requests_total 10\n/);
    assert.match(txt, /aqua_provider_requests_total\{provider="groq"\} 7/);
    assert.match(txt, /aqua_jobs\{state="dead"\} 3/);
    assert.match(txt, /aqua_dlq_level 1\n/);
    assert.match(txt, /aqua_dlq_oldest_dead_age_seconds 90\n/);
  });

  test('TYPE is declared once per metric even with many label sets', () => {
    const txt = renderPrometheus({ metrics: { byProvider: { a: { requests: 1 }, b: { requests: 2 } } } });
    assert.equal((txt.match(/# TYPE aqua_provider_requests_total/g) ?? []).length, 1);
  });

  test('"no data" (null/NaN) is omitted, never rendered as 0', () => {
    const txt = renderPrometheus({ metrics: { totalRequests: 1, avgLatencyMs: null }, dlq: { level: 'ok', oldestDeadAgeMs: null } });
    assert.doesNotMatch(txt, /aqua_request_latency_avg_ms/);
    assert.doesNotMatch(txt, /oldest_dead_age/);
  });

  test('label values are escaped so a hostile provider name cannot forge a series', () => {
    const txt = renderPrometheus({ metrics: { byProvider: { 'x"} 999\nevil{a="': { requests: 1 } } } });
    assert.doesNotMatch(txt, /^evil/m);
    assert.equal(txt.split('\n').filter(l => l.startsWith('aqua_provider_requests_total')).length, 1);
    // The quote and the newline must both arrive ESCAPED inside one label value.
    assert.ok(txt.includes('provider="x\\"} 999\\nevil{a=\\""} 1'), txt);
  });

  test('cost output states when it understates spend', () => {
    const txt = renderPrometheus({ cost: { turns: 2, calls: 3, inputTokens: 10, outputTokens: 5, unpricedCalls: 3, pricedCostUsd: 0, byPurpose: { chat: { inputTokens: 10, outputTokens: 5 } } } });
    assert.match(txt, /aqua_cost_unpriced_calls_total 3/);
    assert.match(txt, /aqua_cost_purpose_tokens_total\{purpose="chat"\} 15/);
  });

  test('generic E6 numeric fields appear; non-numeric are ignored', () => {
    const txt = renderPrometheus({ metrics: { e6: { turns: 5, admitted: 2, note: 'text' } } });
    assert.match(txt, /aqua_e6_turns 5/);
    assert.doesNotMatch(txt, /note/);
  });

  test('empty input yields a valid (empty) document', () => {
    assert.equal(renderPrometheus(), '\n');
  });
});
