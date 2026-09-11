/**
 * AQUA — Web Search Orchestration Routing (integration)
 *
 * Proves the END-TO-END decision the spec asks for: a real user message goes
 * through the actual pipeline front-half — classifier.js (classifyTask) →
 * toolOrchestrator.js (orchestrate) → capabilities.js 'web_search' override →
 * searchDecision.js (decideWebSearch) — and the orchestrator's `web_search`
 * capability comes out enabled or skipped correctly. No providers, no network,
 * no LLM: orchestrate() is pure/deterministic, so this asserts the routing
 * logic that decides *whether* SearchManager will be invoked in chat.js step
 * 5d, not the search itself (that is covered exhaustively by
 * src/search/tests/search.test.js).
 *
 * Regression context: short factual questions ("Current Bitcoin price", "Who
 * is the new CM of Assam?") were classified `conversation` by the classifier's
 * short-message heuristic and then hard-blocked by searchDecision — so the
 * orchestrator skipped web search and AQUA answered from stale model
 * knowledge. The fix restores factual-question classification and broadens the
 * office-holder signal; these tests lock that behavior in.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTask } from '../../core/classifier.js';
import { orchestrate } from '../../orchestrator/toolOrchestrator.js';
import '../../search/searchAgent.js'; // side-effect: registers 'web_search' so the capability override is live

// Run the real front-half of the pipeline and report whether the orchestrator
// enabled the web_search capability for this turn.
function routesToSearch(userMessage, { workspaceId = null } = {}) {
  const { task, confidence } = classifyTask(userMessage);
  const decision = orchestrate({
    userMessage,
    taskType: task,
    confidence,
    hasWorkspaceId: !!workspaceId,
  });
  const cap = decision.capabilities.find((c) => c.id === 'web_search');
  return { enabled: !!cap?.enabled, task, reason: cap?.reason, decision };
}

const searches   = (m, o) => assert.equal(routesToSearch(m, o).enabled, true,  `expected SEARCH: "${m}" (task=${routesToSearch(m, o).task}, reason=${routesToSearch(m, o).reason})`);
const noSearch   = (m, o) => assert.equal(routesToSearch(m, o).enabled, false, `expected NO search: "${m}" (task=${routesToSearch(m, o).task}, reason=${routesToSearch(m, o).reason})`);

describe('web search orchestration routing — spec examples', () => {
  test('fresh / external knowledge questions route THROUGH web search', () => {
    searches('Who is the new CM of Assam?');            // office holder + freshness
    searches('Who is the principal of DR BKB College?'); // institutional office holder
    searches('Latest Node.js version');                  // release / freshness
    searches('Latest Node version');
    searches('Current Bitcoin price');                   // market / pricing
    searches('Compare Gemini 2.5 Flash vs GPT-5');       // comparison / research
    searches('Who is the current CEO of OpenAI?');       // corporate office holder
    searches("What's the current pricing of Vercel Pro?");
  });

  test('creative / memory / workspace-grounded questions SKIP web search', () => {
    noSearch('Write me a poem');                                     // creative → hard block
    noSearch('Remember my birthday is June 3');                      // memory update → hard block
    noSearch('My uploaded PDF says the deadline is Friday — summarize it', { workspaceId: 'ws_1' }); // attachment
    noSearch('What is 17 times 42?');                                // arithmetic — no live signal
    noSearch('Hey, how are you today?');                             // greeting (contains "today" but stays conversation)
    noSearch('Explain the concept of recursion');                    // timeless / definitional
    noSearch('Refactor the auth middleware in this repo', { workspaceId: 'ws_1' }); // workspace grounded
  });
});

describe('classifier no longer swallows factual questions as conversation', () => {
  test('terse office-holder / pricing questions classify as simple_qa, not conversation', () => {
    for (const m of ['Who is the new CM of Assam?', 'Current Bitcoin price', 'Who is the principal of DR BKB College?']) {
      assert.equal(classifyTask(m).task, 'simple_qa', `"${m}" should be simple_qa`);
    }
  });

  test('greetings and weak-signal chatter still classify as conversation', () => {
    assert.equal(classifyTask('Hey, how are you today?').task, 'conversation');
    assert.equal(classifyTask('Hi there').task, 'conversation');
    // demoted-research fragment referencing code — must not become research
    assert.notEqual(classifyTask('Can you clarify what is happening in my code below?').task, 'research');
  });
});

describe('forensic pass (Bug 1 investigation, Bug 2 findings) — present-tense status, plural pricing, imperative requests', () => {
  // "Is X still Y?" reads as settled/historical but asks about RIGHT NOW —
  // exactly the shape flagged for search regardless of how the question is
  // phrased. Neither the old 'status' signal (down/up/available/out/open/
  // closed only) nor 'lifecycle' (still supported/maintained only) covered
  // general present-tense continuity questions.
  test('present-tense "still" status questions route THROUGH web search', () => {
    searches("Is Joe Rogan's podcast still airing?");
    searches('Does India still have the caste reservation system?');
    searches('Is the James Webb telescope still operational?');
  });

  // Bare plural of a positive-signal noun must score the same as the
  // singular — "prices" was silently worth 0 while "price" was worth +3.
  test('plural "prices" scores the same as singular "price"', () => {
    searches('current prices of GPUs');
    searches("what's the current price of GPUs");
  });

  // Imperative information-requests ("give me…") were swept into
  // `personal_info` by the classifier's declarative-intent fallback (no "?",
  // no WH-word/auxiliary opener) and then hard-blocked by searchDecision —
  // silently killing a live-news query carrying an explicit "latest" signal.
  test('imperative "give me the latest on…" requests route THROUGH web search, not personal_info', () => {
    assert.notEqual(classifyTask('give me the latest on the Israel-Gaza ceasefire').task, 'personal_info');
    searches('give me the latest on the Israel-Gaza ceasefire');
    searches('tell me the latest on the Fed rate decision');
  });

  test('"still" alone, without a question opener, does not spuriously add signal', () => {
    // Control: the pattern requires is/are/does/do/has/have near "still" —
    // an ordinary declarative use of "still" must not be scored at all.
    noSearch('I still need to buy groceries');
  });

  test('genuine first-person statements keep classifying as personal_info (imperative guard did not widen the fallback itself)', () => {
    assert.equal(classifyTask('my team ships every two weeks').task, 'personal_info');
  });
});

describe('routing is deterministic (orchestrate() purity)', () => {
  test('same message → identical enabled/skipped decision', () => {
    const a = routesToSearch('Current Bitcoin price').enabled;
    const b = routesToSearch('Current Bitcoin price').enabled;
    assert.equal(a, b);
  });

  test('the Simple Question profile does NOT hard-disable search — the decision is dynamic', () => {
    // Both classify to the Simple Question profile, yet one searches and one
    // does not: profile sets the baseline, SearchDecision decides web search.
    const fresh = routesToSearch('Current Bitcoin price');
    const chat  = routesToSearch('Hey, how are you today?');
    assert.equal(fresh.decision.profile.label, 'Simple Question');
    assert.equal(chat.decision.profile.label, 'Simple Question');
    assert.equal(fresh.enabled, true);
    assert.equal(chat.enabled, false);
  });
});