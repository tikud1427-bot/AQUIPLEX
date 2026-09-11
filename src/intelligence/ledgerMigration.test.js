/**
 * Learning Ledger — Phase 0 migration test (audit F2).
 *
 * The context-blind verification bug booked wrongful "I cannot watch
 * videos" rewrites as legitimate revisions, poisoning v1 aggregates three
 * ways (revisionRate death-spiral, inflated ran counts, provider priors).
 * Aggregates can't separate wrongful from legitimate after the fact, so v2
 * QUARANTINES v1 wholesale and cold-starts (cold start is a guaranteed-
 * neutral state by the ledger's own MIN_SAMPLE design).
 *
 * This file controls import order deliberately: AQUA_DATA_DIR is pointed at
 * a temp dir and a poisoned v1 ledger is written to disk BEFORE the module
 * graph loads, so loadFromDisk() (module-load side effect) exercises the
 * real migration path — no mocks. Run standalone: its own node process,
 * fresh module cache.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-ledger-migration-'));
process.env.AQUA_DATA_DIR = TMP;

const STORE = path.join(TMP, '.aqua-ledger.json');

// A v1 ledger poisoned the way the bug poisoned production: 'analysis'
// (where media questions landed pre-F14) far past every learned threshold.
const POISONED_V1 = {
  version: 1,
  byTask: {
    analysis: {
      turns: 40,
      confidenceEwma: 0.45,
      verification: { warranted: 30, ran: 30, revised: 22, failedOpen: 0, inconclusive: 0 }, // 73% revisionRate
      byProvider: {
        gemini: { turns: 25, confidenceEwma: 0.9, latencyEwma: 900, revised: 20, failedOpen: 0 }, // grounded answers wrongly "corrected"
      },
    },
    coding: {
      turns: 15,
      confidenceEwma: 0.8,
      verification: { warranted: 5, ran: 5, revised: 1, failedOpen: 0, inconclusive: 0 },
      byProvider: {},
    },
  },
  updatedAt: '2026-07-01T00:00:00.000Z',
};

let ledger;

before(async () => {
  fs.writeFileSync(STORE, JSON.stringify(POISONED_V1));
  ledger = await import('./learningLedger.js'); // loadFromDisk() fires here
});

test('poisoned v1 stats do NOT reach routing: getTaskStats is null (neutral cold start)', () => {
  assert.equal(ledger.getTaskStats('analysis'), null, 'the 73% revisionRate must not survive');
  assert.equal(ledger.getTaskStats('coding'),   null, 'v1 is quarantined wholesale — aggregates cannot be selectively trusted');
});

test('poisoned provider priors do NOT reach routing: getProviderPrior is 0', () => {
  assert.equal(ledger.getProviderPrior('gemini', 'analysis'), 0);
});

test('v1 data is preserved verbatim in a timestamped quarantine sidecar', () => {
  const sidecar = fs.readdirSync(TMP).find(f => f.includes('.v1-quarantined-'));
  assert.ok(sidecar, 'quarantine sidecar exists');
  const preserved = JSON.parse(fs.readFileSync(path.join(TMP, sidecar), 'utf8'));
  assert.deepEqual(preserved, POISONED_V1, 'nothing lost — full post-mortem possible');
});

test('fresh v2 ledger records outcomes normally after the migration', () => {
  ledger._resetForTests({ persistence: false });
  for (let i = 0; i < ledger.MIN_SAMPLE; i++) {
    ledger.recordOutcome({
      taskType: 'analysis',
      provider: 'gemini',
      responseConfidence: { score: 0.9 },
      verification: { ran: true, revised: false },
      verificationWarranted: true,
    });
  }
  const stats = ledger.getTaskStats('analysis');
  assert.ok(stats, 'sample gate met on clean v2 data');
  assert.equal(stats.revisionRate, 0, 'clean baseline under grounded reviewers');
});
