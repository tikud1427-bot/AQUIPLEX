/**
 * E6/PR-7 — temporal normalisation (S5).
 *
 * Three rules from the blueprint, and one prohibition that outweighs all of
 * them: NEVER INVENT A DATE. A claim wrongly stamped "now" outranks every
 * correctly-dated claim in a recency-ordered read, and the row looks like a
 * confident recent fact rather than an unanchored one. Most of this file
 * exists to prove that does not happen.
 *
 * Run: node --test src/brain/tests/temporalNormaliser.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseTemporal, applyTemporal, tenseOf, PRECISION } from '../understanding/temporalNormaliser.js';

/** A fixed anchor. Nothing here may depend on the wall clock. */
const SAID = '2026-08-24T10:00:00.000Z';
const day = s => (s === null ? null : s.slice(0, 10));

const at = (text, asserted = SAID) => normaliseTemporal(text, asserted);

describe('S5 — absolute expressions', () => {
  const cases = [
    ['2026-07-15',   '2026-07-15', '2026-07-15', 'day'],
    ['July 2026',    '2026-07-01', '2026-07-31', 'month'],
    ['5 July 2026',  '2026-07-05', '2026-07-05', 'day'],
    ['July 5, 2026', '2026-07-05', '2026-07-05', 'day'],
    ['Q3 2026',      '2026-07-01', '2026-09-30', 'quarter'],
    ['in 2024',      '2024-01-01', '2024-12-31', 'year'],
  ];
  for (const [text, from, to, precision] of cases) {
    test(`${text} → ${from}..${to} (${precision})`, () => {
      const r = at(text);
      assert.equal(day(r.validFrom), from);
      assert.equal(day(r.validTo), to);
      assert.equal(r.precision, precision);
    });
  }

  test('"since 2024" is OPEN-ENDED — a start is not an end', () => {
    const r = at('since 2024');
    assert.equal(day(r.validFrom), '2024-01-01');
    assert.equal(r.validTo, null, 'closing this range would assert the state ended in 2024');
  });

  test('absolute expressions do not need an anchor', () => {
    // A re-ingested five-year-old export has no useful asserted_at, and an
    // ISO date does not care.
    const r = normaliseTemporal('2026-07-15', null);
    assert.equal(day(r.validFrom), '2026-07-15');
  });
});

describe('S5 — relative expressions resolve against asserted_at', () => {
  const cases = [
    ['yesterday',    '2026-08-23', '2026-08-23', 'day'],
    ['today',        '2026-08-24', '2026-08-24', 'day'],
    ['tomorrow',     '2026-08-25', '2026-08-25', 'day'],
    ['last month',   '2026-07-01', '2026-07-31', 'month'],
    ['next month',   '2026-09-01', '2026-09-30', 'month'],
    ['this quarter', '2026-07-01', '2026-09-30', 'quarter'],
    ['last year',    '2025-01-01', '2025-12-31', 'year'],
    ['3 weeks ago',  '2026-08-03', '2026-08-09', 'day'],
    ['a month ago',  '2026-07-01', '2026-07-31', 'month'],
  ];
  for (const [text, from, to, precision] of cases) {
    test(`${text} → ${from}..${to} (${precision})`, () => {
      const r = at(text);
      assert.equal(day(r.validFrom), from, text);
      assert.equal(day(r.validTo), to, text);
      assert.equal(r.precision, precision, text);
    });
  }

  test('JANUARY: "last month" crosses the year boundary', () => {
    // The classic off-by-one-year in this code. December of the PREVIOUS year,
    // not December of the same one.
    const jan = '2026-01-15T00:00:00.000Z';
    const r = normaliseTemporal('last month', jan);
    assert.equal(day(r.validFrom), '2025-12-01');
    assert.equal(day(r.validTo), '2025-12-31');
  });

  test('JANUARY: "last quarter" is Q4 of the previous year', () => {
    const r = normaliseTemporal('last quarter', '2026-01-15T00:00:00.000Z');
    assert.equal(day(r.validFrom), '2025-10-01');
    assert.equal(day(r.validTo), '2025-12-31');
  });

  test('DECEMBER: "next month" crosses forward', () => {
    const r = normaliseTemporal('next month', '2026-12-15T00:00:00.000Z');
    assert.equal(day(r.validFrom), '2027-01-01');
    assert.equal(day(r.validTo), '2027-01-31');
  });

  test('a LEAP-YEAR February ends on the 29th', () => {
    const r = normaliseTemporal('last month', '2028-03-10T00:00:00.000Z');
    assert.equal(day(r.validTo), '2028-02-29', 'month ends are computed, not tabulated');
  });
});

