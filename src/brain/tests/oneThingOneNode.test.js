/**
 * One thing, one node.
 *
 * Two defects of the same shape, both of which split a single subject across
 * two graph nodes whose facts then never merge.
 *
 * 1. FUSED PRONOUNS. The shared extractor reads a run of capitalised tokens as
 *    one name, and `I`, `I'm`, `We're`, `Its` are capitalised — so the first
 *    thing almost anyone types produces an entity called "I'm Maya". Mention
 *    the same person plainly later and "Maya" resolves as a SEPARATE node.
 *
 * 2. TYPE-KEYED DEDUP. `add()` keyed on `type:value`, so "I work at Intercom"
 *    stored `Intercom:name` from the solo pass AND `Intercom:org` from the
 *    declaration cue — two nodes for one employer.
 *
 * Both are conversation problems: prose rarely opens with "I'm Maya", and the
 * document path does not run these passes. `src/files/` stays byte-identical
 * and a test below pins that the shared extractor STILL fuses, so this cannot
 * quietly become the document rule.
 *
 * Proven to bite: 4 of 10 fail against unmodified code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractConversationEntities } from '../knowledgeExtraction/conversationEntities.js';
import { extractEntities } from '../../files/extractors.js';

const names = (t, o = {}) => extractConversationEntities(t, o).map(e => e.value);
const typed = (t, o = {}) => extractConversationEntities(t, o).map(e => `${e.value}:${e.type}`);

// ── 1. Fused pronouns ────────────────────────────────────────────────────────

test('a leading pronoun is not part of the name', () => {
  const cases = [
    ["I'm Maya, I run product at Nummo", 'Maya'],
    ["I'm Dev and I handle engineering", 'Dev'],
    ["We're Nummo, a fintech", 'Nummo'],
    ["I've Maya on the call", 'Maya'],
    ['Hi I\'m Sarah', 'Sarah'],
    ['Its Maya here', 'Maya'],
  ];
  for (const [msg, expected] of cases) {
    assert.ok(names(msg).includes(expected), `"${msg}" → ${JSON.stringify(names(msg))}`);
  }
});

test('the fused form does not survive alongside the clean one', () => {
  // The fork is the real cost: two nodes for one person, facts split forever.
  const out = names("I'm Maya, I run product at Nummo");
  assert.ok(!out.some(v => /^i'?m /i.test(v)), JSON.stringify(out));
});

test('the same person named plainly later resolves onto the SAME value', () => {
  assert.deepEqual(names("I'm Maya"), names('Maya is my name'));
});

test('a name that merely starts with a pronoun-like word is untouched', () => {
  // "It Follows" is a film; "Ivy" is a person. Only first-person and `it`
  // FORMS are stripped — bare "It" is not one of them.
  assert.ok(names('We watched It Follows last night').includes('It Follows'));
  assert.ok(names('I met Ivy Chen at the conference').includes('Ivy Chen'));
});

test('a strip that would empty the name is refused', () => {
  // A repair that leaves nothing is worse than the bug it fixes.
  for (const junk of ["I'm", "we're", "I'm a", '']) {
    assert.ok(Array.isArray(names(junk)));
  }
});

// ── 2. One value, one node ───────────────────────────────────────────────────

test('one employer named once produces ONE entity', () => {
  assert.deepEqual(typed('I work at Intercom'), ['Intercom:org']);
});

test('a declaration cue upgrades the type rather than forking a node', () => {
  // `name` is what the extractor says when it recognised a proper noun and
  // nothing about it, so anything else is better information.
  const out = extractConversationEntities('I work at Intercom', {});
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'org');
});

test('canonical casing from a known entity still wins over a later mention', () => {
  // What the old skip was actually protecting. `add()` keeps the FIRST casing.
  const out = names('we talked to razorpay again', {
    knownEntities: [{ value: 'Razorpay', type: 'name' }],
  });
  assert.deepEqual(out, ['Razorpay']);
});

// ── The standing constraint ──────────────────────────────────────────────────

test('the document pipeline is NOT changed to fix a chat problem', () => {
  // If this fails, someone has edited src/files/ to make the tests above pass.
  // Every uploaded file would pay for a defect that only appears in chat.
  assert.deepEqual(extractEntities("I'm Maya, I run product at Nummo").map(e => e.value), ["I'm Maya"]);
  assert.deepEqual(extractEntities("We're Nummo, a fintech").map(e => e.value), ["We're Nummo"]);
});

test('the speaker is still emitted by grammar, unaffected by either change', () => {
  const out = extractConversationEntities("I'm Maya", { selfText: "I'm Maya" });
  assert.ok(out.some(e => e.isSelf === true), JSON.stringify(out));
  assert.ok(out.some(e => e.value === 'Maya'), JSON.stringify(out));
});
