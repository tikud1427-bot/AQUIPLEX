import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError, extractStatus } from '../providerErrors.js';

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

  test('"no endpoints" / "deprecated" hints → model_not_found', () => {
    assert.equal(classifyProviderError(errWith({ message: 'No endpoints found for this model' })).type, 'model_not_found');
    assert.equal(classifyProviderError(errWith({ message: 'This model has been deprecated' })).type, 'model_not_found');
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
