/**
 * The welcome line — selection, lifecycle, grounding and the service seam.
 *
 * Pure tests over the selector with claims in the canonical read-model shape
 * (what repository.js returns), plus the service (index.js) with injected
 * data sources for the failure and isolation cases. The live Postgres path —
 * real extraction pipeline → canonical claims → HTTP — is welcome.live.test.js.
 *
 *   A two worlds          B blocker resolved      C completed goal
 *   D changed priority    E no context            F provider failure
 *   G isolation           H stability             I re-evaluation on change
 *   J grounding           + legacy fallback rules, sensitivity, phrasing
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectWelcome, isGrounded, gerundPhrase, worldVersion, contentTokens,
  INVITE_NEW, INVITE_RETURNING, UNAVAILABLE, DEVELOPMENT_WINDOW_DAYS,
} from './selector.js';
import { welcomeFor, __setWelcomeDepsForTests, __resetWelcomeDepsForTests } from './index.js';

const NOW = new Date('2026-10-10T09:00:00Z');
const DAY = 86_400_000;
const ago = d => new Date(NOW.getTime() - d * DAY).toISOString();

let seq = 0;
/** One canonical claim. `object` is a literal string or { id, label } for an entity. */
function claim(predicate, object, o = {}) {
  const subject = o.subject ?? 'You';
  return {
    claimId: o.id ?? `c-${++seq}`,
    predicate,
    subject,
    subjectEntityId: o.sid ?? (subject === 'You' ? 'e-self' : `e-${subject.replace(/\W+/g, '-')}`),
    subjectIsSelf: subject === 'You',
    object: typeof object === 'string'
      ? { kind: 'literal', value: object }
      : { kind: 'entity', entityId: object.id, label: object.label },
    polarity: o.polarity ?? 'asserted',
    modality: o.modality ?? 'fact',
    state: o.state ?? 'active',
    assertedAt: ago(o.ago ?? 1),
    updatedAt: ago(o.updatedAgo ?? o.ago ?? 1),
    validTo: null,
    supersededBy: o.supersededBy ?? null,
    extractor: o.extractor ?? 'e6:groq',
    evidenceCount: o.evidence ?? 1,
    confidence: { derived: o.conf ?? 0.8 },
  };
}
const intent = (text, o = {}) => claim('plans_to', text, { modality: 'intent', ...o });
const entity = (label, id = `e-${label.replace(/\W+/g, '-')}`) => ({ id, label });
const pick = (input) => selectWelcome({ now: NOW, ...input });

/** Every claim the line cites, as text — for the grounding assertions. */
function citedText(result, claims, goals = []) {
  const byId = new Map(claims.map(c => [c.claimId, c]));
  return result.evidence.flatMap(e => {
    if (e.source === 'mind_goal') return [goals.find(g => String(g.id) === e.id)?.title];
    const c = byId.get(e.id);
    return c ? [c.subject, c.object.label ?? c.object.value] : [];
  });
}

describe('A — two different worlds produce two different, relevant lines', () => {
  test('a founder and a student do not share a message, and neither sees the other', () => {
    const founder = [claim('builds', 'Aquiplex', { ago: 6 }), intent('launch the beta', { ago: 2, evidence: 3 })];
    const student = [intent('finish my thesis', { ago: 3, evidence: 2 }), claim('task_owner', 'literature review', { ago: 1 })];
    const a = pick({ claims: founder });
    const b = pick({ claims: student });

    assert.notEqual(a.text, b.text);
    assert.match(a.text, /beta/);
    assert.match(b.text, /thesis/);
    assert.doesNotMatch(a.text, /thesis|literature/);
    assert.doesNotMatch(b.text, /beta|Aquiplex/);
    assert.equal(a.basis, 'world_model');
    assert.equal(b.basis, 'world_model');
    // "my thesis" said by the user is "your thesis" said back to them.
    assert.match(b.text, /your thesis/);
  });

  test('the better-evidenced goal wins over the merely newer one', () => {
    const r = pick({ claims: [
      intent('hire a designer', { ago: 1, evidence: 1, conf: 0.6 }),
      intent('launch the beta', { ago: 8, evidence: 5, conf: 0.85 }),
    ] });
    assert.match(r.text, /launching the beta/);
  });
});

