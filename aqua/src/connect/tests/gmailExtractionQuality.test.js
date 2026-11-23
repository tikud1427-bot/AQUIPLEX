/**
 * Phase 4B (2026-11-23) — extraction quality on labelled adversarial fixtures.
 *
 * Each fixture is a thread of synthetic messages with the items a careful reader would list
 * (by type, by a phrase of the statement, and by expected status). Precision / recall per
 * category are measured over the real render → understand → reconcile path and printed for
 * the report. Hard guarantees asserted: nothing uncertain presented as stated; nothing from
 * quoted earlier mail; nothing from automated mail; nothing user-confirmed.
 * Pure: no network, no store.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const K = await import('./testkit.js'); void K;
const U = await import('../gmail/emailUnderstanding.js');
const N = await import('../gmail/gmailNormalize.js');
const F = await import('../testing/gmailFixtures.js');

const PRIYA = 'Priya Sharma <priya@acme.example>', RAJ = 'Raj Mehta <raj@acme.example>', NOREPLY = 'Shop <no-reply@shop.example>';
let seq = 0;
const render = (m, thread) => N.renderGmailDocument(N.parseGmailMessage(F.buildMessage({
  id: `18d${String(++seq).padStart(13, '0')}`, threadId: thread, date: m.date ?? `Mon, ${String(1 + (seq % 27)).padStart(2, '0')} Jun 2026 10:00:00 +0000`,
  headers: { From: m.from ?? PRIYA, To: m.to ?? RAJ, Subject: m.subject ?? 'Plan', 'Message-ID': `<x${seq}@acme.example>` }, text: m.text,
})));
const understandThread = (name, msgs) => {
  const recs = msgs.map((m, k) => U.understandEmail(render({ date: `Mon, ${String(1 + k).padStart(2, '0')} Jun 2026 10:00:00 +0000`, ...m }, name), { extractedAt: '2026-07-01T00:00:00.000Z' })).filter(Boolean);
  return { recs, items: U.reconcileThread(recs) };
};

const STATEMENT_TYPES = ['commitment', 'task', 'deadline', 'decision', 'event', 'project'];
/**
 * [theme, thread messages, expected: Array<[type, phrase, status?]>]
 * status defaults to 'current'; listed items are what SHOULD be extracted; anything else of a
 * statement type is a false positive.
 */
export const FIXTURES = [
  ['invitation vs commitment', [{ text: "You're invited to our launch party on Friday at 6pm." }], [['event', 'launch party']]],
  ['acceptance of an invitation is a commitment', [{ text: "I'll attend the launch party on Friday." }], [['commitment', 'attend the launch party']]],
  ['request vs promise (request)', [{ text: 'Could you send the deck to the board?' }], [['task', 'send the deck']]],
  ['request vs promise (promise)', [{ text: "I'll send the deck to the board." }], [['commitment', 'send the deck']]],
  ['asking permission is not a promise', [{ text: 'Can I send the deck tomorrow?' }], []],
  ['incidental past date is not a deadline', [{ text: 'I was in Paris on March 3 for the conference.' }], []],
  ['founding year is not a deadline', [{ text: 'Our office was founded in 2010 and moved downtown in 2015.' }], []],
  // A dated request carries its date as the task's due date (no separate deadline item by design; the Deadlines view lists it).
  ['actionable deadline', [{ text: 'Please submit the expense form by June 30.' }], [['task', 'submit the expense form']]],
  ['same project named twice in a thread is one project', [{ text: 'Project Atlas kicks off next week.' }, { text: 'Project Atlas budget is approved by finance.' }], [['project', 'atlas']]],
  ['a name mentioned in the body is not a participant', [{ text: 'Please ask Sarah from legal to check the contract.' }], [['task', 'ask sarah']]],
  ['decision vs suggestion (decision)', [{ text: 'We decided to go with vendor A.' }], [['decision', 'vendor a']]],
  ['decision vs suggestion (suggestion)', [{ text: 'Maybe we should go with vendor A? Just a thought.' }], []],
  ['updated decision supersedes', [{ text: 'We decided to launch in Berlin.' }, { text: 'Update: we have decided to launch in Munich instead.' }], [['decision', 'berlin', 'superseded'], ['decision', 'munich']]],
  ['two people state different dates without a change marker: contradiction', [{ text: 'The launch is July 15.' }, { from: RAJ, to: PRIYA, text: 'The launch is July 20.' }], [['date', 'july 15', 'contradicted'], ['date', 'july 20', 'contradicted']]],
  ['completed commitment', [{ text: "I'll send the quarterly report to finance." }, { text: "I've sent the quarterly report to finance." }], [['commitment', 'quarterly report', 'completed']]],
  ['open commitment stays open', [{ text: "I'll prepare the hiring plan for Q3." }, { text: 'Thanks, talk soon.' }], [['commitment', 'hiring plan']]],
  ['automated newsletter yields nothing', [{ from: NOREPLY, text: "We'll ship your order by Friday. We have decided to upgrade your account. Project Freebie starts Monday." }], []],
  ['personal mail with the same words yields items', [{ text: "We'll ship the prototype by Friday." }], [['commitment', 'ship the prototype']]],
  ['quoted earlier mail is not re-extracted', [{ text: "Sounds good.\n\nOn Mon, 1 Jun 2026, Raj wrote:\n> I'll send the deck by Monday.\n> We decided to use Postgres." }], []],
  ['forward divider stops extraction', [{ text: 'FYI below.\n\n---------- Forwarded message ----------\nWe decided to cut the budget. I will send the memo.' }], []],
  ['hedged promise is uncertain, not stated', [{ text: "I'll try to send the slides tonight." }], [['commitment', 'send the slides']]],
];

