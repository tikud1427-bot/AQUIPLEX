/**
 * AQUA Eval — the revision voice over the canonical World Model (L14 gate for
 * AQUA_REVISION_VOICE).
 *
 * Each case says things across conversations, then takes turns. The claims go
 * through the PRODUCTION S8 detector (`dedupAndDetect`, registry-derived sets)
 * and the PRODUCTION contradiction worker (real policy); every lifecycle
 * transition it writes is recorded as `aqua_lifecycle_transitions` would hold
 * it. Each turn then runs exactly the facade's sequence — suitability →
 * candidates past the watermark (owner-scoped) → `selectCanonicalRevision` →
 * advance — with the production selection and wording module. Storage is a
 * Map; the SQL candidate query, the compare-and-set watermark and real-process
 * concurrency are proven against Postgres in revisionVoice.live.test.js.
 *
 * Errors counted by direction (all LOWER_IS_BETTER):
 *   wrong_raises     raised when nothing should be (nagging, echoing, leaking)
 *   missed_raises    stayed silent when a revision should be raised
 *   wrong_content    raised, but not the expected statements / older-newer order
 *   invented_quotes  a quoted span that is not one of the owner's stored statements
 *   repeat_raises    the same transition raised more than once
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dedupAndDetect } from '../../src/brain/understanding/claimDedup.js';
import { runClaimContradictionJob } from '../../src/brain/reflectionV3/contradictionWorker.js';
import { singleValuedPredicateNames, singleObjectPredicateNames } from '../../src/core/claims/predicateRegistry.js';
import { selectCanonicalRevision } from '../../src/brain/reflectionV3/canonicalRevisionVoice.js';
import { isSuitableTurn } from '../../src/brain/reflectionV2/revisionVoice.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/revision-voice.v1.json'), 'utf8'));
const pad = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Say the steps (per owner store), recording every transition the worker applies. */
async function world(steps) {
  const functionalPredicates = new Set(singleValuedPredicateNames());
  const singleObjectPredicates = new Set(singleObjectPredicateNames());
  const stores = new Map();            // owner → Map(claimId → claim)
  const transitions = [];
  let t = Date.parse('2026-01-01T00:00:00Z');
  let seq = 0;
  for (const step of steps) {
    t += 60_000;
    const owner = step.owner ?? 'me';
    if (!stores.has(owner)) stores.set(owner, new Map());
    const store = stores.get(owner);
    const claim = {
      claimId: step.id, subject: step.subject, subjectEntityId: step.subjectEntityId,
      predicate: step.predicate, objectKind: 'entity', object: step.object,
      polarity: step.polarity ?? 'asserted', modality: step.modality ?? 'fact',
      validFrom: step.validFrom ?? null, validTo: step.validTo ?? null,
      assertedAt: new Date(t).toISOString(), actor: step.actor ?? 'e6:e6-v1',
      state: 'active', evidence: [{ role: 'primary' }],
      statementText: step.text, ref: `${step.conv}:turn:${seq + 1}`,
    };
    const history = [...store.values()].filter(c => c.predicate === claim.predicate && c.state !== 'archived');
    const s8 = dedupAndDetect([claim], history, { functionalPredicates, singleObjectPredicates });
    if (s8.evidenceAttachments.length) continue;
    store.set(claim.claimId, claim);
    for (const c of s8.contradictions) {
      await runClaimContradictionJob(
        { ownerId: owner, payload: { incomingClaimId: c.incoming.claimId, existingClaimId: c.existing.claimId } },
        {
          loadClaim: async id => (store.has(id) ? { ...store.get(id) } : null),
          applyTransition: async ({ targetId, toState, supersededBy, reason }) => {
            const row = store.get(targetId);
            if (row.state === toState) throw new Error('lifecycle transition changes nothing');
            row.state = toState;
            if (toState === 'superseded') row.supersededBy = supersededBy;
            transitions.push({ owner, transitionId: pad(++seq), createdAt: new Date(t + seq).toISOString(),
              toState, reason: reason ?? '', targetId });
          },
        });
    }
  }
  return { stores, transitions };
}