describe('B — a resolved blocker is never presented as unresolved', () => {
  const launch = entity('launch');
  const base = () => [
    intent('launch the beta', { ago: 5 }),
    claim('blocks', launch, { subject: 'auth bug', ago: 4 }),
  ];

  test('while the blocker stands, the line can name it', () => {
    const r = pick({ claims: base() });
    assert.equal(r.kind, 'blocked');
    assert.match(r.text, /auth bug/);
    assert.match(r.text, /launch/);
  });

  test('after "the auth bug is fixed", the next selection treats it as resolved', () => {
    const before = pick({ claims: base() });
    const after = pick({ claims: [...base(), claim('has_status', 'fixed', { subject: 'auth bug', ago: 1 })] });
    assert.notEqual(after.worldVersion, before.worldVersion);
    assert.equal(after.kind, 'unblocked');
    assert.equal(after.text, 'With the auth bug sorted, the launch can move forward again.');
    assert.doesNotMatch(after.text, /out of the way|still|blocked|fix your/i);
  });

  test('a negated blocker ("the launch is no longer blocked by the auth bug") also ends it', () => {
    const r = pick({ claims: [...base(), claim('blocks', launch, { subject: 'auth bug', polarity: 'negated', ago: 1 })] });
    assert.notEqual(r.kind, 'blocked');
    assert.doesNotMatch(r.text, /out of the way/);
  });

  test('once the change ages out of its window the line moves on to the standing goal — still never "blocked"', () => {
    const later = new Date(NOW.getTime() + (DEVELOPMENT_WINDOW_DAYS + 2) * DAY);
    const r = selectWelcome({ now: later, claims: [...base(), claim('has_status', 'fixed', { subject: 'auth bug', ago: 1 })] });
    assert.equal(r.kind, 'goal');
    assert.doesNotMatch(r.text, /auth bug/);
  });

  test('an unrelated resolution does not make a still-blocked thing look unblocked', () => {
    const r = pick({ claims: [...base(), claim('has_status', 'fixed', { subject: 'logo', ago: 1 })] });
    assert.equal(r.kind, 'blocked');
  });
});

describe('C — a completed goal is not presented as unfinished', () => {
  test('"finish the migration" then "the migration is done" → acknowledged as done, never as a goal', () => {
    const claims = [
      intent('finish the migration', { ago: 6, evidence: 4 }),
      claim('has_status', 'done', { subject: 'migration', ago: 1 }),
    ];
    const r = pick({ claims });
    assert.equal(r.kind, 'completed');
    assert.equal(r.text, "The migration is done — what's next?");
    assert.doesNotMatch(r.text, /toward|keep|finishing/);
  });

  test('a completed goal with another active goal: the other goal is what remains', () => {
    const later = new Date(NOW.getTime() + 30 * DAY);
    const claims = [
      intent('finish the migration', { ago: 6, evidence: 4 }),
      claim('has_status', 'done', { subject: 'migration', ago: 1 }),
      intent('hire a designer', { ago: 3 }),
    ];
    const r = selectWelcome({ now: later, claims });
    assert.equal(r.text, "Let's keep working toward hiring a designer.");
  });

  test('a superseded or negated plan is not a current goal', () => {
    assert.equal(pick({ claims: [intent('launch in October', { state: 'superseded' })] }).kind, 'invite');
    const r = pick({ claims: [intent('raise a seed round', { ago: 5 }), intent('raise a seed round', { polarity: 'negated', ago: 1 })] });
    assert.doesNotMatch(r.text, /seed round/);
  });

  test('a legacy Mind goal marked completed or abandoned never appears', () => {
    for (const status of ['completed', 'abandoned', 'stale']) {
      const r = pick({ legacyGoals: [{ id: 'g', title: 'ship the pricing page', status, mentions: 5, confidence: 0.9, priority: 9 }] });
      assert.equal(r.kind, 'invite', status);
    }
  });
});

