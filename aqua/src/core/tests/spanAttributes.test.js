/** E12 — span attribute allowlist. BITE (measured): allow any string on an allowed key → 1 fail. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSpanAttributes, hashOwner, SPAN_ATTRIBUTE_SCHEMA } from '../spanAttributes.js';

describe('span attributes', () => {
  test('listed keys with the right type pass through', () => {
    const { attributes, dropped } = sanitizeSpanAttributes({
      'aqua.stage': 'understand', 'aqua.latency_ms': 42, 'aqua.cache_hit': true, 'aqua.provider': 'groq',
    });
    assert.equal(attributes['aqua.latency_ms'], 42);
    assert.deepEqual(dropped, []);
  });

  test('unlisted keys are dropped and REPORTED, not silently eaten', () => {
    const { attributes, dropped } = sanitizeSpanAttributes({ 'user.email': 'a@b.com', 'aqua.stage': 'x', message: 'hi' });
    assert.deepEqual(Object.keys(attributes), ['aqua.stage']);
    assert.deepEqual(dropped.sort(), ['message', 'user.email']);
  });

  test('free text cannot ride in on an allowed key — values must be identifier-shaped', () => {
    for (const leak of ['my password is hunter2', 'alice@example.com', 'x'.repeat(65), '', 'a\nb']) {
      const { attributes, dropped } = sanitizeSpanAttributes({ 'aqua.outcome': leak });
      assert.deepEqual(attributes, {}, `leaked: ${JSON.stringify(leak)}`);
      assert.deepEqual(dropped, ['aqua.outcome']);
    }
  });

  test('wrong types and non-finite numbers are dropped', () => {
    const { attributes, dropped } = sanitizeSpanAttributes({ 'aqua.latency_ms': '12', 'aqua.cost_usd': Infinity, 'aqua.cache_hit': 1 });
    assert.deepEqual(attributes, {});
    assert.equal(dropped.length, 3);
  });

  test('owner identity is only ever a truncated hash, stable and non-reversible', () => {
    const h = hashOwner('user:alice@example.com');
    assert.match(h, /^[0-9a-f]{12}$/);
    assert.equal(h, hashOwner('user:alice@example.com'));
    assert.notEqual(h, hashOwner('user:bob@example.com'));
    assert.equal(hashOwner(null), null);
    assert.ok(!('aqua.owner_id' in SPAN_ATTRIBUTE_SCHEMA), 'a raw owner id key must not exist');
  });
});
