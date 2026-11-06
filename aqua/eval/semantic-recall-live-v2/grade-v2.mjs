/**
 * Frozen grading for semantic-recall-live.v2 (written 2026-11-05, before any embedding).
 *
 * Pure: given the dataset and one cosine per (question, passage), it runs the
 * PRODUCTION ranking code as imported (memory/semanticRecall.js rankHybrid via
 * memory/episodicRecall.js selectRecall, ranked mode) on each user's OWN passages,
 * and the keyword-only path for comparison. No parameter here tunes the ranking.
 */
export const CRITERIA = Object.freeze({
  C1: { what: 'relevant recall: relevant passages selected / all relevant (answerable questions)', min: 0.90 },
  C2: { what: 'excluded passages selected (traps, someone else\'s fact, other meaning)', max: 0 },
  C3: { what: 'share of selected passages that are neither relevant nor excluded', max: 0.20 },
  C4: { what: 'unrelated questions (A7, B7, C3) select nothing', all: true },
  C5: { what: 'right memory ranked first (hybrid hit@1), answerable questions', min: 0.80 },
  C6: { what: 'questions with an old and a current statement: all relevant (old and current) selected', min: 0.80 },
  C7: { what: 'semantic-favoured questions: all relevant selected', min: 0.80 },
  C8: { what: 'keyword-favoured questions (A5, B6): all relevant selected', min: 1.0 },
  C9: { what: 'questions where keyword-only selects a relevant passage that hybrid misses', max: 0 },
  C10: { what: 'small-pool user (ines, < 8 vectors): pool is "small"; C1, C2 all relevant selected; C3 nothing', all: true },
  C11: { what: 'provider failure (500, 429, 401, timeout) falls back to the keyword result', min: 4 },
});
export const INFORMATIONAL = ['latency (hidden by the early query vector; reported, not gated)', 'MRR keyword / semantic / hybrid', 'current statement ranked first'];

const DAY = 86_400_000, T0 = Date.UTC(2026, 0, 1);

/** @param cosOf (questionId, passageId) => number */
export function grade(DS, cosOf, { R, SR }) {
  const perQuestion = [];
  for (const q of DS.questions) {
    const user = DS.users[q.user];
    const conv = new Map();
    for (const p of user.passages) {
      if (!conv.has(p.conv)) conv.set(p.conv, { meta: { userId: q.user, title: p.conv }, messages: [] });
      conv.get(p.conv).messages.push({ role: 'user', content: p.text, ts: T0 + p.day * DAY + conv.get(p.conv).messages.length });
    }
    R.__clearCacheForTests();
    const units = R.collectUnits({ userId: q.user, conversationId: 'none', conversations: conv });
    const idOf = u => user.passages.find(p => p.text === u.text)?.id;
    const semantic = new Map(units.map(u => [u.key, cosOf(q.id, idOf(u))]));
    const hybridList = SR.rankHybrid(units, q.text, semantic);
    const hybridRank = hybridList.map(x => idOf(x.unit));
    const keywordRank = R.scoreUnits(units, q.text).scored.map(s => idOf(s.unit));
    const semanticRank = [...user.passages].sort((a, b) => cosOf(q.id, b.id) - cosOf(q.id, a.id)).map(p => p.id);
    const selected = R.selectRecall(units, q.text, { allUnderChars: 0, semantic }).excerpts.map(idOf);
    const keywordSelected = R.selectRecall(units, q.text, { allUnderChars: 0 }).excerpts.map(idOf);
    const isExcluded = id => q.excluded.includes('*') || q.excluded.includes(id);
    const mrr = rank => { if (!q.relevant.length) return null; const f = rank.findIndex(id => q.relevant.includes(id)); return f < 0 ? 0 : +(1 / (f + 1)).toFixed(3); };
    perQuestion.push({
      id: q.id, user: q.user, kind: q.kind, favours: q.favours, text: q.text, relevant: q.relevant, excluded: q.excluded, current: q.current ?? null,
      cosine: Object.fromEntries(user.passages.map(p => [p.id, +cosOf(q.id, p.id).toFixed(4)])),
      pool: hybridList[0]?.pool ?? (units.length >= SR.SEMANTIC_DEFAULTS.smallPool ? 'contrast' : 'small'),
      hybrid: { rank: hybridRank, top: hybridList.slice(0, 5).map(x => ({ id: idOf(x.unit), score: +x.score.toFixed(4), parts: Object.fromEntries(Object.entries(x.parts).map(([k, v]) => [k, +v.toFixed(4)])), cosine: +x.semantic.toFixed(4), z: +x.z.toFixed(4), admitted: x.admitted, why: x.why })), mrr: mrr(hybridRank), hit1: q.relevant.length ? q.relevant.includes(hybridRank[0]) : null },
      keyword: { rank: keywordRank, mrr: mrr(keywordRank), selected: keywordSelected },
      semantic: { rank: semanticRank.slice(0, 6), mrr: mrr(semanticRank) },
      selected,
      relevantSelected: q.relevant.filter(r => selected.includes(r)),
      excludedSelected: selected.filter(isExcluded),
      otherSelected: selected.filter(id => !q.relevant.includes(id) && !isExcluded(id)),
      lostVsKeyword: q.relevant.filter(r => keywordSelected.includes(r) && !selected.includes(r)),
      currentFirst: q.current ? hybridRank.indexOf(q.current) >= 0 && hybridRank.indexOf(q.current) === Math.min(...q.relevant.map(r => (hybridRank.indexOf(r) < 0 ? 99 : hybridRank.indexOf(r)))) : null,
    });
  }
  return perQuestion;
}

