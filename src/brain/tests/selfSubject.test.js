/**
 * UUS U1 — first-person subject (node:test).
 * Run: node --test src/brain/tests/selfSubject.test.js
 *
 * THE DEFECT
 * ----------
 * "I'm building the understanding engine" resolved to nothing. Every entity
 * pass looked for a NAME, and there is no name in that sentence — the subject
 * is the owner, and the owner could not be a subject. Measured against the
 * shipped code: a realistic 8-answer "getting to know you" conversation
 * produced 0 entities and 0 facts, so the world model learned nothing from the
 * one conversation designed to fill it.
 *
 * THE INVARIANT THIS MUST NOT BREAK
 * ---------------------------------
 * `selfEntity.js` registers the self node with NO norms so that no NAME can
 * ever resolve into it — otherwise learning the user is called Priya would
 * quietly fuse them with every other Priya. Pronouns are not names; they are
 * deixis. Resolution therefore happens in the conversation extractor on the
 * grammar of the sentence, never in idStore and never as a registered alias.
 *
 * The load-bearing test in this file is the NEGATIVE one: a named person still
 * cannot reach the self node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-u1-'));

const {
  extractConversationEntities, isSelfDeclaration, hasSelfDeclaration,
} = await import('../knowledgeExtraction/conversationEntities.js');
const { buildConversationFacts } = await import('../knowledgeExtraction/conversationFacts.js');
const { SELF_GRAPH_ID, SELF_LABEL, SELF_KIND } = await import('../identity/selfEntity.js');
const idStore = await import('../identity/idStore.js');

const SELF_ENTITY = {
  id: SELF_GRAPH_ID, canonical: SELF_LABEL, type: SELF_KIND,
  aliases: [], confidence: 1, isSelf: true,
};

// ── 1. The grammar test ──────────────────────────────────────────────────────

test('U1: first-person disclosure is recognised', () => {
  const disclosures = [
    "I'm a founder and a software engineer.",
    "I'm building the understanding engine.",
    'My biggest project at the moment is Aqua.',
    'I work at Aquiplex.',
    'I have been engineering for eight years.',
    'I prefer short answers with code first.',
    'I founded the company in 2023.',
  ];
  for (const s of disclosures) assert.ok(isSelfDeclaration(s), `should disclose: ${s}`);
});

test('U1: discourse is not disclosure', () => {
  // Opinion markers, hedges and requests are not durable facts about a person.
  // Without this the world model fills with "I think" and "I don't know".
  const notDisclosures = [
    'I think that would work.',
    'I guess so.',
    'I agree with that approach.',
    "I don't know what happened.",
    "I'm not sure about that.",
    'I want you to rewrite this function.',
    'I understand.',
  ];
  for (const s of notDisclosures) assert.ok(!isSelfDeclaration(s), `should NOT disclose: ${s}`);
});

test('U1: a question discloses nothing', () => {
  assert.ok(!isSelfDeclaration('What should I work on next?'));
  assert.ok(!isSelfDeclaration('Am I using this right?'));
});

test('U1: we/our is excluded — a group claim is not an individual one', () => {
  // "we're building X" leaves the speaker's own role unstated. Attributing it
  // to the owner anyway is the quiet inference that puts a wrong line on a
  // summary card.
  assert.ok(!isSelfDeclaration("We're building a new API."));
  assert.ok(!isSelfDeclaration('Our company uses Postgres.'));
});

test('U1: disclosure is found per sentence, not per message', () => {
  // One hedge beside a real disclosure must not suppress it.
  assert.ok(hasSelfDeclaration("I think that's fine. I work at Aquiplex."));
  assert.ok(!hasSelfDeclaration('I think so. I agree.'));
});

// ── 2. Entity emission ───────────────────────────────────────────────────────

test('U1: the speaker becomes an entity when they disclose something', () => {
  const msg = "I'm building the understanding engine.";
  const ents = extractConversationEntities(msg, { selfText: msg });
  const self = ents.find(e => e.isSelf);
  assert.ok(self, 'self entity emitted');
  assert.equal(self.type, SELF_KIND);
  assert.equal(self.value, SELF_LABEL);
});

test('U1: no selfText means no self entity — the option is opt-in', () => {
  const msg = "I'm building the understanding engine.";
  assert.equal(extractConversationEntities(msg).some(e => e.isSelf), false);
});

test('U1: AQUA talking about itself never becomes the user', () => {
  // The turn text passed for extraction contains BOTH sides. Only the user's
  // message is examined for disclosure — reading our own "I can help with…"
  // as the user describing themselves would manufacture evidence out of our
  // own output, the closed loop the Digital Twin was built to avoid.
  const userMessage = 'What can you do?';
  const assistantMessage = "I'm Aqua. I work by building an understanding of your world.";
  const ents = extractConversationEntities(`${userMessage}\n${assistantMessage}`, {
    selfText: userMessage,
  });
  assert.equal(ents.some(e => e.isSelf), false, "the assistant's first person is not the user's");
});

test('U1: the self entity never displaces a named one', () => {
  const msg = 'I work at Aquiplex.';
  const ents = extractConversationEntities(msg, { selfText: msg, limit: 40 });
  assert.ok(ents.some(e => e.isSelf));
  assert.ok(ents.some(e => !e.isSelf), 'named entities still extracted alongside');
});

// ── 3. Facts — the actual gap ────────────────────────────────────────────────

test('U1: a pronoun-only turn now produces a fact', () => {
  const userMessage = "I'm building the understanding engine.";
  const before = buildConversationFacts({ conversationId: 'c1', turn: 1, userMessage, entities: [] });
  assert.equal(before.skipped, 'no-entities', 'pre-U1 behaviour, reproduced');
  assert.equal(before.facts.length, 0);

  const after = buildConversationFacts({ conversationId: 'c1', turn: 1, userMessage, entities: [SELF_ENTITY] });
  assert.equal(after.skipped, null);
  assert.equal(after.facts.length, 1);
  assert.deepEqual(after.facts[0].entities, [SELF_LABEL]);
});

test('U1: a turn naming both the speaker and an organisation links both', () => {
  const userMessage = 'I work at Aquiplex.';
  const entities = [SELF_ENTITY, { id: 'ent:org:aquiplex', canonical: 'Aquiplex', type: 'org', aliases: [] }];
  const { facts } = buildConversationFacts({ conversationId: 'c1', turn: 1, userMessage, entities });
  assert.equal(facts.length, 1);
  assert.deepEqual([...facts[0].entities].sort(), ['Aquiplex', 'You']);
});

test('U1: a hedge sentence does not become a fact about the user', () => {
  const userMessage = "I think that's probably the right call here.";
  const { facts } = buildConversationFacts({ conversationId: 'c1', turn: 1, userMessage, entities: [SELF_ENTITY] });
  assert.equal(facts.length, 0);
});

test('U1: the self label is never matched as a substring', () => {
  // The defining hazard of the naive approach. surfaceFormIndex uses
  // `includes()`, so putting "You" in that index would fire on "your",
  // "young", "yours" — every second sentence would become a fact about the
  // user. The self entity is matched by grammar and stays out of that index.
  const userMessage = 'Your suggestion about young developers is interesting.';
  const { facts } = buildConversationFacts({ conversationId: 'c1', turn: 1, userMessage, entities: [SELF_ENTITY] });
  assert.equal(facts.length, 0, 'no fact from "your"/"young"');
});

// ── 4. The invariant ─────────────────────────────────────────────────────────

test('U1: NO NAME resolves to the self entity — the never-fuse invariant', () => {
  // THE load-bearing test. The self node is registered with no norms so that
  // learning the user is called Priya cannot fuse them with a different Priya.
  // U1 must not have quietly bought first-person support by weakening it.
  const owner = 'user:invariant';
  const entry = idStore.getEntry(owner, 'aq:self:owner');
  if (entry) assert.deepEqual(entry.norms, [], 'self is registered with no norms');

  for (const name of ['Priya', 'You', 'Ananya', 'me', 'myself']) {
    const ents = extractConversationEntities(`${name} owns the billing service.`, {});
    assert.equal(
      ents.some(e => e.isSelf), false,
      `a name must never reach the self entity: ${name}`,
    );
  }
});

test('U1: self facts carry conversational provenance, not document provenance', () => {
  const userMessage = "I'm a founder and a software engineer.";
  const { facts, evidence } = buildConversationFacts({
    conversationId: 'c1', turn: 1, userMessage, entities: [SELF_ENTITY],
  });
  assert.equal(evidence[0].sourceType, 'conversation');
  assert.equal(evidence[0].extractionMethod, 'heuristic');
  assert.ok(facts[0].confidence <= 0.6, 'still capped below document grade');
});
