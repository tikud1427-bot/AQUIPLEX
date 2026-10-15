/**
 * World-Model Lift — provider selection and the paired control, offline.
 *
 * The experiment's claim is "same provider/model, different evidence". These
 * tests pin that BOTH lanes go through one answering function bound to one
 * provider/model, and that a router-mode case answered by two different
 * provider/models is flagged rather than silently averaged in.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIFT_PROVIDERS, resolveLiftTransport, liftAnswerer, isPaired,
} from '../adapters/pairedAnswerLift.mjs';

describe('AQUA_LIFT_PROVIDER / AQUA_LIFT_MODEL', () => {
  test('all four providers are selectable', () => {
    assert.deepEqual([...LIFT_PROVIDERS].sort(), ['gemini', 'groq', 'nvidia', 'openrouter']);
  });

  test('unset → production router, unchanged', async () => {
    assert.deepEqual(await resolveLiftTransport({}), { mode: 'router', provider: null, model: null });
  });

  test('nvidia + explicit model → pinned to exactly that', async () => {
    assert.deepEqual(await resolveLiftTransport({ AQUA_LIFT_PROVIDER: 'NVIDIA', AQUA_LIFT_MODEL: 'openai/gpt-oss-20b' }),
      { mode: 'pinned', provider: 'nvidia', model: 'openai/gpt-oss-20b' });
  });

  test('provider without a model → pinned to that provider\'s first registered model, still one model', async () => {
    const t = await resolveLiftTransport({ AQUA_LIFT_PROVIDER: 'groq' });
    assert.equal(t.mode, 'pinned');
    assert.equal(t.provider, 'groq');
    assert.equal(typeof t.model, 'string');
  });

  test('an unknown provider, or a model with no provider, is refused — never guessed', async () => {
    await assert.rejects(resolveLiftTransport({ AQUA_LIFT_PROVIDER: 'mystery' }), /Unknown AQUA_LIFT_PROVIDER/);
    await assert.rejects(resolveLiftTransport({ AQUA_LIFT_MODEL: 'x' }), /without AQUA_LIFT_PROVIDER/);
  });
});

describe('the two lanes share one provider/model', () => {
  test('pinned: both lanes call the SAME adapter with the SAME model pin, temperature 0', async () => {
    const calls = [];
    const fake = async (system, messages, _signal, maxTokens, opts) => {
      calls.push({ system, maxTokens, opts });
      return { text: `answer:${system.length}`, model: opts.model };
    };
    const answer = await liftAnswerer({ mode: 'pinned', provider: 'nvidia', model: 'openai/gpt-oss-20b' },
      { adapters: { nvidia: fake, groq: async () => { throw new Error('groq must not be called'); } } });
    const tc = { id: 'q1', q: 'Where do I work?' };
    const [floor, world] = await Promise.all([answer(tc, 'floor evidence'), answer(tc, 'world model evidence, longer')]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.opts.model === 'openai/gpt-oss-20b' && c.opts.temperature === 0));
    assert.equal(new Set(calls.map(c => c.maxTokens)).size, 1, 'both lanes must get the same budget');
    assert.equal(floor.provider, 'nvidia');
    assert.equal(world.provider, 'nvidia');
    assert.equal(isPaired(floor, world), true);
  });

  test('router mode: lanes answered by different providers are NOT paired', async () => {
    let n = 0;
    const router = { generateText: async () => (n++ === 0
      ? { text: 'a', provider: 'groq', model: 'openai/gpt-oss-120b' }
      : { text: 'b', provider: 'nvidia', model: 'openai/gpt-oss-20b' }) };
    const answer = await liftAnswerer({ mode: 'router', provider: null, model: null }, { router });
    const tc = { id: 'q1', q: 'x' };
    const a = await answer(tc, 's1');
    const b = await answer(tc, 's2');
    assert.equal(isPaired(a, b), false, 'a Groq floor vs NVIDIA world model is a provider comparison');
  });

  test('same provider but different model is also unpaired', () => {
    assert.equal(isPaired({ provider: 'groq', model: 'a' }, { provider: 'groq', model: 'b' }), false);
  });
});
