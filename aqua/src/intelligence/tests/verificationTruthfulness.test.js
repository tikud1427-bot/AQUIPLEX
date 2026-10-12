/**
 * P0 2026-10-12 — a delivered answer is never represented as verified when
 * verification did not complete.
 *
 * Seen in production: provider timeouts on the reviewer, judge responses cut
 * off by the token budget, and debate panel output that could not be parsed.
 * Before this, a pass-2 timeout after pass 1 returned `ran:true, passed:false`
 * (indistinguishable from a real "issues found"), a truncated critique could
 * REPLACE the answer, a truncated panel surfaced as "unparseable", and the UI
 * badged a turn "verified" whenever verification was merely warranted.
 *
 * The agents are driven through their real run functions with an injected
 * `generate`; the verdict comes from the one function the payload uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVerification } from '../verificationAgent.js';
import { runDebate } from '../debateAgent.js';
import { verificationStatus, VERIFICATION_STATUSES } from '../../orchestrator/verificationStrategy.js';

const DRAFT = 'Paris is the capital of France.';
/** Scripted generate: each entry is a result object or an Error to throw. */
const script = (...steps) => { let i = 0; return async () => { const s = steps[Math.min(i++, steps.length - 1)]; if (s instanceof Error) throw s; return s; }; };
const run = (generate, extra = {}) => runVerification({ userMessage: 'Capital of France?', draftAnswer: DRAFT, taskType: 'factual', generate, ...extra });
const status = v => verificationStatus(v, { warranted: true });

test('a completed clean pass is the ONLY way to be verified', async () => {
  const v = await run(script({ text: 'VERIFICATION_PASSED', provider: 'p' }));
  assert.equal(status(v), 'verified');
});

test('provider timeout before any pass completes → failed (never verified)', async () => {
  const v = await run(script(new Error('provider timeout after 30000ms')));
  assert.equal(v.ran, false);
  assert.equal(status(v), 'failed');
  assert.equal(v.finalAnswer, DRAFT, 'draft delivered unchanged');
});

test('pass 1 revises, pass 2 times out → revised_unconfirmed (was ran:true passed:false)', async () => {
  const v = await run(script({ text: 'Paris is the capital and largest city of France.' }, new Error('timeout')), { maxPasses: 2 });
  assert.equal(status(v), 'revised_unconfirmed');
});

test('a truncated critique never replaces the answer and the review is incomplete', async () => {
  const v = await run(script({ text: 'Paris is the capi', truncated: true, finishReason: 'length' }));
  assert.equal(v.finalAnswer, DRAFT, 'a cut-off critique must not become the delivered answer');
  assert.equal(v.revised, false);
  assert.equal(v.suppressedTruncated, 1);
  assert.equal(status(v), 'incomplete');
});

test('an empty/malformed critique → incomplete, not "issues found"', async () => {
  const v = await run(script({ text: '   ' }));
  assert.equal(status(v), 'incomplete');
});

const PANEL_TAGS = [];
const debate = generate => runDebate({ userMessage: 'Capital of France?', draftAnswer: DRAFT, taskType: 'factual', tags: PANEL_TAGS, generate });

test('debate: a panel cut off by its budget is reported as truncated, and the turn is failed — not verified', async () => {
  const v = await debate(script({ text: '{"findings":[{"persona":"', truncated: true }));
  assert.match(v.error, /panel_truncated/);
  assert.equal(status(v), 'failed');
  assert.equal(v.finalAnswer, DRAFT);
});

test('debate: unparseable panel output → failed', async () => {
  const v = await debate(script({ text: 'I think the answer looks fine overall.' }));
  assert.match(v.error, /panel_unparseable/);
  assert.equal(status(v), 'failed');
});

test('the status table: every verdict is one of the declared statuses, and only one is verified', () => {
  const cases = [
    [{ ran: false }, { warranted: false }, 'not_requested'],
    [{ ran: false }, { warranted: true }, 'unavailable'],
    [{ ran: false, error: 'x' }, {}, 'failed'],
    [{ ran: true, passed: true }, {}, 'verified'],
    [{ ran: true, passed: false, error: 'x' }, {}, 'incomplete'],
    [{ ran: true, passed: false, revised: true }, {}, 'revised_unconfirmed'],
    [{ ran: true, passed: false, inconclusive: true }, {}, 'inconclusive'],
    [{ ran: true, passed: false, agent: 'debate', converged: true, disagreements: [{}] }, {}, 'disputed'],
    [{ ran: true, passed: false, suppressedRefusals: 1 }, {}, 'incomplete'],
    [{ ran: true, passed: false }, {}, 'issues_unresolved'],
  ];
  for (const [v, o, want] of cases) {
    const got = verificationStatus(v, o);
    assert.equal(got, want, JSON.stringify(v));
    assert.ok(VERIFICATION_STATUSES.includes(got));
  }
});
