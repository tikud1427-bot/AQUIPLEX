/**
 * AQUA Brain — Context Engine V2 Assembler (Brain V1 / B4)
 *
 * "The engine should assemble the OPTIMAL context. Do NOT dump every memory
 * into prompts." — the brief's core instruction for this phase.
 *
 * WHAT THIS DOES DIFFERENTLY
 * --------------------------
 * The PIC lane scores facts lexically, sorts, and takes the top N until a
 * char budget fills. Two problems the brief calls out:
 *
 *   1. Scoring is one-dimensional. B4's scorer fixes that (ten dimensions).
 *   2. Selection is "highest first until full" — which loads five near-
 *      duplicate facts about the same entity and nothing about the second
 *      entity the question mentioned. That is dumping, ranked.
 *
 * The assembler makes selection a real decision:
 *
 *   • DIVERSITY. Once an entity has contributed a couple of items, further
 *     items about it are down-weighted, so the budget spreads across the
 *     things the question is actually about instead of piling onto one.
 *   • BUDGET AS SELECTION. Items compete for a token budget by score-per-
 *     char, not raw score — a long low-value item does not crowd out three
 *     short high-value ones.
 *   • THRESHOLD. Below a floor score an item is left out entirely. An empty
 *     assembly is a valid, safe answer (byte-identical prompt to no-context).
 *
 * SUPERSET RETURN SHAPE
 * ---------------------
 * Returns exactly the PIC contract — { items, block, stats } — so it drops
 * into chat.js at the existing seam with no downstream change, PLUS a
 * `contextEngine` stats section (per-item dimensions, what was dropped and
 * why) for observability. Callers that only read block/items/stats are
 * unaffected; the enrichment is additive.
 *
 * Pure over its inputs. The caller (facade) gathers candidates + signals;
 * this ranks, selects, and renders.
 */
import { scoreCandidate, rankedDimensions, tokensOf } from './scorer.js';
import { round3 } from '../worldModel/schema.js';

const RELATIVE_FLOOR = 0.3;
const DEFAULTS = {
  limit: 8,
  charBudget: 1600,
  minScore: 0.12,          // below this an item is not worth prompt space
  perEntitySoftCap: 2,     // items about one entity before diversity kicks in
  diversityPenalty: 0.6,   // multiplier applied past the soft cap
  slotOverBudgetPenalty: 0.35,
  requiredSlotBoost: 1.15,
  optionalSlotBudgetShare: 0.25,
  // RELEVANCE > FILLING (2026-10-04): a candidate scoring below this fraction
  // of the BEST candidate for the same question is not admitted, however many
  // seats are free. Relative, so it adapts per question (absolute thresholds
  // were measured and fail: noisy and answerable scores overlap). Measured on
  // context-core: 0.25 and 0.4 change nothing, 0.55 loses recall
  // (recall_selfword 0.75 → 0.625); 0.3 leaves margin and the full eval:gate
  // unchanged. It does NOT fix the residual noise on unanswerable questions —
  // that is abstention (no signal separates "found the answer" from "found
  // something person-shaped"), see eval/tests/contextBaseline.test.js.
  relativeFloor: RELATIVE_FLOOR,
};

/**
 * @param {Array} candidates - normalized candidate objects (see scorer)
 * @param {object} ctx - the shared signal bag for scoring
 * @param {object} [opts] - { limit, charBudget, minScore, perEntitySoftCap, diversityPenalty, queryPlan }
 * @returns {{ items, block, stats }} PIC-superset
 */
