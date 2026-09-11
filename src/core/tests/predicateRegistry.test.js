/**
 * AQUA — the predicate registry
 * Blueprint E5/PR-2
 *
 * The vocabulary of claims: controlled, so `predicate_accuracy` can be
 * non-zero at all; open, because this project has fixed the closed-allowlist
 * pathology FOUR times (classifier task verbs, goal outcome verbs,
 * self-declaration verbs, TECH_TERMS) and a fifth is not interesting.
 *
 * The design is `reasoning/typeRegistry.js`, reused rather than reinvented —
 * a second vocabulary system with different rules is how "two of everything"
 * starts.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PREDICATE_CLASS, isRegistered, getPredicate, allPredicates, predicateNames,
  registerPredicate, ensurePredicate, inverseOf, objectKindOf,
  autoRegistered, _resetForTests,
} from '../claims/predicateRegistry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

afterEach(() => {
  delete process.env.AQUA_CLAIM_STRICT_PREDICATES;
  _resetForTests();
});

// ── The seed set ─────────────────────────────────────────────────────────────

describe('predicate registry — the seed', () => {
  test('every predicate the eval dataset uses is registered', async () => {
    // If these diverged, the registry and the extraction baseline would be
    // measuring different vocabularies and `predicate_accuracy` would be
    // meaningless the moment E5/PR-3 starts writing claims.
    const { PREDICATES } = await import('../../../eval/datasets/schema.mjs');
    const missing = PREDICATES.filter(p => !isRegistered(p));
    assert.deepEqual(missing, [], 'the registry does not cover the eval dataset');
  });

  test('the predicates absent from the engine today are present here', () => {
    // decisions and tasks are named in the vision and unimplemented — the
    // extraction baseline scores them 53% on detection and 0% on predicate.
    for (const p of ['decided', 'rejected', 'plans_to', 'task_owner', 'has_status']) {
      assert.ok(isRegistered(p), `${p} is missing — E6 would have nowhere to put it`);
    }
  });

  test('every predicate has a class from the known set', () => {
    const classes = Object.values(PREDICATE_CLASS);
    for (const p of allPredicates()) {
      assert.ok(classes.includes(p.class), `${p.name} has class "${p.class}"`);
    }
  });

  test('every predicate declares which object column it expects', () => {
    // The claims table enforces exactly-one-object. This says WHICH one, so a
    // mis-shaped claim fails at write time rather than as a constraint
    // violation nobody can interpret.
    for (const p of allPredicates()) {
      assert.ok(['entity', 'literal', 'quantity', 'time'].includes(p.objectKind), p.name);
    }
  });

  test('names are sorted and unique', () => {
    const names = predicateNames();
    assert.deepEqual(names, [...names].sort());
    assert.equal(new Set(names).size, names.length);
  });
});

// ── Inverses ─────────────────────────────────────────────────────────────────

describe('predicate registry — inverses round-trip', () => {
  test('EVERY declared inverse exists and points back', () => {
    // `manages` ⇄ `reports_to`. A one-way inverse is worse than none: the
    // traversal works in one direction and silently returns nothing in the
    // other, which reads as missing data rather than a broken vocabulary.
    const broken = [];
    for (const p of allPredicates()) {
      if (!p.inverse) continue;
      const inv = getPredicate(p.inverse);
      if (!inv) { broken.push(`${p.name} → ${p.inverse} (missing)`); continue; }
      if (inv.inverse !== p.name) broken.push(`${p.name} → ${p.inverse} → ${inv.inverse}`);
    }
    assert.deepEqual(broken, []);
  });

  test('a symmetric predicate is its own inverse', () => {
    assert.equal(inverseOf('knows'), 'knows');
    assert.equal(getPredicate('knows').symmetric, true);
  });

  test('inverseOf is null for a predicate without one, not undefined', () => {
    assert.equal(inverseOf('habit_of'), null);
    assert.equal(inverseOf('no_such_predicate'), null);
  });

  test('an inverse pair agrees on object kind where both take entities', () => {
    // reports_to/manages both point at entities. A pair that disagreed would
    // make the reverse traversal produce a claim the schema refuses.
    for (const [a, b] of [['reports_to', 'manages'], ['member_of', 'has_member']]) {
      assert.equal(objectKindOf(a), objectKindOf(b), `${a}/${b} disagree`);
    }
  });
});

// ── Open, but noisily ────────────────────────────────────────────────────────

describe('predicate registry — open, and loud about it', () => {
  test('an unseen predicate is admitted', () => {
    // Closed allowlists have been the wrong answer four times in this project.
    assert.equal(isRegistered('mentors'), false);
    const p = ensurePredicate('mentors');
    assert.equal(p.name, 'mentors');
    assert.equal(p.source, 'auto');
    assert.ok(isRegistered('mentors'));
  });

  test('it is logged ONCE, not on every use', () => {
    // Silent admission would let works_at, work_at and worksat accumulate with
    // nobody noticing, and the vocabulary would stop meaning anything. Logging
    // every use would flood, and a flooding log gets filtered out.
    //
    // The once-ness comes from ensurePredicate's EARLY RETURN, not from a
    // separate Set. The first version of this module carried an `autoLogged`
    // Set copied from typeRegistry — where it is needed, because that module's
    // ensure() does not return early. Measuring bite proved it guarded nothing
    // here: mutating it changed no test because the line was already
    // unreachable. The Set is gone; this test now pins the property that
    // actually produces the behaviour.
    const seen = [];
    const original = console.log;
    console.log = (...a) => seen.push(a.join(' '));
    try {
      ensurePredicate('coaches');
      ensurePredicate('coaches');
      ensurePredicate('coaches');
    } finally { console.log = original; }
    assert.equal(seen.filter(l => l.includes('coaches')).length, 1);
  });

  test('auto-registered names are reportable — the drift list', () => {
    ensurePredicate('advises');
    ensurePredicate('sponsors');
    assert.deepEqual(autoRegistered(), ['advises', 'sponsors']);
  });

  test('a MALFORMED predicate always throws, strict mode or not', () => {
    // Not a vocabulary question. A predicate that cannot be a column value is
    // corruption, and admitting it would put unqueryable rows in the table.
    for (const bad of ['Works_At', 'works-at', '1works', 'a', '', 'x'.repeat(60), 'works at']) {
      assert.throws(() => ensurePredicate(bad), /malformed|must match/, `accepted "${bad}"`);
    }
  });
});

// ── Strict mode ──────────────────────────────────────────────────────────────

describe('predicate registry — strict mode', () => {
  test('AQUA_CLAIM_STRICT_PREDICATES=1 turns admission into a throw', () => {
    // For the eval harness and CI: a run that silently invented vocabulary
    // would report a predicate accuracy that means nothing.
    process.env.AQUA_CLAIM_STRICT_PREDICATES = '1';
    assert.throws(() => ensurePredicate('freeform'), /AQUA_CLAIM_STRICT_PREDICATES/);
    assert.equal(isRegistered('freeform'), false, 'the predicate was registered despite strict mode');
  });

  test('strict mode still allows KNOWN predicates', () => {
    process.env.AQUA_CLAIM_STRICT_PREDICATES = '1';
    assert.doesNotThrow(() => ensurePredicate('works_at'));
  });

  test('only the exact value "1" enables it', () => {
    for (const v of ['0', 'true', 'yes', 'on', '']) {
      process.env.AQUA_CLAIM_STRICT_PREDICATES = v;
      _resetForTests();
      assert.doesNotThrow(() => ensurePredicate('loose_one'), `"${v}" enabled strict mode`);
    }
  });

  test('the flag is read per call, so a test can set it without a reload', () => {
    _resetForTests();
    assert.doesNotThrow(() => ensurePredicate('before_strict'));
    process.env.AQUA_CLAIM_STRICT_PREDICATES = '1';
    assert.throws(() => ensurePredicate('after_strict'));
  });
});

// ── Explicit registration ────────────────────────────────────────────────────

describe('predicate registry — explicit registration', () => {
  test('a deliberate addition carries its metadata', () => {
    const p = registerPredicate('mentors', {
      class: PREDICATE_CLASS.RELATION, objectKind: 'entity', inverse: 'mentored_by',
    });
    assert.equal(p.class, PREDICATE_CLASS.RELATION);
    assert.equal(p.source, 'explicit');
    assert.equal(inverseOf('mentors'), 'mentored_by');
  });

  test('an unknown class or object kind is refused', () => {
    assert.throws(() => registerPredicate('x_pred', { class: 'vibes' }), /unknown class/);
    assert.throws(() => registerPredicate('y_pred', { objectKind: 'blob' }), /unknown objectKind/);
  });

  test('a malformed name is refused with the rule in the message', () => {
    assert.throws(() => registerPredicate('Bad-Name'), /lower snake_case/);
  });

  test('entries are frozen — a consumer cannot mutate the vocabulary in place', () => {
    const p = getPredicate('works_at');
    assert.throws(() => { p.class = 'hacked'; }, TypeError);
  });
});

// ── Inertness ────────────────────────────────────────────────────────────────

describe('predicate registry — who is allowed to use it', () => {
  test('every importer of the registry is a DELIBERATE entry', () => {
    // E5/PR-2 asserted nothing imported it; E5/PR-3's repository must, to
    // resolve objectKind before a write. Red battery first, then a deliberate
    // entry — the guard working exactly as intended.
    //
    // E6/PR-4 (Aug 23) is the THIRD time it fired, and the first time from
    // outside the claim layer. The STEP 0 audit recorded the claim substrate as
    // having zero non-test importers — shipped, correct, and an island, the
    // sixth instance of L12's build-but-never-called list. These two entries
    // are the beginning of that closing: the extractor has to speak the claim
    // vocabulary, and the only honest way to teach a model the vocabulary is to
    // read it from the thing that enforces it. A hand-copied predicate list in
    // the prompt is the drift this registry exists to prevent.
    //
    // Both are READERS. Neither writes a claim, and the one-writer guard in
    // claimSchema.test.js is untouched and still passing.
    const ALLOWED = ['src/core/claims/claimRepository.js', 'src/core/claims/backfill.js',
      'src/core/claims/projection.js',
      'src/brain/understanding/extractionPrompt.js',     // E6/PR-4 — generates the prompt vocabulary
      'src/brain/understanding/extractionContract.js',   // E6/PR-4 — refuses unregistered predicates
      // E6/PR-6 — S4 gate ③. Read-only: it asks isRegistered and routes an
      // unknown predicate to PROPOSE rather than registering it. That is the
      // point — ensurePredicate would auto-admit a model's invention, and
      // `enjoys_working_at` beside `works_at` splits one employment history
      // in two, permanently and invisibly.
      'src/brain/understanding/claimValidator.js',
      // E6/PR-8 — S7. Read-only: it asks getPredicate for objectKind, inverse
      // and symmetric to decide edge DIRECTION, and routes an unknown
      // predicate to the proposal queue with a usage count rather than
      // registering it. The registry is the only thing that knows works_at and
      // employs are one relationship; deciding direction from word order
      // instead would write two opposed edges for every fact stated twice.
      'src/brain/understanding/relationshipResolver.js'];
    const offenders = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'tests' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(m?js|cjs)$/.test(name)) continue;
        if (full.endsWith(path.join('claims', 'predicateRegistry.js'))) continue;
        if (/predicateRegistry/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    const undeclared = offenders.filter(f => !ALLOWED.includes(f.split(path.sep).join('/')));
    assert.deepEqual(undeclared, [], 'a new module uses the registry — make that deliberate');
  });

  test('it reuses the typeRegistry design rather than inventing a second one', () => {
    // Same four properties: seeded, auto-register-with-log, classed,
    // strict-mode pin. Divergence here would mean two vocabulary systems with
    // different rules, which is exactly the "two of everything" the audit
    // criticised.
    const src = fs.readFileSync(path.join(ROOT, 'src/core/claims/predicateRegistry.js'), 'utf8');
    for (const property of ['strictMode', 'PREDICATE_CLASS', 'source: \'seed\'']) {
      assert.ok(src.includes(property), `missing the ${property} property from typeRegistry`);
    }
  });
});

// ── An inverse forces objectKind: 'entity' ───────────────────────────────────

/**
 * 🔴 A DERIVED RULE, NOT A STYLE PREFERENCE.
 *
 * "A owns B" and "B owned_by A" are the same fact. So `owns`'s OBJECT and
 * `owned_by`'s SUBJECT are the same thing, and every subject in this system is
 * an entity. A predicate that declares an inverse therefore cannot take a
 * literal object without asserting that one thing is both an entity and not.
 *
 * Five entries violated it — `owns`, `depends_on`, `depended_on_by`, `blocks`,
 * `blocked_by` — while `owned_by` sat two lines below `owns` already declared
 * `entity`. The pair contradicted itself in adjacent lines and nothing noticed
 * for as long as the registry has existed.
 *
 * The cost was measured, not hypothetical. Every contract rejection across a
 * 525-call eval run was `object-kind-mismatch`, and the objects the extractor
 * was refused for included `owns → billing service`, `depends_on → search` and
 * `blocks → Priya` — a person, rejected for not being a literal.
 *
 * BITE, MEASURED (revert the named property → count failures):
 *   any one of the five back to 'literal'  → 1 fail
 *   the rule derived from `inverse`        → 1 fail
 */
