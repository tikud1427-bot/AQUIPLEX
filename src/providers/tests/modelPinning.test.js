/**
 * E6/PR-5b — optional model pin, temperature, and model echo on the
 * non-streaming provider path.
 *
 * This change touches the PRODUCTION ANSWER PATH, so the load-bearing claim is
 * not "the new options work" — it is "omitting them changes nothing". That
 * claim is proved against the REQUEST BYTES the adapter actually puts on the
 * wire, captured by standing up a local HTTP server and pointing the real SDK
 * at it via OPENROUTER_BASE_URL. Same technique `openrouterResilience.test.js`
 * uses, for the same reason: asserting on a mock of your own construction
 * proves things about the mock.
 *
 * WHY PINNING THROWS INSTEAD OF FALLING BACK
 * ------------------------------------------
 * `getCandidateModels` returns a fallback chain and, for OpenRouter, ROTATES
 * it per call. Both are right for a user waiting on an answer and fatal for a
 * measurement: E6/PR-11 compares this extractor against a committed baseline,
 * and a run that silently hopped models produces a difference nobody can
 * attribute to the prompt or to the model. Substitution is the one outcome a
 * pinning caller cannot tolerate, so it is the one outcome that raises.
 *
 * Run: node --test src/providers/tests/modelPinning.test.js
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let server, captured;

function makeServer() {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        captured.push({ url: req.url, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

describe('provider adapters — the pin and temperature are ADDITIVE', () => {
  before(async () => {
    process.env.OPENROUTER_API_KEY_1 = 'test-key-1';
    server = await makeServer();
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    if (server) server.close();
    delete process.env.OPENROUTER_BASE_URL;
  });

  beforeEach(async () => {
    captured = [];
    const { __resetForTests } = await import('../modelRegistry.js');
    __resetForTests();
  });

  test('OMITTING opts leaves the request body byte-identical to the old shape', async () => {
    // THE CLAIM THAT MATTERS. Every existing caller — the whole answer path —
    // calls this with four arguments. If the fifth changes anything for them,
    // this PR broke production to serve a measurement.
    const { generateOpenRouter } = await import('../openrouter.js');
    await generateOpenRouter('sys', [{ role: 'user', content: 'hi' }], undefined, undefined);

    assert.equal(captured.length, 1, 'exactly one request');
    const body = captured[0].body;
    assert.ok(!('temperature' in body),
      'temperature must be ABSENT, not present-and-undefined — a JSON null or 0 is a different request');
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'model'],
      `the body carries only what it carried before; got ${JSON.stringify(Object.keys(body))}`);
  });

  test('an explicit temperature IS sent', async () => {
    const { generateOpenRouter } = await import('../openrouter.js');
    await generateOpenRouter('sys', [{ role: 'user', content: 'hi' }], undefined, undefined,
      { temperature: 0 });
    assert.equal(captured[0].body.temperature, 0,
      'temperature 0 must survive — `0` is falsy and is exactly the value extraction needs');
  });

  test('temperature 0 is not swallowed by a truthiness check', async () => {
    // `...(opts.temperature ? {...} : {})` would drop 0 silently and the
    // extractor would run at the provider default forever, looking pinned.
    const { generateOpenRouter } = await import('../openrouter.js');
    await generateOpenRouter('sys', [{ role: 'user', content: 'hi' }], undefined, undefined,
      { temperature: 0 });
    assert.ok('temperature' in captured[0].body);
  });

  test('the return NAMES the model that answered', async () => {
    const { generateOpenRouter } = await import('../openrouter.js');
    const r = await generateOpenRouter('sys', [{ role: 'user', content: 'hi' }], undefined, undefined);
    assert.equal(typeof r.model, 'string');
    assert.ok(r.model.length > 0);
    assert.equal(r.model, captured[0].body.model, 'and it is the model actually requested');
    // The pre-existing fields are untouched.
    assert.equal(r.text, 'ok');
    assert.equal(r.truncated, false);
    assert.equal(r.finishReason, 'stop');
  });

  test('a PIN routes to exactly that model', async () => {
    const { generateOpenRouter } = await import('../openrouter.js');
    const { getCandidateModels } = await import('../modelRegistry.js');
    const all = getCandidateModels('openrouter');
    assert.ok(all.length >= 2, `only ${all.length} candidates — this test cannot show pinning with one`);

    // Pick a model that is NOT the one an unpinned call would choose first.
    const unpinned = await generateOpenRouter('sys', [{ role: 'user', content: 'hi' }], undefined, undefined);
    const other = all.map(c => c.modelId).find(id => id !== unpinned.model);
    assert.ok(other, 'no second model to pin to');

    captured = [];
    const r = await generateOpenRouter('sys', [{ role: 'user', content: 'hi' }], undefined, undefined,
      { model: other });
    assert.equal(r.model, other);
    assert.equal(captured[0].body.model, other, 'the wire request used the pinned model');
  });

  test('a pin repeated across calls does NOT rotate', async () => {
    // OpenRouter's candidate list rotates per call by design. That rotation is
    // precisely what makes an unpinned measurement unattributable, so the pin
    // has to survive repetition, not just the first call.
    const { generateOpenRouter } = await import('../openrouter.js');
    const { getCandidateModels } = await import('../modelRegistry.js');
    const pin = getCandidateModels('openrouter')[0].modelId;

    for (let i = 0; i < 4; i++) {
      await generateOpenRouter('sys', [{ role: 'user', content: 'hi' }], undefined, undefined, { model: pin });
    }
    assert.deepEqual([...new Set(captured.map(c => c.body.model))], [pin],
      'every call used the pinned model');
  });

  test('an UNAVAILABLE pin throws rather than substituting', async () => {
    const { generateOpenRouter } = await import('../openrouter.js');
    await assert.rejects(
      () => generateOpenRouter('sys', [{ role: 'user', content: 'hi' }], undefined, undefined,
        { model: 'model-that-does-not-exist' }),
      err => {
        assert.equal(err.code, 'MODEL_PIN_UNAVAILABLE',
          'a code, so a caller can tell "cooling down" from "no such model" without parsing prose');
        assert.equal(err.modelId, 'model-that-does-not-exist');
        return true;
      });
    assert.equal(captured.length, 0, 'and NOTHING was sent — no silent substitution reached the wire');
  });
});

describe('all three adapters got the SAME treatment', () => {
  // A STRUCTURAL BACKSTOP, and weaker than the behavioural tests above —
  // stated plainly rather than dressed up. OpenRouter and Groq both use the
  // OpenAI SDK, but only OpenRouter reads a base-URL override
  // (OPENROUTER_BASE_URL), and Gemini uses @google/genai with no override at
  // all. So neither can be pointed at a local server, and the wire-level proof
  // above covers one adapter of three.
  //
  // The alternative to grepping is no coverage at all for the other two, and
  // the specific regression worth catching is cheap and real: a later edit
  // reverts one adapter, or a fourth provider is added without the pin, and
  // extraction silently becomes unattributable again on that path only.
  const read = async name => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    return readFileSync(path.join(here, '..', `${name}.js`), 'utf8');
  };

  for (const [name, provider] of [['gemini', 'gemini'], ['groq', 'groq'], ['openrouter', 'openrouter']]) {
    test(`${name} accepts opts, pins, honours temperature and echoes the model`, async () => {
      const src = await read(name);
      assert.match(src, new RegExp(`export async function generate\\w+\\(systemPrompt, messages, signal, maxTokens, opts = \\{\\}\\)`),
        `${name}: the fifth parameter is missing`);
      assert.ok(src.includes(`pinCandidates(getCandidateModels('${provider}'), opts.model ?? null, '${provider}')`),
        `${name}: the non-streaming path does not pin`);
      assert.ok(src.includes('opts.temperature !== undefined ? { temperature: opts.temperature }'),
        `${name}: temperature is missing, or guarded by truthiness which would swallow 0`);
      assert.ok(/return \{ text[^}]*model: modelId \}/.test(src),
        `${name}: a non-streaming return does not name the model`);
    });
  }

  test('STREAMING was deliberately left alone', async () => {
    // Extraction never streams. Widening the change to the stream paths — which
    // carry their own truncation and abort handling — would grow the risk
    // envelope on the answer path for no caller. If that ever changes it should
    // be a decision, not a drift.
    for (const name of ['gemini', 'groq', 'openrouter']) {
      const src = await read(name);
      const streamed = src.split('\n').filter(l => l.includes('streamed: true'));
      assert.ok(streamed.length > 0, `${name}: no streaming returns found — re-read this test`);
      for (const line of streamed) {
        assert.ok(!line.includes('model: modelId'),
          `${name}: a streaming return now names the model — intended, or an accidental widening?`);
      }
    }
  });
});

describe('pinCandidates — the rule itself', () => {
  test('no pin returns the list unchanged, by identity', async () => {
    const { pinCandidates } = await import('../modelRegistry.js');
    const list = [{ modelId: 'a' }, { modelId: 'b' }];
    assert.equal(pinCandidates(list, null, 'p'), list, 'the same array, not a copy — zero cost when unpinned');
    assert.equal(pinCandidates(list, undefined, 'p'), list);
  });

  test('a pin narrows to one', async () => {
    const { pinCandidates } = await import('../modelRegistry.js');
    const list = [{ modelId: 'a' }, { modelId: 'b' }];
    assert.deepEqual(pinCandidates(list, 'b', 'p'), [{ modelId: 'b' }]);
  });

  test('a pin that matches nothing throws, and never returns an empty list', async () => {
    // Returning [] would send the caller into the adapter's "no candidates"
    // branch, which reports a provider outage. The failure would be blamed on
    // the provider instead of on the pin.
    const { pinCandidates } = await import('../modelRegistry.js');
    assert.throws(() => pinCandidates([{ modelId: 'a' }], 'zz', 'p'),
      err => err.code === 'MODEL_PIN_UNAVAILABLE');
  });

  test('a pin that exists but is COOLING DOWN throws too', async () => {
    // getCandidateModels has already filtered unavailable models out, so a
    // cooling model reaches here as an absent one. The caller must not silently
    // get a different model because theirs is briefly rate-limited.
    const { pinCandidates } = await import('../modelRegistry.js');
    assert.throws(() => pinCandidates([{ modelId: 'healthy' }], 'cooling', 'p'),
      err => err.code === 'MODEL_PIN_UNAVAILABLE');
  });
});