/** As canonicalReadModel.revisionVoiceCandidates projects a transition. */
function candidate(tr, store) {
  const old = store.get(tr.targetId);
  const succ = tr.toState === 'superseded'
    ? store.get(old.supersededBy)
    : [...store.values()].filter(c => c.claimId !== old.claimId && c.subjectEntityId === old.subjectEntityId
        && c.predicate === old.predicate && c.state === 'disputed').sort((a, b) => (a.assertedAt < b.assertedAt ? 1 : -1))[0];
  return { transitionId: tr.transitionId, createdAt: tr.createdAt, toState: tr.toState, reason: tr.reason,
    oldText: old.statementText, currentState: old.state,
    newText: succ?.statementText ?? null, newActor: succ?.actor ?? null, newRef: succ?.ref ?? null };
}

const quoted = d => [...d.matchAll(/"([^"]+)"/g)].map(m => m[1]);

export default {
  id: 'revision-voice',
  title: 'revision voice — raise a canonical change once, only when it is news, quoting only the user',
  about: [
    'Claims said across conversations go through the production S8 detector and E9 contradiction',
    'worker; each turn then runs the production revision-voice selection over the recorded',
    'transitions with an owner-scoped watermark. Checks: a policy supersession from an earlier',
    'conversation is raised once, a change from this conversation is not echoed, a dispute is',
    'asked about, corrections are never raised back, working turns neither raise nor burn,',
    'non-changes are silent, only stored statements are quoted, and owners never see each other.',
  ].join('\n'),

  cases: DS.cases,

  async run(testCase) {
    const { stores, transitions } = await world(testCase.steps);
    const marks = new Map();
    const raisedIds = [];
    const turns = [];
    for (const tn of testCase.turns) {
      const owner = tn.owner ?? 'me';
      if (!isSuitableTurn({ taskType: tn.taskType, mode: tn.mode ?? null })) { turns.push({ directive: '' }); continue; }
      const mark = marks.get(owner) ?? '';
      const store = stores.get(owner) ?? new Map();
      const cands = transitions.filter(tr => tr.owner === owner && tr.transitionId > mark).map(tr => candidate(tr, store));
      const pick = selectCanonicalRevision(cands, { conversationId: tn.conv });
      if (pick.watermark) marks.set(owner, pick.watermark.transitionId);
      if (pick.chosen) raisedIds.push(`${owner}:${pick.chosen.transitionId}`);
      turns.push({ directive: pick.directive, kind: pick.chosen?.toState ?? null });
    }
    const stored = new Map([...stores].map(([o, s]) => [o, new Set([...s.values()].map(c => c.statementText))]));
    return { status: 'ok', actual: { turns, raisedIds, stored: Object.fromEntries([...stored].map(([o, s]) => [o, [...s]])) } };
  },

  score(testCase, actual) {
    let wrongRaise = 0, missedRaise = 0, wrongContent = 0, invented = 0;
    testCase.turns.forEach((tn, i) => {
      const got = actual.turns[i];
      const exp = tn.expect;
      const stored = new Set(actual.stored[tn.owner ?? 'me'] ?? []);
      if (got.directive) for (const q of quoted(got.directive)) if (!stored.has(q)) invented++;
      if (!exp) { if (got.directive) wrongRaise++; return; }
      if (!got.directive) { missedRaise++; return; }
      const q = quoted(got.directive);
      const ok = exp.kind === 'superseded'
        ? got.kind === 'superseded' && q.length === 2 && q[0] === exp.older && q[1] === exp.newer
        : got.kind === 'disputed' && q.length === 2 && new Set(q).size === 2 && exp.quotes.every(x => q.includes(x));
      if (!ok) wrongContent++;
    });
    const repeat = actual.raisedIds.length - new Set(actual.raisedIds).size;
    const correct = !wrongRaise && !missedRaise && !wrongContent && !invented && !repeat;
    return { correct, cat: testCase.cat, wrongRaise, missedRaise, wrongContent, invented, repeat };
  },

  metrics(scored) {
    const sum = k => scored.reduce((n, s) => n + s[k], 0);
    const byCat = {};
    for (const s of scored) { byCat[s.cat] ??= { n: 0, ok: 0 }; byCat[s.cat].n++; if (s.correct) byCat[s.cat].ok++; }
    return {
      case_accuracy: scored.length ? scored.filter(s => s.correct).length / scored.length : 0,
      wrong_raises: sum('wrongRaise'),
      missed_raises: sum('missedRaise'),
      wrong_content: sum('wrongContent'),
      invented_quotes: sum('invented'),
      repeat_raises: sum('repeat'),
      ...Object.fromEntries(Object.entries(byCat).sort().map(([c, v]) => [`accuracy_${c.replace(/-/g, '_')}`, v.ok / v.n])),
    };
  },
};
