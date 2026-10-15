/**
 * The general evaluation harness (evaluation/runners/aqua-standalone.mjs) sees
 * NVIDIA's key slots. A source assertion, deliberately: the runner is a script
 * that boots a server at import, with no unit to call — the same reasoning the
 * e6-shadow harness tests give for their own greps.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const RUNNER = path.join(ROOT, 'evaluation', 'runners', 'aqua-standalone.mjs');
const ADAPTER_CFG = path.join(ROOT, 'evaluation', 'configs', 'adapters', 'nvidia-gpt-oss-20b.json');

describe('evaluation harness — nvidia', () => {
  test('bare NVIDIA_API_KEY aliases into slot _1, additively', () => {
    const src = readFileSync(RUNNER, 'utf8');
    assert.match(src, /\["NVIDIA_API_KEY",\s+"NVIDIA_API_KEY_1"\]/);
    // The alias loop must never overwrite a numbered slot that is already set.
    assert.match(src, /if \(process\.env\[from\] && !process\.env\[to\]\) process\.env\[to\] = process\.env\[from\];/);
  });

  test('startup reports a nvidia=<count>, never a value', () => {
    const src = readFileSync(RUNNER, 'utf8');
    assert.match(src, /nvidia=\$\{countOpenSlots\("NVIDIA_API_KEY"\)\}/);
  });

  test('a comparison-mode adapter config exists for NVIDIA gpt-oss-20b, keyed by env name only', () => {
    assert.ok(existsSync(ADAPTER_CFG));
    const cfg = JSON.parse(readFileSync(ADAPTER_CFG, 'utf8'));
    assert.equal(cfg.type, 'openai_compat');
    assert.equal(cfg.model, 'openai/gpt-oss-20b');
    assert.equal(cfg.base_url, 'https://integrate.api.nvidia.com/v1');
    assert.match(cfg.api_key_env, /^NVIDIA_API_KEY/);
  });
});
