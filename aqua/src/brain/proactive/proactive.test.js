/**
 * Phase 4 — proactive triggers, policy and deadline resolution (pure).
 * Run: node --test src/brain/proactive/proactive.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deadlineDate, daysUntil } from './deadlines.js';
import { detectTriggers, blockersOf, ownerOf, HORIZON_DAYS } from './triggers.js';
import { decide, assess, COOLDOWN_MS } from './policy.js';
import { proposeAction, MAX_STEPS } from '../actions/planner.js';

const NOW = new Date('2026-10-06T10:00:00Z');
const SAID = '2026-10-01T09:00:00Z';
let n = 0;
const C = (over) => ({ claimId: `c${++n}`, ownerId: 'u1', state: 'active', polarity: 'asserted', modality: 'fact',
  assertedAt: SAID, extractor: 'e6', confidence: { derived: 0.66 }, ...over });
const ent = (id, label) => ({ subjectEntityId: id, subject: label });
const obj = (id, label) => ({ object: { kind: 'entity', entityId: id, label } });
const lit = v => ({ object: { kind: 'literal', value: v } });

/** Meera: launch Oct 12, payment integration blocks it, Rohan owns the integration. */
function world() {
  n = 0;
  return [
    C({ ...ent('L', 'iOS launch'), predicate: 'deadline_for', ...lit('October 12') }),
    C({ ...ent('P', 'payment integration'), predicate: 'blocks', ...obj('L', 'iOS launch') }),
    C({ ...ent('R', 'Rohan'), predicate: 'owns', ...obj('P', 'payment integration') }),
  ];
}

describe('deadline dates', () => {
  test('a yearless literal resolves to its next occurrence after it was SAID, never "now"', () => {
    assert.equal(deadlineDate({ object: { kind: 'literal', value: 'May 5' }, assertedAt: '2026-04-10T00:00:00Z' }).date.toISOString().slice(0, 10), '2026-05-05');
    assert.equal(deadlineDate({ object: { kind: 'literal', value: 'May 5' }, assertedAt: '2026-06-10T00:00:00Z' }).date.toISOString().slice(0, 10), '2027-05-05');
    assert.equal(deadlineDate({ object: { kind: 'literal', value: 'January 15' }, assertedAt: '2026-10-06T00:00:00Z' }).date.toISOString().slice(0, 10), '2027-01-15');
  });
  test('"5 May" and "Sept 1st" read as day dates', () => {
    assert.equal(deadlineDate({ object: { kind: 'literal', value: 'due 5 May' }, assertedAt: '2026-04-01T00:00:00Z' }).date.toISOString().slice(0, 10), '2026-05-05');
    assert.equal(deadlineDate({ object: { kind: 'literal', value: 'Sep 1st' }, assertedAt: '2026-04-01T00:00:00Z' }).date.toISOString().slice(0, 10), '2026-09-01');
  });
  test('vague or month-only expressions are NOT given an invented day', () => {
    for (const v of ['in October', 'next spring', 'by September', 'soon']) {
      assert.equal(deadlineDate({ object: { kind: 'literal', value: v }, assertedAt: SAID }), null, v);
    }
  });
  test('a time object and an explicit year are used as stated', () => {
    assert.equal(deadlineDate({ object: { kind: 'time', from: '2026-11-03T00:00:00Z' }, assertedAt: SAID }).date.toISOString().slice(0, 10), '2026-11-03');
    assert.equal(deadlineDate({ object: { kind: 'literal', value: 'October 24, 2026' }, assertedAt: SAID }).date.toISOString().slice(0, 10), '2026-10-24');
  });
  test('daysUntil counts whole days', () => {
    assert.equal(daysUntil(new Date('2026-10-12T00:00:00Z'), NOW), 6);
  });
});

