import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProviderError, extractStatus,
  isRetryable, errorScope, isPermanent, retryAfterMs, createProviderError, ProviderError,
} from '../providerErrors.js';

function errWith(overrides) {
  return Object.assign(new Error(overrides.message ?? 'boom'), overrides);
}

describe('providerErrors.js — Issue 4: differentiate failure types', () => {
  test('404 status → model_not_found', () => {
    assert.equal(classifyProviderError(errWith({ status: 404 })).type, 'model_not_found');
  });

  test('"model not found" message with no status → model_not_found', () => {
    assert.equal(classifyProviderError(errWith({ message: 'Error: model not found' })).type, 'model_not_found');
  });

  // v5: transient capacity ("no endpoints" / "no allowed providers") is NO LONGER
  // conflated with permanent deprecation — it self-heals instead of permanently
  // culling the model. This is the core GSM8K fix.
  test('"no endpoints" / "no allowed providers" → model_unavailable (TRANSIENT)', () => {
    assert.equal(classifyProviderError(errWith({ message: 'No endpoints found for this model' })).type, 'model_unavailable');
    assert.equal(classifyProviderError(errWith({ message: 'No allowed providers are available' })).type, 'model_unavailable');
  });

  test('explicit deprecation → model_not_found (PERMANENT)', () => {
    assert.equal(classifyProviderError(errWith({ message: 'This model has been deprecated' })).type, 'model_not_found');
    assert.equal(classifyProviderError(errWith({ message: 'model is no longer available' })).type, 'model_not_found');
  });

  test('429 status → rate_limit', () => {
    assert.equal(classifyProviderError(errWith({ status: 429 })).type, 'rate_limit');
  });

  test('401/403 status → auth', () => {
    assert.equal(classifyProviderError(errWith({ status: 401 })).type, 'auth');
    assert.equal(classifyProviderError(errWith({ status: 403 })).type, 'auth');
  });

  test('5xx status → server_error', () => {
    assert.equal(classifyProviderError(errWith({ status: 500 })).type, 'server_error');
    assert.equal(classifyProviderError(errWith({ status: 503 })).type, 'server_error');
  });

  test('known network error codes → network', () => {
    assert.equal(classifyProviderError(errWith({ code: 'ECONNREFUSED' })).type, 'network');
    assert.equal(classifyProviderError(errWith({ code: 'ETIMEDOUT' })).type, 'network');
    assert.equal(classifyProviderError(errWith({ code: 'ENOTFOUND' })).type, 'network');
  });

  test('"fetch failed" with no status → network', () => {
    assert.equal(classifyProviderError(errWith({ message: 'fetch failed' })).type, 'network');
  });

  test('router\u2019s own TIMEOUT sentinel → timeout, distinct from network', () => {
    assert.equal(classifyProviderError(errWith({ message: 'TIMEOUT' })).type, 'timeout');
  });

  test('INVALID_RESPONSE sentinel → invalid_response', () => {
    assert.equal(classifyProviderError(errWith({ message: 'INVALID_RESPONSE' })).type, 'invalid_response');
  });

  test('unrecognized error → unknown, never throws', () => {
    assert.equal(classifyProviderError(errWith({ message: 'something weird happened' })).type, 'unknown');
    assert.doesNotThrow(() => classifyProviderError(null));
    assert.doesNotThrow(() => classifyProviderError(undefined));
    assert.equal(classifyProviderError(null).type, 'unknown');
  });

  test('status is read from status, statusCode, response.status, or httpError.status', () => {
    assert.equal(extractStatus({ status: 404 }), 404);
    assert.equal(extractStatus({ statusCode: 429 }), 429);
    assert.equal(extractStatus({ response: { status: 500 } }), 500);
    assert.equal(extractStatus({ httpError: { status: 401 } }), 401);
    assert.equal(extractStatus({}), null);
  });

  test('404 status takes priority even if the message also contains rate-limit-like text', () => {
    // Guards against message-sniffing accidentally overriding an explicit status.
    const { type } = classifyProviderError(errWith({ status: 404, message: 'rate limited, please retry' }));
    assert.equal(type, 'model_not_found');
  });
});

