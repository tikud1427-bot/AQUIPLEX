/**
 * AQUA — E12: Prometheus text exposition.
 *
 * `getMetrics()` has always claimed to be "for /metrics or Prometheus scrape"
 * but returned only a JSON blob. This renders that blob (plus cost and queue
 * state) in the Prometheus text format, dependency-free, so a scraper needs no
 * adapter.
 *
 * PURE: takes snapshots, returns a string. No I/O, no env vars.
 * LABEL SAFETY: label values are escaped per the exposition format, and only
 * internal enumerations (provider, task type, purpose, job state) are ever used
 * as labels — never message content, owner ids or error text.
 */

const NAME_BAD = /[^a-zA-Z0-9_]/g;
const metricName = (s) => `aqua_${String(s).replace(NAME_BAD, '_')}`.replace(/_+/g, '_');
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labels = (l) => {
  const parts = Object.entries(l ?? {}).map(([k, v]) => `${k.replace(NAME_BAD, '_')}="${esc(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};

export function renderPrometheus({ metrics = {}, cost = null, queue = null, dlq = null } = {}) {
  const out = [];
  const seenType = new Set();
  const emit = (name, type, value, l, help) => {
    if (!Number.isFinite(value)) return; // null/NaN = "no data", not zero
    if (!seenType.has(name)) {
      seenType.add(name);
      if (help) out.push(`# HELP ${name} ${help}`);
      out.push(`# TYPE ${name} ${type}`);
    }
    out.push(`${name}${labels(l)} ${value}`);
  };

  emit('aqua_requests_total', 'counter', metrics.totalRequests, {}, 'Requests handled');
  emit('aqua_request_successes_total', 'counter', metrics.totalSuccesses);
  emit('aqua_request_failures_total', 'counter', metrics.totalFailures);
  emit('aqua_request_latency_avg_ms', 'gauge', metrics.avgLatencyMs);
  emit('aqua_request_latency_p95_ms', 'gauge', metrics.p95LatencyMs);

  for (const [provider, s] of Object.entries(metrics.byProvider ?? {})) {
    emit('aqua_provider_requests_total', 'counter', s?.requests, { provider });
    emit('aqua_provider_failures_total', 'counter', s?.failures, { provider });
    emit('aqua_provider_latency_avg_ms', 'gauge', s?.avgLatencyMs, { provider });
  }
  for (const [task, s] of Object.entries(metrics.byTask ?? {})) {
    emit('aqua_task_failures_total', 'counter', s?.failures, { task });
  }

  // Flat numeric fields of the E6 and memory-retrieval snapshots, generically,
  // so a counter added there appears here without a second edit.
  for (const [group, obj] of [['e6', metrics.e6], ['memory_retrieval', metrics.memoryRetrieval]]) {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (typeof v === 'number') emit(metricName(`${group}_${k}`), 'gauge', v);
    }
  }

  if (cost) {
    emit('aqua_cost_turns_total', 'counter', cost.turns);
    emit('aqua_cost_calls_total', 'counter', cost.calls);
    emit('aqua_cost_input_tokens_total', 'counter', cost.inputTokens);
    emit('aqua_cost_output_tokens_total', 'counter', cost.outputTokens);
    emit('aqua_cost_unpriced_calls_total', 'counter', cost.unpricedCalls, {},
      'Calls with no known price; cost_usd understates spend while this is > 0');
    emit('aqua_cost_usd_total', 'counter', cost.pricedCostUsd);
    for (const [purpose, b] of Object.entries(cost.byPurpose ?? {})) {
      emit('aqua_cost_purpose_tokens_total', 'counter', (b.inputTokens ?? 0) + (b.outputTokens ?? 0), { purpose });
    }
  }

  if (queue) {
    for (const state of ['queued', 'running', 'done', 'dead']) {
      emit('aqua_jobs', 'gauge', queue[state], { state }, 'Durable job queue depth by state');
    }
  }
  if (dlq) {
    emit('aqua_dlq_level', 'gauge', { ok: 0, warn: 1, alert: 2 }[dlq.level], {}, 'DLQ alert level: 0 ok, 1 warn, 2 alert');
    emit('aqua_dlq_oldest_dead_age_seconds', 'gauge', dlq.oldestDeadAgeMs == null ? NaN : dlq.oldestDeadAgeMs / 1000);
  }

  return out.join('\n') + '\n';
}