describe('triggers', () => {
  test('SCENARIO 9: a deadline within the horizon with an unresolved blocker → deadline_at_risk, owner reached through the graph', () => {
    const [t] = detectTriggers(world(), NOW);
    assert.equal(t.type, 'deadline_at_risk');
    assert.equal(t.daysLeft, 6);
    assert.equal(t.blockers[0].label, 'payment integration');
    assert.equal(t.blockers[0].owner.label, 'Rohan');
    assert.match(t.message, /iOS launch is due October 12, in 6 days, and payment integration \(owned by Rohan\) is still blocking it/);
    assert.deepEqual(new Set(t.evidenceClaimIds), new Set(['c1', 'c2', 'c3']));
  });

  test('a RESOLVED blocker (newer "fixed" status) is not a blocker', () => {
    const w = world();
    w.push(C({ ...ent('P', 'payment integration'), predicate: 'has_status', ...lit('fixed now'), assertedAt: '2026-10-03T00:00:00Z' }));
    const [t] = detectTriggers(w, NOW);
    assert.equal(t.type, 'deadline_approaching');
  });

  test('a NEGATED, superseded, intent or inferred claim is never evidence', () => {
    for (const over of [{ polarity: 'negated' }, { state: 'superseded' }, { modality: 'intent' }, { extractor: 'e9-pattern-inference' }]) {
      const w = world();
      Object.assign(w[1], over);
      assert.notEqual(detectTriggers(w, NOW)[0]?.type, 'deadline_at_risk', JSON.stringify(over));
    }
  });

  test('a "waiting on" status is a blocker; one depends_on hop reaches a delayed dependency', () => {
    n = 0;
    const w = [
      C({ ...ent('B', 'Brava rebrand'), predicate: 'deadline_for', ...lit('October 9') }),
      C({ ...ent('B', 'Brava rebrand'), predicate: 'has_status', ...lit('waiting on their final logo feedback') }),
    ];
    assert.equal(detectTriggers(w, NOW)[0].blockers[0].label, 'waiting on their final logo feedback');
    n = 0;
    const w2 = [
      C({ ...ent('R', 'release 4.2'), predicate: 'deadline_for', ...lit('October 15') }),
      C({ ...ent('R', 'release 4.2'), predicate: 'depends_on', ...obj('I', 'identity service upgrade') }),
      C({ ...ent('I', 'identity service upgrade'), predicate: 'has_status', ...lit('delayed by a security review') }),
    ];
    const [t] = detectTriggers(w2, NOW);
    assert.equal(t.type, 'deadline_at_risk');
    assert.equal(t.blockers[0].hop, 2);
  });

  test('the NEWEST deadline of a subject is the deadline (an older one is history)', () => {
    const w = world();
    w.push(C({ ...ent('L', 'iOS launch'), predicate: 'deadline_for', ...lit('January 15'), assertedAt: '2026-10-04T00:00:00Z' }));
    const [t] = detectTriggers(w, NOW);
    assert.equal(t.deadline.date, '2027-01-15');
  });

  test('a changed deadline with dependents → dependent_plan_invalidated', () => {
    n = 0;
    const old = C({ ...ent('L', 'launch'), predicate: 'deadline_for', ...lit('October 20'), state: 'superseded', supersededBy: 'c2', validTo: '2026-10-05T00:00:00Z' });
    const w = [old,
      C({ ...ent('L', 'launch'), predicate: 'deadline_for', ...lit('November 20') }),
      C({ ...ent('M', 'marketing campaign'), predicate: 'depends_on', ...obj('L', 'launch') })];
    assert.ok(detectTriggers(w, NOW).some(t => t.type === 'dependent_plan_invalidated'));
  });

  test('two disputed claims about one thing → contradiction_unresolved', () => {
    n = 0;
    const w = [C({ ...ent('B', 'budget'), predicate: 'has_property', ...lit('$20k'), state: 'disputed' }),
      C({ ...ent('B', 'budget'), predicate: 'has_property', ...lit('$35k'), state: 'disputed' })];
    assert.equal(detectTriggers(w, NOW)[0].type, 'contradiction_unresolved');
  });

  test('bounded: blockersOf never exceeds MAX hops; ownerOf picks the newest owner', () => {
    const w = world();
    w.push(C({ ...ent('K', 'Kavya'), predicate: 'owns', ...obj('P', 'payment integration'), assertedAt: '2026-09-01T00:00:00Z' }));
    assert.equal(ownerOf('P', w).label, 'Rohan');
    assert.ok(blockersOf('L', w).every(b => b.hop <= 2));
  });
});

