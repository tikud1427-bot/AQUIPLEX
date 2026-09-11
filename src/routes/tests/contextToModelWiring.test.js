/**
 * §15 SEAM — assembled personal context reaches the MODEL INPUT.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * L12: "Wiring is proven, not assumed." The STEP 0 forensic audit measured the
 * bite of severing this seam and got ZERO:
 *
 *   remove `knowledgeContext` from `combinedContext` in prepareTurn()
 *     → 2416 tests, 0 fail
 *
 * Every path by which PIC, the world model and Context Engine V2 reach the
 * answer could be deleted and the entire battery stayed green. `grep
 * knowledgeContext src/**\/*.test.js` returned zero files. The Context Engine
 * has unit tests for its scorer and assembler — a pure builder with perfect
 * coverage proves nothing about the impure caller that carries its output to
 * the model. That is exactly the class L12 was written for, and this is the
 * most consequential instance of it in the product: the brief's central
 * requirement is that understanding changes the ANSWER, and the answer is
 * generated from `systemPrompt`.
 *
 * So these tests go through the real `prepareTurn()` with DEFAULT deps —
 * real memory engine, real PIC, real world model, real Context Engine V2,
 * real promptBuilder — after seeding an owner through the real writers, and
 * assert on the string that is positionally handed to `generateText()`.
 *
 * WHAT THIS DOES NOT PROVE (declared, not glossed)
 * ------------------------------------------------
 * `prepareTurn()` returns `systemPrompt`; the endpoint then calls
 * `generateText(userMessage, systemPrompt, messages, …)`. This suite proves
 * the context reaches `prep.systemPrompt`. It does NOT prove the endpoint
 * passes that exact value rather than some other string — `generateText` is a
 * static ESM import with no DI seam at the chat.js call site, and adding one
 * is a production change outside PR-1's scope. Recorded as the follow-up.
 *
 * THIS SUITE GUARDS THE WIRE, NOT THE RANKING. Measured: forcing
 * `Brain.contextV2Active()` to false at the call site fails ZERO tests here,
 * and that is the correct outcome — V2 off falls back to the PIC floor, which
 * still produces a block, which still reaches the prompt. Whether the RIGHT
 * lines were selected is a different question with a different instrument (a
 * context-selection eval, which does not exist yet). Conflating the two would
 * give this suite an opinion it cannot defend, and would make a ranking
 * regression look like a wiring failure.
 *
 * VACUITY IS THE REAL RISK HERE. A seeded owner that produces an empty
 * knowledge block would make every assertion below trivially true, and this
 * project has shipped a vacuous measurement before (E1/PR-7). Every test
 * therefore asserts its own precondition FIRST and fails loudly — never
 * silently passes — when the fixture stops producing context.
 *
 * Run: node --test src/routes/tests/contextToModelWiring.test.js
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Production flag values, as they stand in the deployed .env. This suite must
// measure the shipping configuration, not a convenient one.
process.env.AQUA_DATA_DIR             = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-ctxwire-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.AQUA_CONTEXT_V2           = 'on';
process.env.AQUA_BRAIN_INGEST         = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS   = 'on';
process.env.AQUA_SELF_ENTITY          = 'on';

const { prepareTurn }   = await import('../chat.js');
const { createContext } = await import('../../core/observability.js');
const mem               = await import('../../memory/engine.js');
const Brain             = await import('../../brain/index.js');

const USER_ID = 'ctxwire';
const OWNER   = `user:${USER_ID}`;
const CONV    = 'c-ctxwire';

/** The same shape rolloutstage.mjs uses — self-disclosure plus a situation,
 *  because a fixture of pure proper nouns would not exercise the assembler. */
const SESSION = [
  "I'm Maya. I run product at Nummo, a fintech in Bangalore.",
  'My co-founder Dev runs engineering.',
  'our biggest problem right now is churn in the first 30 days',
  'Razorpay is our main competitor',
  'I want to hit 10,000 active merchants by December.',
];

/** A first-person question about the seeded world — the turn shape the whole
 *  product exists to answer well. Not a self/identity question: those are
 *  routed to the Identity Layer and deliberately SKIP knowledge retrieval. */
const QUESTION = 'Where do I work and who is my co-founder?';

let prep;

before(async () => {
  let turn = 0;
  for (const t of SESSION) {
    mem.memoryObserve(OWNER, {
      userMessage: t, taskType: 'personal_info',
      conversationId: CONV, userId: USER_ID, requestId: 'seed',
    });
    await Brain.observeConversationTurn({
      ownerId: OWNER, conversationId: CONV, turn: turn++,
      userMessage: t, assistantMessage: 'Got it.',
    });
  }

  prep = await prepareTurn({
    userMessage: QUESTION,
    workspaceId: null,
    conversationId: CONV,
    userId: USER_ID,
    ctx: createContext({ conversationId: CONV, requestId: 'ctxwire' }),
    requestId: 'ctxwire',
    // The reasoning pass makes provider calls. Skipping it is the same switch
    // the artifact branch uses in production, and it is orthogonal to the
    // grounding seam under test.
    skipReasoningPass: true,
  });
});

/** Bullet lines are what the PIC/Context-Engine block is made of. Comparing
 *  line-by-line rather than substring-on-the-whole-block means a truncating
 *  regression in promptBuilder fails here instead of passing on a prefix. */
