/**
 * Durability self-check (node:test).
 *
 * THE FAILURE THIS GUARDS
 * -----------------------
 * AQUA has two independent ways to survive a redeploy — the Mongo mirror, and
 * AQUA_DATA_DIR on a persistent mount. Either alone is enough. With neither,
 * the service runs perfectly, reports healthy, and loses everything on the next
 * deploy. Nothing checked.
 *
 * The old signal was one warn() at the first failed write, once per process,
 * buried among forty startup lines, and only CONDITIONALLY true — it said data
 * would not survive "until MONGO_URI is reachable", which is wrong if the data
 * directory is a mounted disk. Nobody was told the second path existed.
 *
 * EPHEMERALITY IS PROVEN, NOT GUESSED
 * -----------------------------------
 * The tempting implementation is a path heuristic — /tmp is ephemeral,
 * /var/data probably isn't. A guess printed as a verdict is how a health signal
 * starts lying, which is the exact defect the Jul 31 mirror work fixed. So the
 * check measures: a boot log inside the directory, and a directory that has
 * survived a restart has PROVEN it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assessDurability, recordBoot, formatDurabilityReport, RISK } from '../durability.js';

const DURABLE_MIRROR = { durable: true, enabled: true, verdict: 'ok — writes are reaching Mongo' };
const BROKEN_MIRROR = { durable: false, enabled: true, verdict: 'NOT CONNECTED — file-only' };
const NO_MIRROR = { durable: false, enabled: false, verdict: 'DISABLED — file-only' };

const survived = { boots: 3, writable: true };
const firstBoot = { boots: 1, writable: true };

// ── 1. Either path alone is enough ───────────────────────────────────────────

test('durability: the mirror alone is enough', () => {
  const a = assessDurability({ dataDir: '/tmp/x', mirror: DURABLE_MIRROR, bootHistory: firstBoot });
  assert.equal(a.risk, RISK.SAFE);
  assert.match(a.verdict, /mirror/i);
});

test('durability: a surviving data directory alone is enough', () => {
  // The point of stating both paths: an operator chasing an unreachable Atlas
  // cluster may be one env var away from being safe without it.
  const a = assessDurability({ dataDir: '/var/data/aqua', mirror: BROKEN_MIRROR, bootHistory: survived });
  assert.equal(a.risk, RISK.SAFE);
  assert.match(a.verdict, /data directory/i);
});

test('durability: both is reported as both', () => {
  const a = assessDurability({ dataDir: '/var/data/aqua', mirror: DURABLE_MIRROR, bootHistory: survived });
  assert.equal(a.risk, RISK.SAFE);
  assert.match(a.verdict, /both/i);
});

// ── 2. Neither path ──────────────────────────────────────────────────────────

test('durability: unproven is distinguished from at-risk', () => {
  // A first boot with a broken mirror is NOT yet proof of data loss — the
  // directory may well be a mount that simply has not been restarted. Calling
  // that "at risk" would be the same overconfidence the mirror status had when
  // it reported connected:true against a dead cluster.
  const a = assessDurability({ dataDir: '/var/data/aqua', mirror: BROKEN_MIRROR, bootHistory: firstBoot });
  assert.equal(a.risk, RISK.UNPROVEN);
  assert.match(a.verdict, /UNPROVEN/);
  assert.ok(a.actions.some(x => /redeploy once/i.test(x)), 'it must say how to settle the question');
});

test('durability: a proven wipe is AT RISK, in plain words', () => {
  const a = assessDurability({
    dataDir: '/opt/render/project/.aquiplex', mirror: BROKEN_MIRROR,
    bootHistory: firstBoot, restartCount: 4,
  });
  assert.equal(a.risk, RISK.AT_RISK);
  assert.match(a.verdict, /NOT DURABLE/);
  // The consequence is spelled out. "Mirror unavailable" means nothing to
  // someone deciding whether to send users at it.
  assert.match(a.verdict, /world model|memory|conversation/i);
});

test('durability: an unwritable data directory is AT RISK', () => {
  const a = assessDurability({ dataDir: '/nope', mirror: BROKEN_MIRROR, bootHistory: { boots: 1, writable: false } });
  assert.equal(a.risk, RISK.AT_RISK);
  assert.ok(a.actions.some(x => /permission|writable|mount/i.test(x)));
});

test('durability: an unsafe verdict always warns against real users', () => {
  for (const boot of [firstBoot, { boots: 1, writable: false }]) {
    const a = assessDurability({ dataDir: '/x', mirror: BROKEN_MIRROR, bootHistory: boot });
    assert.ok(a.actions.some(x => /do not ask real users/i.test(x)),
      'the operational consequence must be stated, not implied');
  }
});

test('durability: an unconfigured mirror is reported as a choice, not a fault', () => {
  const a = assessDurability({ dataDir: '/var/data', mirror: NO_MIRROR, bootHistory: survived });
  assert.equal(a.risk, RISK.SAFE);
  assert.ok(a.reasons.some(x => /MONGO_URI unset/i.test(x)));
});

test('durability: a broken mirror points at the doctor', () => {
  const a = assessDurability({ dataDir: '/x', mirror: BROKEN_MIRROR, bootHistory: firstBoot });
  assert.ok(a.actions.some(x => /mirror-doctor/.test(x)),
    'a diagnosis without a next step is just bad news');
});

// ── 3. The boot log — the measurement itself ─────────────────────────────────

test('durability: a boot log survives and accumulates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-boot-'));
  assert.equal(recordBoot(dir).boots, 1);
  assert.equal(recordBoot(dir).boots, 2);
  assert.equal(recordBoot(dir).boots, 3);
  // The whole mechanism: this is what a persistent directory looks like.
  assert.equal(assessDurability({ dataDir: dir, mirror: BROKEN_MIRROR, bootHistory: recordBoot(dir) }).risk, RISK.SAFE);
});

test('durability: a wiped directory resets the count — ephemerality observed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-boot-'));
  recordBoot(dir); recordBoot(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  assert.equal(recordBoot(dir).boots, 1, 'a replaced directory looks like a first boot — which is the signal');
});

test('durability: the boot log is bounded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-boot-'));
  for (let i = 0; i < 40; i++) recordBoot(dir);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.aqua-boot-log.json'), 'utf8'));
  assert.ok(raw.length <= 20, `bounded like every other AQUA store, got ${raw.length}`);
});

test('durability: a corrupt boot log is survivable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-boot-'));
  fs.writeFileSync(path.join(dir, '.aqua-boot-log.json'), 'not json at all');
  assert.equal(recordBoot(dir).boots, 1);
});

test('durability: an unwritable directory is reported, not thrown', () => {
  // This runs during boot. A self-check that crashes the boot it is checking is
  // worse than no self-check.
  const r = recordBoot('/proc/definitely/not/writable');
  assert.equal(r.writable, false);
});

// ── 4. The report ────────────────────────────────────────────────────────────

test('durability: the report leads with the verdict and never repeats an action', () => {
  const a = assessDurability({ dataDir: '/x', mirror: BROKEN_MIRROR, bootHistory: firstBoot });
  const out = formatDurabilityReport(a);
  const firstLine = out.split('\n').find(l => l.includes('[DURABILITY]'));
  assert.match(firstLine, /ATTENTION/);

  const actions = out.split('\n').filter(l => l.trim().startsWith('→'));
  assert.equal(new Set(actions).size, actions.length, 'a repeated instruction reads as noise, not emphasis');
});

test('durability: a safe report is quiet', () => {
  const out = formatDurabilityReport(assessDurability({ dataDir: '/x', mirror: DURABLE_MIRROR, bootHistory: survived }));
  assert.ok(!/ATTENTION|⚠/.test(out), 'a warning printed every boot regardless of state stops being read');
});

test('durability: assessDurability never throws on junk', () => {
  for (const bad of [undefined, {}, { mirror: null, bootHistory: null }, { mirror: 'x', bootHistory: 7 }]) {
    const a = assessDurability(bad);
    assert.ok(Object.values(RISK).includes(a.risk));
    assert.equal(typeof a.verdict, 'string');
  }
});
