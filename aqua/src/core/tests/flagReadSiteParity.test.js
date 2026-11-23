/**
 * The registry agrees with the READ SITES — not with itself (Sprint 1, 2026-11-10).
 *
 * flagRegistry.test.js "a recorded default matches what the read site does"
 * compares flagReport({}) with the registry's own `dflt` — flagReport is
 * computed FROM the registry, so it cannot fail. That is how AQUA_GRAPH and
 * AQUA_CIE (read sites `?? 'on'`) were registered as default OFF and every
 * boot line reported them off (audit F-02).
 *
 * Here each gate's REAL enable function is called with the variable unset and
 * with a vector of raw values, and the answer is compared with the registry's
 * resolution of the same raw value. Gates read once at import time
 * (AQUA_EMBEDDINGS, ARTIFACTS_ENABLED, AQUA_CORRECTION_PHRASES, ...) are checked
 * against the verbatim source expression instead, evaluated the same way.
 *
 * process.env is mutated only inside this file's process and restored after
 * each case; no subprocess is spawned from here.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.AQUA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-flag-parity-'));
process.env.AQUA_DISABLE_MONGO_MIRROR = '1';
process.env.MONGO_URI = '';

const { GATES, gateValue } = await import('../flags.js');
// 2026-11-16 (conversation recovery) read sites.
const { conversationContextEnabled } = await import('../conversationContext.js');
const { turnLockEnabled } = await import('../conversationTurnLock.js');
const { reviewReasonRequired } = await import('../../intelligence/evidenceContext.js');
const { cieEnabled } = await import('../../cognition/index.js');
const { picEnabled, consolidateEnabled } = await import('../../pic/core.js');
const { recallEnabled } = await import('../../memory/episodicRecall.js');
const { mindRelevanceEnabled } = await import('../../mind/mindRetriever.js');
const { propagationEnabled } = await import('../../memory/propagation.js');
const Brain = await import('../../brain/index.js');
const CE = await import('../../brain/contextEngine/index.js');
const { proactiveEnabled } = await import('../../brain/proactive/index.js');
const { uusEnabled } = await import('../../understanding/flags.js');
const { selfEntityEnabled } = await import('../../brain/identity/selfEntity.js');
const { brainEnabled } = await import('../../brain/worldModel/schema.js');
const { storeModeFromEnv, readStoresFromEnv } = await import('../storage/index.js');
const { parsePartitionModes } = await import('../storage/ownerBinding.js');
const FollowUp = await import('../../memory/followUpRelevance.js');
const { infoNeedsMode } = await import('../../brain/contextEngine/informationNeeds.js');
const { hybridContextMode } = await import('../../brain/contextEngine/hybridContext.js');
const { costAwareReviewEnabled } = await import('../../orchestrator/verificationStrategy.js');
const { durableLearningEnabled } = await import('../../learning/turnLearning.js');
const { pendingChargesEnabled } = await import('../../credits/pendingCharges.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8');

const VALUES = [undefined, '', 'on', 'off', 'ON', 'Off', 'true', 'false', '1', '0', 'shadow', 'auto', 'local', 'x,y'];
const ON_LIKE = v => v === 'on' || v === 'auto' || v === 'shadow';

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) process.env[k] = v;
});

function setVar(name, v) { if (v === undefined) delete process.env[name]; else process.env[name] = v; }

/** Runtime probes: the real function, evaluated with process.env as it stands. */
const RUNTIME = {
  AQUA_CIE: () => cieEnabled(),
  AQUA_PIC: () => picEnabled(),
  AQUA_CONSOLIDATE: () => consolidateEnabled(),          // needs PIC on (default)
  AQUA_EPISODIC_RECALL: () => recallEnabled(),
  AQUA_MIND_RELEVANCE: () => mindRelevanceEnabled(),
  AQUA_PROPAGATION: () => propagationEnabled(),
  AQUA_CONTEXT_V2: () => CE.contextV2Enabled(),          // needs BRAIN on (default)
  AQUA_RETRIEVAL_V3: () => CE.retrievalV3Enabled(),
  AQUA_CANONICAL_RELEVANCE_GATE: () => CE.canonicalRelevanceGateEnabled(),
  AQUA_E6: () => Brain.e6Enabled(),
  AQUA_REFLECT_V2: () => Brain.reflectV2Enabled(),
  AQUA_TWIN_V2: () => Brain.twinV2Enabled(),
  AQUA_BRAIN_INGEST: () => Brain.ingestEnabled(),
  AQUA_BRAIN_INGEST_FACTS: () => { process.env.AQUA_BRAIN_INGEST = 'on'; return Brain.factIngestEnabled(); },
  AQUA_UUS: () => uusEnabled(),
  AQUA_SELF_ENTITY: () => selfEntityEnabled(),
  AQUA_WORLD_CORE: () => Brain.worldCoreEnabled(),
  AQUA_REVISION_VOICE: () => Brain.revisionVoiceMode() !== 'off',
  AQUA_BRAIN: () => brainEnabled(),
  AQUA_STORE_PG: () => storeModeFromEnv() === 'shadow',
  AQUA_STORE_PG_READ: () => readStoresFromEnv().length > 0,
  // Phase 2b: a per-store list; any non-empty entry engages the bindings (each store then reads its own mode).
  AQUA_STORE_PARTITIONS: () => parsePartitionModes().size > 0,
  // Phase 3: the flag alone; the history-partitions/database prerequisites are its dependencies.
  AQUA_POST_TURN_DURABLE: () => durableLearningEnabled(),
  // Phase 4B: needs Postgres configured to show its flag semantics (like AQUA_PROACTIVE).
  AQUA_PENDING_CHARGES: () => { process.env.DATABASE_URL = 'postgres://parity-test-never-connects/x'; return pendingChargesEnabled(); },
  AQUA_INFO_NEEDS: () => infoNeedsMode() !== 'off',   // on | shadow both run the engine
  AQUA_HYBRID_CONTEXT: () => hybridContextMode() !== 'off',   // on | shadow both compute the hybrid block
  AQUA_COST_AWARE_REVIEW: () => costAwareReviewEnabled(),
  AQUA_CONVERSATION_CONTEXT: () => conversationContextEnabled(),
  AQUA_CONVERSATION_TURN_LOCK: () => turnLockEnabled(),
  AQUA_REVIEW_REQUIRE_REASON: () => reviewReasonRequired(),
  AQUA_RECALL_FOLLOWUP_V2: () => Object.values(FollowUp).find(f => typeof f === 'function' && /Enabled$/.test(f.name))(process.env),
  // Needs Postgres configured to show its FLAG semantics; without it see the dependency test.
  AQUA_PROACTIVE: () => { process.env.DATABASE_URL = 'postgres://parity-test-never-connects/x'; return proactiveEnabled(); },
  AQUA_CANONICAL_READ: () => { process.env.DATABASE_URL = 'postgres://parity-test-never-connects/x'; return Brain.canonicalReadMode() !== 'legacy'; },
};

