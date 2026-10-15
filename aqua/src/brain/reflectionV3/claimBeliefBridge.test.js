/**
 * E9: canonical claims seed beliefs through the curated bridge — and only
 * first-person, current, factual claims with a curated target do.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { claimToBeliefSignal, planBridgeSignals } from './claimBeliefBridge.js';
import { reflectClaimsToBeliefs } from './claimBeliefAdapter.js';

const claim = (over = {}) => ({
  claimId: 'c1', subjectType: 'self', predicate: 'works_at', object: { entity: 'Nummo' },
  polarity: 'asserted', modality: 'fact', state: 'active', ...over,
});

describe('claimToBeliefSignal', () => {
  test('a first-person current fact maps to the curated belief target', () => {
    assert.deepEqual(
      (({ dimension, key, value, support, source }) => ({ dimension, key, value, support, source }))(claimToBeliefSignal(claim())),
      { dimension: 'identity', key: 'organization', value: 'Nummo', support: true, source: 'fact_bridge' });
    assert.equal(claimToBeliefSignal(claim({ predicate: 'role_is', object: { literal: 'tech lead' } })).key, 'profession');
    assert.equal(claimToBeliefSignal(claim({ predicate: 'uses', object: { entity: 'Postgres' } })).key, 'tech:postgres');
  });
  test('NOT every claim is a belief', () => {
    assert.equal(claimToBeliefSignal(claim({ subjectType: 'person' })), null, 'a claim about someone else');
    assert.equal(claimToBeliefSignal(claim({ modality: 'intent' })), null, 'an intent');
    assert.equal(claimToBeliefSignal(claim({ state: 'superseded' })), null, 'history');
    assert.equal(claimToBeliefSignal(claim({ predicate: 'blocks', object: { entity: 'launch' } })), null, 'no curated target');
  });
  test('a negated claim is contradicting evidence for the same value', () => {
    assert.equal(claimToBeliefSignal(claim({ polarity: 'negated' })).support, false);
  });
});

describe('planBridgeSignals', () => {
  test('an already-linked claim is left to J2; a belief already holding the value is LINKED, not re-applied', () => {
    const beliefs = { 'identity:organization': { id: 'b1', dimension: 'identity', key: 'organization', value: 'Nummo' } };
    const out = planBridgeSignals({ claims: [claim(), claim({ claimId: 'c2' })], linkedClaimIds: new Set(['c1']), beliefs });
    assert.equal(out.apply.length, 0);
    assert.equal(out.linkOnly.length, 1);
    assert.equal(out.linkOnly[0].signal.claimId, 'c2');
  });
});

describe('reflectClaimsToBeliefs seeds and links', () => {
  const run = async (mind, claims, events = []) => {
    const links = [];
    const r = await reflectClaimsToBeliefs({
      ownerId: 'u', affectedClaims: claims, reflectionEvents: events,
      deps: {
        getMind: () => mind,
        beliefsForClaim: async () => [],
        linkBeliefClaim: async row => { links.push(row); return row; },
      },
    });
    return { r, links };
  };

  test('a new first-person claim creates the belief and the provenance link', async () => {
    const mind = { beliefs: {} };
    const { r, links } = await run(mind, [claim()], [{ claimId: 'c1', eventType: 'created' }]);
    assert.equal(r.seeded, 1);
    assert.equal(mind.beliefs['identity:organization'].value, 'Nummo');
    assert.equal(links.length, 1);
    assert.equal(links[0].claimId, 'c1');
    assert.equal(links[0].relation, 'supporting');
  });

  test('a lifecycle event on an unlinked claim seeds nothing (revision belongs to linked beliefs)', async () => {
    const mind = { beliefs: {} };
    const { r } = await run(mind, [claim()], [{ claimId: 'c1', eventType: 'superseded' }]);
    assert.equal(r.seeded, 0);
    assert.deepEqual(mind.beliefs, {});
  });

  test('a claim about another person never becomes a belief about the user', async () => {
    const mind = { beliefs: {} };
    const { r, links } = await run(mind, [claim({ subjectType: 'person' })], [{ claimId: 'c1', eventType: 'created' }]);
    assert.equal(r.seeded, 0);
    assert.equal(links.length, 0);
  });
});
