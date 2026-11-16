/**
 * PWI benchmark — scoring (2026-11-15). Pure: stage outputs + dataset → metrics.
 *
 * Every number is computed against the replayed truth (truth.mjs). Text checks
 * use whole-token, accent- and case-insensitive matching of the dataset's
 * surface forms. Where a judgement needs a rule (what counts as "presented as
 * current"), the rule is in truth.mjs (MARKED_LINE) and documented in the spec.
 */
import { truthAt, resolveProbe, deletedValues, mentions, occurrences, UNKNOWN_ACK, STAGES } from './truth.mjs';

const ratio = (n, d) => (d ? Math.round((n / d) * 10000) / 10000 : null);
const SELF = 'person:__self__';
const RECALL_LINE = /^\s*\[\s*\d{4}-\d{2}-\d{2}/;

// ── Store views ──────────────────────────────────────────────────────────────
const valueText = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
export function storeViews(store) {
  const facts = store?.facts ?? [];
  const current = facts.filter(f => !f.archived && !f.ended);
  const mind = store?.mind;
  const activeGoals = mind ? Object.values(mind.goals).filter(g => !g.deletedAt && !['achieved', 'abandoned', 'completed', 'deleted', 'dropped'].includes(String(g.status))) : [];
  const nodes = mind ? Object.values(mind.graph?.nodes ?? {}).filter(n => !n.deletedAt) : [];
  const nodeByKey = new Map(nodes.map(n => [n.key, n]));
  const edges = mind ? Object.values(mind.graph?.edges ?? {}).filter(e => !e.deletedAt && !e.endedAt && nodeByKey.has(e.from) && nodeByKey.has(e.to)) : [];
  const w = mind?.working ?? {};
  return {
    factsCurrent: current.map(f => `${f.key}: ${valueText(f.value)}`).join('\n'),
    factsAll: facts.map(f => JSON.stringify(f)).join('\n'),
    // What a fact HOLDS (value + its history), apart from the sentence it was extracted from.
    factsHeld: facts.map(f => JSON.stringify({ k: f.key, v: f.value, h: f.history, t: f.transitions, l: f.laterWord, r: f.retiredItems })).join('\n'),
    factsSourceText: facts.map(f => f.sourceText ?? '').join('\n'),
    factRecords: facts,
    mindCurrent: [
      ...Object.values(mind?.beliefs ?? {}).filter(b => !b.deletedAt && !b.retired).map(b => `${b.dimension}:${b.key}: ${valueText(b.value)}`),
      ...activeGoals.map(g => `goal: ${g.title}`),
      ...(w.blockers ?? []).map(b => `blocker: ${b.text}`),
      ...(w.deadlines ?? []).map(d => `deadline: ${d.label}`),
      ...(w.openQuestions ?? []).map(q => `open question: ${q.text}`),
      ...nodes.map(n => `node(${n.type}): ${n.label}`),
    ].join('\n'),
    mindAll: mind ? JSON.stringify(mind) : '',
    evidenceActive: (store?.evidence ?? []).filter(e => !e.archived).map(e => e.statement).join('\n'),
    nodes, edges, nodeByKey,
  };
}

// ── Probe scoring ────────────────────────────────────────────────────────────
/** True when some context line says the named thing is unknown ("annual revenue" → a line with "revenue" + a marker). */
export function unknownAcknowledged(lines, label) {
  const terms = String(label).split(/\s+/).filter(w => w.length > 3);
  return lines.some(l => UNKNOWN_ACK.test(l) && terms.some(t => mentions(l, t)));
}
export function scoreProbe(persona, probe, truth, ctxText, others, views) {
  const r = resolveProbe(persona, probe, truth);
  const lines = String(ctxText ?? '').split(/\r?\n/);
  const structured = lines.filter(l => !RECALL_LINE.test(l)).join('\n');
  const quoted = lines.filter(l => RECALL_LINE.test(l)).join('\n');
  const required = r.required.map(v => {
    const present = mentions(ctxText, v.match);
    let miss = null;
    if (!present) {
      const stored = mentions(views.factsCurrent, v.match) || mentions(views.mindCurrent, v.match) || mentions(views.evidenceActive, v.match);
      miss = stored ? 'retrieval' : 'capture';
    }
    return { slot: v.slot, kind: v.kind, value: v.value, source: v.source, present, inStructured: mentions(structured, v.match), miss };
  });
  const stale = r.staleChecks.map(v => {
    const o = occurrences(structured, v.match);
    const q = occurrences(quoted, v.match);
    return { slot: v.slot, kind: v.kind, value: v.value, unmarked: o.unmarked.length > 0, unmarkedLines: o.unmarked.slice(0, 2), quoted: q.marked.length + q.unmarked.length,
      quotedWithChangeNote: q.marked.filter(l => /since changed|changed|no longer|corrected/i.test(l)).length };
  });
  const irrelevant = r.irrelevant.filter(v => mentions(ctxText, v.match)).map(v => ({ slot: v.slot, value: v.value }));
  const deleted = deletedValues(truth).filter(v => mentions(ctxText, v.match)).map(v => v.value);
  const sensitive = Object.values(truth.slots).flatMap(s => s.sensitive).filter(v => mentions(ctxText, v.match)).map(v => v.value);
  const leaks = others.filter(c => mentions(ctxText, c));
  const reqPresent = required.filter(x => x.present).length;
  return {
    probe: probe.id, category: probe.category, required, stale, irrelevant, deleted, sensitive, leaks,
    // An acknowledgement must be ABOUT the unknown thing: a line with an unknown-marker that names it.
    // (v1 first matched UNKNOWN_ACK anywhere, and the recall block's fixed instructions satisfied it —
    // a harness false positive found in the first baseline and fixed before reporting; see the report.)
    unknown: r.unknown ? { slot: r.unknown, acknowledged: unknownAcknowledged(lines, r.unknown) } : null,
    completeness: ratio(reqPresent, required.length),
    precision: reqPresent + irrelevant.length ? ratio(reqPresent, reqPresent + irrelevant.length) : null,
  };
}

// ── Store scoring (one persona, one stage) ───────────────────────────────────
export function scoreStore(persona, truth, store, others) {
  const v = storeViews(store);
  const cur = `${v.factsCurrent}\n${v.mindCurrent}`;
  // Claims: every current value of every slot (sensitive values are never claims).
  const claims = [];
  for (const [slot, s] of Object.entries(truth.slots)) {
    const staleVals = [...s.past, ...s.wrong].filter(x => mentions(cur, x.match));
    for (const x of s.current) {
      const inFacts = mentions(v.factsCurrent, x.match);
      const inMind = mentions(v.mindCurrent, x.match);
      claims.push({ slot, value: x.value, source: x.source, inFacts, inMind, captured: inFacts || inMind, staleAlongside: staleVals.map(y => y.value) });
    }
  }
  // Changes (world changes and corrections): did the store keep the old value as history, and drop it as current?
  const changes = [];
  for (const [slot, s] of Object.entries(truth.slots)) {
    for (const [kind, list] of [['past', s.past], ['wrong', s.wrong]]) {
      for (const old of list) {
        const recordedAsHistory = v.factRecords.some(f => {
          const curText = valueText(f.value);
          const histText = JSON.stringify({ h: f.history, t: f.transitions, l: f.laterWord, r: f.retiredItems });
          return (mentions(histText, old.match) && !mentions(curText, old.match)) || (f.ended && mentions(curText, old.match));
        });
        changes.push({ slot, kind, old: old.value, recordedAsHistory,
          stillCurrent: { facts: mentions(v.factsCurrent, old.match), mind: mentions(v.mindCurrent, old.match), evidence: mentions(v.evidenceActive, old.match) } });
      }
    }
  }
  // Deletion + sensitive: nothing derived may hold them (facts incl. history, the whole Mind, active evidence).
  const mustBeGone = [
    ...deletedValues(truth).map(x => ({ kind: 'deleted', ...x })),
    ...Object.values(truth.slots).flatMap(s => s.sensitive).map(x => ({ kind: 'sensitive', ...x })),
  ];
  const deletion = mustBeGone.map(x => ({ kind: x.kind, value: x.value,
    found: { facts: mentions(v.factsAll, x.match), mind: mentions(v.mindAll, x.match), evidence: mentions(v.evidenceActive, x.match) },
    // Where in the fact store: held as a value/history, or only inside another fact's source sentence.
    factsDetail: { held: mentions(v.factsHeld, x.match), sourceTextOnly: !mentions(v.factsHeld, x.match) && mentions(v.factsSourceText, x.match) } }));
  const hedged = Object.entries(truth.slots).flatMap(([slot, s]) => s.hedged.map(x => ({ slot, value: x.value,
    asFact: mentions(v.factsCurrent, x.match), inMind: mentions(v.mindCurrent, x.match) })));
  const leaks = others.filter(c => mentions(v.factsAll, c) || mentions(v.mindAll, c) || mentions(v.evidenceActive, c));

  // Entities (graph) — goal and technology nodes are not entities in this dataset's sense.
  const live = truth.entities;
  const graphable = live.filter(e => e.type !== 'place');   // the Mind graph has no place type
  const entityNodes = v.nodes.filter(n => n.key !== SELF && !['goal', 'technology'].includes(n.type));
  const nodeEntity = n => live.find(e => mentions(n.label, e.match)) ?? null;
  const tpNodes = entityNodes.filter(nodeEntity);
  const coveredGraph = graphable.filter(e => entityNodes.some(n => mentions(n.label, e.match)));
  const coveredAny = live.filter(e => entityNodes.some(n => mentions(n.label, e.match)) || mentions(v.factsCurrent, e.match));
  const typeAgree = tpNodes.filter(n => { const e = nodeEntity(n); return e && (e.type === n.type || (e.type === 'organization' && n.type === 'organization')); }).length;
  const deletedEntityNodes = v.nodes.filter(n => truth.deletedEntities.some(e => mentions(n.label, e.match))).map(n => n.label);

  // Relations (graph edges between entity/self nodes).
  const endpoint = key => (key === SELF ? 'self' : (() => { const n = v.nodeByKey.get(key); if (!n || ['goal', 'technology'].includes(n.type)) return undefined; return nodeEntity(n)?.id ?? null; })());
  const relEdges = v.edges.map(e => ({ e, a: endpoint(e.from), b: endpoint(e.to) })).filter(x => x.a !== undefined && x.b !== undefined);
  const isRel = (x, r) => (x.a === r.from && x.b === r.to) || (x.a === r.to && x.b === r.from);
  const tpEdges = relEdges.filter(x => truth.relations.some(r => isRel(x, r)));
  const staleEdges = relEdges.filter(x => [...truth.endedRelations, ...truth.deletedRelations].some(r => isRel(x, r)));
  const coveredRels = truth.relations.filter(r => relEdges.some(x => isRel(x, r)));

  return {
    claims, changes, deletion, hedged, leaks,
    entities: { labelled: live.length, graphable: graphable.length, predicted: entityNodes.length, tp: tpNodes.length, coveredGraph: coveredGraph.length, coveredAny: coveredAny.length,
      typeAgree, missed: graphable.filter(e => !coveredGraph.includes(e)).map(e => e.name), spurious: entityNodes.filter(n => !nodeEntity(n)).map(n => `${n.type}:${n.label}`), deletedEntityNodes },
    relations: { labelled: truth.relations.length, predicted: relEdges.length, tp: tpEdges.length, covered: coveredRels.length, stale: staleEdges.length,
      missed: truth.relations.filter(r => !coveredRels.includes(r)).map(r => `${r.from}-${r.type}-${r.to}`) },
    counts: { facts: (store?.facts ?? []).length, currentFacts: v.factsCurrent ? v.factsCurrent.split('\n').length : 0, nodes: v.nodes.length, edges: v.edges.length, evidence: (store?.evidence ?? []).length },
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────────
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
const mean = xs => { const v = xs.filter(x => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10000) / 10000 : null; };

export function scoreStage(dataset, stageOut) {
  const stage = stageOut.stage;
  const perPersona = {};
  const probes = [];
  for (const p of dataset.personas) {
    const truth = truthAt(p, stage);
    const others = dataset.personas.filter(o => o.id !== p.id).flatMap(o => o.canaries);
    const store = scoreStore(p, truth, stageOut.stores[p.id], others);
    const views = storeViews(stageOut.stores[p.id]);
    perPersona[p.id] = store;
    for (const q of p.probes.filter(q => q.stages.includes(stage))) {
      const rec = stageOut.probes.find(x => x.persona === p.id && x.probe === q.id);
      if (!rec?.ok) { probes.push({ persona: p.id, probe: q.id, category: q.category, infra: rec?.error ?? 'missing' }); continue; }
      probes.push({ persona: p.id, ...scoreProbe(p, q, truth, rec.systemPrompt, others, views) });
    }
  }
  const S = Object.values(perPersona);
  const P = probes.filter(x => !x.infra);
  const claims = S.flatMap(s => s.claims);
  const changes = S.flatMap(s => s.changes);
  const corrections = changes.filter(c => c.kind === 'wrong');
  const worldChanges = changes.filter(c => c.kind === 'past');
  const del = S.flatMap(s => s.deletion);
  const req = P.flatMap(x => x.required);
  const stale = P.flatMap(x => x.stale);
  const cat = c => P.filter(x => x.category === c);
  const temporal = cat('temporal');
  const consistentViews = c => [!c.stillCurrent.facts, !c.stillCurrent.mind, !c.stillCurrent.evidence];
  const probeViewConsistent = (list) => {
    // In the answer context: the old/wrong value is not presented as current on probes that ask about its slot.
    const checks = P.flatMap(x => x.stale.filter(s => list.some(c => c.slot === s.slot && c.old === s.value && c.kind === s.kind)));
    return { n: checks.length, ok: checks.filter(s => !s.unmarked).length };
  };
  const corrProbe = probeViewConsistent(corrections);
  const changeProbe = probeViewConsistent(worldChanges);
  const ent = S.map(s => s.entities);
  const rel = S.map(s => s.relations);

  return {
    stage,
    infra: { events: stageOut.events.filter(e => !e.ok).length, probes: probes.filter(x => x.infra).length, other: stageOut.infra.length, networkBlocked: stageOut.network.blocked,
      actions: stageOut.events.filter(e => e.action).map(e => ({ persona: e.persona, ...e.action })) },
    metrics: {
      entity: { precision: ratio(sum(ent, e => e.tp), sum(ent, e => e.predicted)), recallGraph: ratio(sum(ent, e => e.coveredGraph), sum(ent, e => e.graphable)),
        recallStructured: ratio(sum(ent, e => e.coveredAny), sum(ent, e => e.labelled)), typeAgreement: ratio(sum(ent, e => e.typeAgree), sum(ent, e => e.tp)) },
      relationship: { precision: ratio(sum(rel, r => r.tp), sum(rel, r => r.predicted)), recall: ratio(sum(rel, r => r.covered), sum(rel, r => r.labelled)), staleEdges: sum(rel, r => r.stale) },
      claim: { recall: ratio(claims.filter(c => c.captured).length, claims.length), recallFactStore: ratio(claims.filter(c => c.inFacts).length, claims.length),
        accuracy: ratio(claims.filter(c => c.captured && !c.staleAlongside.length).length, claims.length),
        recallChat: ratio(claims.filter(c => c.source === 'chat' && c.captured).length, claims.filter(c => c.source === 'chat').length),
        recallDocument: ratio(claims.filter(c => c.source === 'document' && c.captured).length, claims.filter(c => c.source === 'document').length) },
      temporal: { probeAccuracy: ratio(temporal.filter(x => x.required.every(r => r.present) && x.stale.every(s => !s.unmarked)).length, temporal.length),
        staleUnmarkedRate: ratio(stale.filter(s => s.kind !== 'hedged' && s.unmarked).length, stale.filter(s => s.kind !== 'hedged').length),
        staleQuoted: stale.filter(s => s.kind !== 'hedged' && s.quoted).length, staleQuotedWithChangeNote: stale.filter(s => s.kind !== 'hedged' && s.quotedWithChangeNote).length },
      contradiction: { changes: worldChanges.length + corrections.length,
        detectedInStore: ratio(changes.filter(c => c.recordedAsHistory).length, changes.length),
        handledInContext: ratio(changeProbe.ok + corrProbe.ok, changeProbe.n + corrProbe.n) },
      correctionPropagation: { corrections: corrections.length,
        storeViewsConsistent: ratio(sum(corrections, c => consistentViews(c).filter(Boolean).length), corrections.length * 3),
        contextConsistent: ratio(corrProbe.ok, corrProbe.n),
        worldChangeStoreViewsConsistent: ratio(sum(worldChanges, c => consistentViews(c).filter(Boolean).length), worldChanges.length * 3) },
      retrievalRelevance: { precisionMean: mean(P.map(x => x.precision)), irrelevantItemsPerProbe: ratio(sum(P, x => x.irrelevant.length), P.length) },
      contextCompleteness: { mean: mean(P.map(x => x.completeness)), items: ratio(req.filter(r => r.present).length, req.length),
        missCapture: req.filter(r => !r.present && r.miss === 'capture').length, missRetrieval: req.filter(r => !r.present && r.miss === 'retrieval').length },
      crossSource: { completeness: mean(cat('cross-source').map(x => x.completeness)),
        documentItems: ratio(req.filter(r => r.source === 'document' && r.present).length, req.filter(r => r.source === 'document').length) },
      personalizedReasoning: { completeness: mean(cat('personalized').map(x => x.completeness)), precision: mean(cat('personalized').map(x => x.precision)) },
      answerFactuality: { value: null, status: 'not measured — needs model calls (answer + judge); not approved for this run' },
      personalizedAnswerQuality: { value: null, status: 'not measured — needs model calls (answer + judge); not approved for this run' },
      uncertainty: { hedgedAsFact: S.flatMap(s => s.hedged).filter(h => h.asFact || h.inMind).length, hedged: S.flatMap(s => s.hedged).length,
        hedgedUnmarkedInContext: stale.filter(s => s.kind === 'hedged' && s.unmarked).length, hedgedChecks: stale.filter(s => s.kind === 'hedged').length,
        unknownAcknowledged: ratio(P.filter(x => x.unknown?.acknowledged).length, P.filter(x => x.unknown).length) },
      deletion: { checksStore: del.length * 3, violationsStore: sum(del, d => Object.values(d.found).filter(Boolean).length),
        complianceStore: ratio(del.length * 3 - sum(del, d => Object.values(d.found).filter(Boolean).length), del.length * 3),
        contextViolations: sum(P, x => x.deleted.length + x.sensitive.length), deletedEntityNodes: sum(ent, e => e.deletedEntityNodes.length),
        items: del.length, itemsFullyGone: del.filter(d => !Object.values(d.found).some(Boolean)).length,
        factsHeld: del.filter(d => d.factsDetail.held).length, factsSourceTextOnly: del.filter(d => d.factsDetail.sourceTextOnly).length,
        mind: del.filter(d => d.found.mind).length, evidence: del.filter(d => d.found.evidence).length },
      isolation: { storeLeaks: sum(S, s => s.leaks.length), contextLeaks: sum(P, x => x.leaks.length), probes: P.length },
      quantity: { facts: sum(S, s => s.counts.facts), currentFacts: sum(S, s => s.counts.currentFacts), nodes: sum(S, s => s.counts.nodes), edges: sum(S, s => s.counts.edges), evidence: sum(S, s => s.counts.evidence) },
    },
    perPersona, probes,
  };
}

/** Persistence: the same measurements from the fresh process over the same data. */
export function persistence(runScore, verifyScore) {
  const key = x => JSON.stringify({ r: x.required?.map(r => r.present), s: x.stale?.map(s => s.unmarked), i: x.irrelevant?.map(i => i.value).sort(), d: x.deleted, l: x.leaks });
  const a = new Map(runScore.probes.map(x => [`${x.persona}/${x.probe}`, key(x)]));
  const diffs = verifyScore.probes.filter(x => a.get(`${x.persona}/${x.probe}`) !== key(x)).map(x => `${x.persona}/${x.probe}`);
  const storeKey = s => JSON.stringify({ c: s.claims.map(c => c.captured), ch: s.changes.map(c => [c.recordedAsHistory, c.stillCurrent]), d: s.deletion.map(d => d.found), e: [s.entities.tp, s.entities.predicted], r: [s.relations.tp, s.relations.predicted] });
  const storeDiffs = Object.keys(runScore.perPersona).filter(p => storeKey(runScore.perPersona[p]) !== storeKey(verifyScore.perPersona[p]));
  return { probesCompared: verifyScore.probes.length, probeDiffs: diffs, storeDiffs, identical: ratio(verifyScore.probes.length - diffs.length, verifyScore.probes.length) };
}

export { STAGES };
