/**
 * Startup validation recognizes NVIDIA, and a missing NVIDIA key is a
 * WARNING — never a boot failure (Issue 6 contract: this function never throws).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runStartupValidation } from '../startupValidation.js';

let saved;
const warnings = [];
const logs = [];
const realWarn = console.warn, realLog = console.log;

beforeEach(() => {
  saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('NVIDIA_')));
  for (const k of Object.keys(saved)) delete process.env[k];
  warnings.length = 0; logs.length = 0;
  console.warn = (...a) => warnings.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
});

afterEach(() => {
  console.warn = realWarn; console.log = realLog;
  for (const k of Object.keys(process.env)) if (k.startsWith('NVIDIA_')) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('startup validation — nvidia', () => {
  test('no NVIDIA keys → keyChecks.nvidia=false and a warning, not a throw', () => {
    let r;
    assert.doesNotThrow(() => { r = runStartupValidation(); });
    assert.equal(r.keyChecks.nvidia, false);
    assert.ok(warnings.some(w => /provider="nvidia"/.test(w)), 'missing NVIDIA keys should warn');
    assert.ok(Array.isArray(r.snapshot.nvidia) && r.snapshot.nvidia.length > 0, 'nvidia models are in the registry snapshot');
  });

  test('keys present → keyChecks.nvidia=true; the log reports a COUNT, never a value', () => {
    for (let i = 1; i <= 5; i++) process.env[`NVIDIA_API_KEY_${i}`] = `nv-startup-secret-${i}`;
    const r = runStartupValidation();
    assert.equal(r.keyChecks.nvidia, true);
    assert.ok(logs.some(l => /NVIDIA key pool: 5 key slot\(s\)/.test(l)));
    assert.ok(![...logs, ...warnings].some(l => l.includes('nv-startup-secret')));
    assert.ok(!JSON.stringify(r).includes('nv-startup-secret'));
  });
});
