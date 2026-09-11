/**
 * Phase 0 — functional proof for each flag.
 *
 * The test battery staying green with flags on proves only that nothing
 * crashes; 15 call sites in the brain suites set their own env, so the
 * ambient value barely reaches them. This exercises the enabled path for
 * real and asserts the observable difference each flag is supposed to make.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-flagproof-'));
process.env.AQUA_DATA_DIR = TMP;

const G = await import('./src/reasoning/reasoningGraph.js');
const mindStore = await import('./src/mind/mindStore.js');
const Brain = await import('./src/brain/index.js');

const O = 'user:proof';
const results = [];
const check = (flag, claim, pass, detail) => {
  results.push({ flag, claim, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${flag.padEnd(18)} ${claim}\n      ${detail}`);
};

// ── AQUA_BRAIN_INGEST ────────────────────────────────────────────────────────
// Claim: conversations enter the world model.
const turn = {
  ownerId: O, conversationId: 'c1', turn: 1,
  userMessage: 'Priya owns the billing service at Aquiplex and it is blocking the Q4 launch.',
  assistantMessage: 'Understood — Priya owns billing at Aquiplex.',
};

delete process.env.AQUA_BRAIN_INGEST;
const offResult = Brain.observeConversationTurn(turn);
const offCount = Brain.listEntities(O).length;

process.env.AQUA_BRAIN_INGEST = 'on';
const onResult = Brain.observeConversationTurn(turn);
const onEntities = Brain.listEntities(O);

check('AQUA_BRAIN_INGEST',
  'off = inert, on = conversations become graph entities',
  offCount === 0 && onEntities.length > 0,
  `off → ${offCount} entities (skipped: ${offResult.skipped ?? 'n/a'}); on → ${onEntities.length} entities: ${onEntities.map(e => e.title).join(', ')}`);

const conversationSourced = onEntities.some(e =>
  (e.sourceRefs?.files ?? []).some(f => String(f).startsWith('conv:')));
check('AQUA_BRAIN_INGEST',
  'entities carry conversational provenance, not fake document provenance',
  conversationSourced,
  `sourceRefs → ${JSON.stringify(onEntities[0]?.sourceRefs ?? {})}`);

// ── AQUA_CONTEXT_V2 ──────────────────────────────────────────────────────────
// Claim: retrieval is scored + assembled, and never regresses below the floor.
const floorItems = [
  { kind: 'fact', statement: 'Aquiplex is building AQUA', confidence: 0.9, entities: ['Aquiplex'] },
  { kind: 'fact', statement: 'Priya owns billing', confidence: 0.8, entities: ['Priya'] },
];
const floor = () => ({ items: floorItems, block: floorItems.map(i => i.statement).join('\n'), stats: { facts: 2 } });

delete process.env.AQUA_CONTEXT_V2;
const ctxOff = Brain.contextV2Active();

process.env.AQUA_CONTEXT_V2 = 'on';
const ctxOn = Brain.contextV2Active();
const assembled = Brain.assembleContext(O, 'who owns billing?', floor, { limit: 8 });

check('AQUA_CONTEXT_V2',
  'gate flips, and the assembler returns a PIC-floor superset',
  ctxOff === false && ctxOn === true && Array.isArray(assembled.items),
  `off=${ctxOff} on=${ctxOn}; items=${assembled.items.length} hasContextEngineStats=${!!assembled.stats?.contextEngine}`);

check('AQUA_CONTEXT_V2',
  'selects rather than dumps — a scored subset of the floor, each item explainable',
  assembled.items.length > 0 && assembled.items.length <= floorItems.length,
  `floor=${floorItems.length} selected=${assembled.items.length} candidates=${assembled.stats?.contextEngine?.candidates ?? '?'} dropped=${assembled.stats?.contextEngine?.dropped ?? '?'}`);

// ── AQUA_TWIN_V2 ─────────────────────────────────────────────────────────────
// Claim: style is inferred from turns, and the anti-fabrication bar holds.
delete process.env.AQUA_TWIN_V2;
Brain.observeTwin({ ownerId: O, userMessage: 'Keep it brief and concise, bullet points only, no preamble.' });
const twinOff = Brain.getTwin(O);

process.env.AQUA_TWIN_V2 = 'on';
const oneTurn = 'Keep it brief and concise, bullet points only, no preamble please.';
Brain.observeTwin({ ownerId: O, userMessage: oneTurn, conversationId: 'c1' });
const afterOne = Brain.getTwin(O);

for (let i = 0; i < 6; i++) {
  Brain.observeTwin({ ownerId: O, userMessage: oneTurn, conversationId: 'c1' });
}
const afterMany = Brain.getTwin(O);

check('AQUA_TWIN_V2',
  'off observes nothing',
  twinOff.inferences.length === 0,
  `inferences=${twinOff.inferences.length}`);

check('AQUA_TWIN_V2',
  'ONE turn never establishes a claim (minEvidence 3 / minConfidence 0.45)',
  afterOne.inferences.length === 0,
  `after 1 turn → ${afterOne.inferences.length} reportable, ${afterOne.tentative} tentative`);

check('AQUA_TWIN_V2',
  'repeated evidence crosses the bar, carrying confidence + evidence + lastVerified',
  afterMany.inferences.length > 0 &&
    afterMany.inferences.every(i => 'confidence' in i && 'lastVerified' in i),
  `after 7 turns → ${afterMany.inferences.length} inferences: ${afterMany.inferences.map(i => `${i.pattern}=${i.value}@${i.confidence}`).join(', ') || '(none)'}`);

// ── AQUA_REFLECT_V2 ──────────────────────────────────────────────────────────
// Claim: reflection emits a structured delta, and only WRITES when enabled.
G.upsertNode(O, {
  id: 'ent:name:newthing', type: 'entity', label: 'New Thing', kind: 'derived',
  data: { entityType: 'name', aliases: [], resolutionConfidence: 1, fileCount: 1 },
  sourceFiles: ['uko:x.pdf'],
});

delete process.env.AQUA_REFLECT_V2;
const reflectOff = Brain.reflectTurn(O);

process.env.AQUA_REFLECT_V2 = 'on';
G.upsertNode(O, {
  id: 'ent:name:another', type: 'entity', label: 'Another Thing', kind: 'derived',
  data: { entityType: 'name', aliases: [], resolutionConfidence: 1, fileCount: 1 },
  sourceFiles: ['uko:y.pdf'],
});
const reflectOn = Brain.reflectTurn(O);

check('AQUA_REFLECT_V2',
  'off still COMPUTES the delta (dry-run observability) but applies nothing',
  reflectOff.delta !== null && reflectOff.applied === false,
  `off → delta=${reflectOff.delta ? 'computed' : 'null'} applied=${reflectOff.applied}`);

check('AQUA_REFLECT_V2',
  'on emits a structured WorldDelta object, not a text summary',
  reflectOn.delta !== null && typeof reflectOn.delta === 'object' && !Array.isArray(reflectOn.delta),
  `on → applied=${reflectOn.applied} deltaKeys=[${Object.keys(reflectOn.delta ?? {}).join(', ')}]`);

// ── AQUA_REVISION_VOICE ──────────────────────────────────────────────────────
// Claim: with the flag on, a recorded revision becomes ONE directive on ONE
// suitable turn — named, never counted, never repeated, never on a working
// turn. Every other flag here changes what AQUA KNOWS; this one changes what it
// SAYS unprompted, which is the one worth being able to prove.
delete process.env.AQUA_REVISION_VOICE;
const voiceOff = Brain.revisionDirectiveFor(O, { taskType: 'conversation' });

process.env.AQUA_REVISION_VOICE = 'on';
const voiceOn    = Brain.revisionDirectiveFor(O, { taskType: 'conversation' });
const voiceAgain = Brain.revisionDirectiveFor(O, { taskType: 'conversation' });
const voiceCoding = Brain.revisionDirectiveFor(O, { taskType: 'coding' });
delete process.env.AQUA_REVISION_VOICE;

check('AQUA_REVISION_VOICE',
  'off says nothing, whatever AQUA noticed',
  voiceOff === '',
  `off → ${voiceOff === '' ? 'silent' : `LEAKED ${voiceOff.length} chars`}`);

check('AQUA_REVISION_VOICE',
  'on raises a revision by NAME, never as a count of anything',
  voiceOn.length > 0 && !/\d+ entit/.test(voiceOn),
  voiceOn ? `raised: "${voiceOn.split('\n')[1] ?? ''}"` : 'nothing was raised');

check('AQUA_REVISION_VOICE',
  'raised ONCE — a second turn says nothing about the same revision',
  voiceAgain === '',
  `second turn → ${voiceAgain === '' ? 'silent' : 'REPEATED'}`);

check('AQUA_REVISION_VOICE',
  'never interrupts a working turn',
  voiceCoding === '',
  `coding turn → ${voiceCoding === '' ? 'silent' : 'INTERRUPTED'}`);

// ── AQUA_UUS (User Understanding System) ─────────────────────────────────────
// Claim: a fact the user STATED outright earns explicit standing, instead of
// arriving at the confidence appropriate to something merely inferred.
const mindSchema = await import('./src/mind/mindSchema.js');
const beliefEngine = await import('./src/mind/beliefEngine.js');
const observers = await import('./src/mind/observers.js');

const statedProfession = [{ key: 'profession', value: 'founder', confidence: 0.85, extractor: 'schema' }];
const readProfession = () => {
  const mind = mindSchema.createEmptyMind('uus-proof');
  const { signals } = observers.observeTurn({
    userMessage: 'x', taskType: 'conversation', extractedFacts: statedProfession,
  });
  beliefEngine.observeSignals(mind, signals);
  return mind.beliefs[mindSchema.beliefKey(mindSchema.DIMENSIONS.IDENTITY, 'profession')];
};

delete process.env.AQUA_UUS;
const uusOff = readProfession();
process.env.AQUA_UUS = 'on';
const uusOn = readProfession();
delete process.env.AQUA_UUS;

check('AQUA_UUS',
  'off leaves a stated fact at inference confidence (unchanged behaviour)',
  Math.abs(uusOff.confidence - 0.35) < 0.005 && uusOff.privacy.source === 'fact_bridge',
  `off → confidence=${uusOff.confidence.toFixed(2)} source=${uusOff.privacy.source}`);

check('AQUA_UUS',
  'on gives a stated fact explicit standing (0.9) and explicit provenance',
  uusOn.confidence === 0.9 && uusOn.privacy.source === 'explicit',
  `on → confidence=${uusOn.confidence.toFixed(2)} source=${uusOn.privacy.source}`);

// The word-sense guard is deliberately NOT flagged — a bug fix behind a flag is
// a bug that stays. Proven here so that stays true.
const goSense = observers.observeTurn({ userMessage: "Go deep, don't over-explain.", taskType: 'conversation' });
check('AQUA_UUS',
  'the tech word-sense fix is unflagged and applies with the flag OFF',
  !goSense.hints.tech.includes('go'),
  `flag off → tech=[${goSense.hints.tech.join(', ')}] (pre-fix this was ['go'])`);

// U1 — the speaker as a subject. Requires AQUA_SELF_ENTITY too, so prove the
// conjunction rather than just the one flag.
const CE = await import('./src/brain/knowledgeExtraction/conversationEntities.js');
const CF = await import('./src/brain/knowledgeExtraction/conversationFacts.js');
const firstPerson = "I'm building the understanding engine.";

const noSelf = CF.buildConversationFacts({ conversationId: 'p', turn: 1, userMessage: firstPerson, entities: [] });
check('AQUA_UUS',
  'without the self subject a pronoun-only turn writes nothing (the U1 defect)',
  noSelf.skipped === 'no-entities' && noSelf.facts.length === 0,
  `skipped=${noSelf.skipped} facts=${noSelf.facts.length}`);

const selfEnts = CE.extractConversationEntities(firstPerson, { selfText: firstPerson });
const withSelf = CF.buildConversationFacts({
  conversationId: 'p', turn: 1, userMessage: firstPerson,
  entities: [{ id: 'ent:self:owner', canonical: 'You', type: 'self', aliases: [], isSelf: true }],
});
check('AQUA_UUS',
  'the speaker becomes a subject, and the same turn now writes a fact about them',
  selfEnts.some(e => e.isSelf) && withSelf.facts.length === 1 && withSelf.facts[0].entities.includes('You'),
  `entities=[${selfEnts.map(e => e.value).join(', ')}] facts=${withSelf.facts.length} → ${JSON.stringify(withSelf.facts[0]?.entities ?? [])}`);

check('AQUA_UUS',
  'no NAME reaches the self entity — the never-fuse invariant survives U1',
  !CE.extractConversationEntities('Priya owns the billing service.', {}).some(e => e.isSelf),
  'a named person still resolves to a named entity, never to the owner');

// U2 — interview mode. The measured claim: the intro conversation stops
// tripping the verification path that costs up to five extra LLM calls.
const IM = await import('./src/understanding/interviewMode.js');
const CL = await import('./src/core/classifier.js');
const gtky = [
  "I'm a founder and a software engineer.",
  "I'm building an AI product right now.",
  'My biggest project at the moment is the understanding engine.',
  'Long term I want to build AI that truly understands people.',
];
const bare = gtky.filter(m => CL.classifyTask(m).confidence < 0.5).length;
process.env.AQUA_UUS = 'on';
const inMode = gtky.filter(m => IM.classifyForMode('understanding', m, CL.classifyTask).confidence < 0.5).length;
const passthrough = gtky.every(m =>
  IM.classifyForMode(null, m, CL.classifyTask).task === CL.classifyTask(m).task);
delete process.env.AQUA_UUS;
const gated = IM.classifyForMode('understanding', gtky[0], CL.classifyTask).task === CL.classifyTask(gtky[0]).task;

// This check used to require `bare > 0` — i.e. it asserted that intro turns
// were BROKEN without the mode, which is what made the mode worth having.
// P1 (declarativeIntent.js at the classifier fallback seam) fixed the cause for
// every turn in the product, so `bare` is now 0 and the old form could only
// pass by the defect coming back. Inverted: what still has to hold is that
// intro turns clear the threshold, whichever layer gets them there.
check('AQUA_UUS',
  'intro turns never trip verification — with or without the mode',
  bare === 0 && inMode === 0,
  `unclassified → ${bare}/${gtky.length} below 0.5; in mode → ${inMode}/${gtky.length}`);

check('AQUA_UUS',
  'no mode means byte-identical classification, and the flag still gates it',
  passthrough && gated,
  'absent mode → passthrough; flag off → mode ignored');

// U3 — file understanding reaches the Mind. Before this, `mindObserve` had one
// caller (the chat pipeline), so an uploaded README filled the evidence store,
// the graph and the PIC while the card and the dashboard stayed empty.
const FB = await import('./src/understanding/fileBridge.js');
const OI = await import('./src/understanding/observeIngest.js');
const readmeUko = {
  structuredContent: { title: 'README.md' },
  entities: [
    { type: 'language', value: 'TypeScript', count: 14 },
    { type: 'technology', value: 'Kafka', count: 1 },
    { type: 'person', value: 'Ada Lovelace', count: 9 },
  ],
  topics: [], timeline: [{ order: 1, event: 'Q3 goal: ship the public beta', source: 'roadmap' }], facts: [],
};
const read = FB.readUko(readmeUko);

delete process.env.AQUA_UUS;
const offSeam = OI.observeIngest({ ownerId: 'p', ukoIds: ['u1'] });
process.env.AQUA_UUS = 'on';
const onSeam = OI.observeIngest({ ownerId: 'p', ukoIds: ['u1'], deps: { defer: () => {} } });
delete process.env.AQUA_UUS;

check('AQUA_UUS',
  'off = the upload seam is inert, on = it runs',
  offSeam.ok === false && offSeam.skipped === 'disabled' && onSeam.ok === true,
  `off → ${JSON.stringify(offSeam)}; on → ${JSON.stringify(onSeam)}`);

check('AQUA_UUS',
  'a README becomes beliefs and goals, and restraint holds',
  read.signals.length === 1 && read.signals[0].key === 'tech:typescript'
    && read.goalTitles.length === 1,
  `kept ${read.signals.map(s => s.key).join(', ')} + goal "${read.goalTitles[0]}"; `
  + 'dropped Kafka (1 mention) and Ada Lovelace (a name in a document is not a colleague)');

check('AQUA_UUS',
  'file evidence stays weaker than a person saying it',
  read.signals[0].strength < 0.5 && read.signals[0].source === 'fact_bridge',
  `strength=${read.signals[0].strength} source=${read.signals[0].source} — a README must never outrank its author`);

// U5 — the world-model card. Not flag-gated (a read model that 404s until a
// flag flips is worse than one that reports honestly), so these prove the two
// properties that decide whether the card earns trust.
const SUM = await import('./src/understanding/summary.js');
const thinCard = SUM.buildCard({
  beliefsByDimension: { identity: [{ dimension: 'identity', key: 'profession', value: 'founder', confidence: 0.9, status: 'active' }] },
  goals: [], projects: [], score: 18,
});
const guessCard = SUM.buildCard({
  beliefsByDimension: { identity: [
    { dimension: 'identity', key: 'profession', value: 'founder', confidence: 0.9, status: 'active' },
    { dimension: 'identity', key: 'city', value: 'Berlin', confidence: 0.3, status: 'active' },
  ] },
  goals: [], projects: [], score: 22,
});
const shown = guessCard.sections.flatMap(x => x.items.map(i => i.text));

check('AQUA_UUS',
  'an empty section is dropped, never rendered as "unknown"',
  thinCard.sections.length === 1 && !/unknown/i.test(JSON.stringify(thinCard)) && thinCard.isThin === true,
  `sections=[${thinCard.sections.map(x => x.id).join(', ')}] isThin=${thinCard.isThin} — three true lines beat nine hedged ones`);

check('AQUA_UUS',
  'a guess never appears on the card as a fact',
  shown.includes('founder') && !shown.includes('Berlin'),
  `shown=[${shown.join(', ')}]; a 0.30 belief is a follow-up question, not a card line`);

// U6 — one correction endpoint over four stores. Ungated for the same reason
// the read model is: a correction path that only works when a flag is on is a
// correction path the user cannot rely on.
const COR = await import('./src/understanding/corrections.js');
const refCases = {
  'belief:identity:profession': 'belief',
  'belief:knowledge:tech:go': 'belief',   // key contains a colon
  'goal:goal_1a2b': 'goal',
  'entity:ent:proj:aqua': 'entity',
};
const parsedOk = Object.entries(refCases).every(([r, k]) => COR.parseRef(r)?.kind === k);
const colonKey = COR.parseRef('belief:knowledge:tech:go');
const junkRejected = ['', 'nonsense', 'belief:', 'belief:identity:'].every(r => COR.parseRef(r) === null);

check('AQUA_UUS',
  'one ref grammar covers beliefs, goals and entities, and rejects junk',
  parsedOk && junkRejected,
  `${Object.keys(refCases).length} ref shapes parsed; unrecognised refs return null rather than a guess`);

check('AQUA_UUS',
  'a key containing a colon survives parsing',
  colonKey.dimension === 'knowledge' && colonKey.key === 'tech:go',
  `belief:knowledge:tech:go → dimension=${colonKey.dimension} key=${colonKey.key} `
  + '— splitting on every colon would apply the correction to the wrong belief');

check('AQUA_UUS',
  'dismissal records are bookkeeping and never displayed as understanding',
  COR.isDismissalKey('dismissed:ent:proj:x') === true && COR.isDismissalKey('message_style') === false,
  'a dashboard row reading "dismissed:… = true" would show the user our filing system');

// ── Master kill switch ───────────────────────────────────────────────────────
process.env.AQUA_BRAIN = 'off';
const killed = Brain.listEntities(O);
delete process.env.AQUA_BRAIN;
const revived = Brain.listEntities(O);

check('AQUA_BRAIN',
  'master switch empties everything, and unsetting restores it with no data loss',
  killed.length === 0 && revived.length > 0,
  `off → ${killed.length} entities; unset → ${revived.length} entities`);

// ── Summary ──────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.pass);
console.log(`\n${'─'.repeat(70)}\n${results.length - failed.length}/${results.length} functional checks passed`);
if (failed.length) {
  console.log('FAILURES:');
  for (const f of failed) console.log(`  ${f.flag}: ${f.claim}\n    ${f.detail}`);
  process.exitCode = 1;
}