/**
 * Import-time and inline read sites: the verbatim expression must still be in
 * the source (so this cannot drift from the code), and is evaluated here.
 */
const SOURCE = {
  AQUA_GRAPH: { files: ['routes/chat.js', 'routes/intelligence.js'], expr: "String(process.env.AQUA_GRAPH ?? 'on').toLowerCase()", fn: env => String(env.AQUA_GRAPH ?? 'on').toLowerCase() !== 'off' },
  AQUA_EMBEDDINGS: { files: ['embeddings/embeddingProvider.js'], expr: "String(process.env.AQUA_EMBEDDINGS || '').toLowerCase() === 'off'", fn: env => !(String(env.AQUA_EMBEDDINGS || '').toLowerCase() === 'off') },
  ARTIFACTS_ENABLED: { files: ['routes/chat.js'], expr: "process.env.ARTIFACTS_ENABLED !== 'false'", fn: env => env.ARTIFACTS_ENABLED !== 'false' },
  AQUA_CORRECTION_PHRASES: { files: ['memory/memoryConflictResolver.js'], expr: ".split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)", fn: env => (env.AQUA_CORRECTION_PHRASES ? env.AQUA_CORRECTION_PHRASES.split(',').map(p => p.trim().toLowerCase()).filter(Boolean) : []).length > 0 },
  AQUA_PARSE_WORKER: { files: ['upload/boundedParse.js'], expr: "String(process.env.AQUA_PARSE_WORKER ?? 'on').toLowerCase() !== 'off'", fn: env => String(env.AQUA_PARSE_WORKER ?? 'on').toLowerCase() !== 'off' },
  AQUA_ANSWER_SCAFFOLD_GUARD: { files: ['core/reasoningStrategy.js'], expr: "String(process.env.AQUA_ANSWER_SCAFFOLD_GUARD ?? 'on').toLowerCase() !== 'off'", fn: env => String(env.AQUA_ANSWER_SCAFFOLD_GUARD ?? 'on').toLowerCase() !== 'off' },
  AQUA_CROSS_ENCODER: { files: ['brain/contextEngine/crossEncoderLocal.js'], expr: "String(process.env.AQUA_CROSS_ENCODER ?? '').toLowerCase() === 'on'", fn: env => String(env.AQUA_CROSS_ENCODER ?? '').toLowerCase() === 'on' },
  AQUA_E6_ACTOR_RETRY: { files: ['brain/understanding/pipeline.js'], expr: "String(process.env.AQUA_E6_ACTOR_RETRY ?? 'on').toLowerCase() !== 'off'", fn: env => String(env.AQUA_E6_ACTOR_RETRY ?? 'on').toLowerCase() !== 'off' },
  AQUA_E6_COMPOUND_RETRY: { files: ['brain/understanding/pipeline.js'], expr: "String(process.env.AQUA_E6_COMPOUND_RETRY ?? '').toLowerCase() === 'on'", fn: env => String(env.AQUA_E6_COMPOUND_RETRY ?? '').toLowerCase() === 'on' },
  AQUA_CANONICAL_IDS: { files: ['brain/worldModel/projection.js'], expr: "process.env.AQUA_CANONICAL_IDS === 'on'", fn: env => env.AQUA_CANONICAL_IDS === 'on' },
  AQUA_REL_EVOLVE: { files: ['reasoning/reasoningGraph.js'], expr: "process.env.AQUA_REL_EVOLVE === 'on'", fn: env => env.AQUA_REL_EVOLVE === 'on' },
  AQUA_MIND_VIEW: { files: ['mind/mindRoutes.js'], expr: "process.env.AQUA_MIND_VIEW !== '1'", fn: env => !(env.AQUA_MIND_VIEW !== '1') },
  AQUA_CLAIM_STRICT_PREDICATES: { files: ['core/claims/predicateRegistry.js'], expr: "String(process.env.AQUA_CLAIM_STRICT_PREDICATES ?? '') === '1'", fn: env => String(env.AQUA_CLAIM_STRICT_PREDICATES ?? '') === '1' },
  AQUA_GRAPH_STRICT_TYPES: { files: ['reasoning/typeRegistry.js'], expr: "String(process.env.AQUA_GRAPH_STRICT_TYPES ?? '') === '1'", fn: env => String(env.AQUA_GRAPH_STRICT_TYPES ?? '') === '1' },
  AQUA_PROVIDER_LOG: { files: ['providers/router.js', 'core/health.js'], expr: "String(process.env.AQUA_PROVIDER_LOG ?? '').toLowerCase() === 'debug'", fn: env => String(env.AQUA_PROVIDER_LOG ?? '').toLowerCase() === 'debug' },
  AQUA_DISABLE_MONGO_MIRROR: { files: ['core/mongoMirror.js'], expr: "process.env.AQUA_DISABLE_MONGO_MIRROR === '1'", fn: env => env.AQUA_DISABLE_MONGO_MIRROR === '1' },
  AQUA_CLAIMS_SHADOW: { files: ['core/claims/shadowMode.js'], expr: "String(process.env.AQUA_CLAIMS_SHADOW ?? '').toLowerCase() === 'on'", fn: env => String(env.AQUA_CLAIMS_SHADOW ?? '').toLowerCase() === 'on' },
  AQUA_LOG_CONTENT: { files: ['core/logSafety.js'], expr: "String(env.AQUA_LOG_CONTENT ?? '').toLowerCase() !== 'local'", fn: null },   // behaviour tested via contentLoggingAllowed below
  AQUA_E8_PERSONAL_SCOPE: { files: ['brain/contextEngine/queryPlan.js'], expr: "String(process.env.AQUA_E8_PERSONAL_SCOPE ?? 'on').trim().toLowerCase() === 'off'", fn: env => !(String(env.AQUA_E8_PERSONAL_SCOPE ?? 'on').trim().toLowerCase() === 'off') },
  AQUA_STRICT_CONVERSATION_IDS: { files: ['routes/chat.js'], expr: "String(process.env.AQUA_STRICT_CONVERSATION_IDS ?? 'on').trim().toLowerCase() !== 'off'", fn: env => String(env.AQUA_STRICT_CONVERSATION_IDS ?? 'on').trim().toLowerCase() !== 'off' },
  AQUA_GMAIL_CONNECT: { files: ['connect/gmail/gmailOAuthConfig.js'], expr: "String(env.AQUA_GMAIL_CONNECT ?? '').toLowerCase() === 'on'", fn: env => String(env.AQUA_GMAIL_CONNECT ?? '').toLowerCase() === 'on' },
  AQUA_SEMANTIC_RECALL: { files: ['memory/semanticRecall.js'], expr: "String(env.AQUA_SEMANTIC_RECALL ?? '').toLowerCase() === 'on'", fn: env => String(env.AQUA_SEMANTIC_RECALL ?? '').toLowerCase() === 'on' },   // && isEmbeddingEnabled(): a dependency
};

