/**
 * A forget removes the forgotten value's copies from the Mind — in BOTH forget
 * flows and whatever AQUA_PROPAGATION says (2026-11-06).
 *
 * The bridged belief ("organization: Fintrail") and the graph edge self → Fintrail
 * outlived a forgotten workplace in every prompt's cognitive model until
 * propagation.js forgetValueInMind ran on forget. That cleanup is privacy, not
 * propagation, so it is unconditional: the chat-path forget ("Forget my
 * workplace.", engine.js) and the Memory-page forget (forget.js forgetFact) both
 * run it with propagation OFF (the default) and ON — and running it never turns
 * propagation on (no transition is recorded, the sweeper does not start).
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-forget-mind-'));
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
  if (/(_API_KEY|^GEMINI_KEY|^SERPER|^TAVILY)/.test(k)) delete process.env[k];
}
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
process.env.AQUA_BRAIN_INGEST = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS = 'on';

const engine = await import('../engine.js');
const Brain = await import('../../brain/index.js');
const P = await import('../propagation.js');
const { forgetFact } = await import('../forget.js');
const { peekMind } = await import('../../mind/mindStore.js');

let clock = Date.UTC(2026, 9, 1);
const realNow = Date.now;
Date.now = () => clock;
process.on('exit', () => { Date.now = realNow; });
afterEach(() => { delete process.env.AQUA_PROPAGATION; P.stopPropagationSweeper(); });

let turn = 0, n = 0;
async function say(owner, text) {
  clock += 60_000; turn++;
  engine.memoryObserve(owner, { userMessage: text, conversationId: `${owner}-c`, userId: owner, requestId: `r${turn}`, extractMessage: text });
  engine.memoryAfterTurn(owner, {});
  await Brain.observeConversationTurn({ ownerId: owner, conversationId: `${owner}-c`, turn, userMessage: text, assistantMessage: '' });
  await new Promise(r => setTimeout(r, 30));
}
const org = m => Object.values(m?.beliefs ?? {}).find(b => b.key === 'organization' && /fintrail/i.test(String(b.value)));
const edge = m => Object.values(m?.graph?.edges ?? {}).find(e => e.from === 'person:__self__' && /fintrail/i.test(m.graph.nodes[e.to]?.label ?? ''));
const transitions = m => Object.values(m?.facts ?? {}).flatMap(f => (f.transitions ?? []).filter(t => t.id));

async function withCopies() {
  const owner = `user:forget-mind-${++n}`;
  await say(owner, "I'm a data analyst at Fintrail.");
  const m = peekMind(owner);
  assert.ok(m?.facts?.workplace, 'control: the workplace fact is stored');
  assert.ok(org(m), 'control: the organization belief holds Fintrail');
  assert.ok(edge(m), 'control: the graph edge self → Fintrail exists');
  return owner;
}

for (const flag of ['unset', 'on']) {
  describe(`AQUA_PROPAGATION ${flag}`, () => {
    const set = () => { if (flag === 'on') process.env.AQUA_PROPAGATION = 'on'; else delete process.env.AQUA_PROPAGATION; };

    test('chat-path forget ("Forget my workplace.") removes the Mind copies', async () => {
      set();
      const owner = await withCopies();
      await say(owner, 'Forget my workplace.');
      const m = peekMind(owner);
      assert.equal(m.facts.workplace, undefined, 'the fact itself is forgotten');
      assert.equal(org(m), undefined, 'the organization belief is gone');
      assert.equal(edge(m), undefined, 'the graph edge is gone');
    });

    test('Memory-page forget (forgetFact) removes the Mind copies', async () => {
      set();
      const owner = await withCopies();
      await forgetFact(owner, 'workplace');
      const m = peekMind(owner);
      assert.equal(m.facts.workplace, undefined);
      assert.equal(org(m), undefined);
      assert.equal(edge(m), undefined);
    });

    if (flag === 'unset') {
      test('the cleanup does not activate propagation', async () => {
        const owner = await withCopies();
        await say(owner, 'Forget my workplace.');
        await forgetFact(owner, 'workplace');
        assert.equal(process.env.AQUA_PROPAGATION, undefined, 'the variable is never set');
        assert.equal(P.propagationEnabled(), false);
        assert.deepEqual(transitions(peekMind(owner)), [], 'no transition recorded');
        assert.equal(P.startPropagationSweeper({ intervalMs: 3_600_000, firstAfterMs: 3_600_000 }), false, 'the sweeper still does not start');
      });
    }
  });
}
