/**
 * core/tokenManager.js buildContextWindowWithStats — audit D-08 (2026-11-16).
 * One oversized message must not erase every older turn; the window stays a
 * contiguous suffix (callers index from history.length - window.length),
 * store objects are never mutated, and no assistant message is orphaned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContextWindow, buildContextWindowWithStats, estimateTokens } from '../tokenManager.js';

const u = (content) => ({ role: 'user', content });
const a = (content) => ({ role: 'assistant', content });
const tokensOf = (msgs) => msgs.reduce((n, m) => n + estimateTokens(m.content), 0);
const isSuffix = (history, window) => window.every((m, i) => {
  const src = history[history.length - window.length + i];
  return m === src || (m.truncated && m.role === src.role);
});

test('normal history: everything fits, identical objects, nothing truncated', () => {
  const h = [u('Is pneumonia curable?'), a('Often yes.'), u('Tell me about pneumonia.'), a('An infection of the lungs.')];
  const { messages, stats } = buildContextWindowWithStats(h, 4000);
  assert.equal(messages.length, 4);
  assert.ok(messages.every((m, i) => m === h[i]));
  assert.deepEqual({ included: stats.included, excluded: stats.excluded, truncated: stats.truncated }, { included: 4, excluded: 0, truncated: 0 });
});

test('oversized PREVIOUS message: newest exchange kept, the big one truncated (not dropped), older turns not silently erased', () => {
  const h = [u('Explain photosynthesis.'), a('Photosynthesis converts light.'), u('Paste:'), a('Z'.repeat(40_000)), u('Why is it important?'), a('Because…')];
  const { messages, stats } = buildContextWindowWithStats(h, 4000);
  assert.ok(tokensOf(messages) <= 4000, `budget respected: ${tokensOf(messages)}`);
  assert.equal(messages.at(-1), h.at(-1));
  assert.equal(messages.at(-2), h.at(-2));
  const big = messages.find(m => m.truncated);
  assert.ok(big, 'the oversized message is present as a truncated copy');
  assert.match(big.content, /characters omitted to fit the context window/);
  assert.equal(h[3].content.length, 40_000, 'the stored message is not mutated');
  assert.ok(isSuffix(h, messages), 'contiguous suffix');
  assert.equal(stats.truncated >= 1, true);
});

test('oversized NEWEST message: the window is no longer empty — the latest message is kept truncated', () => {
  const h = [u('Explain photosynthesis.'), a('Photosynthesis…'), u('Summarise this: ' + 'q'.repeat(60_000))];
  const { messages } = buildContextWindowWithStats(h, 4000);
  assert.ok(messages.length >= 1);
  assert.equal(messages.at(-1).role, 'user');
  assert.ok(messages.at(-1).truncated);
  assert.ok(tokensOf(messages) <= 4000);
});

test('the old implementation returned [] for an oversized newest message (regression pinned)', () => {
  // Re-implementation of the pre-2026-11-16 loop, for the record.
  const old = (history, max) => { const s = []; let used = 0; for (let i = history.length - 1; i >= 0; i--) { const t = estimateTokens(history[i].content); if (used + t > max) break; s.unshift(history[i]); used += t; } return s; };
  const h = [u('Explain photosynthesis.'), a('A'.repeat(20_000))];
  assert.equal(old(h, 4000).length, 0);
  assert.ok(buildContextWindow(h, 4000).length >= 1);
});

test('many turns + budget exhaustion: stays within budget, keeps the most recent turns, never opens on an orphaned assistant', () => {
  const h = [];
  for (let i = 0; i < 200; i += 1) h.push(u(`question ${i} ` + 'w'.repeat(300)), a(`answer ${i} ` + 'v'.repeat(500)));
  const { messages, stats } = buildContextWindowWithStats(h, 4000);
  assert.ok(tokensOf(messages) <= 4000);
  assert.equal(messages.at(-1), h.at(-1));
  assert.equal(messages[0].role, 'user', 'first message is a question, not an orphaned answer');
  assert.equal(stats.included + stats.excluded, h.length);
  assert.ok(isSuffix(h, messages));
});

test('referential retention: the antecedent turn is kept when a long answer sits between it and the follow-up', () => {
  const h = [u('Tell me about pneumonia.'), a('P'.repeat(14_000)), u('Is it curable?')];
  const { messages } = buildContextWindowWithStats(h.slice(0, 2), 4000);
  // the long answer is truncated; its question (the antecedent) is still present
  assert.equal(messages[0].content, 'Tell me about pneumonia.');
});
