# AQUA Hybrid Context — Architecture Proposal

**Sprint 5, 2026-11-11. PROPOSAL ONLY: nothing implemented, nothing activated.**

## 1. Problem

Two measured facts from the Sprint 4 evaluation (`acib.v2.eval`, single run):

1. **The existing pipeline (A) has high recall on short histories** (0.98, 95/100 correct). It has poor precision (0.55 short, 0.16 long), no unknown handling (0), and weak contradiction handling (0.50).
2. **Information Needs V2 (B) has high precision** (0.80 / 0.68) and is strong on contradictions (0.94) and unknowns (0.85 / 0.69). Because it **replaces** A's context, it loses cases A gets right: 88 vs 95 short. Its lexical matching misses paraphrases, and 22 of 200 turns fell back.

**Replacement is the wrong composition.** The hybrid keeps A's context and lets V2 *add* what A lacks: labelled unknowns, conflicts, changes, and evidence A missed. Precision gains are a later, separately gated step.

## 2. Principles (from the brief)

| # | Rule | Mechanism |
|---|---|---|
| 1 | A keeps its normal context | A's lanes are built exactly as today; V2 output is appended as a separate block. |
| 2 | V2 identifies relevant and missing information independently | V2 runs on the question as today (anchoring, requirements, evidence, statuses). |
| 3 | V2 contributes only when strong | A per-contribution **strength gate** (§4). |
| 4 | Weak or failed V2 never discards A | Hybrid v1 never removes A content. Pruning is a separate flag (§7), off. |
| 5 | Contradiction and outdated evidence stay labelled | V2 annotations reference the statements involved, whichever lane holds them. |
| 6 | Essential unknowns stay unknown, never inferred | An "unknown" is declared only if **neither V2 nor A's context** holds candidate evidence (§4.3). |
| 7 | Token budgets controlled | A hard budget for the hybrid block; V2 content is trimmed first, never A's. |
| 8 | Privacy, provenance, isolation preserved | Same privacy filters, `scrubSensitiveLines`, untrusted-content fence, owner scoping. |

## 3. Architecture

```
prepareTurn
 ├─ (unchanged) memoryRetrieve → memoryBlock (identity, profile, cognitive)
 ├─ (unchanged) PIC knowledge → knowledgeContext
 ├─ (unchanged) episodic recall → recall.block
 ├─ NEW  hybridContribution(question, A-context, V2-analysis)   ← AQUA_HYBRID_CONTEXT
 │        ├─ V2 analysis (existing analyseInformationNeeds, with a work budget)
 │        ├─ A-context index: normalised sentences + fact keys already in A's lanes
 │        ├─ strength gate per contribution
 │        ├─ unknown verification against A's context
 │        └─ render ≤ budget → hybridBlock
 └─ buildSystemPrompt(… + hybridBlock appended after recall, inside the same untrusted fence rules)
```

New module: `aqua/src/brain/contextEngine/hybridContext.js`. It is pure, takes the A lanes and the V2 result as inputs, and returns `{ block, summary }`.

**No changes to:** memory writes, the commit boundary, A's retrieval, the engine's stores, or the response payload (only a content-free summary for logs).

## 4. Contribution rules

### 4.1 Contribution types

| Type | Comes from | Added when |
|---|---|---|
| **Missing evidence** | A V2 quote or fact for a need, *not already in A's context* (normalised-sentence or fact-key dedupe) | Its need's match is **strong** (§4.2) |
| **Conflict note** | V2 `contradictory` status | Always (both statements quoted), when both statements belong to this user |
| **Change note** | V2 `outdated` or `followChanges`, or fact ended by a later word | Always, when the later statement is the user's own, dated after the earlier one |
| **Unknown** | A V2 essential need with status `missing` | Only if verified unknown (§4.3) |
| **Ambiguity note** | V2 `ambiguous` (e.g. two Sams) | Always |
| **Clarifying question** | `clarifyingQuestion()` | Only when an essential unknown, conflict or ambiguity remains after verification |

### 4.2 Strength of a V2 match

```
strong(evidence, need) =
     evidence.score ≥ 2                      // ≥2 need terms, or a term plus a phrase/figure
  || evidence.kind == 'fact' && evidence.hits ≥ 1 && !hedged
  || need.entity && evidence names the entity
weak = any other positive match           → not added; counted in the summary
```

The thresholds are hypotheses, to be fitted on the **development** set only (§9).

### 4.3 Unknown verification (prevents a lexical miss from becoming a false "Not known")

```
for need in V2.essential where status == 'missing':
    if A_context contains any sentence/fact matching need.terms (expanded) or need.phrases or (need.amount && figure):
        → status 'possibly-present': NOT declared unknown; no clarifying question about it
    else if V2.fallbackReason == 'no-evidence' and A_context is non-empty:
        → 'unverified': not declared (A's broad context may hold it in words V2 cannot match)
    else:
        → declared: "Not known: <label> — the user has not said. Do not guess it."
```

This is the hybrid's main safety property: **V2 never claims ignorance of something the existing context already shows the model.**

## 5. Behaviour by case