describe('D — a newer explicit priority supersedes the old one', () => {
  const claims = () => [
    intent('launch the mobile app', { id: 'old', ago: 9, state: 'superseded', supersededBy: 'new', evidence: 5 }),
    intent('ship the web beta', { id: 'new', ago: 2 }),
  ];

  test('the line follows the current priority and acknowledges the shift', () => {
    const r = pick({ claims: claims() });
    assert.equal(r.kind, 'focus_changed');
    assert.equal(r.text, "Your focus has moved to shipping the web beta — let's build on that.");
    assert.doesNotMatch(r.text, /mobile/);
  });

  test('after the shift is no longer news, the current priority is still the goal — the old one never returns', () => {
    const r = selectWelcome({ now: new Date(NOW.getTime() + 40 * DAY), claims: claims() });
    assert.equal(r.kind, 'goal');
    assert.match(r.text, /web beta/);
    assert.doesNotMatch(r.text, /mobile/);
  });

  test('as the store records an intent revision today (old plan still active beside its negated twin), the shift is still read', () => {
    const r = pick({ claims: [
      intent('launch the mobile app', { ago: 9, evidence: 5 }),
      intent('launch the mobile app', { polarity: 'negated', ago: 2 }),
      intent('ship the web beta', { ago: 2 }),
    ] });
    assert.equal(r.kind, 'focus_changed');
    assert.equal(r.text, "Your focus has moved to shipping the web beta — let's build on that.");
    assert.equal(r.evidence.length, 3);
  });

  test('a negation alone is not a shift: with no new plan, nothing is announced as the new focus', () => {
    const r = pick({ claims: [intent('launch the mobile app', { ago: 9 }), intent('launch the mobile app', { polarity: 'negated', ago: 2 })] });
    assert.notEqual(r.kind, 'focus_changed');
    assert.doesNotMatch(r.text, /mobile/);
  });

  test('a canonical correction vetoes the legacy goal it replaced', () => {
    const r = pick({
      claims: [intent('launch the mobile app', { state: 'superseded', supersededBy: 'x', ago: 3 })],
      legacyGoals: [{ id: 'g1', title: 'launch the mobile app', status: 'active', mentions: 4, confidence: 0.8, priority: 8 }],
    });
    assert.doesNotMatch(r.text, /mobile/);
  });
});

describe('E — no meaningful context: nothing is fabricated', () => {
  test('a new user gets the invitation, marked not-established', () => {
    const r = pick({});
    assert.equal(r.text, INVITE_NEW);
    assert.equal(r.established, false);
    assert.equal(r.basis, 'none');
    assert.deepEqual(r.evidence, []);
  });

  test('a returning user without established context is invited to share it', () => {
    assert.equal(pick({ history: true }).text, INVITE_RETURNING);
  });

  test('weak, uncertain or non-assertive claims are not stated back', () => {
    const weak = [
      intent('launch the beta', { conf: 0.3 }),                               // low confidence
      intent('move to Berlin', { state: 'disputed' }),                         // contested
      claim('builds', 'a chess engine', { extractor: 'reflection:pattern' }),  // machine-inferred
      claim('builds', 'a mobile app', { modality: 'hypothetical' }),           // "I'm considering…"
      claim('builds', 'a startup', { modality: 'quote' }),                     // reported speech
      claim('builds', 'the mobile app', { polarity: 'negated' }),              // "we never shipped…"
    ];
    const r = pick({ claims: weak });
    assert.equal(r.kind, 'invite');
    for (const word of ['beta', 'Berlin', 'chess', 'mobile', 'startup']) assert.doesNotMatch(r.text, new RegExp(word, 'i'));
  });

  test('a single regex-captured legacy goal is not enough to speak for the user', () => {
    const r = pick({ legacyGoals: [{ id: 'g', title: 'go to sleep early', status: 'active', mentions: 1, confidence: 0.55, priority: 5 }] });
    assert.equal(r.kind, 'invite');
  });

  test('a restated legacy goal fills the gap when the canonical model has nothing', () => {
    const goals = [{ id: 'g', title: 'hire two engineers', status: 'active', mentions: 3, confidence: 0.75, priority: 5 }];
    const r = pick({ legacyGoals: goals });
    assert.equal(r.basis, 'legacy_goals');
    assert.equal(r.text, "Let's keep working toward hiring two engineers.");
    assert.deepEqual(r.evidence, [{ source: 'mind_goal', id: 'g' }]);
  });

  test('canonical context outranks legacy goals', () => {
    const r = pick({
      claims: [claim('builds', 'Aquiplex')],
      legacyGoals: [{ id: 'g', title: 'hire two engineers', status: 'active', mentions: 3, confidence: 0.75, priority: 9 }],
    });
    assert.equal(r.basis, 'world_model');
    assert.match(r.text, /Aquiplex/);
  });
});