describe('policy', () => {
  const ctxFor = (w, extra = {}) => ({ ownerId: 'u1', claimsById: new Map(w.map(c => [c.claimId, c])), history: [], prefs: {}, now: NOW, ...extra });

  test('fires a high-severity intervention for a blocked deadline 6 days out', () => {
    const w = world();
    const d = decide(detectTriggers(w, NOW)[0], ctxFor(w));
    assert.equal(d.fire, true);
    assert.equal(d.severity, 'high');
    assert.ok(d.trace.length >= 2);
  });

  test('TOO_EARLY beyond the horizon, TOO_LATE after the date', () => {
    const w = world();
    const t = detectTriggers(w, NOW)[0];
    assert.equal(decide({ ...t, daysLeft: HORIZON_DAYS + 1 }, ctxFor(w)).reason, 'too_early');
    assert.equal(decide({ ...t, daysLeft: -1 }, ctxFor(w)).reason, 'too_late');
  });

  test('REDUNDANT: the same evidence fingerprint is never recorded twice', () => {
    const w = world();
    const t = detectTriggers(w, NOW)[0];
    const d = decide(t, ctxFor(w));
    assert.equal(decide(t, ctxFor(w, { history: [{ idempotencyKey: d.idempotencyKey, cooldownKey: t.cooldownKey, createdAt: NOW, status: 'proposed', severity: 'high' }] })).reason, 'redundant');
  });

  test('COOLDOWN on the same subject; ESCALATION breaks through', () => {
    const w = world();
    const t = detectTriggers(w, NOW)[0];
    const hist = [{ idempotencyKey: 'other', cooldownKey: t.cooldownKey, createdAt: new Date(NOW - 3_600_000), status: 'proposed', severity: 'high' }];
    assert.equal(decide(t, ctxFor(w, { history: hist })).reason, 'cooldown');
    const esc = [{ ...hist[0], severity: 'medium' }];
    assert.equal(decide(t, ctxFor(w, { history: esc })).fire, true);
    const old = [{ ...hist[0], createdAt: new Date(NOW - COOLDOWN_MS - 1) }];
    assert.equal(decide(t, ctxFor(w, { history: old })).fire, true);
  });

  test('WRONG OWNER and INSUFFICIENT EVIDENCE are refused and never recorded', () => {
    const w = world();
    w[1].ownerId = 'someone-else';
    const d = decide(detectTriggers(w, NOW)[0], ctxFor(w));
    assert.equal(d.reason, 'wrong_owner');
    assert.equal(d.record, false);
    const w2 = world();
    const t2 = detectTriggers(w2, NOW)[0];
    w2[1].state = 'superseded';                 // evidence changed after detection
    assert.equal(decide(t2, ctxFor(w2)).reason, 'insufficient_evidence');
  });

  test('USER PREFERENCES: disabled, minimum severity, frequency cap, quiet hours (deferral, not suppression)', () => {
    const w = world();
    const t = detectTriggers(w, NOW)[0];
    assert.equal(decide(t, ctxFor(w, { prefs: { enabled: false } })).reason, 'user_disabled');
    assert.equal(decide({ ...t, daysLeft: 10 }, ctxFor(w, { prefs: { minSeverity: 'high' } })).reason, 'below_min_severity');
    const busy = Array.from({ length: 3 }, (_, i) => ({ idempotencyKey: `k${i}`, cooldownKey: `x${i}`, createdAt: NOW, status: 'proposed', severity: 'medium' }));
    assert.equal(decide(t, ctxFor(w, { history: busy })).reason, 'frequency_cap');
    const quiet = decide(t, ctxFor(w, { prefs: { quietStartMin: 9 * 60, quietEndMin: 12 * 60 } }));   // 10:00 UTC is inside
    assert.equal(quiet.fire, true);
    assert.equal(quiet.deliverAfter.toISOString(), '2026-10-06T12:00:00.000Z');
  });

  test('LEARNING: three dismissals of a trigger type with no acceptance mute that type; one acceptance keeps it', () => {
    const w = world();
    const t = detectTriggers(w, NOW)[0];
    const dismissals = Array.from({ length: 3 }, (_, i) => ({ triggerType: t.type, cooldownKey: `other${i}`, idempotencyKey: `d${i}`, userResponse: 'dismissed', respondedAt: new Date(NOW - 86_400_000), createdAt: new Date(NOW - 5 * 86_400_000), status: 'dismissed', severity: 'high' }));
    assert.equal(decide(t, ctxFor(w, { history: dismissals, prefs: { maxPerDay: 10 } })).reason, 'learned_dismissal');
    const withAccept = [...dismissals, { ...dismissals[0], idempotencyKey: 'a', userResponse: 'accepted' }];
    assert.equal(decide(t, ctxFor(w, { history: withAccept, prefs: { maxPerDay: 10 } })).fire, true);
  });

  test('severity mapping is deterministic', () => {
    assert.equal(assess({ type: 'deadline_at_risk', daysLeft: 3 }).severity, 'high');
    assert.equal(assess({ type: 'deadline_at_risk', daysLeft: 12 }).severity, 'medium');
    assert.equal(assess({ type: 'deadline_approaching', daysLeft: 3 }).severity, 'low');
  });
});

describe('bounded action planner (Phase 5)', () => {
  test('a blocked deadline with a known blocker owner → a DRAFT to that owner; approval required; bounded', () => {
    const w = world();
    const p = proposeAction(detectTriggers(w, NOW)[0]);
    assert.equal(p.kind, 'draft_message');
    assert.equal(p.requiresApproval, true);
    assert.ok(p.steps.length <= MAX_STEPS);
    assert.match(p.preview.body, /^Hi Rohan, quick check on payment integration/);
  });
  test('a contradiction → resolve_contradiction that NEEDS the user\'s choice', () => {
    n = 0;
    const w = [C({ ...ent('B', 'budget'), predicate: 'has_property', ...lit('$20k'), state: 'disputed' }),
      C({ ...ent('B', 'budget'), predicate: 'has_property', ...lit('$35k'), state: 'disputed' })];
    const p = proposeAction(detectTriggers(w, NOW)[0]);
    assert.equal(p.kind, 'resolve_contradiction');
    assert.equal(p.needsChoice, true);
  });
  test('nothing fits → no plan (no action is invented)', () => {
    assert.equal(proposeAction({ type: 'dependent_plan_invalidated' }), null);
  });
});
