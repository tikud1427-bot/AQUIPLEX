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

export function renderPrometheus({ metrics = {}, cost = null, queue = null, dlq = null, telemetry = null, evalGate = null, workers = null, servers = null } = {}) {
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

  // Revision voice + J3 consolidation, this process (2026-10-04).
  const voice = (rv, prefix, base) => {
    if (!rv) return;
    emit(`${prefix}_considered_total`, 'counter', rv.considered, base, 'Revision candidates examined');
    emit(`${prefix}_emitted_total`, 'counter', rv.emitted, base, 'Revisions raised to the user');
    for (const [reason, n] of Object.entries(rv.suppressed ?? {})) {
      emit(`${prefix}_suppressed_total`, 'counter', n, { ...base, reason }, 'Revision candidates judged not raisable, by reason');
    }
    for (const [reason, n] of Object.entries(rv.skipped ?? {})) {
      emit(`${prefix}_skipped_total`, 'counter', n, { ...base, reason }, 'Turns on which the voice did not select, by reason');
    }
  };
  const j3 = (o, prefix, base) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (typeof v === 'number') emit(metricName(`${prefix}_${k}_total`), 'counter', v, base);
    }
  };
  voice(metrics.revisionVoice, 'aqua_revision_voice', {});
  j3(metrics.j3, 'j3', {});
  j3(metrics.proactive, 'proactive', {});

  if (cost) {
    emit('aqua_cost_turns_total', 'counter', cost.turns);
    emit('aqua_cost_calls_total', 'counter', cost.calls);
    emit('aqua_cost_input_tokens_total', 'counter', cost.inputTokens);
    emit('aqua_cost_output_tokens_total', 'counter', cost.outputTokens);
    emit('aqua_cost_unpriced_calls_total', 'counter', cost.unpricedCalls, {},
      'Calls with no known price; cost_usd understates spend while this is > 0');
    // Withheld unless EVERY call was priced: with unpriced calls the sum
    // understates spend, and an exported $0 reads as "free" (L16).
    emit('aqua_cost_usd_total', 'counter', cost.unpricedCalls === 0 && cost.calls > 0 ? cost.pricedCostUsd : NaN, {},
      'USD spend; absent while any call is unpriced');
    for (const [purpose, b] of Object.entries(cost.byPurpose ?? {})) {
      emit('aqua_cost_purpose_tokens_total', 'counter', (b.inputTokens ?? 0) + (b.outputTokens ?? 0), { purpose });
    }
  }

  if (queue) {
    for (const state of ['queued', 'running', 'done', 'dead']) {
      emit('aqua_jobs', 'gauge', queue[state], { state }, 'Durable job queue depth by state');
    }
  }
  for (const row of queue?.byKind ?? []) {
    emit('aqua_jobs_window', 'gauge', row.jobs, { kind: row.kind, state: row.state }, 'Jobs touched in the last 24h by kind/state');
    emit('aqua_job_retries_window', 'gauge', row.retries, { kind: row.kind, state: row.state }, 'Retry attempts in the last 24h by kind/state');
  }
  for (const [stage, s] of Object.entries(telemetry?.stages ?? {})) {
    emit('aqua_span_count', 'counter', s.count, { stage }, 'Finished spans per stage (this process)');
    emit('aqua_span_duration_ms_sum', 'counter', Number(s.sumMs.toFixed(2)), { stage });
    emit('aqua_span_duration_ms_max', 'gauge', Number(s.maxMs.toFixed(2)), { stage });
    emit('aqua_span_errors_total', 'counter', s.errors, { stage });
  }
  for (const [where, n] of Object.entries(telemetry?.errors ?? {})) {
    emit('aqua_reported_errors_total', 'counter', n, { where }, 'PII-scrubbed errors reported, by site');
  }
  // Worker processes, from their published snapshots (processMetrics.js). The
  // count is of FRESH snapshots: a worker that stopped publishing is absent.
  if (Array.isArray(workers)) {
    emit('aqua_workers_alive', 'gauge', workers.length, {}, 'Worker processes with a snapshot in the last 2 minutes');
    for (const w of workers) {
      const process = w.processId;
      const snap = w.snapshot ?? {};
      emit('aqua_worker_snapshot_age_seconds', 'gauge', Number(w.ageSeconds.toFixed(1)), { process });
      for (const [stage, s] of Object.entries(snap.telemetry?.stages ?? {})) {
        emit('aqua_worker_span_count', 'counter', s.count, { process, stage }, 'Finished spans per stage, per worker');
        emit('aqua_worker_span_duration_ms_sum', 'counter', Number(Number(s.sumMs ?? 0).toFixed(2)), { process, stage });
        emit('aqua_worker_span_errors_total', 'counter', s.errors, { process, stage });
      }
      for (const [where, n] of Object.entries(snap.telemetry?.errors ?? {})) {
        emit('aqua_worker_reported_errors_total', 'counter', n, { process, where });
      }
      const c = snap.cost ?? {};
      emit('aqua_worker_cost_calls_total', 'counter', c.calls, { process });
      emit('aqua_worker_cost_unpriced_calls_total', 'counter', c.unpricedCalls, { process });
      for (const [purpose, b] of Object.entries(c.byPurpose ?? {})) {
        emit('aqua_worker_cost_purpose_tokens_total', 'counter', (b.inputTokens ?? 0) + (b.outputTokens ?? 0), { process, purpose });
      }
      for (const [k, v] of Object.entries(snap.e6 ?? {})) {
        if (typeof v === 'number') emit(metricName(`worker_e6_${k}`), 'gauge', v, { process });
      }
      j3(snap.j3, 'worker_j3', { process });
      j3(snap.proactive, 'worker_proactive', { process });
    }
  }
  // Every server instance, from its published snapshot: one scrape sees the
  // revision voice across the fleet, not only the instance that answered.
  if (Array.isArray(servers)) {
    emit('aqua_servers_alive', 'gauge', servers.length, {}, 'Server processes with a snapshot in the last 2 minutes');
    for (const sv of servers) voice(sv.snapshot?.revisionVoice, 'aqua_server_revision_voice', { process: sv.processId });
  }
  if (evalGate) {
    emit('aqua_eval_gate_passed', 'gauge', evalGate.passed ? 1 : 0, {}, '1 if the last recorded eval:gate run passed');
    emit('aqua_eval_gate_age_seconds', 'gauge', evalGate.ageSeconds, {}, 'Seconds since the last recorded eval:gate run');
    emit('aqua_eval_gate_regressions', 'gauge', evalGate.regressions, {}, 'Suites that regressed in the last eval:gate run');
  }
  if (dlq) {
    emit('aqua_dlq_level', 'gauge', { ok: 0, warn: 1, alert: 2 }[dlq.level], {}, 'DLQ alert level: 0 ok, 1 warn, 2 alert');
    emit('aqua_dlq_oldest_dead_age_seconds', 'gauge', dlq.oldestDeadAgeMs == null ? NaN : dlq.oldestDeadAgeMs / 1000);
  }

  return out.join('\n') + '\n';
}