describe('providerErrors.js — v5: retryable / scope / permanent metadata', () => {
  test('transient types are retryable', () => {
    for (const t of ['rate_limit', 'server_error', 'network', 'timeout', 'invalid_response', 'model_unavailable', 'unknown']) {
      assert.equal(isRetryable(t), true, t);
    }
  });

  test('terminal types are not retryable AND permanent', () => {
    for (const t of ['auth', 'config', 'model_not_found']) {
      assert.equal(isRetryable(t), false, t);
      assert.equal(isPermanent(t), true, t);
    }
  });

  test('model-scoped vs provider-scoped', () => {
    assert.equal(errorScope('model_unavailable'), 'model');
    assert.equal(errorScope('model_not_found'), 'model');
    assert.equal(errorScope('auth'), 'provider');
    assert.equal(errorScope('network'), 'provider');
    assert.equal(errorScope('timeout'), 'provider');
  });

  test('NO_CANDIDATE_MODELS sentinel → model_unavailable (retryable, not permanent)', () => {
    const c = classifyProviderError(Object.assign(new Error('none available'), { code: 'NO_CANDIDATE_MODELS' }));
    assert.equal(c.type, 'model_unavailable');
    assert.equal(c.retryable, true);
    assert.equal(c.permanent, false);
  });

  test('missing/unconfigured key message → config (terminal)', () => {
    assert.equal(classifyProviderError(errWith({ message: 'No Groq keys configured' })).type, 'config');
    assert.equal(classifyProviderError(errWith({ message: 'GEMINI_KEY is not configured' })).type, 'config');
  });

  test('classifyProviderError returns the full superset shape', () => {
    const c = classifyProviderError(errWith({ status: 429 }));
    assert.deepEqual(Object.keys(c).sort(), ['permanent', 'retryAfterMs', 'retryable', 'scope', 'status', 'type'].sort());
    assert.equal(c.retryable, true);
    assert.equal(c.scope, 'model');
    assert.equal(c.permanent, false);
  });
});

describe('providerErrors.js — v5: Retry-After parsing', () => {
  test('numeric header seconds → ms', () => {
    const e = errWith({ status: 429, response: { headers: { get: (n) => (n === 'retry-after' ? '12' : null) } } });
    assert.equal(retryAfterMs(e), 12_000);
  });

  test('plain-object header', () => {
    assert.equal(retryAfterMs(errWith({ headers: { 'retry-after': '5' } })), 5_000);
  });

  test('message body "retry after N seconds"', () => {
    assert.equal(retryAfterMs(errWith({ message: 'rate limited, retry after 3 seconds' })), 3_000);
    assert.equal(retryAfterMs(errWith({ message: 'try again in 500 ms' })), 500);
  });

  test('already-numeric retryAfterMs / retryAfterSeconds fields', () => {
    assert.equal(retryAfterMs(errWith({ retryAfterMs: 2500 })), 2500);
    assert.equal(retryAfterMs(errWith({ retryAfterSeconds: 4 })), 4_000);
  });

  test('no hint → null', () => {
    assert.equal(retryAfterMs(errWith({ status: 429 })), null);
    assert.equal(retryAfterMs(null), null);
  });
});

describe('providerErrors.js — v5: structured ProviderError object', () => {
  test('createProviderError builds a serializable structured error', () => {
    const e = createProviderError({ provider: 'gemini', cause: errWith({ status: 503 }) });
    assert.ok(e instanceof ProviderError);
    assert.equal(e.provider, 'gemini');
    assert.equal(e.type, 'server_error');
    assert.equal(e.code, 'SERVER_ERROR');
    assert.equal(e.retryable, true);
    assert.equal(e.scope, 'model');
  });

  test('toJSON is stable and JSON-stringifiable', () => {
    const e = createProviderError({ provider: 'openrouter', cause: errWith({ status: 401 }), attempt: 2 });
    const j = e.toJSON();
    assert.equal(j.provider, 'openrouter');
    assert.equal(j.type, 'auth');
    assert.equal(j.retryable, false);
    assert.equal(j.attempt, 2);
    assert.equal(typeof JSON.stringify(j), 'string');
  });

  test('original cause is preserved', () => {
    const cause = errWith({ status: 500, message: 'upstream boom' });
    const e = createProviderError({ provider: 'groq', cause });
    assert.equal(e.cause, cause);
  });
});
