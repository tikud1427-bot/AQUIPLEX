/**
 * Child process for unifiedChangeLifecycle.test.js: a real process that lives
 * one change and dies at a named point, and a fresh process that recovers from
 * the same data directory. Prints one JSON line.
 *
 *   node changeLifecycleChild.mjs <dataDir> crash <owner> <crashPoint>
 *   node changeLifecycleChild.mjs <dataDir> recover <owner>
 *   node changeLifecycleChild.mjs <dataDir> sweep <owner>     (concurrent sweepers)
 */
const [dataDir, mode, owner, crashPoint] = process.argv.slice(2);
process.env.AQUA_DATA_DIR = dataDir;
for (const k of Object.keys(process.env)) if (k.startsWith('AQUA_') && k !== 'AQUA_DATA_DIR') delete process.env[k];
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';
delete process.env.DATABASE_URL;
process.env.AQUA_BRAIN_INGEST = 'on';
process.env.AQUA_BRAIN_INGEST_FACTS = 'on';
process.env.AQUA_PROPAGATION = 'on';   // OFF by default (2026-11-06): the crash-recovery child runs the enabled path
for (const k of ['log', 'info', 'warn']) console[k] = () => {};

const engine = await import('../../engine.js');
const Brain = await import('../../../brain/index.js');
const ES = await import('../../../files/evidenceStore.js');
const P = await import('../../propagation.js');
const { peekMind, flushMind } = await import('../../../mind/mindStore.js');

let clock = Date.UTC(2026, 8, 1);
Date.now = () => clock;
let turn = 0;
async function say(text) {
  clock += 60_000; turn++;
  engine.memoryObserve(owner, { userMessage: text, conversationId: `${owner}-c`, userId: owner, requestId: `r${turn}`, extractMessage: text });
  await Brain.observeConversationTurn({ ownerId: owner, conversationId: `${owner}-c`, turn, userMessage: text, assistantMessage: '' });
}
const OLD = "I'm a data analyst at Fintrail.";
const state = () => {
  const m = peekMind(owner);
  const ts = Object.values(m?.facts ?? {}).flatMap(f => f.transitions ?? []).filter(t => t.id);
  const s = ES.listFacts(owner, { limit: 1000 });
  return {
    workplace: m?.facts?.workplace?.value ?? null,
    transitions: ts.length,
    stamped: ts.filter(t => t.pic).length,
    oldArchived: s.find(x => x.statement === OLD)?.archived === true,
    reviews: s.filter(x => x.review).length,
    reviewed: s.filter(x => x.review).map(x => x.id),
    history: m?.facts?.workplace?.history?.length ?? 0,
    pending: P.propagationStatus(owner).evidencePending.length,
  };
};

if (mode === 'crash') {
  for (const t of [OLD, 'My goal is to get promoted to senior analyst at Fintrail.', "I'm leading the Atlas migration at Fintrail; it's due on March 3."]) await say(t);
  flushMind(owner); ES.flushEvidence();                  // the first week is safely on disk
  clock += 7 * 86_400_000;
  process.env.AQUA_PROPAGATION_CRASH_AT = crashPoint;    // the evidence step dies here
  await say('I now work at Northbeam as a senior analyst.');
  await new Promise(r => setTimeout(r, 200));
  process.stdout.write(`${JSON.stringify({ survived: true, ...state() })}\n`);
  process.exit(0);
}
clock = Date.UTC(2026, 9, 1);
const before = state();
const r = await P.sweepOnce({ owners: [owner] });
flushMind(owner); ES.flushEvidence();
process.stdout.write(`${JSON.stringify({ before, sweep: r, after: state() })}\n`);
process.exit(0);
