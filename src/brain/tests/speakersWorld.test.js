/**
 * The speaker's world — situation capture, and the "You" leak that came with it.
 *
 * TWO THINGS HERE, FOUND IN THAT ORDER
 * ------------------------------------
 * 1. `minEntities: 1` meant a sentence with no proper noun wrote nothing.
 *    Measured on a seven-turn session that was all situation and almost no
 *    names, only 2 of 7 produced a fact — the five losses were the sentences
 *    carrying what was actually going on in someone's work.
 *
 * 2. Measuring the fix surfaced a PRE-EXISTING bug it would have amplified:
 *    once `AQUA_SELF_ENTITY` created the self node, pass B rematched its label
 *    — the literal word "You" — against every message. "thank you" became a
 *    stored fact and the graph grew a second `You` node beside the real one.
 *
 * Proven to bite: reverting the wider predicate fails the first two tests;
 * restoring the self node to `knownEntitiesFor` fails the pass-B block.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSelfDeclaration, isAboutSpeakersWorld, hasSpeakersWorld,
} from '../knowledgeExtraction/selfDeclaration.js';
import {
  extractConversationEntities, knownEntitiesFor,
} from '../knowledgeExtraction/conversationEntities.js';
import { buildConversationFacts } from '../knowledgeExtraction/conversationFacts.js';

const SELF = [{ id: 'ent:self:owner', canonical: 'You', type: 'self', aliases: [], confidence: 1, isSelf: true }];
const factsFor = (msg) => buildConversationFacts({ conversationId: 'c', turn: 1, userMessage: msg, entities: SELF }).facts;

// ── 1. Situation capture ─────────────────────────────────────────────────────

test('a first-person PLURAL statement is part of the speaker\'s world', () => {
  for (const s of [
    'our biggest problem is churn in the first 30 days',
    'we decided to ship the new pricing tiers on Friday',
    "we're hiring two engineers this quarter",
    'our runway is nine months',
  ]) {
    assert.equal(isAboutSpeakersWorld(s), true, `"${s}"`);
  }
});

test('an adverb between the pronoun and the verb no longer blocks the match', () => {
  // "I usually do deep work in the mornings" matched nothing, because the
  // pattern required `i` and the verb to be adjacent.
  assert.equal(isAboutSpeakersWorld('I usually do deep work in the mornings'), true);
  assert.equal(isSelfDeclaration('I usually do deep work in the mornings'), true);
});

test('a sentence with no proper noun still becomes a fact', () => {
  // The whole point: `minEntities: 1` is satisfied by the speaker themselves.
  assert.equal(factsFor('our biggest problem is churn in the first 30 days').length, 1);
  assert.equal(factsFor('we decided to ship the new pricing tiers on Friday').length, 1);
});

// ── The constraints on widening ──────────────────────────────────────────────

test('the STRICT predicate is unchanged — plural still never reaches it', () => {
  // The card's singular-only rule exists so a group claim never becomes a line
  // about the individual. Widening the world-model predicate must not touch it.
  for (const s of [
    'our biggest problem is churn',
    "we're hiring two engineers",
    'we decided to ship on Friday',
  ]) {
    assert.equal(isSelfDeclaration(s), false, `"${s}" reached the strict predicate`);
  }
});

test('hedges and requests are still the texture of a conversation, not its content', () => {
  for (const s of [
    "we think that's the right call",
    "we're not sure yet",
    'we don\'t know what caused it',
    "I think that's right",
    'I want you to rewrite this',
    'can you help me write a script',
  ]) {
    assert.equal(isAboutSpeakersWorld(s), false, `"${s}"`);
  }
});

test('a question is never a disclosure, whatever pronoun it carries', () => {
  assert.equal(isAboutSpeakersWorld('what should we do about churn?'), false);
  assert.equal(isAboutSpeakersWorld('where do I work?'), false);
});

test('a sentence with no first person at all is left alone', () => {
  assert.equal(isAboutSpeakersWorld('the deploy failed again'), false);
  assert.equal(factsFor('the deploy failed again').length, 0);
});

test('hasSpeakersWorld is sentence-scoped, so one hedge cannot suppress a real statement', () => {
  assert.equal(hasSpeakersWorld("I think so. Our runway is nine months."), true);
});

// ── 2. The "You" leak ────────────────────────────────────────────────────────

test('the self node is NEVER a known entity for pass B', () => {
  // Its label is the literal word "You" and pass B is a surface match, so
  // leaving it in meant every message containing "you" resolved it.
  const graph = {
    nodesByType: () => [
      { label: 'You', data: { entityType: 'self' } },
      { label: 'Nummo', data: { entityType: 'name' } },
    ],
  };
  const known = knownEntitiesFor(graph, 'user:t');
  assert.deepEqual(known.map(k => k.value), ['Nummo']);
});

test('"thank you" does not resolve an entity, and does not become a fact', () => {
  const known = [{ value: 'You', type: 'self' }, { value: 'Nummo', type: 'name' }];
  for (const msg of ['thank you', 'can you help me debug this', 'what do you think']) {
    const ents = extractConversationEntities(msg, { knownEntities: known, selfText: msg });
    assert.deepEqual(ents, [], `"${msg}" → ${JSON.stringify(ents)}`);
    assert.equal(factsFor(msg).length, 0, `"${msg}" became a fact`);
  }
});

test('a real known entity still resolves case-insensitively — pass B is not broken', () => {
  const graph = { nodesByType: () => [{ label: 'Razorpay', data: { entityType: 'name' } }] };
  const known = knownEntitiesFor(graph, 'user:t');
  const ents = extractConversationEntities('we talked to razorpay again', { knownEntities: known });
  assert.ok(ents.some(e => e.value === 'Razorpay'), JSON.stringify(ents));
});

test('the speaker still becomes a subject by GRAMMAR, which is the only route', () => {
  // Pass D, not pass B. Removing the self node from `knownEntitiesFor` must not
  // remove the speaker from turns that genuinely disclose something.
  const ents = extractConversationEntities('our biggest problem is churn', {
    knownEntities: [], selfText: 'our biggest problem is churn',
  });
  assert.ok(ents.some(e => e.isSelf === true), JSON.stringify(ents));
});