describe('sensitive context is not used for a greeting', () => {
  test('the old billionaire line cannot come back, from either source', () => {
    const r1 = pick({ claims: [intent('become a billionaire', { evidence: 6, conf: 0.95 })] });
    const r2 = pick({ legacyGoals: [{ id: 'g', title: 'become a billionaire within a year', status: 'active', mentions: 8, confidence: 1, priority: 10 }] });
    for (const r of [r1, r2]) {
      assert.doesNotMatch(r.text, /billion|middle of/i);
      assert.equal(r.established, false);
    }
  });

  test('health and money details are skipped in favour of the next relevant thing', () => {
    const r = pick({ claims: [
      intent('pay off my student loan', { evidence: 5 }),
      claim('task_owner', 'therapy homework', { ago: 1 }),
      claim('builds', 'a recipe app', { ago: 4 }),
    ] });
    assert.equal(r.text, "Let's keep building your recipe app.");
  });
});

describe('F — retrieval failure keeps the page usable and invents nothing', () => {
  afterEach(() => __resetWelcomeDepsForTests());

  test('selector: unavailable → neutral, non-personal line', () => {
    const r = pick({ unavailable: true, history: true, claims: [claim('builds', 'Aquiplex')] });
    assert.equal(r.text, UNAVAILABLE);
    assert.equal(r.established, false);
    assert.doesNotMatch(r.text, /Aquiplex/);
  });

  test('service: a throwing canonical read is caught, and legacy memory is NOT used unchecked', async () => {
    __setWelcomeDepsForTests({
      readMode: () => 'authoritative',
      loadClaims: async () => { throw new Error('connection refused'); },
      legacyGoals: () => [{ id: 'g', title: 'hire two engineers', status: 'active', mentions: 5, confidence: 0.9, priority: 9 }],
    });
    const r = await welcomeFor('user:f', { history: true, now: NOW });
    assert.equal(r.kind, 'unavailable');
    assert.equal(r.text, UNAVAILABLE);
    assert.doesNotMatch(r.text, /engineers/);
  });

  test('service: legacy mode with an unreadable Mind is also neutral', async () => {
    __setWelcomeDepsForTests({ readMode: () => 'legacy', legacyGoals: () => { throw new Error('corrupt mind file'); } });
    const r = await welcomeFor('user:f2', { now: NOW });
    assert.equal(r.kind, 'unavailable');
  });
});