| Case | Hybrid behaviour |
|---|---|
| **Strong V2 evidence** | A unchanged. Add V2's strong evidence not already present (dedupe), plus any conflict and change notes. Status line: "sufficient". No question. |
| **Partial V2 evidence** | A unchanged. Add strong pieces only; weak matches are dropped. Unknowns only if verified (§4.3). Status "partial" if a non-essential need is missing. |
| **No V2 evidence** (`no-evidence` fallback, or nothing strong) | **Exactly A's context; the hybrid block is empty.** The summary records the reason. |
| **Contradictory evidence** | Conflict note quoting both statements with dates; "do not pick one silently". Exactly one clarifying question ("Which is right: … or …?"). A's lines stay; the note points at them. |
| **Outdated evidence** | Change note: "'<earlier>' (date) has since changed: '<later>' (date)". If A's profile still shows the old value as current, the note names it explicitly ("the profile line '<key>: <value>' is outdated"). A's line is not edited in v1. |
| **Missing essential information** | Declared unknown only after §4.3. One clarifying question for the most important verified gap. Never filled in. |
| **Engine exception** | `try/catch` gives exactly A's context; `[HYBRID] failed <ErrorName>`; `noteFeature('AQUA_HYBRID_CONTEXT','failed')`. |
| **Engine over budget (time)** | The engine is synchronous, so a timer cannot pre-empt it. Two layers: (1) a **work budget** inside the engine: max units scanned (e.g. the most recent 2,000 sentences plus anchored lookups), and deadline checks between stages that abort with `BudgetExceeded`; (2) **post-hoc discard**: if `ms > AQUA_HYBRID_MAX_MS` (default 50), the result is not used. Both give exactly A's context. A worker-thread variant is possible later if needed. |
| **Very long histories** | Same work budget. Unit collection is limited to the most recent N conversations, plus sentences containing anchor terms. An inverted index per owner would be a later optimisation, with no new store in v1. A's own recall behaviour is unchanged. |
| **Impersonal question** | V2 says `general`: the hybrid adds nothing. A unchanged in v1. Removing A's personal lanes on impersonal turns is the pruning flag (§7). |
| **Privacy: forgotten or withheld** | V2 uses the same `forgetClean`, `withholdClean` and `recallRedaction`. The hybrid block passes `scrubSensitiveLines`. A forget request seen by V2 but not reflected in A's lanes yields a note: "do not use or reconstruct <topic>". |

## 6. Token budget

```
budget = min(AQUA_HYBRID_MAX_TOKENS (default 400), contextBudget - tokens(A lanes) - reserve)
order of inclusion (until budget): conflict notes → change notes → ambiguity → verified unknowns
                                   → clarifying question → missing evidence (highest score first)
if budget ≤ 0: block = conflict + change notes only (≤ 120 tokens), else nothing
```

A's lanes are never trimmed by the hybrid. If A alone exceeds the context budget, the existing window logic applies as today.

## 7. Feature flags

| Flag | Values | Default | Meaning |
|---|---|---|---|
| `AQUA_HYBRID_CONTEXT` | `off` / `shadow` / `on` | `off` | **shadow:** compute the hybrid block, log a content-free summary, prompt unchanged. **on:** append the block. |
| `AQUA_HYBRID_MAX_TOKENS` | integer | 400 | Hybrid block budget |
| `AQUA_HYBRID_MAX_MS` | integer | 50 | Post-hoc discard threshold |
| `AQUA_HYBRID_PRUNE` | `off` / `shadow` / `on` | `off` | **Later, separate decision:** allow removing A's personal lanes on impersonal turns and A's irrelevant items when V2 is strong. Needs its own evaluation. |

- **Precedence:** `AQUA_INFO_NEEDS=on` (replacement) and `AQUA_HYBRID_CONTEXT=on` are mutually exclusive. If both are on, the registry reports a conflict and the **hybrid wins** (the safer composition). Registered in `core/flags.js` with `DEPENDENCIES`, and covered by the parity and registry tests.
- **Log line (shadow and on):** `[HYBRID] mode= added_evidence= dup_skipped= weak_dropped= conflicts= changes= unknowns_declared= unknowns_suppressed= question=0|1 tokens= ms= reason= owner=#hash req=`

## 8. Pseudocode

```js
// routes/chat.js, after A's lanes are built (memoryBlock, knowledgeContext, recall.block):
const hybridMode = hybridContextMode();
let hybrid = null;
if (hybridMode !== 'off' && memoryOwner && !identityIntent.isSelf && !isInterviewTurn(mode)) {
  try {
    const v2 = analyseInformationNeeds({ ownerId, userId, conversationId, question, taskType,
                                        excludeFromIndex, sensitive, budget: workBudget() });
    hybrid = hybridContribution({ v2, aContext: { memoryBlock, knowledgeContext, recallBlock: recall.block },
                                  maxTokens: settings.maxTokens, maxMs: settings.maxMs });
    noteFeature('AQUA_HYBRID_CONTEXT', 'ran');
    log(`[HYBRID] ${hybrid.summaryLine} owner=#${shortHash(memoryOwner)} req=${requestId}`);
  } catch (err) { noteFeature('AQUA_HYBRID_CONTEXT', 'failed', err?.name); hybrid = null; }
}
const hybridBlock = hybridMode === 'on' && hybrid?.block ? scrubSensitiveLines(hybrid.block, sensitive).block : '';

