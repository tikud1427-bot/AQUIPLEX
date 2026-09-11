/**
 * AQUA Eval — retrieval label schema
 * Blueprint E2/PR-4
 *
 * SHAPE: ONE CORPUS, MANY QUERIES — the standard IR arrangement
 * ------------------------------------------------------------
 * A single fixed world state (facts about one owner) plus queries with
 * relevance judgments against it. That mirrors real usage — a person with an
 * accumulated world model asks a question — and it is what makes recall@k,
 * MRR and nDCG computable at all. Per-query world states would give 200
 * corpora of one fact each and measure nothing.
 *
 * GRADED RELEVANCE, TWO LEVELS
 * ----------------------------
 *   relevant    the fact that answers the query        gain 2
 *   acceptable  related, reasonable to return, not the answer   gain 1
 *   everything else                                    gain 0
 *
 * Two levels rather than five: with one annotator, finer grades would be
 * invented precision. nDCG over 2/1/0 is honest and still distinguishes
 * "found the answer" from "found the neighbourhood".
 *
 * THE ADVERSARIAL SET IS THIS PROJECT'S OWN SCAR TISSUE
 * ----------------------------------------------------
 * The hard categories are not generic IR difficulty. Each one is a failure
 * this codebase has actually shipped:
 *
 *   selfword    a query containing "you" — SEVEN of nine noise lines in the
 *               rollout harness came from one such query, because the self
 *               entity is labelled with the literal word "You"
 *   stopword    "what is the capital of France" once matched a stored fact
 *               through the word "the"
 *   category    "where do I work" against a fact that says "I run product at
 *               Nummo" — no lexical overlap at all; the self-anchor exists
 *               for exactly this
 *   superseded  a fact that WAS true; the current one must outrank it
 *   negation    a query about what is NOT the case
 *   unknown     nothing in the corpus answers it — the right response is to
 *               return nothing, and an engine that always returns something
 *               cannot be told apart from one that knows
 */

export const QUERY_CATEGORIES = Object.freeze([
  'direct',       // a fact is stated almost verbatim in the corpus
  'category',     // category/instance gap — no lexical overlap
  'multi',        // more than one fact is relevant
  'temporal',     // time-sensitive; the current fact must win
  'superseded',   // an outdated fact exists and must not win
  'negation',     // asks about what is not the case
  'selfword',     // contains "you"/"your" — the self-label leak
  'stopword',     // shares only stopwords with the corpus
  'unknown',      // nothing answers it; returning nothing is correct
]);

/** What kind of thing the query asks for — used for the top-1-KIND metric. */
export const ANSWER_KINDS = Object.freeze([
  'place', 'person', 'org', 'time', 'role', 'thing', 'none',
]);
// `reason` is deliberately ABSENT. Why-questions have nothing to score against
// yet: the chain builder names its output `progression` rather than causation
// because it cannot detect cause. Adding the kind with no queries behind it
// would be a vocabulary entry pretending to be a capability.

const CORPUS_ID = /^f\d{3}$/;
const QUERY_ID = /^q\d{3}$/;

export class RetrievalDatasetError extends Error {
  constructor(message) { super(message); this.name = 'RetrievalDatasetError'; }
}
const fail = (id, msg) => { throw new RetrievalDatasetError(`${id}: ${msg}`); };

export function validateRetrievalDataset(ds) {
  for (const f of ['id', 'version', 'about', 'limitations', 'corpus', 'queries']) {
    if (!ds?.[f]) throw new RetrievalDatasetError(`dataset.${f} is required`);
  }

  // ── corpus ────────────────────────────────────────────────────────────────
  const factIds = new Set();
  const statements = new Set();
  for (const f of ds.corpus) {
    const id = f.id ?? '(no id)';
    if (!CORPUS_ID.test(id)) fail(id, 'corpus id must look like "f007"');
    if (factIds.has(id)) fail(id, 'duplicate corpus id');
    factIds.add(id);
    if (typeof f.statement !== 'string' || f.statement.length < 5) fail(id, 'statement is required');
    if (statements.has(f.statement)) fail(id, 'duplicate statement — it would double-count in every metric');
    statements.add(f.statement);
    if (!Array.isArray(f.entities)) fail(id, 'entities must be an array (use [] for none)');
    if (typeof f.confidence !== 'number' || f.confidence <= 0 || f.confidence > 1) {
      fail(id, 'confidence must be in (0,1]');
    }
    if (!['conversation', 'document'].includes(f.sourceType)) {
      fail(id, 'sourceType must be conversation or document — trust tiers differ and ranking uses them');
    }
    if (f.supersededBy && !ds.corpus.some(o => o.id === f.supersededBy)) {
      fail(id, `supersededBy points at ${f.supersededBy}, which is not in the corpus`);
    }
  }

  // ── queries ───────────────────────────────────────────────────────────────
  const queryIds = new Set();
  const texts = new Set();
  for (const q of ds.queries) {
    const id = q.id ?? '(no id)';
    if (!QUERY_ID.test(id)) fail(id, 'query id must look like "q042"');
    if (queryIds.has(id)) fail(id, 'duplicate query id');
    queryIds.add(id);

    if (typeof q.q !== 'string' || q.q.length < 3) fail(id, 'q (the query text) is required');
    if (texts.has(q.q.toLowerCase())) fail(id, 'duplicate query text');
    texts.add(q.q.toLowerCase());

    if (!QUERY_CATEGORIES.includes(q.cat)) fail(id, `unknown category "${q.cat}"`);
    if (!ANSWER_KINDS.includes(q.kind)) fail(id, `unknown answer kind "${q.kind}"`);

    for (const list of ['relevant', 'acceptable']) {
      if (!Array.isArray(q[list] ?? [])) fail(id, `${list} must be an array`);
      for (const fid of q[list] ?? []) {
        if (!factIds.has(fid)) fail(id, `${list} references unknown fact ${fid}`);
      }
    }
    const rel = q.relevant ?? [];
    const acc = q.acceptable ?? [];
    for (const fid of rel) {
      if (acc.includes(fid)) fail(id, `${fid} is listed as both relevant and acceptable`);
    }

    // The rule that makes silence measurable, stated on the QUERY rather than
    // the category: three categories carry silence-expecting queries —
    // `unknown` (nothing is stored), `stopword` (only stopwords overlap) and
    // `selfword` (a request that merely contains "you"). Tying the rule to the
    // category would have forced those into the wrong bucket and lost exactly
    // the distinction the adversarial set exists to draw.
    if (rel.length === 0) {
      if (q.kind !== 'none') {
        fail(id, 'a query with no relevant facts asks for no kind — set kind:"none", or give it a relevant fact');
      }
      if (acc.length) fail(id, 'a query expecting silence cannot have acceptable facts either');
    }
    if (q.cat === 'unknown' && rel.length) {
      fail(id, 'an "unknown" query must have NO relevant facts — that is what makes silence measurable');
    }

    if (q.cat === 'superseded' && !rel.some(fid => ds.corpus.find(f => f.id === fid && !f.supersededBy))) {
      fail(id, 'a superseded query must mark the CURRENT fact as relevant, not the outdated one');
    }
  }
  return true;
}

export function retrievalCensus(ds) {
  const out = Object.fromEntries(QUERY_CATEGORIES.map(c => [c, 0]));
  for (const q of ds.queries) out[q.cat]++;
  return out;
}
