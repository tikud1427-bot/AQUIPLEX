#!/usr/bin/env node
/**
 * NVIDIA live smoke test — the one place a real NVIDIA call is made on purpose.
 * Never part of `npm test`; the unit suites are offline.
 *
 *   cd aqua
 *   node scripts/nvidia-smoke.mjs                      # every key once + one stream
 *   node scripts/nvidia-smoke.mjs --model openai/gpt-oss-20b
 *   node scripts/nvidia-smoke.mjs --calls 1            # a single call (cheapest)
 *
 * What it proves, through the REAL adapter (rotation, registry, cost counters):
 *   - the key slots exist (count only — no value is ever printed)
 *   - each key answers (one short call per slot, round-robin lands on each)
 *   - the pinned model answered, non-streaming AND streaming
 * Exit code 0 only if every call succeeded.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Root .env BEFORE the provider import (same semantics as index.js: a shell
// export wins over the file).
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.join(here, '..', '..', '.env');
  if (existsSync(envPath)) createRequire(path.join(here, '..', 'package.json'))('dotenv').config({ path: envPath, quiet: true });
}

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const { generateNvidia, streamNvidia, getKeySlotSummary } = await import('../src/providers/nvidia.js');
const { getCostMetrics } = await import('../src/core/costAccounting.js');
const { pickModel } = await import('../src/providers/modelRegistry.js');

const slots = getKeySlotSummary();
console.log(`\nNVIDIA SMOKE · key slots: ${slots.count} (${slots.slots.join(', ') || 'none'})`);
if (!slots.count) {
  console.error('✗ no NVIDIA_API_KEY_<n> (or NVIDIA_API_KEY) is set in the environment or root .env\n');
  process.exit(1);
}

const model = flag('--model', pickModel('nvidia')?.modelId ?? null);
const calls = Math.max(1, Number(flag('--calls', slots.count)));
const maxTokens = Math.max(64, Number(flag('--max-tokens', 512)));
console.log(`model: ${model} · calls: ${calls} · max_tokens: ${maxTokens}\n`);

const sys = 'You are a terse assistant. Answer in one short sentence.';
const user = [{ role: 'user', content: 'Name one planet in the solar system.' }];
const clip = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);

let failed = 0;
for (let i = 0; i < calls; i++) {
  const t0 = Date.now();
  try {
    const r = await generateNvidia(sys, user, undefined, maxTokens, { model, temperature: 0, purpose: 'other' });
    console.log(`  ✓ call ${i + 1} key=${r.keySlot} provider=nvidia model=${r.model} ${Date.now() - t0}ms ` +
      `usage=${JSON.stringify(r.usage)} finish=${r.finishReason} → "${clip(r.text)}"`);
  } catch (err) {
    failed++;
    console.log(`  ✗ call ${i + 1} ${Date.now() - t0}ms ${err?.status ?? ''} ${clip(err?.message)}`);
  }
}

{
  const t0 = Date.now();
  let deltas = 0;
  try {
    const r = await streamNvidia(sys, user, undefined, maxTokens, () => { deltas++; }, { model });
    console.log(`  ✓ stream key=${r.keySlot} model=${r.model} ${Date.now() - t0}ms deltas=${deltas} ` +
      `usage=${JSON.stringify(r.usage)} finish=${r.finishReason} → "${clip(r.text)}"`);
  } catch (err) {
    failed++;
    console.log(`  ✗ stream ${Date.now() - t0}ms ${err?.status ?? ''} ${clip(err?.message)}`);
  }
}

const cost = getCostMetrics();
console.log(`\ncost counters: calls=${cost.calls} in=${cost.inputTokens} out=${cost.outputTokens} unpriced=${cost.unpricedCalls}`);
console.log(failed ? `\n✗ ${failed} call(s) failed\n` : '\n✓ NVIDIA smoke passed\n');
process.exit(failed ? 1 : 0);
