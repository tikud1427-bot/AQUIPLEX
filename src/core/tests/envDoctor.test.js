/**
 * The deployment env is linted against the flag registry
 * Blueprint L13 · E4
 *
 * 🔴 THE DEFECT THIS EXISTS FOR: `AQUA_E6_SHADOW=on`.
 *
 * It sat in a production env file for months. Nothing reads it — the real gate
 * is `AQUA_E6` — so the understanding pipeline had never run, while the
 * deployment claimed it was on and every observation about E6's behaviour was
 * about a stage that was switched off.
 *
 * The flag registry cannot catch this. It compares the REGISTRY to the SOURCE
 * in both directions, and a key set in `.env` and read by nothing is absent
 * from both. The gap is between the deployment and the registry, and only
 * something that reads the env file can stand in it.
 *
 * BITE, MEASURED (revert the named property → count failures):
 *   unregistered keys reported          → 2 fail
 *   unreachable gate values reported    → 2 fail
 *   duplicate assignments reported      → 1 fail
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseEnvFile, lintEnv } from '../../../scripts/env-doctor.mjs';

const lint = text => lintEnv(parseEnvFile(text));
const errors = f => f.filter(x => x.level === 'error');

describe('env-doctor catches what the registry structurally cannot', () => {
  test('THE AQUA_E6_SHADOW CASE: a key nothing reads is an error', () => {
    const f = errors(lint('AQUA_E6_SHADOW=on\n'));
    assert.equal(f.length, 1);
    assert.equal(f[0].key, 'AQUA_E6_SHADOW');
    assert.match(f[0].message, /no source file reads this/);
  });

  test('a gate set to a value its read site never matches is an error', () => {
    // `AQUA_E6=true` is OFF. The read is `=== 'on'`, and until now nothing
    // anywhere said so — the deployment looked configured and was not.
    const f = errors(lint('AQUA_E6=true\n'));
    assert.equal(f.length, 1);
    assert.match(f[0].message, /resolves to off, the default/);
    assert.match(f[0].hint, /the value that changes behaviour is on/);
  });

  test('an INVERTED gate is judged against its own read, not a convention', () => {
    // `AQUA_BRAIN` is `!== 'off'` — on by default. Setting it to `on` changes
    // nothing and is therefore just as misleading as `AQUA_E6=true`.
    const f = errors(lint('AQUA_BRAIN=on\n'));
    assert.equal(f.length, 1, 'an inverted gate set to its default was accepted');
    assert.match(f[0].hint, /the value that changes behaviour is off/);
  });

  test('a correctly set gate is silent', () => {
    assert.deepEqual(errors(lint('AQUA_E6=on\nAQUA_BRAIN=off\n')), []);
  });

  test('a duplicate assignment is a warning naming the dead line', () => {
    // Last one wins, silently. The real env had AQUA_SELF_ENTITY twice.
    const f = lint('AQUA_SELF_ENTITY=on\nAQUA_E6=on\nAQUA_SELF_ENTITY=on\n');
    const dup = f.find(x => x.level === 'warn');
    assert.ok(dup, 'a duplicate key was not reported');
    assert.equal(dup.line, 3);
    assert.match(dup.message, /line 1 is dead/);
  });

  test('non-AQUA keys are LEFT ALONE, including credentials', () => {
    // A previous session declared a set of live API keys invalid by
    // pattern-matching their prefix, and was wrong. Shape is not validity, and
    // this tool does not guess about anything it cannot check.
    const f = lint('GEMINI_KEY_1=AQ.Ab8RN6xxxx\nGROQ_API_KEY=gsk_x\nRANDOM_THING=1\n');
    assert.deepEqual(f, []);
  });

  test('an absent registered flag is NOT a finding — absent means default', () => {
    assert.deepEqual(lint('AQUA_E6=on\n'), []);
  });

  test('the real deployment reproduces all three faults at once', () => {
    const f = lint([
      'AQUA_BRAIN_INGEST=on',
      'AQUA_SELF_ENTITY=on',
      'DATABASE_URL=postgresql://x',
      'AQUA_SELF_ENTITY=on',
      'AQUA_E6_SHADOW=on',
      'AQUA_E6=true',
    ].join('\n'));
    assert.equal(errors(f).length, 2, 'expected the unread key and the unreachable value');
    assert.equal(f.filter(x => x.level === 'warn').length, 1, 'expected the duplicate');
  });
});

describe('env-doctor parses a dotenv file the way dotenv does', () => {
  test('comments, blanks and `export` prefixes', () => {
    const e = parseEnvFile('# note\n\nexport AQUA_E6=on\n');
    assert.deepEqual(e, [{ key: 'AQUA_E6', value: 'on', line: 3 }]);
  });

  test('quoted values are unwrapped — the real env quotes MONGO_URI', () => {
    assert.equal(parseEnvFile('MONGO_URI="mongodb+srv://a:b@c/d?x=1"\n')[0].value,
      'mongodb+srv://a:b@c/d?x=1');
  });

  test('a value containing `=` survives intact', () => {
    assert.equal(parseEnvFile('DATABASE_URL=postgres://u:p@h/db?a=1&b=2\n')[0].value,
      'postgres://u:p@h/db?a=1&b=2');
  });

  test('ORDER is preserved, because duplicate detection depends on it', () => {
    const e = parseEnvFile('A=1\nB=2\nA=3\n');
    assert.deepEqual(e.map(x => x.line), [1, 2, 3]);
  });
});
