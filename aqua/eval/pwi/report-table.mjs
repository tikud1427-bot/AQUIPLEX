#!/usr/bin/env node
/** Print a results table from a run's summary.json (Markdown). Usage: node report-table.mjs <runDir> */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const s = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const f = v => (v == null ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));
const ROWS = [
  ['Claim recall', m => m.claim.recall],
  ['Claim recall (fact store only)', m => m.claim.recallFactStore],
  ['Claim accuracy', m => m.claim.accuracy],
  ['Claim recall — chat', m => m.claim.recallChat],
  ['Claim recall — documents', m => m.claim.recallDocument],
  ['Entity precision (graph)', m => m.entity.precision],
  ['Entity recall (graph, non-place)', m => m.entity.recallGraph],
  ['Entity recall (graph or fact)', m => m.entity.recallStructured],
  ['Entity type agreement', m => m.entity.typeAgreement],
  ['Relationship precision', m => m.relationship.precision],
  ['Relationship recall', m => m.relationship.recall],
  ['Stale relation edges', m => m.relationship.staleEdges],
  ['Context completeness (mean)', m => m.contextCompleteness.mean],
  ['— misses: capture / retrieval', m => `${m.contextCompleteness.missCapture} / ${m.contextCompleteness.missRetrieval}`],
  ['Retrieval relevance (precision mean)', m => m.retrievalRelevance.precisionMean],
  ['Irrelevant items per probe', m => m.retrievalRelevance.irrelevantItemsPerProbe],
  ['Temporal probe accuracy', m => m.temporal.probeAccuracy],
  ['Stale-unmarked rate', m => m.temporal.staleUnmarkedRate],
  ['Stale quoted / with change note', m => `${m.temporal.staleQuoted} / ${m.temporal.staleQuotedWithChangeNote}`],
  ['Changes (world + corrections)', m => m.contradiction.changes],
  ['Contradiction detected in store', m => m.contradiction.detectedInStore],
  ['Contradiction handled in context', m => m.contradiction.handledInContext],
  ['Correction: store views consistent', m => m.correctionPropagation.storeViewsConsistent],
  ['Correction: context consistent', m => m.correctionPropagation.contextConsistent],
  ['World change: store views consistent', m => m.correctionPropagation.worldChangeStoreViewsConsistent],
  ['Cross-source completeness', m => m.crossSource.completeness],
  ['Document items in context', m => m.crossSource.documentItems],
  ['Personalised: completeness', m => m.personalizedReasoning.completeness],
  ['Personalised: precision', m => m.personalizedReasoning.precision],
  ['Hedged held as fact / hedged', m => `${m.uncertainty.hedgedAsFact} / ${m.uncertainty.hedged}`],
  ['Hedged unmarked in context / checks', m => `${m.uncertainty.hedgedUnmarkedInContext} / ${m.uncertainty.hedgedChecks}`],
  ['Unknown acknowledged', m => m.uncertainty.unknownAcknowledged],
  ['Deletion: store compliance', m => m.deletion.complianceStore],
  ['Deletion: items fully gone / items', m => `${m.deletion.itemsFullyGone} / ${m.deletion.items}`],
  ['Deletion: in facts held / source text only', m => `${m.deletion.factsHeld} / ${m.deletion.factsSourceTextOnly}`],
  ['Deletion: in Mind / evidence', m => `${m.deletion.mind} / ${m.deletion.evidence}`],
  ['Deletion: context violations', m => m.deletion.contextViolations],
  ['Isolation: store / context leaks', m => `${m.isolation.storeLeaks} / ${m.isolation.contextLeaks}`],
  ['Answer factuality', () => 'not measured'],
  ['Personalised answer quality', () => 'not measured'],
  ['Quantity: facts / nodes / edges', m => `${m.quantity.facts} / ${m.quantity.nodes} / ${m.quantity.edges}`],
];
for (const [cell, a] of Object.entries(s.arms)) {
  const st = Object.keys(a.stages);
  console.log(`\n### ${cell}${a.infraFailures.length ? ` — INFRA FAILURES: ${a.infraFailures.length}` : ''}\n`);
  console.log(`| Metric | ${st.join(' | ')} |\n|---|${st.map(() => '---').join('|')}|`);
  for (const [label, get] of ROWS) console.log(`| ${label} | ${st.map(x => f(get(a.stages[x].metrics))).join(' | ')} |`);
  console.log(`| Persistence (identical after restart) | ${st.map(x => f(a.stages[x].persistence?.identical)).join(' | ')} |`);
  console.log(`| Infra: events/probes/other/network | ${st.map(x => { const i = a.stages[x].infra; return `${i.events}/${i.probes}/${i.other}/${i.networkBlocked}`; }).join(' | ')} |`);
}
