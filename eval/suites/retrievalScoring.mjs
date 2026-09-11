/**
 * AQUA Eval — the retrieval scorer, shared by every lane that is graded on
 * `retrieval-core.v1`.
 *
 * WHY IT WAS EXTRACTED
 * --------------------
 * `context-core` grades a SECOND retrieval path (the Context Engine) against
 * the same 200 queries. Copying the arithmetic would have produced two scorers
 * that drift, and the drift would land exactly where it does the most damage:
 * the two numbers are meant to be COMPARED, and a comparison between two
 * scorers is not a comparison between two engines.
 *
 * `e6Extractor.mjs` set this precedent for extraction and stated the reason
 * plainly — a second scorer written for the new lane is "a scorer written by
 * the person hoping it wins". Same rule, same file layout: one definition,
 * two callers, only the engine changes.
 *
 * Pure. No I/O, no imports, no engine knowledge.
 */

export const K = 8;

/**
 * Which kind of answer each corpus fact can serve. Derived from the CORPUS,
 * once, so it describes the world rather than any engine's opinion of it.
 */
export function kindMap(corpus) {
  return new Map(corpus.map(f => {
    const t = f.statement.toLowerCase();
    let kind = 'thing';
    if (/\b(in|at|to|based|office|moved)\b/.test(t) && /\b(bangalore|guwahati|delhi|pune|office)\b/.test(t)) kind = 'place';
    else if (/\b(20\d\d|january|march|june|july|september|november|monday|thursday|friday|q2|quarter|months)\b/.test(t)) kind = 'time';
    else if (f.entities.some(e => /^(Priya|Dev|Chhanda|Rahul|Sam|Karan|Meera|Neha|Farah)$/.test(e))) kind = 'person';
    else if (f.entities.some(e => /^(Nummo|Aquiplex|Intercom|Groq)$/.test(e))) kind = 'org';
    else if (/\b(i run|i lead|head of|manages|co-founded)\b/.test(t)) kind = 'role';
    return [f.id, kind];
  }));
}

/** Grade one query's ranked ids against its labels. */
export function scoreQuery(testCase, ranked, KIND_OF) {
  const top8 = ranked.slice(0, K);
  const rel = new Set(testCase.relevant);
  const acc = new Set(testCase.acceptable);

  if (rel.size === 0) {
    return { correct: top8.length === 0, cat: testCase.cat, silence: true, returned: top8.length };
  }

  const firstHit = top8.findIndex(id => rel.has(id));
  const gains = top8.map(id => (rel.has(id) ? 2 : acc.has(id) ? 1 : 0));
  const dcg = gains.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  const ideal = [...Array(rel.size).fill(2), ...Array(acc.size).fill(1)]
    .slice(0, K)
    .reduce((s, g, i) => s + g / Math.log2(i + 2), 0);

  const top = top8[0] ?? null;
  return {
    correct: firstHit === 0,
    cat: testCase.cat,
    silence: false,
    hit: firstHit >= 0,
    rr: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
    ndcg: ideal > 0 ? dcg / ideal : 0,
    recalled: top8.filter(id => rel.has(id)).length,
    relevantTotal: rel.size,
    kindOk: top ? KIND_OF.get(top) === testCase.kind : false,
    returned: top8.length,
  };
}

/** Aggregate graded queries into the reported metric set. */
export function aggregate(scored) {
  const answerable = scored.filter(s => !s.silence);
  const silent = scored.filter(s => s.silence);
  const ratio = (a, b) => (b ? a / b : 0);

  const byCat = {};
  for (const s of answerable) {
    byCat[s.cat] ??= { n: 0, hit: 0 };
    byCat[s.cat].n++;
    if (s.hit) byCat[s.cat].hit++;
  }

  return {
    [`recall_at_${K}`]: ratio(answerable.filter(s => s.hit).length, answerable.length),
    mrr: ratio(answerable.reduce((n, s) => n + s.rr, 0), answerable.length),
    [`ndcg_at_${K}`]: ratio(answerable.reduce((n, s) => n + s.ndcg, 0), answerable.length),
    top1_correct: ratio(answerable.filter(s => s.correct).length, answerable.length),
    top1_kind: ratio(answerable.filter(s => s.kindOk).length, answerable.length),

    // Silence, always separate. An engine that returns everything scores
    // perfect recall, and averaging these in is how that stays hidden.
    unknown_honesty: ratio(silent.filter(s => s.correct).length, silent.length),
    noise_lines: silent.reduce((n, s) => n + s.returned, 0),
    noisy_queries: silent.filter(s => s.returned > 0).length,

    ...Object.fromEntries(Object.entries(byCat).sort()
      .map(([cat, v]) => [`recall_${cat}`, ratio(v.hit, v.n)])),

    answerable_queries: answerable.length,
    silence_queries: silent.length,
  };
}
