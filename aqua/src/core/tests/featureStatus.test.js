/**
 * Flag enabled ≠ dependencies present ≠ feature executing ≠ feature healthy
 * (Sprint 1 Task B, 2026-11-10).
 *
 * The audit's production evidence was "legacy read, no Postgres", and in that
 * configuration the boot line reported AQUA_PROACTIVE on — a feature that
 * cannot do anything without a database. featureStatus() derives a state per
 * gate: off | inert (on, dependency missing) | enabled (on, deps present, not
 * yet seen running) | active (observed running) | failing (last outcome failed).
 * Env and infrastructure are injected: nothing here touches process.env.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-feature-status-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';

const F = await import('../flags.js');
const row = (env, name, infra) => F.featureStatus(env, infra ? { infra } : {}).find(r => r.name === name);
const NONE = { db: false, llm: false, 'embedding-key': false, 'dedicated-embedding-key': false };
const ALL = { db: true, llm: true, 'embedding-key': true, 'dedicated-embedding-key': true };

beforeEach(() => F._resetFeatureExecutionsForTests());

describe('defaults in the documented production configuration (no Postgres)', () => {
  test('AQUA_PROACTIVE: flag on, but INERT for want of a database — never "on"', () => {
    const r = row({}, 'AQUA_PROACTIVE', { ...ALL, db: false });
    assert.equal(r.value, 'on');
    assert.equal(r.state, 'inert');
    assert.deepEqual(r.missing, ['no-db']);
  });
  test('canonical read, revision voice, claims shadow, world core: inert or off without a database', () => {
    const env = {};
    const infra = { ...ALL, db: false };
    assert.equal(row(env, 'AQUA_CANONICAL_READ', infra).state, 'inert');
    assert.equal(row(env, 'AQUA_REVISION_VOICE', infra).state, 'inert');
    assert.equal(row(env, 'AQUA_CLAIMS_SHADOW', infra).state, 'off');
    const wc = row(env, 'AQUA_WORLD_CORE', infra);
    assert.equal(wc.state, 'inert', 'world core needs the Context Engine V2 gate and Postgres');
    assert.ok(wc.missing.includes('AQUA_CONTEXT_V2=off'));
  });
  test('AQUA_CIE and AQUA_GRAPH are on by default (the registry used to say off)', () => {
    assert.equal(row({}, 'AQUA_CIE', NONE).value, 'on');
    assert.equal(row({}, 'AQUA_CIE', NONE).state, 'enabled', 'no infrastructure needed — enabled until seen running');
    assert.equal(row({}, 'AQUA_GRAPH', NONE).state, 'inert', 'no provider key → cannot run');
    assert.equal(row({}, 'AQUA_GRAPH', ALL).state, 'enabled');
  });
  test('the effective boot line names every inert gate and why', () => {
    const line = F.flagEffectiveLine({}, { infra: { ...ALL, db: false } });
    assert.match(line, /AQUA_PROACTIVE\(no-db\)/);
    assert.match(line, /AQUA_CANONICAL_READ\(no-db\)/);
    assert.match(line, /on by default: .*AQUA_CIE/);
    assert.match(line, /on by default: .*AQUA_GRAPH/);
  });
});

describe('explicit overrides', () => {
  test('AQUA_E6=on without a provider key is inert; with one, enabled', () => {
    assert.equal(row({ AQUA_E6: 'on' }, 'AQUA_E6', NONE).state, 'inert');
    assert.deepEqual(row({ AQUA_E6: 'on' }, 'AQUA_E6', NONE).missing, ['no-llm']);
    assert.equal(row({ AQUA_E6: 'on' }, 'AQUA_E6', ALL).state, 'enabled');
  });
  test('AQUA_E6=true is off (exact-string gates) — and says so', () => {
    const r = row({ AQUA_E6: 'true' }, 'AQUA_E6', ALL);
    assert.equal(r.value, 'off');
    assert.equal(r.state, 'off');
  });
  test('a child gate on under a parent that is off is inert, naming the parent', () => {
    const r = row({ AQUA_BRAIN_INGEST_FACTS: 'on' }, 'AQUA_BRAIN_INGEST_FACTS', ALL);
    assert.equal(r.state, 'inert');
    assert.deepEqual(r.missing, ['AQUA_BRAIN_INGEST=off']);
    const v2 = row({ AQUA_CONTEXT_V2: 'on', AQUA_BRAIN: 'off' }, 'AQUA_CONTEXT_V2', ALL);
    assert.deepEqual(v2.missing, ['AQUA_BRAIN=off'], 'the kill switch makes every Brain feature inert');
  });
  test('dependencies resolve transitively (semantic recall → embeddings → key)', () => {
    const r = row({ AQUA_SEMANTIC_RECALL: 'on' }, 'AQUA_SEMANTIC_RECALL', { ...ALL, 'embedding-key': false, 'dedicated-embedding-key': false });
    assert.deepEqual(r.missing.sort(), ['no-dedicated-embedding-key', 'no-embedding-key']);
  });
  test('=off turns a default-on gate off', () => {
    assert.equal(row({ AQUA_CIE: 'off' }, 'AQUA_CIE', ALL).state, 'off');
    assert.equal(row({ AQUA_GRAPH: 'OFF' }, 'AQUA_GRAPH', ALL).state, 'off', 'GRAPH lowercases its value');
  });
});

describe('observed execution decides "active" and "failing"', () => {
  test('enabled → active only after it actually ran', () => {
    assert.equal(row({}, 'AQUA_CIE', NONE).state, 'enabled');
    F.noteFeature('AQUA_CIE', 'ran');
    const r = row({}, 'AQUA_CIE', NONE);
    assert.equal(r.state, 'active');
    assert.equal(r.observed.runs, 1);
  });
  test('a failure makes it failing; a later success makes it active again; counts are kept', () => {
    F.noteFeature('AQUA_PIC', 'ran');
    F.noteFeature('AQUA_PIC', 'failed', 'TypeError');
    let r = row({}, 'AQUA_PIC', NONE);
    assert.equal(r.state, 'failing');
    assert.equal(r.observed.lastErrorCode, 'TypeError');
    F.noteFeature('AQUA_PIC', 'ran');
    r = row({}, 'AQUA_PIC', NONE);
    assert.equal(r.state, 'active');
    assert.deepEqual([r.observed.runs, r.observed.failures], [2, 1]);
  });
  test('an inert gate stays inert even if something recorded a run (dependency wins)', () => {
    F.noteFeature('AQUA_PROACTIVE', 'ran');
    assert.equal(row({}, 'AQUA_PROACTIVE', NONE).state, 'inert');
  });
  test('noteFeature never throws and never stores more than a short code', () => {
    F.noteFeature('AQUA_CIE', 'failed', 'x'.repeat(500));
    assert.equal(row({}, 'AQUA_CIE', NONE).observed.lastErrorCode.length, 60);
  });
});

describe('the production call sites record execution', () => {
  test('cognitivePrepare (CIE, on by default) is recorded as active', async () => {
    const { cognitivePrepare } = await import('../../cognition/index.js');
    const before = row({}, 'AQUA_CIE', NONE).state;
    cognitivePrepare({ userMessage: 'How should I plan my week?', taskType: 'planning', confidence: 0.9, complexity: 'medium', hasOwner: true });
    assert.equal(before, 'enabled');
    assert.equal(row({}, 'AQUA_CIE', NONE).state, 'active');
  });
  test('proactiveDirectiveForTurn without Postgres returns nothing and records no run', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { proactiveDirectiveForTurn } = await import('../../brain/proactive/index.js');
      assert.equal(await proactiveDirectiveForTurn('user:status-test'), '');
      assert.equal(row({}, 'AQUA_PROACTIVE', NONE).observed, null, 'an inert feature never claims a run');
    } finally { if (saved !== undefined) process.env.DATABASE_URL = saved; }
  });
});

test('infrastructure() reads presence, never values', () => {
  const infra = F.infrastructure({ DATABASE_URL: 'postgres://x', GROQ_API_KEY_1: 'k', GEMINI_KEY_3: 'g', AQUA_EMBEDDING_API_KEY: '' });
  assert.deepEqual(infra, { db: true, llm: true, 'embedding-key': true, 'dedicated-embedding-key': false });
  assert.deepEqual(F.infrastructure({}), NONE);
});
