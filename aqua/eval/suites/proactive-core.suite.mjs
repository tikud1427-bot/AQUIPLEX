/**
 * AQUA Eval — proactive intelligence: usefulness vs noise (L14 gate for
 * AQUA_PROACTIVE, Phase 4).
 *
 * Every case is one owner's World-Model slice + intervention history + prefs,
 * labelled with what SHOULD happen now. The PRODUCTION trigger detector
 * (brain/proactive/triggers.js) and the PRODUCTION policy (policy.js) decide;
 * nothing here re-implements them. Persistence (idempotent insert, CAS
 * delivery, purge) is proven against Postgres in proactive.live.test.js.
 *
 * Metrics:
 *   intervention_precision   correct fires / all fires
 *   intervention_recall      should-fire cases that fired the expected trigger
 *   high_value_recall        the same, on HIGH_VALUE cases only
 *   false_interventions      fires in a case that should stay silent   (lower is better)
 *   wrong_type_interventions fires of an unexpected trigger type        (lower is better)
 *   duplicate_interventions  >1 fire for one subject, or any fire in a REDUNDANT case (lower is better)
 *   accuracy_<label>         per label
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectTriggers } from '../../src/brain/proactive/triggers.js';
import { decide } from '../../src/brain/proactive/policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/proactive-core.v1.json'), 'utf8'));
const OWNER = 'case-owner';
const SHOULD_FIRE = new Set(['VALID_INTERVENTION', 'HIGH_VALUE']);

function toClaims(compact) {
  return compact.map(c => ({
    claimId: c.id, ownerId: c.owner ?? OWNER, subjectEntityId: c.sid, subject: c.s, predicate: c.p,
    object: c.oid ? { kind: 'entity', entityId: c.oid, label: c.o } : { kind: 'literal', value: c.lit ?? null },
    polarity: c.pol ?? 'asserted', modality: c.mod ?? 'fact', state: c.state ?? 'active',
    assertedAt: c.said ?? '2026-10-01T09:00:00Z', supersededBy: c.supersededBy ?? null, validTo: c.validTo ?? null,
    extractor: c.ex ?? 'e6', confidence: { derived: 0.66 },
  }));
}

export default {
  id: 'proactive-core',
  title: 'proactive interventions — usefulness vs noise (triggers + policy)',
  about: 'Production trigger detection and intervention policy over labelled owner situations: does Aqua interrupt exactly when evidence, relevance, timing and benefit justify it?',
  cases: DS.cases,

  async run(testCase) {
    const now = new Date(testCase.now ?? DS.now);
    const claims = toClaims(testCase.claims);
    const claimsById = new Map(claims.map(c => [c.claimId, c]));
    const candidates = detectTriggers(claims, now);
    let history = (testCase.history ?? []).map(h => ({
      ...h, createdAt: new Date(now.getTime() - (h.hoursAgo ?? 1) * 3_600_000),
      respondedAt: h.respondedHoursAgo != null ? new Date(now.getTime() - h.respondedHoursAgo * 3_600_000) : null,
    }));
    if (testCase.historySameState && candidates[0]) {
      history = [...history, { triggerType: candidates[0].type, cooldownKey: candidates[0].cooldownKey,
        idempotencyKey: `${candidates[0].cooldownKey}|${candidates[0].fingerprint}`, severity: 'high', status: 'delivered',
        createdAt: new Date(now.getTime() - 3_600_000) }];
    }
    const decisions = [];
    for (const cand of candidates) {
      const d = decide(cand, { ownerId: OWNER, claimsById, history, prefs: testCase.prefs ?? {}, now });
      decisions.push({ type: cand.type, cooldownKey: cand.cooldownKey, fire: d.fire, reason: d.reason, severity: d.severity, deferred: Boolean(d.deliverAfter) });
      if (d.fire) history = [{ triggerType: cand.type, cooldownKey: cand.cooldownKey, idempotencyKey: d.idempotencyKey,
        severity: d.severity, status: 'proposed', createdAt: now }, ...history];
    }
    return { status: 'ok', actual: { decisions } };
  },

  score(testCase, actual) {
    const fired = actual.decisions.filter(d => d.fire);
    const should = SHOULD_FIRE.has(testCase.label);
    const rightType = fired.filter(d => d.type === testCase.expectType);
    const perKey = new Map();
    for (const d of fired) perKey.set(d.cooldownKey, (perKey.get(d.cooldownKey) ?? 0) + 1);
    const dup = [...perKey.values()].reduce((n, k) => n + Math.max(0, k - 1), 0) + (testCase.label === 'REDUNDANT' ? fired.length : 0);
    return {
      correct: should ? rightType.length >= 1 && fired.length === rightType.length : fired.length === 0,
      label: testCase.label, should, fires: fired.length, correctFires: should ? rightType.length : 0,
      wrongType: should ? fired.length - rightType.length : 0, falseFires: should ? 0 : fired.length, dup,
      reasons: actual.decisions.map(d => d.reason),
    };
  },

  metrics(scored) {
    const ratio = (a, b) => (b ? a / b : 0);
    const fires = scored.reduce((n, s) => n + s.fires, 0);
    const shouldCases = scored.filter(s => s.should);
    const hv = scored.filter(s => s.label === 'HIGH_VALUE');
    const labels = [...new Set(scored.map(s => s.label))].sort();
    return {
      case_accuracy: ratio(scored.filter(s => s.correct).length, scored.length),
      intervention_precision: ratio(scored.reduce((n, s) => n + s.correctFires, 0), fires),
      intervention_recall: ratio(shouldCases.filter(s => s.correctFires > 0).length, shouldCases.length),
      high_value_recall: ratio(hv.filter(s => s.correctFires > 0).length, hv.length),
      false_interventions: scored.reduce((n, s) => n + s.falseFires, 0),
      wrong_type_interventions: scored.reduce((n, s) => n + s.wrongType, 0),
      duplicate_interventions: scored.reduce((n, s) => n + s.dup, 0),
      ...Object.fromEntries(labels.map(l => [`accuracy_${l.toLowerCase()}`,
        ratio(scored.filter(s => s.label === l && s.correct).length, scored.filter(s => s.label === l).length)])),
      n_cases_should_fire: shouldCases.length,
      n_cases_should_not_fire: scored.length - shouldCases.length,
    };
  },
};