/** Evaluate the frozen criteria. `fallbackOk` = number of simulated failures that returned the keyword result. */
export function evaluate(perQuestion, { fallbackOk = null } = {}) {
  const answerable = perQuestion.filter(q => q.relevant.length);
  const allRel = q => q.relevant.every(r => q.selected.includes(r));
  const rate = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : 1);
  const relTotal = answerable.reduce((n, q) => n + q.relevant.length, 0);
  const relSel = answerable.reduce((n, q) => n + q.relevantSelected.length, 0);
  const selTotal = perQuestion.reduce((n, q) => n + q.selected.length, 0);
  const other = perQuestion.reduce((n, q) => n + q.otherSelected.length, 0);
  const excl = perQuestion.flatMap(q => q.excludedSelected.map(x => `${q.id}:${x}`));
  const unrelated = perQuestion.filter(q => q.kind.includes('unrelated'));
  const hist = perQuestion.filter(q => q.current);
  const semFav = perQuestion.filter(q => q.favours === 'semantic');
  const kwFav = perQuestion.filter(q => q.favours === 'keyword');
  const lost = perQuestion.filter(q => q.lostVsKeyword.length).map(q => `${q.id}:${q.lostVsKeyword.join('+')}`);
  const ines = perQuestion.filter(q => q.user === 'ines');
  const m = {
    C1: +(relSel / relTotal).toFixed(3),
    C2: excl.length,
    C3: selTotal ? +(other / selTotal).toFixed(3) : 0,
    C4: unrelated.every(q => q.selected.length === 0),
    C5: +rate(answerable, q => q.hybrid.hit1).toFixed(3),
    C6: +rate(hist, allRel).toFixed(3),
    C7: +rate(semFav, allRel).toFixed(3),
    C8: +rate(kwFav, allRel).toFixed(3),
    C9: lost.length,
    C10: ines.every(q => q.pool === 'small') && ines.filter(q => q.relevant.length).every(allRel) && ines.filter(q => !q.relevant.length).every(q => q.selected.length === 0),
    C11: fallbackOk,
  };
  const pass = {
    C1: m.C1 >= CRITERIA.C1.min, C2: m.C2 <= CRITERIA.C2.max, C3: m.C3 <= CRITERIA.C3.max, C4: m.C4 === true,
    C5: m.C5 >= CRITERIA.C5.min, C6: m.C6 >= CRITERIA.C6.min, C7: m.C7 >= CRITERIA.C7.min, C8: m.C8 >= CRITERIA.C8.min,
    C9: m.C9 <= CRITERIA.C9.max, C10: m.C10 === true, C11: fallbackOk == null ? null : fallbackOk >= CRITERIA.C11.min,
  };
  const mean = k => +(answerable.reduce((n, q) => n + (q[k].mrr ?? 0), 0) / answerable.length).toFixed(3);
  return {
    metrics: m, pass, detail: { excludedSelected: excl, lostVsKeyword: lost, relevant: `${relSel}/${relTotal}`, otherSelected: `${other}/${selTotal}` },
    informational: { mrr: { keyword: mean('keyword'), semantic: mean('semantic'), hybrid: mean('hybrid') }, currentFirst: `${hist.filter(q => q.currentFirst).length}/${hist.length}` },
  };
}
