/**
 * AQUA Eval — claim lifecycle under changing facts (E6 S8 + E9 policy)
 *
 * The World-Model Lift run (2026-10-04) showed changed facts leaving the old
 * value active. The fix declares cardinality in the predicate registry and lets
 * the E9 policy retire the older snapshot of a SINGLE-VALUED fact — and nothing
 * else. This suite is the evaluation L14 requires before that ships: it drives
 * the PRODUCTION S8 detector (`dedupAndDetect`, with the registry-derived sets
 * `understandTurn` passes) and the PRODUCTION contradiction worker
 * (`runClaimContradictionJob`, real policy) through ordered claim sequences.
 * Only storage is in memory: `loadClaim` / `applyTransition` read and write a
 * Map instead of Postgres. No provider, no clock dependence.
 *
 * Errors are counted by DIRECTION, never folded into one number:
 *   false_supersession  a claim retired that must stay current (data loss risk)
 *   missed_retirement   an old value left current (the stale-answer bug)
 *   wrong_dispute       disputed when it should not be, or not when it should
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dedupAndDetect } from '../../src/brain/understanding/claimDedup.js';
import { runClaimContradictionJob } from '../../src/brain/reflectionV3/contradictionWorker.js';
import { singleValuedPredicateNames, singleObjectPredicateNames } from '../../src/core/claims/predicateRegistry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/claim-lifecycle.v1.json'), 'utf8'));

const CURRENT = new Set(['active', 'trusted', 'extracted']);

/** One sequence through S8 + the worker, against an in-memory store. */
export async function runSequence(steps, { functionalPredicates, singleObjectPredicates } = {}) {
  const store = new Map();     // claimId → claim
  const corroborated = {};
  let t = Date.parse('2026-01-01T00:00:00Z');

  for (const step of steps) {
    t += 60_000;
    const claim = {
      claimId: step.id,
      subject: step.subject,
      subjectEntityId: step.subjectEntityId,
      predicate: step.predicate,
      objectKind: step.object.entity !== undefined ? 'entity' : 'literal',
      object: step.object,
      polarity: step.polarity ?? 'asserted',
      modality: step.modality ?? 'fact',
      validFrom: step.validFrom ?? null,
      validTo: step.validTo ?? null,
      assertedAt: new Date(t).toISOString(),
      actor: step.actor ?? 'e6:e6-v1',
      state: 'active',
      evidence: [{ role: 'primary' }],
    };
    // S8 history = every non-archived claim with that predicate, as
    // findClaimsForDedup loads it.
    const history = [...store.values()].filter(c => c.predicate === claim.predicate && c.state !== 'archived');
    const s8 = dedupAndDetect([claim], history, { functionalPredicates, singleObjectPredicates });

    if (s8.evidenceAttachments.length) {
      for (const a of s8.evidenceAttachments) corroborated[a.targetClaimId] = (corroborated[a.targetClaimId] ?? 0) + 1;
      continue;                      // a restatement adds evidence, not a row
    }
    store.set(claim.claimId, claim);

    for (const c of s8.contradictions) {
      await runClaimContradictionJob(
        { ownerId: 'u-lifecycle', payload: { incomingClaimId: c.incoming.claimId, existingClaimId: c.existing.claimId } },
        {
          loadClaim: async id => (store.has(id) ? { ...store.get(id) } : null),
          applyTransition: async ({ targetId, toState, supersededBy }) => {
            const row = store.get(targetId);
            if (row.state === toState) throw new Error('lifecycle transition changes nothing');
            row.state = toState;
            if (toState === 'superseded') {
              row.supersededBy = supersededBy;
              row.validTo ??= new Date(t).toISOString();
            }
          },
        });
    }
  }
  return { store, corroborated };
}

export default {
  id: 'claim-lifecycle',
  title: 'claim lifecycle — changing facts retire the old value, and only the old value',
  about: [
    'Ordered canonical-claim sequences through the production S8 detector and the production',
    'E9 contradiction worker, with registry-declared cardinality. Checks that a single-valued',
    'fact replaced by a new value is superseded (history kept), that multi-valued predicates',
    'never conflict, that polarity flips stay disputed, that an explicit correction outranks',
    'extraction, that intents and closed windows are not conflicts, and that A→B→C chains settle.',
  ].join('\n'),

  cases: DS.cases,

  async run(testCase) {
    const { store, corroborated } = await runSequence(testCase.steps, {
      functionalPredicates: new Set(singleValuedPredicateNames()),
      singleObjectPredicates: new Set(singleObjectPredicateNames()),
    });
    const rows = [...store.values()];
    return {
      status: 'ok',
      actual: {
        current: rows.filter(c => CURRENT.has(c.state)).map(c => c.claimId).sort(),
        superseded: Object.fromEntries(rows.filter(c => c.state === 'superseded').map(c => [c.claimId, c.supersededBy])),
        disputed: rows.filter(c => c.state === 'disputed').map(c => c.claimId).sort(),
        corroborated,
      },
    };
  },

  score(testCase, actual) {
    const e = testCase.expect;
    const expCurrent = new Set(e.current);
    const actCurrent = new Set(actual.current);
    const falseSupersession = [...expCurrent].filter(id => !actCurrent.has(id) && actual.superseded[id]).length;
    const missedRetirement = Object.keys(e.superseded).filter(id => actCurrent.has(id)).length;
    const wrongSuccessor = Object.entries(e.superseded).filter(([id, by]) => actual.superseded[id] && actual.superseded[id] !== by).length;
    const wrongDispute = new Set([...e.disputed, ...actual.disputed]).size
      - [...e.disputed].filter(id => actual.disputed.includes(id)).length;
    const corroborationOk = !e.corroborated
      || Object.entries(e.corroborated).every(([id, n]) => (actual.corroborated[id] ?? 0) === n);
    const exact = JSON.stringify([...actCurrent].sort()) === JSON.stringify([...expCurrent].sort())
      && JSON.stringify(actual.superseded) === JSON.stringify(Object.fromEntries(Object.entries(e.superseded).sort()))
      && JSON.stringify(actual.disputed) === JSON.stringify([...e.disputed].sort())
      && corroborationOk;
    return { correct: exact, cat: testCase.cat, falseSupersession, missedRetirement, wrongSuccessor, wrongDispute };
  },

  metrics(scored) {
    const sum = k => scored.reduce((n, s) => n + s[k], 0);
    const byCat = {};
    for (const s of scored) { byCat[s.cat] ??= { n: 0, ok: 0 }; byCat[s.cat].n++; if (s.correct) byCat[s.cat].ok++; }
    return {
      case_accuracy: scored.length ? scored.filter(s => s.correct).length / scored.length : 0,
      false_supersessions: sum('falseSupersession'),
      missed_retirements: sum('missedRetirement'),
      wrong_successors: sum('wrongSuccessor'),
      wrong_disputes: sum('wrongDispute'),
      ...Object.fromEntries(Object.entries(byCat).sort().map(([c, v]) => [`accuracy_${c.replace(/-/g, '_')}`, v.ok / v.n])),
    };
  },
};