const bulletsOf = block =>
  String(block ?? '').split('\n').map(l => l.trim()).filter(l => l.startsWith('•'));

test('PRECONDITION — the fixture actually produces personal context', () => {
  assert.ok(prep, 'prepareTurn returned a prep object');
  assert.equal(prep.identityIntent?.isSelf, false,
    'the probe question must NOT route to the Identity Layer — that path skips knowledge retrieval by design, and a self-question would make every assertion below vacuous');
  assert.ok(prep.knowledgeContext && prep.knowledgeContext.trim().length > 0,
    'knowledgeContext is non-empty — if this fails the fixture stopped producing context and every other test in this file is meaningless, so fix the fixture rather than deleting the assertion');
  assert.ok(bulletsOf(prep.knowledgeContext).length > 0,
    'the knowledge block contains at least one bullet line');
});

test('knowledgeContext reaches the system prompt — the seam whose bite was zero', () => {
  const bullets = bulletsOf(prep.knowledgeContext);
  assert.ok(bullets.length > 0, 'precondition: block has bullets');

  const missing = bullets.filter(b => !prep.systemPrompt.includes(b));
  assert.deepEqual(missing, [],
    `every retrieved knowledge line must appear in the system prompt handed to generateText(). Missing ${missing.length}/${bullets.length}. This is the §15 wire: knowledgeContext → combinedContext → buildSystemPrompt → systemPrompt → generateText(userMessage, systemPrompt, …).`);
});

test('the memory block reaches the system prompt too — the other personal channel', () => {
  // memoryBlock rides a different promptBuilder parameter than knowledgeContext.
  // A regression that drops one and not the other must not hide behind the test
  // for the other.
  if (!prep.memoryBlock || !prep.memoryBlock.trim()) {
    assert.fail('memoryBlock is empty — the memory lane stopped grounding this turn; this suite cannot report on a channel that produced nothing');
  }
  const lines = prep.memoryBlock.split('\n').map(l => l.trim()).filter(l => l.length > 3);
  const missing = lines.filter(l => !prep.systemPrompt.includes(l));
  assert.deepEqual(missing, [],
    `every memory line must reach the system prompt (missing ${missing.length}/${lines.length})`);
});

test('the personal context arrives FENCED — L18 survives the trip', () => {
  // Ingested content is data, never instruction. The fence is applied at the
  // same seam the context travels through, so a refactor that preserves the
  // content while losing the fence is a security regression that this suite is
  // positioned to catch and nothing else is.
  //
  // 🔴 THE FIRST VERSION OF THIS TEST SCORED ZERO BITE. It asserted that the
  // text preceding the block matched /UNTRUSTED[_ ]?CONTENT/i — and passed
  // with the fence removed, because the BASE SYSTEM PROMPT states the
  // data-vs-instruction hierarchy in prose (L18 requires it to). The detector
  // matched the prompt's own explanation of fencing instead of a fence. Same
  // class as the six prior self-matches in this project; the fix is the same
  // one every time — anchor on the REAL delimiter, never on a description of
  // it. Hence the exact marker strings below rather than a tolerant regex.
  const OPEN  = /<<<UNTRUSTED-CONTENT [^>]+>>>/g;
  const CLOSE = /<<<END-UNTRUSTED-CONTENT [^>]+>>>/g;

  const bullets = bulletsOf(prep.knowledgeContext);
  assert.ok(bullets.length > 0, 'precondition: block has bullets');

  const at = prep.systemPrompt.indexOf(bullets[0]);
  assert.ok(at > 0, 'precondition: the block was located in the prompt');

  const lastIndexOfMatch = (re, limit) => {
    let found = -1;
    for (const m of prep.systemPrompt.matchAll(re)) {
      if (m.index < limit) found = m.index; else break;
    }
    return found;
  };
  const firstIndexOfMatchAfter = (re, from) => {
    for (const m of prep.systemPrompt.matchAll(re)) if (m.index > from) return m.index;
    return -1;
  };

  const openAt  = lastIndexOfMatch(OPEN, at);
  const closeAt = firstIndexOfMatchAfter(CLOSE, at);
  const strayCloseBetween = lastIndexOfMatch(CLOSE, at);

  assert.ok(openAt >= 0,
    'a real <<<UNTRUSTED-CONTENT …>>> marker opens before the injected personal context (L18)');
  assert.ok(closeAt > at,
    'a real <<<END-UNTRUSTED-CONTENT …>>> marker closes after it');
  assert.ok(strayCloseBetween < openAt,
    'the context sits INSIDE the fence — no close marker intervenes between the opening marker and the content, which would leave it unfenced while both markers are still present');
});

test('the wire is UNCONDITIONAL — no silent budget drop at the prompt seam', () => {
  // buildSystemPrompt applies no truncation to this parameter today. If a
  // future budget pass starts trimming, personal context is the first thing an
  // author would reach for, and it must not disappear silently.
  const bullets = bulletsOf(prep.knowledgeContext);
  const present = bullets.filter(b => prep.systemPrompt.includes(b)).length;
  assert.equal(present, bullets.length,
    `all ${bullets.length} knowledge lines survived prompt assembly; a partial count here means something began trimming personal context`);
});
