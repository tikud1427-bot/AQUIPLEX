/**
 * AQUA Eval — adapter for the CURRENT retrieval path
 * Blueprint E2/PR-5
 *
 * TWO HALVES, AND BOTH CAN LIE
 * ----------------------------
 * A retrieval baseline needs a WORLD and a QUERY PATH, and an unfaithful
 * version of either produces a number that looks like a measurement.
 *
 *   the world   seeded with the same node and edge shapes
 *               `conversationIngest.js` writes — fact node, `asserts` edge
 *               from the source, and an `about` edge per entity. The `about`
 *               edges are what Lane 3 and the Context Engine hop across;
 *               without them the facts sit in the store off every graph path
 *               that reaches them, and retrieval would score near zero for
 *               reasons that have nothing to do with retrieval.
 *
 *   the path    `pic/core.js retrieveKnowledge(ownerId, query, opts)` — the
 *               exact facade the chat spine calls, not the inner
 *               `retrievalIntelligence` function with hand-wired deps.
 *
 * The extraction baseline in E2/PR-3 nearly published 0% three times because
 * its adapter was wrong in three different ways while the engine was fine.
 * This one is written against the production writer and the production reader
 * for exactly that reason, and a test asserts it retrieves something real.
 *
 * ISOLATION
 * ---------
 * Every store here is a module-level singleton that loads from disk at import.
 * `AQUA_DATA_DIR` is therefore set BEFORE the engine is imported, to a fresh
 * temp directory — a baseline that read the developer's real world model would
 * be unreproducible and would leak their data into a committed report.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let engine = null;

/** Import the engine once, against a private data directory. */
async function loadEngine() {
  if (engine) return engine;
  process.env.AQUA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'aqua-eval-retrieval-'));
  // Every understanding flag ON, matching the extraction baseline's rule: a
  // baseline measures what the code CAN do, not what a .env currently permits.
  // AQUA_SELF_ENTITY in particular gates lane 2b, the self-anchor that exists
  // precisely for the category/instance gap this dataset probes.
  process.env.AQUA_BRAIN = 'on';
  process.env.AQUA_PIC = 'on';
  process.env.AQUA_UUS = 'on';
  process.env.AQUA_SELF_ENTITY = 'on';
  process.env.AQUA_CONTEXT_V2 = 'on';

  const [pic, graph, evidenceStore, evidence] = await Promise.all([
    import('../../src/pic/core.js'),
    import('../../src/reasoning/reasoningGraph.js'),
    import('../../src/files/evidenceStore.js'),
    import('../../src/files/evidence.js'),
  ]);
  engine = { pic, graph, evidenceStore, evidence };
  return engine;
}

const SELF_LABEL = 'You';
const nodeIdFor = name => `entity:${String(name).toLowerCase().replace(/\s+/g, '-')}`;

/**
 * Build the corpus into a real world model for one owner.
 * Mirrors conversationIngest's write shapes; see the header.
 */
export async function seedWorld(ownerId, corpus) {
  const { graph: G, evidenceStore: ES } = await loadEngine();

  const entityNames = new Set(corpus.flatMap(f => f.entities));
  for (const name of entityNames) {
    G.upsertNode(ownerId, {
      id: nodeIdFor(name), type: 'entity', label: name,
      kind: 'observed',
      // data.entityType === 'self' is the marker retrievalIntelligence actually
      // looks for (retrievalIntelligence.js:142). Seeding isSelf instead left
      // the self node unrecognised, lane 2b dark and the baseline understated —
      // the same class of silent unfairness the extraction adapter hit three
      // times. Found by reading the predicate, not by assuming it.
      data: name === SELF_LABEL ? { entityType: 'self' } : {},
      sourceFiles: ['eval:corpus'],
    }, { fileId: 'eval:corpus' });
  }

  for (const f of corpus) {
    const sourceId = `eval:${f.sourceType}:${f.id}`;
    const evidenceId = `${f.id}#ev`;

    ES.saveEvidence(ownerId, {
      id: evidenceId, sourceFileId: sourceId, quote: f.statement,
      location: { kind: 'eval' }, extractedAt: new Date(0).toISOString(),
    });

    ES.saveFact(ownerId, {
      id: f.id, statement: f.statement, entities: f.entities,
      confidence: f.confidence, sourceType: f.sourceType,
      evidence: [evidenceId], state: 'active',
    }, { sourceFileId: sourceId });

    G.upsertNode(ownerId, {
      id: `fact:${f.id}`, type: 'fact', label: f.statement.slice(0, 120),
      kind: 'observed', data: { confidence: f.confidence },
      sourceFiles: [sourceId],
    }, { fileId: sourceId });

    G.addEdge(ownerId, {
      from: `src:${sourceId}`, to: `fact:${f.id}`, type: 'asserts',
      kind: 'observed', confidence: f.confidence,
      evidence: [evidenceId], sourceFiles: [sourceId], reason: 'eval corpus',
    }, { fileId: sourceId });

    // The edges Lane 3 hops across. Half the gap, and the easier half to miss.
    for (const name of f.entities) {
      G.addEdge(ownerId, {
        from: `fact:${f.id}`, to: nodeIdFor(name), type: 'about',
        kind: 'observed', confidence: f.confidence,
        evidence: [evidenceId], sourceFiles: [sourceId],
        reason: 'eval corpus fact about entity',
      }, { fileId: sourceId });
    }
  }

  return { entities: entityNames.size, facts: corpus.length };
}

/** Ask the same question the chat spine would ask. */
export async function retrieveWithCurrentEngine(ownerId, query, { limit = 8, semanticScores = null } = {}) {
  const { pic } = await loadEngine();
  // `semanticScores` is Map<factId, cosine>, supplied by the caller. In eval it
  // comes from the committed fixture, keyed by evidence-store fact id — the
  // same identity the retrieval pool uses. Absent, the dense lane is inert and
  // this behaves exactly as it did before it existed.
  const out = pic.retrieveKnowledge(ownerId, query, { limit, semanticScores });
  return {
    items: out.items ?? [],
    stats: out.stats ?? {},
    // Ranked fact ids, best first — what every metric is computed over.
    ranked: (out.items ?? [])
      .map(it => it.factId ?? it.id ?? null)
      .filter(Boolean)
      .map(id => String(id).replace(/^fact:/, '')),
  };
}

export async function resetWorld(ownerId) {
  const { graph: G, evidenceStore: ES } = await loadEngine();
  G.purgeOwner?.(ownerId);
  ES.purgeOwner?.(ownerId);
}