describe('S5 — it never invents a date', () => {
  test('a relative expression with NO anchor is unresolved, not guessed', () => {
    // Guessing from the process clock would date a re-ingested five-year-old
    // export to today, and nothing downstream could tell.
    const r = normaliseTemporal('last month', null);
    assert.equal(r.validFrom, null);
    assert.equal(r.validTo, null);
    assert.equal(r.precision, 'relative');
    assert.equal(r.reason, 'relative-without-asserted-at');
    assert.equal(r.quote, 'last month', 'the quote is KEPT — rule three');
  });

  test('an invalid anchor is treated as no anchor', () => {
    for (const bad of ['not-a-date', NaN, {}]) {
      const r = normaliseTemporal('last month', bad);
      assert.equal(r.validFrom, null, String(bad));
      assert.equal(r.precision, 'relative');
    }
  });

  test('an IMPOSSIBLE date is refused, not rolled over', () => {
    // 2026-02-30 becomes March 2nd if you let Date normalise it — a fact about
    // a different month, stored with day precision and full confidence.
    const r = at('2026-02-30');
    assert.equal(r.validFrom, null);
    assert.equal(r.precision, 'relative');
    assert.equal(r.reason, 'impossible-date');
  });

  test('NO temporal expression is `none`, not `relative`', () => {
    // Two different facts about the world. `none` = this claim is timeless;
    // `relative` = it has a time we failed to place. Collapsing them hides a
    // parser gap as a property of the data.
    const r = at('I run product at Nummo');
    assert.equal(r.precision, 'none');
    assert.equal(r.reason, 'no-temporal-expression');
    assert.equal(r.validFrom, null);
  });

  test('empty input yields nothing and does not throw', () => {
    for (const bad of ['', '   ', null, undefined, 42]) {
      const r = normaliseTemporal(bad, SAID);
      assert.equal(r.validFrom, null);
      assert.ok(['none', 'relative'].includes(r.precision));
    }
  });

  test('every precision returned is in the schema CHECK', () => {
    for (const text of ['2026-07-15', 'July 2026', 'Q3 2026', 'in 2024', 'last month',
      'nothing here', '2026-02-30']) {
      assert.ok(PRECISION.includes(at(text).precision), text);
    }
  });
});