describe('G — one owner\'s world never reaches another\'s line', () => {
  afterEach(() => __resetWelcomeDepsForTests());

  test('the service reads only the requested owner', async () => {
    const worlds = {
      'user:alice': [claim('builds', 'Aquiplex')],
      'user:bob': [intent('finish my thesis')],
    };
    const asked = [];
    __setWelcomeDepsForTests({
      readMode: () => 'canonical',
      loadClaims: async owner => { asked.push(owner); return worlds[owner] ?? []; },
    });
    const a = await welcomeFor('user:alice', { now: NOW });
    const b = await welcomeFor('user:bob', { now: NOW });
    const c = await welcomeFor('user:carol', { now: NOW });
    assert.deepEqual(asked, ['user:alice', 'user:bob', 'user:carol']);
    assert.match(a.text, /Aquiplex/);
    assert.doesNotMatch(a.text, /thesis/);
    assert.match(b.text, /thesis/);
    assert.doesNotMatch(b.text, /Aquiplex/);
    assert.equal(c.kind, 'invite');
  });

  test('canonical-only mode never consults legacy memory', async () => {
    let touched = false;
    __setWelcomeDepsForTests({ readMode: () => 'canonical', loadClaims: async () => [], legacyGoals: () => { touched = true; return []; } });
    await welcomeFor('user:x', { now: NOW });
    assert.equal(touched, false);
  });

  test('the service refuses to run without an owner', async () => {
    await assert.rejects(() => welcomeFor(null), /ownerId is required/);
  });
});

describe('H — stable while the world is unchanged', () => {
  test('repeated selection over the same state returns the same line and ids', () => {
    const claims = [claim('builds', 'Aquiplex', { ago: 9 }), intent('launch the beta', { ago: 2 }), claim('task_owner', 'fix the retrieval bug', { ago: 4 })];
    const first = pick({ claims });
    for (let i = 0; i < 50; i++) {
      const r = pick({ claims: [...claims].sort(() => Math.random() - 0.5) });
      assert.equal(r.text, first.text);
      assert.equal(r.messageId, first.messageId);
      assert.equal(r.worldVersion, first.worldVersion);
    }
  });

  test('time passing alone does not rotate a standing line', () => {
    const claims = [claim('builds', 'Aquiplex', { ago: 9 }), intent('launch the beta', { ago: 2 })];
    const texts = new Set([0, 1, 3, 7, 20, 60].map(d => selectWelcome({ now: new Date(NOW.getTime() + d * DAY), claims }).text));
    assert.equal(texts.size, 1);
  });
});

describe('I — a relevant change triggers re-evaluation; an irrelevant one does not change the line', () => {
  test('a new development moves the world version and the line', () => {
    const before = [intent('launch the beta', { ago: 3 })];
    const r1 = pick({ claims: before });
    const r2 = pick({ claims: [...before, claim('has_status', 'done', { subject: 'beta', ago: 0 })] });
    assert.notEqual(r2.worldVersion, r1.worldVersion);
    assert.notEqual(r2.messageId, r1.messageId);
    assert.equal(r2.text, "The beta is done — what's next?");
  });

  test('a change that does not affect the choice moves the version but keeps the message id', () => {
    const goal = intent('launch the beta', { id: 'g', ago: 3, evidence: 4 });
    const r1 = pick({ claims: [goal, claim('builds', 'Aquiplex', { id: 'p', ago: 20 })] });
    const r2 = pick({ claims: [goal, claim('builds', 'Aquiplex', { id: 'p', ago: 20, updatedAgo: 0 })] });
    assert.notEqual(r2.worldVersion, r1.worldVersion);
    assert.equal(r2.messageId, r1.messageId, 'the client keeps the same line');
  });

  test('worldVersion is order-independent and moves on a state change', () => {
    const a = claim('builds', 'X', { id: 'a' });
    const b = claim('builds', 'Y', { id: 'b' });
    assert.equal(worldVersion([a, b]), worldVersion([b, a]));
    assert.notEqual(worldVersion([a, b]), worldVersion([a, { ...b, state: 'superseded' }]));
  });
});