const match = (it, phrase) => JSON.stringify([it.statement, it.object, it.name, it.topic, it.value?.date, it.when?.date, it.due?.date].filter(Boolean)).toLowerCase().includes(phrase.toLowerCase())
  || (it.type === 'date' && /july (15|20)/.test(phrase) && String(it.value?.date ?? '').includes(phrase.endsWith('15') ? '07-15' : '07-20'));

function evaluate() {
  const per = Object.fromEntries([...STATEMENT_TYPES, 'date'].map(t => [t, { tp: 0, fp: 0, fn: 0 }]));
  const statusErrors = [];
  const misses = [], extras = [];
  for (const [theme, msgs, expected] of FIXTURES) {
    const { items } = understandThread(theme, msgs);
    const pred = items.filter(i => [...STATEMENT_TYPES, 'date'].includes(i.type) && i.status !== 'duplicate' && i.status !== 'corroborates');
    const used = new Set();
    for (const [type, phrase, status = 'current'] of expected) {
      const hit = pred.find(i => !used.has(i) && i.type === type && match(i, phrase));
      if (hit) { used.add(hit); per[type].tp++; if (hit.status !== status) statusErrors.push(`${theme}: ${type} '${phrase}' is ${hit.status}, expected ${status}`); }
      else { per[type].fn++; misses.push(`${theme}: ${type} '${phrase}'`); }
    }
    for (const i of pred) if (!used.has(i)) { per[i.type].fp++; extras.push(`${theme}: ${i.type} (${i.certainty}/${i.explicit ? 'explicit' : 'inferred'})`); }
  }
  const metrics = Object.fromEntries(Object.entries(per).map(([t, c]) => [t, { precision: c.tp + c.fp ? +(c.tp / (c.tp + c.fp)).toFixed(2) : null, recall: c.tp + c.fn ? +(c.tp / (c.tp + c.fn)).toFixed(2) : null, ...c }]));
  return { metrics, statusErrors, misses, extras };
}

describe('D · extraction quality (labelled adversarial fixtures)', () => {
  test('D1 · precision / recall per category (printed for the report)', () => {
    const r = evaluate();
    process.stderr.write(`[EXTRACT] ${JSON.stringify(r.metrics)}\n[EXTRACT] status errors: ${JSON.stringify(r.statusErrors)}\n[EXTRACT] misses: ${JSON.stringify(r.misses)}\n[EXTRACT] false positives: ${JSON.stringify(r.extras)}\n`);
    assert.ok(r.metrics.commitment.recall >= 0.8 && r.metrics.task.recall >= 0.6, 'regression floor');
  });

  test('D2 · nothing uncertain is presented as stated; nothing is user-confirmed', () => {
    for (const [theme, msgs] of FIXTURES) {
      for (const i of understandThread(theme, msgs).items) {
        assert.equal(i.userConfirmed, false, theme);
        if (i.certainty === 'uncertain') assert.equal(i.explicit, false, `${theme}: uncertain but explicit`);
      }
    }
    const hedged = understandThread('h', [{ text: "I'll try to send the slides tonight." }]).items.find(i => i.type === 'commitment');
    assert.deepEqual([hedged.certainty, hedged.explicit], ['uncertain', false]);
  });

  test('D3 · quoted earlier mail and automated mail never produce statements', () => {
    for (const theme of ['quoted earlier mail is not re-extracted', 'forward divider stops extraction', 'automated newsletter yields nothing']) {
      const [, msgs] = FIXTURES.find(f => f[0] === theme);
      const st = understandThread(theme, msgs).items.filter(i => STATEMENT_TYPES.includes(i.type) || i.type === 'date');
      assert.deepEqual(st.map(i => i.type), [], theme);
    }
  });

  test('D5 · a dated request carries its due date; a project named twice in a thread is one current project', () => {
    const t = understandThread('d5', [{ text: 'Please submit the expense form by June 30.' }]).items.find(i => i.type === 'task');
    assert.equal(t.due?.date, '2026-06-30');
    const p = understandThread('d5b', [{ text: 'Project Atlas kicks off next week.' }, { text: 'Project Atlas budget is approved by finance.' }]).items.filter(i => i.type === 'project');
    assert.deepEqual(p.map(i => i.status), ['current', 'corroborates']);
  });

  test('D4 · participants come from headers only; a name in the body creates no participant', () => {
    const { recs } = understandThread('p', [{ text: 'Please ask Sarah from legal to check the contract.' }]);
    assert.deepEqual(recs[0].people.map(p => p.address).sort(), ['priya@acme.example', 'raj@acme.example']);
  });
});