export function assembleContext(candidates, ctx, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const started = Date.now();

  // 1. Score every candidate on all ten dimensions, then apply a lifecycle
  // adjustment (opt-in via an explicit `validTo` key) so a superseded fact
  // never outranks its current replacement on tied dimension scores alone —
  // the ten dimensions have no sense of "is this still true", only "is this
  // relevant". Candidates that don't declare `validTo` are untouched.
  const scored = candidates.map(c => {
    const { score, dimensions } = scoreCandidate(c, ctx);
    const lifecycle = lifecycleInfo(c);
    const adjusted = lifecycle ? round3(score * lifecycle.penalty) : score;
    return {
      ...c, score: adjusted,
      selectionScore: Number.isFinite(c.selectionScore) ? c.selectionScore : adjusted,
      dimensions, lifecycleLabel: lifecycle?.label ?? null,
    };
  });

  // 2. Select with diversity + budget as actual constraints.
  //
  // Diversity is a RE-RANKING, not a per-item gate during a raw-score walk:
  // if we simply walked highest-first, the 4th fact about entity A (even
  // penalized) could still take a slot before the 1st fact about entity B is
  // ever considered. Instead we repeatedly pick the best-scoring remaining
  // candidate under its CURRENT diversity penalty, then update the penalty —
  // so once A is well-covered, B's fresh item outranks A's next one.
  const dropped = [];
  const top = scored.reduce((m, c) => Math.max(m, c.score), 0);
  const floorScore = Math.max(cfg.minScore, (Number(cfg.relativeFloor) || 0) * top);
  // RELEVANCE-BACKED (2026-10-04): a candidate can clear the score floor on
  // PRIORS alone — confidence, source reliability, importance, recency — with
  // no signal that it is about the question ("I had coffee on Monday" scored
  // 46% of a strong match). When at least one candidate IS backed by a
  // relevance signal, prior-only candidates are not admitted: an empty seat
  // beats irrelevant personal information. When none is backed, nothing is
  // dropped by this rule (the absolute and relative floors still apply).
  const backed = scored.map(relevanceBacked);
  const anyBacked = cfg.requireRelevance !== false && backed.some(Boolean);
  const pool = scored.filter((c, i) => c.score >= floorScore && (!anyBacked || backed[i]));
  scored.forEach((c, i) => {
    if (c.score < cfg.minScore) dropped.push({ id: c.id, reason: 'below-threshold', score: c.score });
    else if (c.score < floorScore) dropped.push({ id: c.id, reason: 'below-relative-floor', score: c.score });
    else if (anyBacked && !backed[i]) dropped.push({ id: c.id, reason: 'no-relevance-signal', score: c.score });
  });

  const selected = [];
  const perEntityCount = new Map();
  let usedChars = 0;
  // RENDERED == SELECTED (2026-10-06). Items were budgeted against charBudget
  // alone, then renderBlock counted its header/footer lines against the SAME
  // budget and silently cut the trailing items: stats said 8 selected, the
  // model read fewer. For production-sized budgets the fixed overhead is now
  // reserved up front, so every selected item is rendered. Tiny budgets (unit
  // fixtures < 800) keep the old arithmetic.
  const overhead = blockOverhead(contextEpistemicState(cfg.queryPlan), candidates.some(c => c.understood));
  const reserve = cfg.charBudget >= 800;
  const itemBudget = reserve ? cfg.charBudget - overhead : cfg.charBudget;
  const slotBudget = buildSlotBudget(cfg.queryPlan, cfg.charBudget);
  const slotUsed = new Map();

  // Why the loop can end with items still in the pool: `limit` reached (they
  // lost on rank) or nothing left is ELIGIBLE (each is worth less than
  // `minScore` once its slot situation is priced in). The two are reported
  // as different reasons — conflating them is how a gate hid inside a
  // re-ranking for as long as it did.
  let exhaustedEligible = false;
  while (selected.length < cfg.limit && pool.length) {
    // Effective score for each remaining candidate under the current coverage.
    let bestIdx = -1;
    let bestEff = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const primary = pool[i].entityIds?.[0] ?? null;
      const covered = primary ? (perEntityCount.get(primary) ?? 0) : 0;
      const base = pool[i].selectionScore ?? pool[i].score;

      // What the item is worth BEFORE crowding: its score, adjusted by where
      // it sits in the slot plan. This — not the diversity-penalised value —
      // is what `minScore` judges. Diversity is a RE-RANKING (see the comment
      // above): it may move an item down the order, it may never remove one
      // that cleared the floor. Judging the penalised value turned a soft
      // cap into a hard one: in a self-scoped world nearly every fact has the
      // user as its primary entity, so after two picks every remaining fact
      // was multiplied by diversityPenalty, fell under `minScore` together,
      // and was dropped with reason 'diversity' — while 194 of 1600 chars of
      // budget went unused.
      let worth = base;
      const slotId = bestSlotForCandidate(pool[i], slotBudget, slotUsed);
      if (slotId) {
        const budget = slotBudget.get(slotId) ?? 0;
        const used = slotUsed.get(slotId) ?? 0;
        if (used >= budget) worth *= cfg.slotOverBudgetPenalty;
        else if (isRequiredSlot(cfg.queryPlan, slotId) && used === 0) worth *= cfg.requiredSlotBoost;
      }
      if (worth < cfg.minScore) continue;   // not eligible this round

      const eff = covered >= cfg.perEntitySoftCap ? worth * cfg.diversityPenalty : worth;
      if (eff > bestEff) { bestEff = eff; bestIdx = i; }
    }
    if (bestIdx < 0) { exhaustedEligible = true; break; }

    const c = pool.splice(bestIdx, 1)[0];

    // One sentence, one line. A single user sentence often yields several
    // claims ("I run product at Ledgerly" → works_at + role_is); each arrived
    // as its own candidate and the model read the same line twice while a
    // different fact lost its seat to the repeat (live Postgres, 2026-10-04).
    // The kept line inherits the duplicate's slots; nothing about the claim
    // itself is lost — only the redundant rendering.
    const textKey = normText(c.text);
    const twin = textKey ? selected.find(s => normText(s.text) === textKey && Boolean(s.disputed) === Boolean(c.disputed)) : null;
    if (twin) {
      if (Array.isArray(c.slotIds) && c.slotIds.length) {
        twin.slotIds = [...new Set([...(twin.slotIds ?? []), ...c.slotIds])];
      }
      // One line, every READING (2026-10-06): "the launch is now January 15,
      // not December 10" is two claims; keeping only the first reading lost
      // the new date. The twin's reading joins the kept line when it fits.
      if (c.understood && twin.understood) {
        const before = renderLength(twin);
        const merged = { ...twin, alsoUnderstood: [...(twin.alsoUnderstood ?? []), c.understood] };
        const delta = renderLength(merged) - before;
        if (usedChars + delta <= itemBudget) { twin.alsoUnderstood = merged.alsoUnderstood; usedChars += delta; }
      }
      dropped.push({ id: c.id, reason: 'duplicate-text', score: c.score });
      continue;
    }

    // Budget as selection: value must justify the space. A near-empty budget
    // still admits a short, strong item.
    const cost = renderLength(c) + (reserve ? 1 : 0);   // + the newline that joins it
    if (usedChars + cost > itemBudget) {
      const remaining = itemBudget - usedChars;
      if (cost > remaining) { dropped.push({ id: c.id, reason: 'budget', score: c.score }); continue; }
    }

    selected.push({ ...c, effectiveScore: round3(bestEff) });
    usedChars += cost;
    const selectedSlot = bestSlotForCandidate(c, slotBudget, slotUsed);
    if (selectedSlot) slotUsed.set(selectedSlot, (slotUsed.get(selectedSlot) ?? 0) + cost);
    const primary = c.entityIds?.[0] ?? null;
    if (primary) perEntityCount.set(primary, (perEntityCount.get(primary) ?? 0) + 1);
  }
  for (const c of pool) dropped.push({ id: c.id, reason: exhaustedEligible ? 'below-threshold' : 'limit', score: c.score });

  // 3. Render + structured items (PIC-shaped) + observability stats.
  const items = selected.map(c => toItem(c));
  const epistemic = contextEpistemicState(cfg.queryPlan);
  const retired = cfg.retiredTexts ? new Set([...cfg.retiredTexts].map(normText)) : null;
  const block = renderBlock(selected, cfg.charBudget, epistemic, retired);

  const stats = {
    // PIC-compatible fields (chat.js logs these).
    facts: selected.filter(s => s.kind === 'fact').length,
    entities: selected.filter(s => s.kind === 'entity').length,
    timelineEvents: selected.filter(s => s.kind === 'event').length,
    connectedFacts: selected.filter(s => (s.via ?? '').startsWith('graph')).length,
    reusedSignals: 0,
    durationMs: Date.now() - started,
    // B4 observability — the assembly is explainable.
    contextEngine: {
      version: 3,
      epistemicState: epistemic.state,
      shouldAbstain: epistemic.shouldAbstain,
      requiredSlotsMissing: epistemic.missing,
      provenancePreserved: true,
      candidates: candidates.length,
      selected: selected.length,
      dropped: dropped.length,
      dropReasons: tally(dropped.map(d => d.reason)),
      usedChars,
      charBudget: cfg.charBudget,
      slotBudgets: Object.fromEntries([...slotBudget.entries()].map(([id, budget]) => [id, {
        budget,
        used: slotUsed.get(id) ?? 0,
        remaining: Math.max(0, budget - (slotUsed.get(id) ?? 0)),
      }])),
      topDimensionsPerItem: selected.slice(0, 5).map(s => ({
        id: s.id ?? s.entity,
        score: s.score,
        top: rankedDimensions(s.dimensions).slice(0, 3).map(r => `${r.dim}:${r.contribution}`),
      })),
    },
  };

  return { items, block, stats };
}

