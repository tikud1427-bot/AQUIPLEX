/**
 * AQUA Eval — adapter for the CURRENT extraction lane
 * Blueprint E2/PR-3
 *
 * WHY AN ADAPTER, AND WHY IT MIRRORS PRODUCTION LINE BY LINE
 * ---------------------------------------------------------
 * The baseline this produces is the number E6 has to beat. If the adapter
 * drives the extractor differently from the way a real turn drives it, the
 * baseline is fiction and every later comparison inherits the fiction.
 *
 * So this file replicates `brain/knowledgeExtraction/conversationIngest.js`
 * step for step — extract → lift the self mention → resolve → build facts —
 * rather than calling the pieces in whatever order looked reasonable.
 *
 * That care is not theoretical. The first three probes written against this
 * lane all produced ZERO facts for every sentence, which would have published
 * a baseline of 0% and made any replacement look miraculous. The cause was the
 * probe each time: a wrong argument shape, then a wrong field name, then a
 * missing resolver step. The extractor was working.
 *
 * CONFIGURED AT ITS BEST, NOT AT ITS DEFAULT
 * ------------------------------------------
 * `selfText` is only passed in production when AQUA_UUS and AQUA_SELF_ENTITY
 * are both on — and in production today they are both off. The baseline runs
 * with them ON regardless, because a baseline is a measure of what the code can
 * do, not of what a .env file currently permits. Measuring the dark
 * configuration would understate the extractor and flatter its replacement.
 */
import { extractConversationEntities } from '../../src/brain/knowledgeExtraction/conversationEntities.js';
import { buildConversationFacts } from '../../src/brain/knowledgeExtraction/conversationFacts.js';
import { resolveEntities } from '../../src/reasoning/entityResolver.js';

const SELF_GRAPH_ID = 'self';
const SELF_LABEL = 'You';
const SELF_KIND = 'person';

/**
 * Run one sentence through the current extraction lane.
 *
 * @param {string} text  the user's message
 * @returns {{ entities: object[], facts: object[], skipped: string|null }}
 */
export function extractWithCurrentEngine(text) {
  const sourceId = 'eval:turn';

  // 1 — the same call conversationIngest makes. `knownEntities` is empty by
  //     design: a labelled sentence is a COLD turn, the hardest and most
  //     honest case. Warm-start recall would measure the graph, not the
  //     extractor.
  const raw = extractConversationEntities(text, {
    limit: 40,
    knownEntities: [],
    selfText: text,          // see the header — best configuration, not default
  });

  if (!raw.length) return { entities: [], facts: [], skipped: 'no-entities' };

  // 2 — the speaker never goes through the resolver; the owner's id is a
  //     constant that must not change when their name is learned.
  const selfMention = raw.find(e => e.isSelf) ?? null;
  const named = raw.filter(e => !e.isSelf);

  // 3 — resolve, exactly as ingest does
  const mentions = named.map(e => ({
    value: e.value, type: e.type, fileId: sourceId, fileName: sourceId,
    factId: null, evidenceId: `${sourceId}#ev`,
  }));
  const { entities } = resolveEntities(mentions);
  if (selfMention) {
    entities.push({
      id: SELF_GRAPH_ID, canonical: SELF_LABEL, type: SELF_KIND,
      aliases: [], confidence: 1, isSelf: true,
    });
  }

  // 4 — facts
  const built = buildConversationFacts(
    { conversationId: 'eval', turn: 1, userMessage: text, entities },
    { minEntities: 1 },
  );

  return { entities, facts: built.facts ?? [], skipped: built.skipped ?? null };
}

/** Every surface form the extractor produced, lowercased, for subject matching. */
export function surfacesOf(result) {
  const out = new Set();
  for (const e of result.entities ?? []) {
    for (const s of [e.canonical, e.value, ...(e.aliases ?? [])]) {
      if (s) out.add(String(s).toLowerCase());
    }
    if (e.isSelf) out.add('__self__');
  }
  return out;
}
