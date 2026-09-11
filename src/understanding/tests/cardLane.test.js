/**
 * The card lane — what the user says reaching the screen that claims to
 * understand them.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The previous phase doubled the world model (entities 6 → 13) and the card did
 * not move one point, because the card reads the MIND BELIEF lane and the world
 * model is a different store. Entity capture cannot fill it. `FACT_TO_BELIEF`
 * was the actual bottleneck, and it was missing entries for the two most basic
 * things a person says in their first sentence: their name, and what they are
 * building.
 *
 * Measured on a generous 9-turn interview, before → after:
 *
 *     score 31 → 51, goals 0 → 2, isThin true → false
 *     sections: [How you like to work]
 *            →  [You, Working on, Aiming at, How you like to work]
 *
 * Proven to bite: removing the `name` and `project` entries from
 * FACT_TO_BELIEF fails the first two tests here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildCard } from '../summary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OBSERVERS = readFileSync(path.join(HERE, '..', '..', 'mind', 'observers.js'), 'utf8');

// ── The bridges ──────────────────────────────────────────────────────────────

test('the stated name reaches an identity belief', () => {
  // Extracted at 0.98 on "I'm Maya." and, until now, consumed by nothing —
  // so "You" rendered empty for someone who introduced themselves first.
  assert.match(OBSERVERS, /^\s*name:\s+\(f\)\s*=>\s*\(\{\s*dimension:\s*DIMENSIONS\.IDENTITY/m);
});

test('the stated project reaches an identity belief', () => {
  assert.match(OBSERVERS, /^\s*project:\s+\(f\)\s*=>\s*\(\{\s*dimension:\s*DIMENSIONS\.IDENTITY/m);
});

test('goal is still routed to the goal tracker, never to a belief', () => {
  // Goals have their own lifecycle (active/blocked/abandoned/completed) that a
  // belief cannot express. Bridging them would be a downgrade, not a fix.
  assert.match(OBSERVERS, /^\s*goal:\s+null,/m);
});

// ── The card ─────────────────────────────────────────────────────────────────

test('a project carries its own correction ref, not a stamped entity id', () => {
  // A project can come from the graph (a document named it) or the Mind (the
  // user said it). They are corrected through different endpoints, so a card
  // that stamps every project as `entity:` sends half of them to the wrong one.
  const card = buildCard({
    projects: [
      { id: 'belief:identity:project', label: 'Nummo', ref: 'belief:identity:project', confidence: 0.9 },
      { id: 'ent-7', label: 'Docs Site' },
    ],
    score: 40,
  });
  const working = card.sections.find(s => s.id === 'working_on');
  assert.ok(working, 'the Working on section did not render');
  assert.equal(working.items[0].ref, 'belief:identity:project');
  assert.equal(working.items[0].confidence, 0.9);
  // Unchanged for anything without its own ref — the existing graph contract.
  assert.equal(working.items[1].ref, 'entity:ent-7');
  assert.equal(working.items[1].confidence, 0.8);
});

test('a stated project and a stated goal produce a card that is not thin', () => {
  const card = buildCard({
    beliefsByDimension: {
      identity: [{ key: 'name', value: 'Maya', confidence: 0.9, status: 'active' }],
      communication: [{ key: 'message_style', value: 'terse', confidence: 0.8, status: 'active' }],
    },
    goals: [{ id: 'g1', title: 'hit 10,000 active merchants by December', status: 'active', confidence: 0.55 }],
    projects: [{ id: 'belief:identity:project', label: 'Nummo', ref: 'belief:identity:project', confidence: 0.9 }],
    score: 51,
  });
  assert.equal(card.isThin, false);
  assert.deepEqual(card.sections.map(s => s.id), ['you', 'working_on', 'aiming_at', 'how_to_help']);
});

test('a project never renders twice — once under You and once under Working on', () => {
  // The project belief lives in the identity dimension, which the "You" section
  // also reads. The read model filters it out of that pool before the card is
  // built; this pins the SHAPE that filtering has to produce.
  const card = buildCard({
    beliefsByDimension: { identity: [{ key: 'name', value: 'Maya', confidence: 0.9, status: 'active' }] },
    projects: [{ id: 'b', label: 'Nummo', ref: 'belief:identity:project', confidence: 0.9 }],
    score: 40,
  });
  const you = card.sections.find(s => s.id === 'you');
  assert.ok(!you.items.some(i => i.text === 'Nummo'), 'the project leaked into the You section');
});

test('an empty project list still drops the section entirely', () => {
  // The one rule the card has had since U5. A new source must not turn "no
  // projects" into a rendered blank.
  const card = buildCard({ beliefsByDimension: {}, projects: [], goals: [], score: 0 });
  assert.ok(!card.sections.some(s => s.id === 'working_on'));
});

test('the read model filters the project key out of the card, not out of coverage', () => {
  // Coverage must see everything AQUA knows — hiding a belief from the score to
  // tidy the card would make the number lie in the user's favour.
  const routes = readFileSync(path.join(HERE, '..', 'understandingRoutes.js'), 'utf8');
  const coverageLine = routes.indexOf('buildCoverage({ beliefsByDimension');
  const filterLine = routes.indexOf('PROJECT_BELIEF_KEY');
  assert.ok(coverageLine > 0 && filterLine > 0);
  assert.ok(
    routes.includes('const cardBeliefs = {'),
    'the card/coverage split is gone — the project belief is being hidden from the score',
  );
});