describe('S5 — the range never violates the schema CHECK', () => {
  test('valid_to >= valid_from, always', () => {
    // aqua_claims_validity_ck. A violation here is a database error at write
    // time, thrown from a stack that says nothing about temporal parsing.
    for (const text of ['2026-07-15', 'July 2026', 'Q3 2026', 'in 2024', 'last month',
      'next month', 'this quarter', 'last year', '3 weeks ago', 'a month ago',
      'yesterday', 'today', 'tomorrow']) {
      const r = at(text);
      if (r.validFrom && r.validTo) {
        assert.ok(new Date(r.validTo) >= new Date(r.validFrom),
          `${text}: ${r.validFrom} .. ${r.validTo}`);
      }
    }
  });

  test('bounds are ISO strings or null — never Date objects or numbers', () => {
    const r = at('last month');
    assert.equal(typeof r.validFrom, 'string');
    assert.match(r.validFrom, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('S5 — tense sets default validity', () => {
  test('past tense is recognised', () => {
    for (const t of ['I left Intercom last month', 'we shipped it yesterday', 'I used to work there']) {
      assert.equal(tenseOf(t), 'past', t);
    }
  });

  test('present tense is recognised', () => {
    for (const t of ['I work at Nummo', 'she is the CTO', 'I currently run product']) {
      assert.equal(tenseOf(t), 'present', t);
    }
  });

  test('PAST WINS A TIE, deliberately', () => {
    // "I used to work at X and now work at Y" describes a CLOSED period for X.
    // Reading it as present would leave both employers open, which is two
    // overlapping current jobs — the superseded-at-20% failure manufactured at
    // ingest. A wrongly-closed range is recoverable from the quote; two open
    // ones are a contradiction nobody asked for.
    assert.equal(tenseOf('I used to work at Intercom and now work at Nummo'), 'past');
  });

  test('PRESENT tense OPENS the end of a range', () => {
    const r = applyTemporal({ statementText: 'I have worked here since 2024' }, SAID);
    assert.equal(day(r.validFrom), '2024-01-01');
    assert.equal(r.validTo, null, 'still true → open');
  });

  test('PAST tense KEEPS the range closed', () => {
    const r = applyTemporal({ statementText: 'I left Intercom last month' }, SAID);
    assert.equal(day(r.validFrom), '2026-07-01');
    assert.equal(day(r.validTo), '2026-07-31');
  });

  test('tense NEVER creates a range where there was none', () => {
    // "I work at Nummo" has no temporal expression. Present tense must not
    // invent a start of "now" — that is the invented-date failure wearing a
    // grammatical disguise.
    const r = applyTemporal({ statementText: 'I work at Nummo' }, SAID);
    assert.equal(r.validFrom, null);
    assert.equal(r.validTo, null);
    assert.equal(r.timePrecision, 'none');
  });

  test('applyTemporal distinguishes an EXPRESSION-opened range from a TENSE-opened one', () => {
    // Both end in null, and a later reader cannot tell them apart from the
    // null alone. The first draft of this test asserted openedByTense on
    // "since 2024" and was wrong: "since" opens the range itself, so the tense
    // had nothing left to do. The distinction is the useful part.
    const byExpression = applyTemporal({ statementText: 'I have worked here since 2024' }, SAID);
    assert.equal(byExpression.validTo, null);
    assert.equal(byExpression.temporal.openedByTense, false, '"since" did the opening');
    assert.equal(byExpression.temporal.reason, 'since-year');

    const byTense = applyTemporal({ statementText: 'I have worked here since last year' }, SAID);
    assert.equal(byTense.validTo, null);
    assert.equal(byTense.temporal.openedByTense, true,
      '"last year" is a CLOSED range and present tense opened it');

    const closed = applyTemporal({ statementText: 'I left Intercom last month' }, SAID);
    assert.equal(closed.temporal.openedByTense, false);
    assert.ok(closed.validTo, 'past tense keeps the end');
  });

  test('KNOWN LIMITATION: a past-tense verb beats an explicit "still"', () => {
    // "I still work at Nummo, joined in 2024" reads as past because `joined`
    // matches, and past wins ties — so the range closes at end-of-2024 even
    // though "still" says the state persists.
    //
    // NOT FIXED HERE, deliberately. A "still" override is a one-word change
    // and would probably be right, but there is no temporal eval corpus to
    // measure it against, and adding tie-breakers by intuition is how a
    // rule-set becomes unfalsifiable. Pinned so the behaviour is a decision
    // rather than a surprise, and so a future fix is a visible event.
    const r = applyTemporal({ statementText: 'I still work at Nummo, joined in 2024' }, SAID);
    assert.equal(r.temporal.tense, 'past');
    assert.equal(day(r.validTo), '2024-12-31',
      'INVERT THIS TEST when continuity markers are measured and given priority');
  });

  test('applyTemporal preserves the rest of the claim', () => {
    const claim = { subject: 'self', predicate: 'works_at', object: { entity: 'Nummo' },
      statementText: 'I left Intercom last month' };
    const r = applyTemporal(claim, SAID);
    assert.equal(r.subject, 'self');
    assert.equal(r.predicate, 'works_at');
    assert.deepEqual(r.object, { entity: 'Nummo' });
  });
});

describe('S5 — determinism', () => {
  test('same input, same output — no wall-clock dependency anywhere', () => {
    // A module that reads Date.now() would give different answers on different
    // days, and the eval would drift without anyone changing code.
    const a = at('last month'), b = at('last month');
    assert.deepEqual(a, b);
    const c = normaliseTemporal('I work at Nummo', null);
    assert.deepEqual(c, normaliseTemporal('I work at Nummo', null));
  });
});
