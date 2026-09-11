/**
 * Claim shadow mode degrades and DECLARES · AQUA_GRAPH gates a live endpoint
 * Blueprint E5/PR-5 · E4/PR-9 · L11 · L13
 *
 * BITE, MEASURED (revert the named property → count failures):
 *   PG-absent returns a reason        → 2 fail
 *   PG-absent degrades instead of throwing → 1 fail
 *   AQUA_GRAPH gates the orchestrate endpoint → 2 fail
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveClaimShadowMode, claimShadowBootLine, CLAIMS_SHADOW_FLAG } from '../claims/shadowMode.js';
import { GATES } from '../flags.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function withFlag(value, fn) {
  const saved = process.env.AQUA_CLAIMS_SHADOW;
  if (value === undefined) delete process.env.AQUA_CLAIMS_SHADOW;
  else process.env.AQUA_CLAIMS_SHADOW = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.AQUA_CLAIMS_SHADOW;
    else process.env.AQUA_CLAIMS_SHADOW = saved;
  }
}

// ── E5/PR-5 — the PG-absent contract ─────────────────────────────────────────

describe('claim shadow mode: requested without Postgres DEGRADES AND SAYS SO', () => {
  test('THE CONTRACT: flag on, no DATABASE_URL → off, with the reason', async () => {
    // The decision this PR exists to settle, taken from `configureStorageFromEnv`
    // rather than invented. Throwing would break L11; silence would break L13.
    const r = await withFlag('on', () => resolveClaimShadowMode({ isConfigured: () => false }));
    assert.equal(r.mode, 'off');
    assert.match(r.reason, /AQUA_CLAIMS_SHADOW=on but DATABASE_URL is not set/);
  });

  test('the reason reaches the boot line — that is the whole point', async () => {
    const r = await withFlag('on', () => resolveClaimShadowMode({ isConfigured: () => false }));
    assert.match(claimShadowBootLine(r), /shadow=off \(AQUA_CLAIMS_SHADOW=on but DATABASE_URL/);
  });

  test('a THROWING probe degrades too — enrichment never costs a turn (L11)', async () => {
    const r = await withFlag('on', () => resolveClaimShadowMode({
      isConfigured: () => { throw new Error('pool exploded'); },
    }));
    assert.equal(r.mode, 'off');
    assert.match(r.reason, /pool exploded/);
  });

  test('flag OFF is off with NO reason — silence is correct when nothing was asked', async () => {
    // A reason on the default path would train an operator to ignore the field.
    const r = await withFlag(undefined, () => resolveClaimShadowMode({ isConfigured: () => true }));
    assert.equal(r.mode, 'off');
    assert.equal(r.reason, null);
    assert.equal(claimShadowBootLine(r), '[CLAIMS] shadow=off');
  });

  test('flag on WITH Postgres resolves to shadow, and says JSON stays authoritative', async () => {
    const r = await withFlag('on', () => resolveClaimShadowMode({ isConfigured: () => true }));
    assert.equal(r.mode, 'shadow');
    assert.match(claimShadowBootLine(r), /JSON facts remain authoritative/);
  });

  test('the flag goes through the ONE registry — no second config mechanism', () => {
    const g = GATES.find(x => x.name === CLAIMS_SHADOW_FLAG);
    assert.ok(g, 'the claims shadow flag is not registered');
    assert.equal(g.dflt, 'off');
  });

  test('NOTHING IS WRITTEN YET — this module resolves, it does not project', () => {
    // Guards against the next change quietly turning a mode resolver into a
    // writer without the parity reporting E5/PR-6 requires.
    const text = readFileSync(path.join(SRC, 'core/claims/shadowMode.js'), 'utf8');
    assert.ok(!/recordClaim|attachEvidence|supersede/.test(text),
      'shadowMode.js now writes claims — PR-6 needs parity reporting before that ships');
  });
});

// ── E4/PR-9 — AQUA_GRAPH gates a LIVE endpoint ───────────────────────────────

describe('AQUA_GRAPH is a live endpoint gate, not a dead flag', () => {
  const orchestrate = () => readFileSync(path.join(SRC, 'routes/intelligence.js'), 'utf8');

  test('the audit was WRONG: the flag has a second, dedicated call site', () => {
    // The audit recorded AQUA_GRAPH as living "only in the POST /chat handler"
    // and offered deletion as an option. `POST /api/aqua/intelligence/orchestrate`
    // is a reachable authenticated route with its own kill switch. Deleting the
    // flag would silently UN-GATE a live endpoint — the opposite of the cleanup
    // it was filed as.
    assert.match(orchestrate(), /AQUA_GRAPH/,
      'the orchestrate route no longer reads AQUA_GRAPH — if it was removed, say why');
  });

  test('the endpoint is gated BEFORE it runs the graph', () => {
    const text = orchestrate();
    const flagAt = text.indexOf('AQUA_GRAPH');
    const runAt = text.indexOf('runTaskGraph');
    assert.ok(flagAt >= 0 && runAt >= 0);
    assert.ok(flagAt < runAt, 'the graph runs before its kill switch is consulted');
  });

  test('it is registered, so it is no longer dark (L13)', () => {
    const g = GATES.find(x => x.name === 'AQUA_GRAPH');
    assert.ok(g, 'AQUA_GRAPH is not in the registry');
    assert.equal(g.dflt, 'off');
    assert.match(g.note ?? '', /orchestrate/,
      'the registry does not record that this gate protects an endpoint');
  });
});