function buildSlotBudget(plan, charBudget) {
  const slots = Array.isArray(plan?.slots) ? plan.slots : [];
  if (!slots.length) return new Map();
  const required = slots.filter(s => s.required);
  const optional = slots.filter(s => !s.required);
  const reserve = Math.floor(charBudget * 0.75);
  const requiredBudget = required.length ? Math.floor(reserve / required.length) : 0;
  const optionalPool = Math.max(0, charBudget - requiredBudget * required.length);
  const optionalBudget = optional.length ? Math.floor(optionalPool * 0.25 / optional.length) : 0;
  const out = new Map();
  for (const slot of required) out.set(slot.id, requiredBudget);
  for (const slot of optional) out.set(slot.id, optionalBudget);
  return out;
}

function isRequiredSlot(plan, slotId) {
  return !!plan?.slots?.find(s => s.id === slotId)?.required;
}

function bestSlotForCandidate(candidate, slotBudget, slotUsed) {
  const ids = Array.isArray(candidate?.slotIds) ? candidate.slotIds : [];
  if (!ids.length || !slotBudget.size) return null;
  return ids
    .filter(id => slotBudget.has(id))
    .sort((a, b) => {
      const ar = (slotBudget.get(a) - (slotUsed.get(a) ?? 0)) / Math.max(1, slotBudget.get(a));
      const br = (slotBudget.get(b) - (slotUsed.get(b) ?? 0)) / Math.max(1, slotBudget.get(b));
      return br - ar;
    })[0] ?? null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderLength(c) {
  return renderItemLine(c).length;
}

/**
 * A citation is a formatted string (formatCitation ran) or a raw canonical
 * evidence row ({ quote, locator, role, extracted_at }). The raw row used to be
 * interpolated as-is and the model read "[[object Object]]" on every canonical
 * claim (live Postgres, 2026-10-04) — the same class of defect as "• undefined".
 * Render what the row actually says about provenance; omit it if nothing.
 */
function citationLabel(cit) {
  if (cit == null) return '';
  if (typeof cit === 'string') return cit;
  if (typeof cit !== 'object') return String(cit);
  const at = cit.extracted_at ?? cit.extractedAt ?? cit.asserted_at ?? null;
  const when = at ? new Date(at) : null;
  const day = when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 10) : null;
  const turn = cit.locator?.turn ?? null;
  const parts = [
    day ? `said ${day}` : null,
    Number.isInteger(turn) ? `turn ${turn}` : null,
    cit.role && cit.role !== 'primary' ? cit.role : null,
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * One line the ANSWER MODEL reads. Only what it needs to answer: the statement,
 * when it was said, how sure, and its status.
 *
 * Retrieval mechanics — the lane (`via dense: 0.58`, `via graph:1:out:…`) and
 * the QueryPlan slot (`{slots: …}`) — are NOT rendered (2026-10-05). The model
 * repeated them to users ("reported in a dense-extraction snippet"). They stay
 * on every item (`provenance.via`, `slotIds`) and in stats for diagnostics.
 */
/**
 * How a canonical relation reads in English. Display only — the predicate on
 * the item is unchanged. Unlisted predicates read as their name with spaces.
 */
const RELATION_PHRASE = Object.freeze({
  works_at: 'works at', role_is: 'has the role', located_in: 'is based in', member_of: 'is a member of',
  founded: 'founded', is_a: 'is', knows: 'knows', reports_to: 'reports to', manages: 'manages',
  related_to: 'is related to', employs: 'employs', has_member: 'has member', founded_by: 'was founded by',
  builds: 'builds', uses: 'uses', owns: 'owns', owned_by: 'is owned by', blocks: 'blocks',
  blocked_by: 'is blocked by', depends_on: 'depends on', plans_to: 'plans to', decided: 'decided',
  rejected: 'rejected', has_status: 'has status', deadline_for: 'has the deadline', prefers: 'prefers',
  dislikes: 'dislikes', habit_of: 'has the habit', has_property: 'has', task_owner: 'is responsible for',
});
const MODALITY_LABEL = Object.freeze({ intent: 'intends', hypothetical: 'hypothetically', question: 'asked whether', quote: 'quoting' });
// The self entity is labelled "You"; a first-mention entity keeps the user's
// own words ("my thesis"). Both read from the answer model's side as the user's.
const subjectLabel = s => {
  const t = String(s).trim();
  if (/^you$/i.test(t)) return 'User';
  return t.replace(/^(my|our)\s+/i, "User's ");
};
const dayOf = t => { const d = t ? new Date(t) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null; };

/**
 * A CANONICAL fact line (2026-10-06): the World Model's reading first, then the
 * user's own words as evidence, then when it was said.
 *
 *   • NOT: User decided an Android app — "We decided not to build an Android app this year" [said 2026-10-06]
 *
 * WHY: the line used to be the verbatim segment alone ("Rohan took it over",
 * "he handles engineering"), so everything the World Model resolved — the
 * subject behind a pronoun, the relation, the polarity — never reached the
 * answer model, and the context was a re-ranked list of sentences that lost to
 * plain lexical memory on the World-Model Lift. No numeric confidence: every
 * chat claim derives ≈0.66 (a constant, not a measurement), and the answer
 * model hedged on it in 11 of 14 inspected answers (PRODUCTION_VALIDATION Part
 * 3 §3.6). Meaningful status (disputed / no longer current / stale) stays.
 */
function readingOf(u) {
  const neg = u.polarity === 'negated' ? 'NOT: ' : '';
  const mod = MODALITY_LABEL[u.modality] ? `(${MODALITY_LABEL[u.modality]}) ` : '';
  const rel = RELATION_PHRASE[u.predicate] ?? String(u.predicate).replace(/_/g, ' ');
  // CLOSED VALIDITY IS PAST (2026-10-06, Lift p9: "I lived in Kyoto until 2023"
  // rendered as "User is based in Kyoto").
  const end = u.validTo ? new Date(u.validTo) : null;
  // SCHEDULED IS NOT CURRENT (2026-10-11, Pass 2): a state that starts later
  // ("from next month my manager will be Priya") is rendered as scheduled, so
  // the answer model can answer "next month" without asserting it as "now".
  const start = u.validFrom ? new Date(u.validFrom) : null;
  const scheduled = start && !Number.isNaN(start.getTime()) && start.getTime() > Date.now()
    ? ` (scheduled from ${dayOf(start)} — not yet current)` : '';
  const past = (end && !Number.isNaN(end.getTime()) && end.getTime() < Date.now()
    ? ` (until ${dayOf(end)} — past, not current)` : '') + scheduled;
  // A ROLE RELATION (prompt rule 13) reads as what it is: "Sam Patel is the
  // user's mentor", not "Sam Patel is related to mentor".
  if (u.predicate === 'related_to') return `${neg}${mod}${subjectLabel(u.subject)} is the user's ${String(u.object).replace(/^(?:the\s+)?(?:user'?s|my|our)\s+/i, '')}${past}`;
  return `${neg}${mod}${subjectLabel(u.subject)} ${rel} ${subjectLabel(u.object)}${past}`;
}

function renderCanonicalLine(c, { showDates = true, retired = null } = {}) {
  // Asserted readings first: "deadline January 15; NOT: deadline December 10".
  const readings = [c.understood, ...(c.alsoUnderstood ?? [])]
    .sort((a, b) => (a.polarity === 'negated') - (b.polarity === 'negated'))
    .map(readingOf);
  const quote = String(c.text ?? '').replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  const day = showDates ? dayOf(c.assertedAt) : null;
  const flags = [c.disputed && 'disputed — treat as contested', c.stale && 'stale',
    c.superseded && 'no longer current — past only'].filter(Boolean).join('; ');
  // A sentence that also carried a now-RETIRED claim ("My biggest client is a
  // restaurant called Fennel" after the role moved) is not quoted: the quote
  // would re-assert the retired part. The current reading stands alone.
  // History shown AS history (superseded, past-tense question) keeps its quote:
  // it is already labelled "no longer current".
  const evidence = !c.superseded && retired?.has(normText(c.text)) ? '' : ` — "${quote}"`;
  // NO STRONGER THAN THE EVIDENCE (2026-10-11, Pass 2): "we're thinking about
  // cross-border splits in v2, nothing is decided" read as "(intends) User
  // plans to add cross-border splits", and the answer asserted the plan. A
  // hedged source is labelled so the reading cannot outrank its own words.
  const hedge = HEDGE_RE.test(quote) && !readings.some(r => /^\(?(?:hypothetically|undecided)/.test(r)) ? '(undecided — not decided by the user) ' : '';
  return `• ${hedge}${[...new Set(readings)].join('; ')}${evidence} ${sourceTag(c, day)}${flags ? ` (${flags})` : ''}`;
}

/**
 * WHERE IT CAME FROM, ALWAYS (2026-10-19). Asked "Where did you learn our
 * current price?", the answer called the founder's own chat message "internal
 * pricing information… the later internal note" (live founder journey): the
 * line carried a quote and, on a one-day session, nothing saying who said it.
 * Every canonical line now names its source kind; the date is added only when
 * it informs (see renderItemLine).
 */
export function sourceTag(c, day) {
  const on = day ? ` on ${day}` : '';
  if (c.sourceType === 'document') {
    const name = String(c.sourceRef ?? '').match(/^file:(.+):chunk:\d+$/)?.[1];
    return `[from the user's uploaded file${name ? ` ${name}` : ''}${day ? `, added ${day}` : ''}]`;
  }
  if (c.sourceType === 'user_correction') return `[the user corrected this in Aqua's Memory${on}]`;
  return `[the user told Aqua in conversation${on}]`;
}

/**
 * WHEN-SAID ONLY WHEN IT INFORMS (2026-10-06, Lift). Every claim of a block
 * told on one day carries no information in its date, and the answer model
 * quoted "[said 2026-10-06]" as the date of the EVENT (judged fabrication on
 * 3 lost questions). Dates render only when the selected claims span ≥ 2 days;
 * order is conveyed by the oldest → newest listing either way.
 */
function renderItemLine(c, opts = {}) {
  if (c.kind === 'fact' && c.understood) return renderCanonicalLine(c, opts);
  if (c.kind === 'entity') {
    const aka = c.aliases?.length ? ` (a.k.a. ${c.aliases.slice(0, 3).join(', ')})` : '';
    const where = c.files?.length ? ` — appears in ${c.files.slice(0, 3).join(', ')}` : '';
    return `• Entity: ${c.text}${aka}${where}`;
  }
  if (c.kind === 'event') {
    return `• ${c.timestamp ? `[${c.timestamp}] ` : ''}${String(c.text).slice(0, 120)}`;
  }
  const label = citationLabel(c.citations?.[0]);
  const cite = label ? ` [${label}]` : '';
  const flags = [c.trusted && 'trusted', c.disputed && 'disputed — treat as contested', c.stale && 'stale',
    c.superseded && 'no longer current — past only',
    c.lifecycleLabel && `lifecycle ${c.lifecycleLabel}`]
    .filter(Boolean).join(', ');
  return `• ${c.text}${cite} (confidence ${fmt(c.confidence)}${flags ? `; ${flags}` : ''})`;
}

const HEDGE_RE = /\b(?:might|maybe|perhaps|possibly|thinking\s+about|considering|not\s+(?:yet\s+)?decided|undecided|haven['’]t\s+decided|nothing\s+(?:is\s+)?decided|not\s+sure|just\s+an\s+idea|we['’]ll\s+see)\b/i;
const ORDER_NOTE = 'Statements below are listed oldest → newest. When two statements about the same thing conflict, the later one is the current state unless it is marked disputed.';
// NOT LISTED = NOT KNOWN (2026-10-11, Pass 2). Fabrication was the largest
// World-Model failure class on Lift v3 (39 judged answers): invented dates,
// statuses, day rates and "on track" claims next to a correct context. The
// context now says what its absence means.
const BLOCK_FOOTER = 'Use the context above with its provenance and citations; disputed items must be presented as contested, never as settled. '
  + 'Anything about the user not stated in this context is unknown: never invent their names, dates, numbers, plans or statuses — say it is not known.';

/** Fixed (non-item) characters a block with this epistemic state will carry. */
function blockOverhead(epistemic, ordered) {
  const head = headerLines(epistemic);
  return [...head, ...(ordered ? [ORDER_NOTE] : []), BLOCK_FOOTER].reduce((n, l) => n + l.length + 1, 0);
}

function headerLines(epistemic) {
  const lines = ['── CONTEXT AQUA ASSEMBLED FOR THIS QUESTION ──'];
  const knownRequired = (epistemic.filled ?? []).length > 0;
  if (epistemic.state === 'unknown' && knownRequired) {
    lines.push(`EVIDENCE STATUS: PARTIAL — answer from what is known below.`);
    lines.push(`Not known: ${epistemic.missing.join(', ') || 'unspecified'}. Say so plainly; do not infer or fabricate it. If it changes the answer, ask about it once.`);
  } else if (epistemic.state === 'unknown') {
    lines.push(`EVIDENCE STATUS: UNKNOWN — required information is missing after the bounded retrieval policy.`);
    lines.push(`Required slots still unknown: ${epistemic.missing.join(', ') || 'unspecified'}. Do not infer or fabricate them.`);
  } else if (epistemic.state === 'needs_round_two') {
    lines.push(`EVIDENCE STATUS: INCOMPLETE — a targeted second retrieval round is required for: ${epistemic.missing.join(', ')}.`);
  } else {
    lines.push('EVIDENCE STATUS: SUFFICIENT for the required QueryPlan slots.');
  }
  return lines;
}

function renderBlock(selected, charBudget, epistemic = { state: 'sufficient', missing: [] }, retired = null) {
  if (!selected.length && epistemic.state !== 'unknown') return '';
  const lines = ['── CONTEXT AQUA ASSEMBLED FOR THIS QUESTION ──'];
  // PARTIAL vs UNKNOWN (2026-10-07). With predicate-defined slots, "Should I
  // launch?" routinely knows the goal and the blocker but not the deadline.
  // Calling that UNKNOWN pushed the model toward refusing to answer — the
  // interrogator failure Blueprint E8 names. PARTIAL keeps the honesty (the
  // gap is named, never filled in) while still answering from what is known,
  // and caps the follow-up at one question. UNKNOWN is kept for the case where
  // no required slot is known at all. State names and shouldAbstain unchanged.
  lines.push(...headerLines(epistemic).slice(1));
  // ORDER IN TIME (2026-10-06). Selection is by relevance; the READING order is
  // chronological for the World Model's dated claims, so the answer model can
  // see which of two statements about the same thing came later — the one
  // thing lexical memory's "[turn N]" lines told it and these lines did not.
  // Undated items (legacy floor, entities) keep their relevance order, first.
  const dated = selected.filter(c => c.kind === 'fact' && c.understood && dayOf(c.assertedAt));
  const undated = selected.filter(c => !dated.includes(c));
  const ordered = [...undated, ...[...dated].sort((a, b) => new Date(a.assertedAt) - new Date(b.assertedAt))];
  if (dated.length > 1) lines.push(ORDER_NOTE);
  // Selection budgeted the LONGER (dated) line, so dropping dates never overflows.
  const showDates = new Set(dated.map(c => dayOf(c.assertedAt))).size >= 2;
  for (const c of ordered) lines.push(renderItemLine(c, { showDates, retired }));
  lines.push(BLOCK_FOOTER);

  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > charBudget) break;
    out += (out ? '\n' : '') + l;
  }
  return out;
}

function contextEpistemicState(plan) {
  const required = Array.isArray(plan?.slots) ? plan.slots.filter(s => s.required) : [];
  const missing = required.filter(s => s.status !== 'filled').map(s => s.id);
  const round = Number(plan?.round ?? 1);
  const filled = required.filter(s => s.status === 'filled').map(s => s.id);
  if (!missing.length) return { state: 'sufficient', shouldAbstain: false, missing: [], filled };
  if (round >= 2) return { state: 'unknown', shouldAbstain: true, missing, filled };
  return { state: 'needs_round_two', shouldAbstain: false, missing, filled };
}

function toItem(c) {
  const provenance = {
    via: c.via ?? null,
    citations: Array.isArray(c.citations) ? [...c.citations] : [],
    slotIds: Array.isArray(c.slotIds) ? [...new Set(c.slotIds)] : [],
    lane: c.lanes?.length ? [...c.lanes] : null,
  };
  if (c.kind === 'entity') {
    return {
      kind: 'entity', epistemic: 'derived',
      entity: c.text, entityType: c.entityType, aliases: c.aliases ?? [],
      files: c.files ?? [], nodeId: c.id,
      slotIds: provenance.slotIds, provenance,
      score: c.score, dimensions: c.dimensions,
    };
  }
  if (c.kind === 'event') {
    return {
      kind: 'event', epistemic: 'derived',
      statement: c.text, timestamp: c.timestamp, certainty: c.certainty,
      slotIds: provenance.slotIds, provenance,
      score: c.score, dimensions: c.dimensions,
    };
  }
  return {
    kind: 'fact', epistemic: c.epistemic ?? 'observed',
    id: c.id, statement: c.text, confidence: c.confidence,
    // Opaque canonical ids the fact is about (never rendered into the prompt);
    // conversation focus uses them to resolve "this"/"it" next turn.
    entityIds: Array.isArray(c.entityIds) ? [...c.entityIds] : [],
    trusted: !!c.trusted, disputed: !!c.disputed, stale: !!c.stale,
    citations: provenance.citations, via: provenance.via,
    slotIds: provenance.slotIds, provenance,
    score: c.score, dimensions: c.dimensions,
    understood: c.understood ?? null, assertedAt: c.assertedAt ?? null,
    ...(c.alsoUnderstood?.length ? { alsoUnderstood: [...c.alsoUnderstood] } : {}),
  };
}

// ── small utils ──────────────────────────────────────────────────────────────

/**
 * Opt-in lifecycle adjustment: only candidates that explicitly declare a
 * `validTo` (even `null`) participate — everything else renders exactly as
 * before. `validTo: null` means "still open" (current); a `validTo` in the
 * past means a later fact superseded this one and it should rank behind it
 * on tied relevance, never ahead of it.
 */
/** Does anything other than priors say this candidate is about the question? */
// semantic_similarity counts only from SEMANTIC_BACKING up: every embedded
// candidate has SOME cosine, and 0.05 means unrelated, not relevant.
const SEMANTIC_BACKING = 0.3;
// relationship_distance is 0.5 when graph distance is UNKNOWN (a prior), so it
// counts only for candidates the graph actually reached (hops known).
const RELEVANCE_DIMENSIONS = ['user_focus', 'active_project', 'active_goal', 'conversation_continuity'];
const STRUCTURAL_LANES = new Set(['structured', 'graph']);
function relevanceBacked(c) {
  if (Number(c.dimensions?.semantic_similarity ?? 0) >= SEMANTIC_BACKING) return true;
  if (c.hops != null && Number(c.dimensions?.relationship_distance ?? 0) > 0) return true;
  if (RELEVANCE_DIMENSIONS.some(d => Number(c.dimensions?.[d] ?? 0) > 0)) return true;
  if (Array.isArray(c.slotIds) && c.slotIds.length) return true;          // fills a required slot by predicate
  if ((c.lanes ?? []).some(l => STRUCTURAL_LANES.has(l))) return true;    // selected by anchor / predicate
  return false;
}

function lifecycleInfo(c) {
  if (!Object.prototype.hasOwnProperty.call(c, 'validTo')) return null;
  if (c.validTo == null) return { label: 'current', penalty: 1 };
  const validTo = new Date(c.validTo).getTime();
  if (Number.isFinite(validTo) && validTo < Date.now()) return { label: 'superseded', penalty: 0.5 };
  return { label: 'current', penalty: 1 };
}

function tally(arr) {
  const out = {};
  for (const x of arr) out[x] = (out[x] ?? 0) + 1;
  return out;
}
const fmt = (n) => (n == null ? '?' : Number(n).toFixed(2));
/** Sentence identity for duplicate suppression: case, spacing and final punctuation ignored. */
const normText = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();

export { DEFAULTS as ASSEMBLER_DEFAULTS, tokensOf, readingOf };