// brain/contextEngine/hybridContext.js
export function hybridContribution({ v2, aContext, maxTokens, maxMs }) {
  if (!v2 || v2.summary.ms > maxMs) return empty('budget');
  if (!v2.applied || v2.understanding.intent === 'general') return empty(v2.reason ?? 'general');
  const present = indexOfContext(aContext);             // normalised sentences + fact keys + figures
  const items = [];
  for (const r of v2.needs) {
    if (r.status === 'contradictory') items.push(conflictNote(r));
    if (r.status === 'ambiguous')     items.push(ambiguityNote(r));
    for (const c of r.evidence ?? []) if (c.outdatedBy) items.push(changeNote(c));
    for (const f of r.ended ?? [])    items.push(endedFactNote(f, present));
    if (r.status === 'missing' && r.need.essential) {
      const v = verifyUnknown(r.need, present, v2);       // §4.3
      if (v === 'declared') items.push(unknownNote(r.need)); else count(v);
    }
    for (const c of [...(r.facts ?? []), ...(r.evidence ?? [])])
      if (strong(c, r.need) && !present.has(c)) items.push(evidenceItem(c));
      else count(present.has(c) ? 'dup' : 'weak');
  }
  const q = clarifyingQuestionFor(items);                 // one, only for verified gaps/conflicts/ambiguity
  return renderWithinBudget(prioritise(items), q, maxTokens);
}
```

## 9. Risks

| Risk | Mitigation |
|---|---|
| **More tokens** than A alone (the hybrid adds, never removes) | Hard budget; measure the token delta in shadow; pruning is a later flag. |
| **The model sees evidence twice**, or conflicting instructions (A's recall says "newer replaces older"; hybrid notes say "conflict") | Dedupe against A; hybrid notes use the same vocabulary as recall notes ("since changed", "uncertain"); answer-level evaluation required before `on`. |
| **False unknowns** from lexical misses | §4.3 verification against A's context; the unknown-suppressed count is logged. |
| **Strength thresholds overfit** | Fit on the development set only; evaluate once on the new frozen set (benchmark plan). |
| **Latency:** a second whole-history read | Work budget, post-hoc discard, `ms` in logs; a later shared unit collection between recall and V2 (one read). |
| **Precision unchanged** in v1 (A's noise stays) | Explicitly out of scope for v1; `AQUA_HYBRID_PRUNE` is a separate decision with its own evaluation. |
| **Complexity:** three flags interacting | Mutual exclusion in the registry; `/health` shows the effective mode. |

## 10. Test cases (to write with the implementation)

**Unit (`hybridContext.test.js`):**
1. Strong V2 evidence not in A → added once. The same sentence already in A's recall → not added (dup counted).
2. Weak match (one generic term) → not added.
3. V2 `missing` essential need where A's context holds a paraphrase-free match → **not** declared unknown; no question.
4. V2 `missing` where A's context has nothing → declared unknown, plus exactly one question.
5. Contradiction → conflict note quoting both statements, plus one question; A's lines intact.
6. Outdated → change note naming A's stale profile line.
7. V2 `general` or `no-evidence` → empty block; prompt equals A's.
8. `ms > maxMs` → empty block.
9. Budget smaller than the items → priority order kept; evidence trimmed first; never over budget.
10. Forgotten topic → note present, no forgotten content.

**Route (`hybridContextRoute.test.js`, real route, fake provider):**
11. `off` → prompt byte-identical to today.
12. `shadow` → byte-identical; one `[HYBRID]` line, content-free.
13. `on` → A's lanes byte-identical to `off` **as a prefix**; the hybrid block appended inside the fence.
14. Engine throws → prompt equals `off`.
15. Failed provider turn → no memory residue.
16. Isolation: two users, no cross-reading.
17. Both `AQUA_INFO_NEEDS=on` and `AQUA_HYBRID_CONTEXT=on` → the registry reports the conflict; the hybrid path is used.
18. A long synthetic history (10k sentences) → the work budget bounds `ms`; the result is discarded or kept correctly.

**Bite checks:** remove the dedupe; remove unknown verification; let hybrid trim A. Each must fail a test.

## 11. Rollout sequence (each step needs approval)

1. Implement behind `AQUA_HYBRID_CONTEXT=off`, with the tests above.
2. Fit thresholds on the **dev** set of the new benchmark ([plan](AQUA_HYBRID_CONTEXT_BENCHMARK_PLAN.md)).
3. Single run on the new frozen **eval** set: A vs hybrid, context level.
4. Answer-level A/B on the same set (approved spend).
5. Render `shadow` (after the `AQUA_INFO_NEEDS` shadow observation, or instead of it).
6. `on` for a cohort (needs a cohort selector, which does not exist today).
