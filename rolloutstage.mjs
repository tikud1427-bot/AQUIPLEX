/**
 * One rollout stage, measured. Run by rollout.mjs, one child process per stage
 * because several flags are read at module load and every store is a
 * module-level singleton — measuring stages in one process would measure
 * whatever the previous stage left behind.
 *
 * Usage: node rolloutstage.mjs <stageName> <flag=on,flag=on,...>
 */
import { rmSync } from 'node:fs';

const [, , stage, flagSpec = ''] = process.argv;
const dir = `/tmp/rollout-${stage}`;
rmSync(dir, { recursive: true, force: true });

process.env.AQUA_DATA_DIR = dir;
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
for (const pair of flagSpec.split(',').filter(Boolean)) {
  const [k, v] = pair.split('=');
  process.env[k] = v;
}

const Brain = await import('./src/brain/index.js');
const mem   = await import('./src/memory/engine.js');
const pic   = await import('./src/pic/core.js');
const mv    = await import('./src/understanding/mindView.js');
const cov   = await import('./src/understanding/coverage.js');
const ES    = await import('./src/files/evidenceStore.js');

const O = 'user:rollout';

// One realistic session. Deliberately mixed: self-disclosure, situation with no
// proper nouns, a goal, a correction, and two ordinary working turns — the last
// two matter because a rollout that improves understanding while degrading
// normal chat is not an improvement.
const SESSION = [
  "I'm Maya. I run product at Nummo, a fintech in Bangalore.",
  'My co-founder Dev runs engineering.',
  'our biggest problem right now is churn in the first 30 days',
  'Razorpay is our main competitor',
  'I want to hit 10,000 active merchants by December.',
  'I usually do deep work in the mornings',
  'can you help me debug this auth middleware',
  'the error is a 401 after the token refresh',
];

const ASK = [
  ['Where do I work now?',            'nummo|bangalore'],
  ['Who is my co-founder?',           'dev'],
  ['What is our biggest problem?',    'churn'],
  ['Who is our competitor?',          'razorpay'],
  ['When do I do deep work?',         'morning'],
  ['Which city am I in?',             'bangalore'],
];

// Queries that are NOT about the user. Context arriving here is noise, and the
// cost side of every flag below.
const NOISE = [
  'explain how OAuth works',
  'what is the capital of France',
  'can you write me a python script',
  'I need to fix this bug in my code',
];

let memFacts = 0;
let turn = 0;
for (const t of SESSION) {
  const r = mem.memoryObserve(O, {
    userMessage: t, taskType: 'personal_info', conversationId: 'c1',
    userId: 'rollout', requestId: 'r',
  });
  memFacts += r.extractedFacts.length;
  await Brain.observeConversationTurn({
    ownerId: O, conversationId: 'c1', turn: turn++,
    userMessage: t, assistantMessage: 'Got it.',
  });
}

// Reflection twice, as the cadence would: the first establishes a baseline, the
// second is the one that can produce a real delta.
Brain.reflectTurn(O);
Brain.reflectTurn(O);

const worldFacts = (() => { try { return ES.listFacts(O, { limit: 200 }).length; } catch { return 0; } })();

let top1 = 0;
for (const [q, want] of ASK) {
  const k = pic.retrieveKnowledge(O, q, { limit: 6 });
  const lines = (k.block || '').split('\n').filter(l => l.trim().startsWith('•'));
  if (lines.length && want.split('|').some(w => lines[0].toLowerCase().includes(w))) top1 += 1;
}

let noiseLines = 0;
for (const q of NOISE) {
  const k = pic.retrieveKnowledge(O, q, { limit: 8 });
  noiseLines += (k.block || '').split('\n').filter(l => l.trim().startsWith('•')).length;
}

const beliefs = (() => { try { return mv.beliefsForCoverage(O); } catch { return {}; } })();
const goals   = (() => { try { return mv.goalsForCoverage(O); } catch { return []; } })();
const score   = (() => { try { return cov.understandingScore({ beliefsByDimension: beliefs, goals }); } catch { return 0; } })();
const beliefCount = Object.values(beliefs).reduce((n, l) => n + (l?.length ?? 0), 0);

// Would AQUA say anything unprompted on the next conversational turn?
const voice = (() => {
  try { return Brain.revisionDirectiveFor(O, { taskType: 'conversation' }) ? 'yes' : 'no'; }
  catch { return 'no'; }
})();

console.log(`__RESULT__${JSON.stringify({
  stage, memFacts, worldFacts, beliefs: beliefCount, goals: goals.length,
  score, top1: `${top1}/${ASK.length}`, noiseLines, voice,
})}`);