describe('every gate is covered by a read-site probe', () => {
  test('no gate is left unchecked', () => {
    const unchecked = GATES.map(g => g.name).filter(n => !(n in RUNTIME) && !(n in SOURCE));
    assert.deepEqual(unchecked, [], `gates with no read-site probe: ${unchecked.join(', ')}`);
  });
});

describe('runtime read sites: registry resolution == the real enable function', () => {
  for (const [name, probe] of Object.entries(RUNTIME)) {
    test(name, () => {
      const wrong = [];
      for (const v of VALUES) {
        for (const k of Object.keys(process.env)) if (k.startsWith('AQUA_') && !['AQUA_DATA_DIR', 'AQUA_DISABLE_MONGO_MIRROR'].includes(k)) delete process.env[k];
        delete process.env.DATABASE_URL;
        setVar(name, v);
        const actual = !!probe();
        const registry = ON_LIKE(gateValue(name, process.env));
        if (actual !== registry) wrong.push(`${JSON.stringify(v)}: read site=${actual ? 'on' : 'off'} registry=${registry ? 'on' : 'off'}`);
      }
      assert.deepEqual(wrong, [], `${name} — the registry disagrees with the code:\n${wrong.join('\n')}`);
    });
  }
});

describe('import-time / inline read sites: verbatim expression present and resolved alike', () => {
  for (const [name, spec] of Object.entries(SOURCE)) {
    test(name, () => {
      for (const f of spec.files) assert.ok(read(f).includes(spec.expr), `${f} no longer contains the read expression for ${name} — update this probe from the source`);
      if (!spec.fn) return;
      const wrong = [];
      for (const v of VALUES) {
        const env = v === undefined ? {} : { [name]: v };
        if (!!spec.fn(env) !== ON_LIKE(gateValue(name, env))) wrong.push(`${JSON.stringify(v)}: read site=${spec.fn(env)} registry=${gateValue(name, env)}`);
      }
      assert.deepEqual(wrong, [], `${name}:\n${wrong.join('\n')}`);
    });
  }
});

test('AQUA_LOG_CONTENT: registry and logSafety agree, including the production refusal', async () => {
  const { contentLoggingAllowed } = await import('../logSafety.js');
  for (const env of [{}, { AQUA_LOG_CONTENT: 'local' }, { AQUA_LOG_CONTENT: 'LOCAL' }, { AQUA_LOG_CONTENT: 'local', NODE_ENV: 'production' }, { AQUA_LOG_CONTENT: 'local', RENDER: 'true' }, { AQUA_LOG_CONTENT: 'on' }]) {
    assert.equal(contentLoggingAllowed(env), gateValue('AQUA_LOG_CONTENT', env) === 'on', JSON.stringify(env));
  }
});

test('the three gates the audit found misreported now report their real defaults', () => {
  assert.equal(gateValue('AQUA_GRAPH', {}), 'on');
  assert.equal(gateValue('AQUA_CIE', {}), 'on');
  assert.equal(gateValue('AQUA_PROACTIVE', {}), 'on', 'the flag is on by default…');
});
