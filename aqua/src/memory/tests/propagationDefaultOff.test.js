/**
 * Change propagation is OFF by default (2026-11-06).
 *
 * memory/propagation.js records fact transitions, reconciles the Mind / profile
 * / evidence lane and runs a startup sweeper. It used to be ON unless
 * AQUA_PROPAGATION=off; now it runs only when the variable is exactly "on"
 * (case-insensitive, trimmed). These tests pin:
 *   · the gate itself (unset / empty / other values → off; "on" → on);
 *   · the sweeper never starts, and a sweep does nothing, when off;
 *   · AQUA_PROPAGATION_CRASH_AT has no effect when propagation is off;
 *   · a real turn with a fact change records nothing and flags nothing by default;
 *   · no production source turns it on implicitly.
 * The enabled behaviour is tested by the propagation suites themselves
 * (oneChangeEveryStore, unifiedChangeLifecycle, goalTargetReached, …), which
 * set AQUA_PROPAGATION=on explicitly.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-propagation-off-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
process.env.AQUA_BRAIN_INGEST = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS = 'on';

const P = await import('../propagation.js');
const engine = await import('../engine.js');
const Brain = await import('../../brain/index.js');
const ES = await import('../../files/evidenceStore.js');
const { peekMind } = await import('../../mind/mindStore.js');
const { GATES, SETTINGS } = await import('../../core/flags.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AQUA = path.resolve(HERE, '../../..');

afterEach(() => { delete process.env.AQUA_PROPAGATION; delete process.env.AQUA_PROPAGATION_CRASH_AT; P.stopPropagationSweeper(); });

// An ASSIGNMENT to the variable in code (comments and docs that name it do not count).
const SETS_IT = /process\.env\.AQUA_PROPAGATION\s*(=(?!=)|\?\?=|\|\|=)|process\.env\[\s*['"]AQUA_PROPAGATION['"]\s*\]\s*(=(?!=)|\?\?=|\|\|=)/;

describe('the gate', () => {
  test('unset, empty and every value other than "on" mean OFF', () => {
    delete process.env.AQUA_PROPAGATION;
    assert.equal(P.propagationEnabled(), false, 'unset');
    for (const v of ['', ' ', 'off', 'true', '1', 'yes', 'enabled', 'onn', 'no']) {
      process.env.AQUA_PROPAGATION = v;
      assert.equal(P.propagationEnabled(), false, JSON.stringify(v));
    }
  });
  test('exactly "on" (case-insensitive, trimmed) means ON', () => {
    for (const v of ['on', 'ON', ' On ']) {
      process.env.AQUA_PROPAGATION = v;
      assert.equal(P.propagationEnabled(), true, JSON.stringify(v));
    }
  });
  test('the registry records it as an OFF-by-default gate, and the crash seam as a setting', () => {
    const g = GATES.find(x => x.name === 'AQUA_PROPAGATION');
    assert.equal(g?.dflt, 'off');
    assert.equal(g?.inverted, undefined);
    const s = SETTINGS.find(x => x.name === 'AQUA_PROPAGATION_CRASH_AT');
    assert.match(s?.note ?? '', /TEST SEAM ONLY/);
  });
});

describe('the startup sweeper', () => {
  test('does not start when propagation is off (default)', () => {
    assert.equal(P.startPropagationSweeper({ intervalMs: 3_600_000, firstAfterMs: 3_600_000 }), false);
  });
  test('a sweep does nothing when off — even called directly', async () => {
    const r = await P.sweepOnce({ owners: ['user:nobody'] });
    assert.equal(r.disabled, true);
    assert.equal(r.owners, 0);
  });
  test('starts only when AQUA_PROPAGATION=on (and stops)', () => {
    process.env.AQUA_PROPAGATION = 'on';
    assert.equal(P.startPropagationSweeper({ intervalMs: 3_600_000, firstAfterMs: 3_600_000 }), true);
    assert.equal(P.startPropagationSweeper({ intervalMs: 3_600_000, firstAfterMs: 3_600_000 }), false, 'never twice');
    P.stopPropagationSweeper();
  });
  test('the server starts it only through that gated call', () => {
    const router = fs.readFileSync(path.join(AQUA, 'router.js'), 'utf8');
    assert.match(router, /startPropagationSweeper\(\)/);
    assert.doesNotMatch(router, /sweepOnce\(/);
    assert.doesNotMatch(router, SETS_IT);
  });
});

describe('nothing runs by default', () => {
  test('AQUA_PROPAGATION_CRASH_AT has no effect while propagation is off', async () => {
    process.env.AQUA_PROPAGATION_CRASH_AT = 'after-mind-flush';   // a real crash point: exit(70) inside an ENABLED evidence step
    const r = await P.propagateToEvidence('user:crash-seam-off');
    assert.equal(r.retired ?? 0, 0);   // still alive: the step never ran
  });

  test('a real turn that changes a fact records no transition, flags nothing, touches no evidence (default env)', async () => {
    delete process.env.AQUA_PROPAGATION;
    let clock = Date.UTC(2026, 8, 1); const realNow = Date.now; Date.now = () => clock;
    try {
      const owner = 'user:propagation-default-off';
      let turn = 0;
      const say = async text => {
        clock += 60_000; turn++;
        engine.memoryObserve(owner, { userMessage: text, conversationId: `${owner}-c`, userId: owner, requestId: `r${turn}`, extractMessage: text });
        engine.memoryAfterTurn(owner, {});
        await Brain.observeConversationTurn({ ownerId: owner, conversationId: `${owner}-c`, turn, userMessage: text, assistantMessage: '' });
        await new Promise(r => setTimeout(r, 30));
      };
      for (const t of ["I'm a data analyst at Fintrail.", 'My goal is to get promoted to senior analyst at Fintrail.']) await say(t);
      clock += 7 * 86_400_000;
      await say('I now work at Northbeam as a senior analyst.');
      await new Promise(r => setTimeout(r, 50));
      const m = peekMind(owner);
      assert.ok(m?.facts?.workplace, 'control: the fact itself is stored');
      assert.ok(!(m.facts.workplace.transitions ?? []).some(t => t.id), 'no transition recorded');
      assert.ok(Object.values(m.goals ?? {}).every(g => g.review === undefined), 'no goal flagged for review');
      assert.ok(!Object.values(m.graph?.edges ?? {}).some(e => e.endedAt), 'no graph edge ended');
      assert.ok(ES.listFacts(owner, { limit: 1000 }).every(f => !f.review && !f.retiredBy), 'evidence lane untouched');
    } finally { Date.now = realNow; }
  });

  test('no production source turns propagation on implicitly', () => {
    const offenders = [];
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!/^(tests|node_modules|fixtures)$/.test(e.name)) walk(p); continue; }
        if (!/\.(m?js|cjs)$/.test(e.name) || /\.test\./.test(e.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (SETS_IT.test(src)) offenders.push(path.relative(AQUA, p));
      }
    };
    walk(path.join(AQUA, 'src'));
    for (const f of ['router.js', '../index.js']) { const p = path.join(AQUA, f); if (fs.existsSync(p) && SETS_IT.test(fs.readFileSync(p, 'utf8'))) offenders.push(f); }
    assert.deepEqual(offenders, []);
  });
});
