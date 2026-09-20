/**
 * AQUIPLEX — End-to-end World-Model Lift
 *
 * This suite is deliberately NOT a promotion gate. It measures whether the
 * world-model Context Engine changes the answer produced by the SAME provider
 * when both lanes receive evidence from the SAME seeded world.
 *
 * Automated score is conservative: "reference coverage" checks whether the
 * generated answer contains at least one meaningful token from a judged
 * relevant/acceptable fact. It is not a semantic judge and must not be sold as
 * human preference or answer correctness.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedWorld } from '../adapters/currentRetrieval.mjs';
import { generatePairedAnswers } from '../adapters/pairedAnswerLift.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = JSON.parse(readFileSync(path.join(HERE, '../datasets/retrieval-core.v1.json'), 'utf8'));
const OWNER = 'user:eval-world-model-lift-e2e';
let seeded = false;

const stop = new Set(['the','a','an','is','are','i','my','our','we','to','of','in','on','and','for','do','did','what','where','when','who','how','why','does','with','from','it','this','that','you','me']);

function tokens(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9]+/g,' ').split(/\s+/).filter(x => x.length >= 4 && !stop.has(x)));
}
function referenceTokens(ids) {
  return tokens(ids.map(id => DS.corpus.find(f => f.id === id)?.statement ?? '').join(' '));
}
function covers(answer, ids) {
  const a = tokens(answer);
  const r = referenceTokens(ids);
  for (const t of r) if (a.has(t)) return true;
  return false;
}
function exactPhraseCoverage(answer, ids) {
  const a = String(answer).toLowerCase();
  return ids.some(id => {
    const s = DS.corpus.find(f => f.id === id)?.statement ?? '';
    const words = [...tokens(s)].slice(0, 4);
    return words.length >= 2 && words.every(w => a.includes(w));
  });
}

export default {
  id: 'world-model-lift-e2e',
  title: 'World-Model Lift — paired provider answers',
  about: [
    'Same 60-fact world, same query set, same provider/router and same answer rubric.',
    'Control receives production-floor evidence; treatment receives Context Engine evidence.',
    'Automated scoring is conservative reference-token coverage, not a semantic or human-quality score.',
  ].join('\n'),

  cases: DS.queries,

  async run(testCase) {
    if (!seeded) {
      await seedWorld(OWNER, DS.corpus);
      seeded = true;
    }
    return generatePairedAnswers(OWNER, testCase);
  },

  score(testCase, actual) {
    const relevant = testCase.relevant ?? [];
    const acceptable = [...new Set([...(testCase.relevant ?? []), ...(testCase.acceptable ?? [])])];
    const floor = actual.floor;
    const worldModel = actual.worldModel;
    const floorCoverage = covers(floor.answer, acceptable);
    const worldCoverage = covers(worldModel.answer, acceptable);
    const floorRelevant = covers(floor.answer, relevant);
    const worldRelevant = covers(worldModel.answer, relevant);
    return {
      correct: worldRelevant,
      cat: testCase.cat,
      floor: { referenceCoverage: floorCoverage, relevantCoverage: floorRelevant, phraseCoverage: exactPhraseCoverage(floor.answer, acceptable) },
      worldModel: { referenceCoverage: worldCoverage, relevantCoverage: worldRelevant, phraseCoverage: exactPhraseCoverage(worldModel.answer, acceptable) },
      provider: { floor: floor.provider, worldModel: worldModel.provider },
    };
  },

  metrics(scored) {
    const mean = key => scored.length ? scored.reduce((n,x) => n + (x[key] ? 1 : 0), 0) / scored.length : 0;
    const fRef = scored.map(x => x.floor.referenceCoverage);
    const wRef = scored.map(x => x.worldModel.referenceCoverage);
    const fRel = scored.map(x => x.floor.relevantCoverage);
    const wRel = scored.map(x => x.worldModel.relevantCoverage);
    const avg = xs => xs.length ? xs.reduce((a,b)=>a+(b?1:0),0)/xs.length : 0;
    return {
      n: scored.length,
      floor: { referenceCoverage: avg(fRef), relevantCoverage: avg(fRel) },
      worldModel: { referenceCoverage: avg(wRef), relevantCoverage: avg(wRel) },
      delta: {
        referenceCoverage: Number((avg(wRef)-avg(fRef)).toFixed(6)),
        relevantCoverage: Number((avg(wRel)-avg(fRel)).toFixed(6)),
      },
      note: 'Reference-token coverage is a conservative automated proxy; it is not semantic correctness, human preference, or an overall product score.',
    };
  },
};