describe('J — every specific in a line is supported by the cited context', () => {
  const launch = entity('launch');
  const ios = entity('iOS launch');
  const due = new Date(NOW.getTime() + 3 * DAY).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const worlds = {
    project: [claim('builds', 'Aquiplex')],
    goal: [intent('finish my thesis')],
    task: [claim('task_owner', 'fix the retrieval bug')],
    decision: [claim('decided', 'drop the mobile app')],
    decisionNoun: [claim('decided', 'Postgres')],
    open: [claim('decided', 'pricing', { polarity: 'negated' })],
    blocked: [claim('blocks', launch, { subject: 'auth bug' })],
    blockedStatus: [claim('has_status', 'on hold', { subject: 'beta' })],
    unblocked: [claim('blocks', launch, { subject: 'auth bug', ago: 4 }), claim('has_status', 'fixed', { subject: 'auth bug', ago: 1 })],
    completed: [claim('has_status', 'done', { subject: 'billing refactor' })],
    focus: [intent('launch the mobile app', { id: 'o', state: 'superseded', supersededBy: 'n', ago: 6 }), intent('ship the web beta', { id: 'n' })],
    deadline: [claim('deadline_for', due, { subject: 'iOS launch', sid: ios.id, ago: 1 }), claim('blocks', ios, { subject: 'payment integration', ago: 1 })],
    approaching: [claim('deadline_for', due, { subject: 'iOS launch', sid: ios.id, ago: 1 })],
  };

  for (const [name, claims] of Object.entries(worlds)) {
    test(`${name}: grounded in its evidence, concise, free of internals`, () => {
      const r = pick({ claims });
      assert.equal(r.basis, 'world_model', `${name} produced no personalised line`);
      assert.ok(r.evidence.length > 0);
      assert.ok(isGrounded(r.text, citedText(r, claims)), `ungrounded: ${r.text}`);
      assert.ok(r.text.length <= 110, `too long for the heading: ${r.text}`);
      assert.doesNotMatch(r.text, /claim|predicate|confidence|entity|database|memor(y|ies)|monitor|analy[sz]ed|\bI noticed\b/i);
      assert.doesNotMatch(r.text, /!/, 'no exaggerated enthusiasm');
    });
  }

  test('the grounding check rejects a line naming something the evidence does not', () => {
    const claims = [claim('builds', 'Aquiplex')];
    assert.equal(isGrounded("Let's keep building Aquiplex.", citedText({ evidence: [{ source: 'claim', id: claims[0].claimId }] }, claims)), true);
    assert.equal(isGrounded("Let's keep building your rocket company.", ['Aquiplex']), false);
    assert.equal(isGrounded("You're close to closing your seed round.", ['seed round']), false, 'invented progress');
  });

  test('every content word of a goal line traces back to the user\'s own words', () => {
    const r = pick({ claims: [intent('hit 10,000 active merchants by December')] });
    const said = new Set(contentTokens('hit 10,000 active merchants by December'));
    for (const w of ['active', 'merchants', 'december']) assert.ok(said.has(w) && r.text.toLowerCase().includes(w));
  });
});

describe('phrasing helpers', () => {
  test('gerund phrases follow the user\'s words', () => {
    assert.equal(gerundPhrase('finish the migration'), 'finishing the migration');
    assert.equal(gerundPhrase('ship pricing tiers'), 'shipping pricing tiers');
    assert.equal(gerundPhrase('be profitable'), 'being profitable');
    assert.equal(gerundPhrase('hire a designer'), 'hiring a designer');
    assert.equal(gerundPhrase('finalize my slides'), 'finalizing your slides');
    assert.equal(gerundPhrase('frontend tests'), null);
  });

  test('a clause-shaped decision is skipped rather than misquoted', () => {
    const r = pick({ claims: [claim('decided', 'Priya owns onboarding')] });
    assert.doesNotMatch(r.text, /Priya/);
  });

  test('a completion is reported in the user\'s own word for it', () => {
    assert.equal(pick({ claims: [claim('has_status', 'live', { subject: 'beta' })] }).text, "The beta is live — what's next?");
    assert.equal(pick({ claims: [claim('has_status', 'signed', { subject: 'contract' })] }).text, "The contract is signed — what's next?");
  });

  test('the user as the blocker is never the subject of the greeting', () => {
    const r = pick({ claims: [claim('blocks', { id: 'e-release', label: 'release' }, { subject: 'You' })] });
    assert.doesNotMatch(r.text, /\bYou out of the way|Let's get you/i);
  });

  test('"I\'m blocked" about the person is not turned into a line about them', () => {
    const r = pick({ claims: [claim('has_status', 'blocked')] });
    assert.equal(r.kind, 'invite');
  });
});
