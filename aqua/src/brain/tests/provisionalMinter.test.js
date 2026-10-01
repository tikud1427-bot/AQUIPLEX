/**
 * S6's missing half. See understanding/provisionalMinter.js for the measured
 * failure: a claim about a name the identity map had never seen was labelled
 * `new-provisional`, left UNREADY, and nothing ever inserted it — so the world
 * model could only learn about things it already knew.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mintProvisionalEntities, isMintableSurface, MAX_MINTS_PER_TURN, MINTED_TIER, MINT_KIND } from '../understanding/provisionalMinter.js';
import { TIER } from '../understanding/entityResolution.js';
import * as Brain from '../index.js';
import * as canonicalIds from '../identity/canonicalId.js';
import { putEntry } from '../identity/idStore.js';
import { SELF_CANONICAL_ID, SELF_KIND, SELF_LABEL } from '../identity/selfEntity.js';

const SELF = { entityId: 'aq:self:owner', tier: TIER.SELF, provisional: false };
const prov = (name) => ({ entityId: null, tier: TIER.PROVISIONAL, provisional: true, proposedName: name, normalized: name.toLowerCase() });
const mk = (object, over = {}) => ({
  predicate: 'works_at', objectKind: 'entity', subject: 'I', object: { entity: object },
  statementText: `I work at ${object}`,
  resolution: { subject: SELF, object: prov(object), ready: false, blockedBy: 'object:new-provisional' },
  ...over,
});
const fakeMint = () => {
  const seen = new Map(); const calls = [];
  const fn = (owner, spec) => {
    calls.push({ owner, ...spec });
    const key = spec.name.toLowerCase();
    const created = !seen.has(key);
    if (created) seen.set(key, `aq:name:${key}`);
    return { id: seen.get(key), created, ambiguous: null };
  };
  fn.calls = calls; return fn;
};

describe('mintProvisionalEntities', () => {
  test('a provisional object is MINTED and the claim becomes READY', () => {
    const mint = fakeMint();
    const out = mintProvisionalEntities([mk('Intercom')], { ownerId: 'u1', mint });
    assert.equal(out.readyForS7.length, 1, 'the claim stayed unready — nothing was inserted');
    const c = out.claims[0];
    assert.equal(c.objectEntityId, 'aq:name:intercom');
    assert.equal(c.resolution.object.tier, MINTED_TIER);
    assert.equal(c.resolution.object.provisional, false);
    assert.equal(c.resolution.blockedBy, null);
    assert.deepEqual(out.stats, { minted: 1, reused: 0, refused: {} });
  });

  test('minted UNDER-TYPED (wildcard kind), owner-scoped — never guesses org vs place', () => {
    const mint = fakeMint();
    mintProvisionalEntities([mk('Mercury')], { ownerId: 'u-scope', mint });
    assert.deepEqual(mint.calls, [{ owner: 'u-scope', name: 'Mercury', kind: MINT_KIND }]);
    assert.equal(MINT_KIND, 'name');
  });

  test('the SAME name twice in a turn is minted once and REUSED (L8: one thing, one id)', () => {
    const out = mintProvisionalEntities([mk('Nummo'), mk('nummo', { statementText: 'I like nummo' })], { ownerId: 'u', mint: fakeMint() });
    assert.equal(out.stats.minted, 1);
    assert.equal(out.stats.reused, 1);
    assert.equal(out.claims[0].objectEntityId, out.claims[1].objectEntityId);
  });

  test('does not mutate its input', () => {
    const input = [mk('Intercom')];
    const snap = JSON.stringify(input);
    mintProvisionalEntities(input, { ownerId: 'u', mint: fakeMint() });
    assert.equal(JSON.stringify(input), snap);
  });

  test('already-ready claims pass through untouched, by identity', () => {
    const ready = { predicate: 'x', resolution: { ready: true, subject: SELF, object: SELF } };
    const mint = fakeMint();
    const out = mintProvisionalEntities([ready], { ownerId: 'u', mint });
    assert.equal(out.claims[0], ready);
    assert.equal(mint.calls.length, 0);
  });

  test('AMBIGUOUS ends are never minted — a third candidate is the fusion S6 refused to guess', () => {
    const amb = { entityId: null, tier: TIER.AMBIGUOUS, provisional: false, candidates: [{}, {}] };
    const c = mk('Rahul', { resolution: { subject: SELF, object: amb, ready: false, blockedBy: 'object:ambiguous' } });
    const mint = fakeMint();
    const out = mintProvisionalEntities([c], { ownerId: 'u', mint });
    assert.equal(mint.calls.length, 0);
    assert.equal(out.readyForS7.length, 0);
  });

  test('deixis with no self entity is never minted into one', () => {
    const noSelf = { entityId: null, tier: TIER.SELF, provisional: false, reason: 'no-self-entity' };
    const c = mk('Nummo', { resolution: { subject: noSelf, object: prov('Nummo'), ready: false, blockedBy: 'subject:self-grammar' } });
    const out = mintProvisionalEntities([c], { ownerId: 'u', mint: fakeMint() });
    assert.equal(out.readyForS7.length, 0, 'a claim with no subject became ready');
    assert.equal(out.claims[0].resolution.subject.entityId, null);
  });

  test('refusals are COUNTED BY REASON, not silent (L13)', () => {
    const out = mintProvisionalEntities(
      [mk('it'), mk('my manager'), mk('someone'), mk('Intercom')], { ownerId: 'u', mint: fakeMint() });
    assert.deepEqual(out.stats.refused, { pronoun: 2, description: 1 });
    assert.equal(out.stats.minted, 1);
  });

  test('the per-turn cap binds, and the overflow is counted not dropped silently', () => {
    const many = Array.from({ length: MAX_MINTS_PER_TURN + 3 }, (_, i) => mk(`Org${String.fromCharCode(65 + i)}${i}`));
    const out = mintProvisionalEntities(many, { ownerId: 'u', mint: fakeMint() });
    assert.equal(out.stats.minted, MAX_MINTS_PER_TURN);
    assert.equal(out.stats.refused['turn-cap'], 3);
    assert.equal(out.readyForS7.length, MAX_MINTS_PER_TURN);
  });

  test('a minter that throws, returns nothing, or reports ambiguity fails CLOSED per claim, never the batch', () => {
    const boom = () => { throw new Error('idStore down'); };
    let out = mintProvisionalEntities([mk('A1'), mk('B2')], { ownerId: 'u', mint: boom });
    assert.deepEqual(out.stats.refused, { 'mint-threw': 2 });
    out = mintProvisionalEntities([mk('A1')], { ownerId: 'u', mint: () => null });
    assert.deepEqual(out.stats.refused, { 'mint-returned-no-id': 1 });
    out = mintProvisionalEntities([mk('A1')], { ownerId: 'u', mint: () => ({ id: 'x', ambiguous: { score: .7 } }) });
    assert.deepEqual(out.stats.refused, { 'identity-ambiguous': 1 });
    assert.equal(out.readyForS7.length, 0);
  });

  test('no minter or no owner = inert passthrough', () => {
    const c = [mk('Intercom')];
    assert.equal(mintProvisionalEntities(c, { ownerId: 'u' }).readyForS7.length, 0);
    assert.equal(mintProvisionalEntities(c, { mint: fakeMint() }).readyForS7.length, 0);
  });
});

describe('isMintableSurface', () => {
  const ok = ['Intercom', 'Nummo Labs', 'The Hague', '3M', 'Priya', 'Mary-Jane', 'São Paulo', 'AT&T'];
  const no = [['it', 'pronoun'], ['someone', 'pronoun'], ['this', 'pronoun'], ['my manager', 'description'],
    ['the project', 'description'], ['a company', 'description'], ['', 'empty'], ['---', 'no-letter'],
    ['x@y.com', 'not-a-name'], ['https://a.b', 'not-a-name'], ['I', 'deixis'], ['my', 'deixis'],
    ['a b c d e f g', 'too-many-tokens'], ['x'.repeat(81), 'too-long']];
  for (const s of ok) test(`mints "${s}"`, () => assert.deepEqual(isMintableSurface(s), { ok: true }));
  for (const [s, reason] of no) test(`refuses ${JSON.stringify(s.slice(0, 20))} as ${reason}`, () => {
    const v = isMintableSurface(s);
    assert.equal(v.ok, false);
    assert.equal(v.reason, reason);
  });
});

// ── The WIRING, through the production facade ───────────────────────────────

describe('understandTurn — minting reaches the canonical commit path', () => {
  // Unique owners per RUN: the identity map persists under AQUA_DATA_DIR, so a
  // fixed owner id turns the second run into "already known" and the test
  // measures leftover state instead of the minter.
  const RUN = Math.random().toString(36).slice(2, 8);
  const saved = {};
  const KEYS = ['AQUA_E6', 'AQUA_E6_COMMIT', 'AQUA_E6_MINT'];
  beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  const worksAt = (name) => async () => ({
    text: JSON.stringify({ claims: [{ subject: 'I', predicate: 'works_at', object: { entity: name },
      polarity: 'asserted', modality: 'fact', timePrecision: 'none',
      statementText: `I work at ${name}`, confidenceExtraction: 0.9 }] }),
    model: 'stub/model',
  });
  const withSelf = (owner) => putEntry(owner, SELF_CANONICAL_ID, { kind: SELF_KIND, canonical: SELF_LABEL, norms: [], refs: [] });

  test('commit ON: an unseen employer becomes READY, with a stored id', async () => {
    process.env.AQUA_E6 = 'on'; delete process.env.AQUA_E6_COMMIT; delete process.env.AQUA_E6_MINT;
    const owner = `u-mint-on-${RUN}`; withSelf(owner);
    const r = await Brain.understandTurn({ ownerId: owner, conversationId: 'c', userMessage: 'I work at Quillbase.', callModel: worksAt('Quillbase') });
    assert.equal(r.readyForS7.length, 1, 'S6 still strands the claim — the minter is not wired');
    assert.equal(r.stats.s6.minted, 1);
    // lookup() returns an OBJECT even on a miss ({id: null, matched: 'none'}), so
    // asserting on the object itself is vacuous — the first draft of this test did.
    assert.equal(canonicalIds.lookup(owner, 'Quillbase').id, r.claims[0].objectEntityId,
      'the minted entity is not in the identity map under the id the claim carries');
    assert.match(r.claims[0].objectEntityId, /^aq:/);
  });

  test('AQUA_E6_MINT=off is the exact rollback: pre-change behaviour, nothing minted', async () => {
    process.env.AQUA_E6 = 'on'; process.env.AQUA_E6_MINT = 'off';
    const owner = `u-mint-off-${RUN}`; withSelf(owner);
    const r = await Brain.understandTurn({ ownerId: owner, conversationId: 'c', userMessage: 'I work at Quillbase.', callModel: worksAt('Quillbase') });
    assert.equal(r.readyForS7.length, 0);
    assert.equal(r.stats.s6.minted, undefined);
    assert.equal(canonicalIds.lookup(owner, 'Quillbase').id, null);
  });

  test('commit OFF: an extractor that is not committing must NOT grow the identity map', async () => {
    process.env.AQUA_E6 = 'on'; process.env.AQUA_E6_COMMIT = 'off'; delete process.env.AQUA_E6_MINT;
    const owner = `u-mint-nocommit-${RUN}`; withSelf(owner);
    const r = await Brain.understandTurn({ ownerId: owner, conversationId: 'c', userMessage: 'I work at Quillbase.', callModel: worksAt('Quillbase') });
    assert.equal(r.readyForS7.length, 0);
    assert.equal(canonicalIds.lookup(owner, 'Quillbase').id, null, 'shadow-mode extraction wrote into the identity map');
  });

  test('MINT=on cannot override COMMIT=off — minting has nowhere to go without a commit', async () => {
    // The guard on e6CommitEnabled() is invisible while MINT merely follows
    // COMMIT. It is load-bearing exactly when both are set explicitly and
    // disagree, which is the state someone lands in mid-rollback.
    process.env.AQUA_E6 = 'on'; process.env.AQUA_E6_COMMIT = 'off'; process.env.AQUA_E6_MINT = 'on';
    const owner = `u-mint-conflict-${RUN}`; withSelf(owner);
    const r = await Brain.understandTurn({ ownerId: owner, conversationId: 'c', userMessage: 'I work at Quillbase.', callModel: worksAt('Quillbase') });
    assert.equal(r.readyForS7.length, 0);
    assert.equal(canonicalIds.lookup(owner, 'Quillbase').id, null);
  });

  test('owner isolation: owner B does not see owner A\'s minted entity (L19)', async () => {
    process.env.AQUA_E6 = 'on'; delete process.env.AQUA_E6_COMMIT; delete process.env.AQUA_E6_MINT;
    withSelf(`u-iso-a-${RUN}`); withSelf(`u-iso-b-${RUN}`);
    await Brain.understandTurn({ ownerId: `u-iso-a-${RUN}`, conversationId: 'c', userMessage: 'I work at Quillbase.', callModel: worksAt('Quillbase') });
    assert.ok(canonicalIds.lookup(`u-iso-a-${RUN}`, 'Quillbase').id, 'precondition: owner A has the entity');
    assert.equal(canonicalIds.lookup(`u-iso-b-${RUN}`, 'Quillbase').id, null);
  });
});

// ── S8: a changed employer must be EMITTED, not silently doubled ────────────
import { dedupAndDetect } from '../understanding/claimDedup.js';
import { singleValuedPredicates, SINGLE_VALUED } from '../index.js';

describe('single-valued predicates reach S8', () => {
  const claim = (obj, over = {}) => ({ subject: 'aq:self:owner', predicate: 'works_at', objectKind: 'entity',
    object: { entity: obj }, objectEntityId: `aq:name:${obj.toLowerCase()}`, polarity: 'asserted', modality: 'fact', ...over });
  const KEY = 'AQUA_E6_SINGLE_VALUED';
  const was = process.env[KEY];
  afterEach(() => { if (was === undefined) delete process.env[KEY]; else process.env[KEY] = was; });

  test('default OFF: empty set — behaviour identical to before', () => {
    delete process.env[KEY];
    assert.equal(singleValuedPredicates().size, 0);
    assert.equal(dedupAndDetect([claim('Nummo')], [claim('Intercom')], { functionalPredicates: singleValuedPredicates() }).contradictions.length, 0);
  });

  test('ON: Intercom -> Nummo is EMITTED as an object contradiction, and both claims survive', () => {
    process.env[KEY] = 'on';
    const out = dedupAndDetect([claim('Nummo')], [claim('Intercom')], { functionalPredicates: singleValuedPredicates() });
    assert.equal(out.contradictions.length, 1);
    assert.equal(out.contradictions[0].kind, 'object');
    assert.equal(out.claims.length, 2, 'S8 must emit, never resolve (Reflection decides)');
  });

  test('ON: a past-tense employer with a closed validity window is NOT a contradiction', () => {
    process.env[KEY] = 'on';
    const old = claim('Intercom', { validTo: '2024-06-01' });
    const now = claim('Nummo', { validFrom: '2024-07-01' });
    assert.equal(dedupAndDetect([now], [old], { functionalPredicates: singleValuedPredicates() }).contradictions.length, 0);
  });

  test('ON: the SAME employer restated is corroboration, not contradiction', () => {
    process.env[KEY] = 'on';
    const out = dedupAndDetect([claim('Nummo')], [claim('Nummo')], { functionalPredicates: singleValuedPredicates() });
    assert.equal(out.contradictions.length, 0);
  });

  test('only works_at is declared — an unreviewed predicate is never silently single-valued', () => {
    assert.deepEqual([...SINGLE_VALUED], ['works_at']);
  });
});

describe('S8 compares in the STORED vocabulary', () => {
  const stored = { subject: 'You', predicate: 'works_at', objectKind: 'entity', object: { entity: 'Intercom' }, polarity: 'asserted', modality: 'fact' };
  const fn = new Set(['works_at']);

  test('why it matters: surface text "I" never meets the stored label "You"', () => {
    const surface = { ...stored, subject: 'I', object: { entity: 'Nummo' } };
    const canonical = { ...stored, object: { entity: 'Nummo' } };
    assert.equal(dedupAndDetect([surface], [stored], { functionalPredicates: fn }).contradictions.length, 0,
      'if this fires, S8 has started normalising on its own and the facade mapping is redundant');
    assert.equal(dedupAndDetect([canonical], [stored], { functionalPredicates: fn }).contradictions.length, 1);
  });

  // STRUCTURAL, and labelled as such: the facade needs Postgres to execute, so
  // this pins the call site. The behaviour itself was verified on a real
  // database (Intercom -> Nummo emits claim.contradiction.detected; a restated
  // claim adds neither a row nor a second event).
  test('the facade hands S8 the canonical-vocabulary claims, not the raw segment', async () => {
    const fs = await import('node:fs'); const url = await import('node:url'); const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../index.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.match(src, /dedupAndDetect\(forS8,\s*existing,\s*\{\s*functionalPredicates:\s*singleValuedPredicates\(\)/);
    assert.doesNotMatch(src, /dedupAndDetect\(segment\.claims/);
  });
});
