/**
 * E6 — the extraction prompt must not contain the exam.
 *
 * Found 2026-10-03: six of the eleven few-shot examples were VERBATIM
 * extraction-core cases ("I don't use Postgres anymore.", "We haven't decided
 * on pricing.", ...), two more were near-copies, and rule 2 quoted a third.
 * Every E6 score measured with that prompt was partly a memory test — the model
 * was shown the answer to the question it was then graded on. Those numbers are
 * upper bounds, not measurements.
 *
 * The check reads the DATASET, not a list of known-bad sentences, so a new
 * eval case cannot be leaked into the prompt without this failing. Two levels:
 *   · no eval sentence appears, normalised, anywhere in the rendered prompt
 *   · no example segment or quoted rule sentence is a near-paraphrase
 *     (token Jaccard ≥ 0.5) of any eval sentence
 *
 * Run: node --test src/brain/tests/extractionPromptContamination.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtractionPrompt, FIXTURES } from '../understanding/extractionPrompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATASET = JSON.parse(readFileSync(
  path.resolve(HERE, '..', '..', '..', 'eval', 'datasets', 'extraction-core.v1.json'), 'utf8'));

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = s => new Set(norm(s).split(' ').filter(Boolean));
export function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter || 1);
}
export const NEAR = 0.5;

/** Every sentence-like quoted string in the system prompt's prose (examples excluded). */
function quotedProse(system) {
  const prose = system.split('EXAMPLES')[0];
  return [...prose.matchAll(/"([^"]{12,})"/g)].map(m => m[1]).filter(q => q.includes(' '));
}

export function contamination(system, examples, cases) {
  const hits = [];
  const flat = ` ${norm(system)} `;
  for (const c of cases) {
    if (flat.includes(` ${norm(c.text)} `)) hits.push({ kind: 'verbatim', id: c.id, text: c.text });
  }
  const probes = [
    ...examples.map(e => ({ where: `example ${e.id}`, text: e.segment })),
    ...quotedProse(system).map(q => ({ where: 'rule text', text: q })),
  ];
  for (const p of probes) for (const c of cases) {
    const j = jaccard(p.text, c.text);
    if (j >= NEAR) hits.push({ kind: 'near', where: p.where, id: c.id, j: +j.toFixed(2), text: p.text });
  }
  return hits;
}

const system = buildExtractionPrompt('placeholder segment', { asOf: '2026-10-03T00:00:00.000Z', nonce: 'n' }).system;

describe('extraction prompt ∩ extraction-core = ∅', () => {
  test('precondition: the dataset and the examples were actually read', () => {
    assert.ok(DATASET.cases.length >= 200, `only ${DATASET.cases.length} cases loaded`);
    assert.ok(FIXTURES.examples.length >= 8, `only ${FIXTURES.examples.length} examples loaded`);
    assert.ok(system.includes('EXAMPLES'), 'prompt has no examples section to check');
  });

  test('no eval sentence and no near-paraphrase of one appears in the prompt', () => {
    const hits = contamination(system, FIXTURES.examples, DATASET.cases);
    assert.deepEqual(hits, [], `prompt leaks the exam:\n${hits.map(h => JSON.stringify(h)).join('\n')}`);
  });
});

describe('the check bites (mutant controls)', () => {
  test('a verbatim eval case planted as an example is caught', () => {
    const victim = DATASET.cases.find(c => c.cat === 'negation');
    const ex = [...FIXTURES.examples, { id: 'fx-planted', segment: victim.text, claims: [] }];
    const planted = `${system}\nINPUT: ${victim.text}`;
    const hits = contamination(planted, ex, DATASET.cases);
    assert.ok(hits.some(h => h.kind === 'verbatim' && h.id === victim.id));
    assert.ok(hits.some(h => h.kind === 'near' && h.where === 'example fx-planted'));
  });

  test('a light paraphrase (one word added) is caught as near', () => {
    const victim = DATASET.cases.find(c => c.id === 'negation-004') ?? DATASET.cases[0];
    const para = victim.text.replace(/\.$/, ' anymore.');
    const hits = contamination(system, [{ id: 'fx-para', segment: para, claims: [] }], DATASET.cases);
    assert.ok(hits.some(h => h.where === 'example fx-para'), `paraphrase "${para}" slipped through`);
  });

  test('an eval sentence quoted inside rule prose is caught', () => {
    const victim = DATASET.cases.find(c => c.cat === 'negation' && c.text.split(' ').length >= 4);
    const leaked = system.replace('RULES', `RULES\n  0. e.g. "${victim.text.replace(/\.$/, '')}" is negated.`);
    const hits = contamination(leaked, [], DATASET.cases);
    assert.ok(hits.length > 0, 'a quoted eval sentence in the rules was not detected');
  });

  test('an unrelated sentence is NOT flagged (no false alarm)', () => {
    const hits = contamination('nothing here', [{ id: 'x', segment: 'Leena paints watercolours on Sunday evenings.', claims: [] }], DATASET.cases);
    assert.deepEqual(hits, []);
  });
});
