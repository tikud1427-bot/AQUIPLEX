/**
 * E6 transport selection — NVIDIA joins groq/openrouter/gemini without
 * changing any existing default, and every run stays attributable to ONE
 * provider/model. Offline: nothing here calls a provider.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { e6TransportConfig } from '../index.js';
import {
  E6_PROVIDERS, PROVIDER_HELP, resolveShadowProvider, isAttributable,
} from '../../../scripts/e6-shadow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('production E6 transport (AQUA_E6_PROVIDER / AQUA_E6_MODEL)', () => {
  test('the measured default is unchanged: groq, openai/gpt-oss-120b', async () => {
    assert.deepEqual(await e6TransportConfig({}), { provider: 'groq', model: 'openai/gpt-oss-120b' });
  });

  test('AQUA_E6_PROVIDER=nvidia → nvidia with ITS registered model, not the Groq default', async () => {
    const c = await e6TransportConfig({ AQUA_E6_PROVIDER: 'nvidia' });
    assert.equal(c.provider, 'nvidia');
    // The Groq default would fail the nvidia pin (MODEL_PIN_UNAVAILABLE) on every call.
    assert.notEqual(c.model, 'openai/gpt-oss-120b');
    if (!process.env.NVIDIA_DEFAULT_MODEL) assert.equal(c.model, 'openai/gpt-oss-20b');
  });

  test('AQUA_E6_MODEL still pins explicitly', async () => {
    assert.deepEqual(await e6TransportConfig({ AQUA_E6_PROVIDER: 'nvidia', AQUA_E6_MODEL: 'x/y' }),
      { provider: 'nvidia', model: 'x/y' });
  });
});

describe('e6-shadow --provider', () => {
  test('groq, openrouter and nvidia are each one transport; unknown is refused', () => {
    assert.deepEqual(Object.keys(E6_PROVIDERS).sort(), ['groq', 'nvidia', 'openrouter']);
    assert.equal(resolveShadowProvider('nvidia').name, 'nvidia');
    assert.equal(resolveShadowProvider('NVIDIA').name, 'nvidia');
    assert.equal(resolveShadowProvider(undefined).name, 'openrouter', 'the historical default is unchanged');
    assert.equal(resolveShadowProvider('mystery'), null);
    assert.equal(resolveShadowProvider('toString'), null, 'prototype keys are not providers');
  });

  test('nvidia exposes its key-pool wait so a rate limit is slept through, not scored', () => {
    assert.equal(typeof resolveShadowProvider('nvidia').msUntilAnyKeyFree, 'function');
    assert.equal(typeof resolveShadowProvider('groq').msUntilAnyKeyFree, 'function');
  });

  test('token budgets: Groq keeps its measured 1024; nvidia gets reasoning headroom', () => {
    assert.equal(E6_PROVIDERS.groq.maxTokens, 1024, 'the measured Groq call shape changed');
    assert.equal(E6_PROVIDERS.openrouter.maxTokens, 1024);
    assert.ok(E6_PROVIDERS.nvidia.maxTokens >= 4096,
      'gpt-oss-20b on NVIDIA exhausted 1024 on hidden reasoning — empty or cut-off JSON');
  });

  test('the help text names every provider', () => {
    for (const p of ['groq', 'openrouter', 'nvidia']) assert.match(PROVIDER_HELP, new RegExp(`--provider ${p}`));
  });

  test('attributable = exactly one model; none or several is NOT publishable', () => {
    assert.equal(isAttributable(new Set()), false);
    assert.equal(isAttributable(new Set(['openai/gpt-oss-20b'])), true);
    assert.equal(isAttributable(new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b'])), false,
      'a run that mixed models blends their numbers');
  });

  test('the JSON record names the provider and the pin', () => {
    const src = readFileSync(path.join(HERE, '../../../scripts/e6-shadow.mjs'), 'utf8');
    assert.match(src, /provider: providerName, modelPin: modelPin \?\? null,/);
  });
});