describe('an inverse forces an entity object', () => {
  const withInverse = () => allPredicates().filter(p => p.inverse);

  test('the scan finds the inverse pairs it is supposed to find', () => {
    // A rule over an empty set passes trivially. This is the denominator.
    const names = withInverse().map(p => p.name);
    assert.ok(names.length >= 15, `only ${names.length} inverse-bearing predicates found`);
    for (const n of ['owns', 'owned_by', 'depends_on', 'blocks', 'works_at']) {
      assert.ok(names.includes(n), `scan missed ${n}`);
    }
  });

  test('EVERY predicate with an inverse takes an entity object', () => {
    const bad = withInverse()
      .filter(p => (p.objectKind ?? 'literal') !== 'entity')
      .map(p => `${p.name} (${p.objectKind ?? 'literal'}, inverse ${p.inverse})`);
    assert.deepEqual(bad, [],
      `an inverse makes the object a subject on the other side, and subjects are entities: ${bad.join(', ')}`);
  });

  test('the inverse relation is symmetric — both halves are declared', () => {
    // The rule above is only sound if `inverse` really is a two-way link. A
    // one-way declaration would let a literal-objected predicate hide as the
    // unnamed half of a pair.
    const byName = new Map(allPredicates().map(p => [p.name, p]));
    for (const p of withInverse()) {
      const other = byName.get(p.inverse);
      assert.ok(other, `${p.name} names an inverse that does not exist: ${p.inverse}`);
      assert.equal(other.inverse, p.name,
        `${p.name} ↔ ${p.inverse} is declared one way only`);
    }
  });

  test('predicates WITHOUT an inverse are untouched by this rule', () => {
    // `uses` and `task_owner` have no inverse, so nothing here says what shape
    // their objects should be — that stays an ontology decision with the owner,
    // and this test exists so a later reader does not mistake silence for
    // endorsement.
    for (const n of ['uses', 'task_owner', 'has_status', 'role_is']) {
      const p = allPredicates().find(x => x.name === n);
      assert.ok(p, `${n} is missing from the registry`);
      assert.equal(p.inverse ?? null, null, `${n} gained an inverse — re-check its objectKind`);
    }
  });
});
