# AQUA Hybrid Context V1 — Implementation

**Sprint 6, 2026-11-11.** Design: [AQUA_HYBRID_CONTEXT_ARCHITECTURE.md](AQUA_HYBRID_CONTEXT_ARCHITECTURE.md) (Sprint 5).

**Gate:** `AQUA_HYBRID_CONTEXT` = `off` (default) / `shadow` / `on`. **The production default is unchanged (off).** Uncommitted; not deployed.

## 1. What it does

The existing pipeline (A) builds its context exactly as before:
- identity, profile and cognitive lanes;
- PIC knowledge;
- episodic recall.

The information-needs engine (V2) runs beside it. The hybrid then **appends** a bounded block **after** A's recall excerpts.

```
--- NEEDS CHECK (added after the context above; it does not replace it) ---
- Conflict (<need>): "<statement A>" (date) vs "<statement B>" (date) — neither is marked as a change; do not pick one silently.
- Since changed: "<old>" (date) → now: "<new>" (date).
- No longer current (the profile line above is outdated): <key>: <value> — they later said: "<…>".
- Not known: which <name> is meant (ambiguous) — the user knows <A> and <B>.
- Not known: <need> — neither the user's history nor the context above states it. Do not guess it.
- Not matched by the needs check: <need> — it may be stated above in other words; check before saying it is unknown.
Also relevant, in the user's own words (not shown above):
[date · they said] <strong evidence A did not show>
If you need to ask, ask only this: "<one question>"
--- END NEEDS CHECK ---
```

## 2. The rules, and where they are enforced

| Requirement | Mechanism (`brain/contextEngine/hybridContext.js`) | Test |
|---|---|---|
| Existing context preserved | The route appends `h.block` to `recall.block`; nothing in A's lanes is read for writing | Route test: **`on` prompt minus the block == `off` prompt**, byte for byte, on `/chat` and `/chat/stream`. Bite 3 (replace instead of append) fails 3 tests. |
| Only strong, relevant evidence not already present | `isStrong` per need. A fact needs ≥1 term (score ≥1.5 with the fact bonus) and not hedged. Entity needs must name the entity. Situation needs need first person, about the user (not a family member or friend), and specific (a figure, a proper name, or a second term). Everything else needs score ≥2. `presence().has` drops anything A's user-content lines already show. | Unit tests: strong added / duplicate skipped / weak dropped / unrelated not added / third-party not added. Bite 1 (no dedupe) fails a test. |
| Conflict, change, ambiguity notes kept | From V2 statuses: `contradictory`, `outdatedBy` (including `followChanges`), `ended` facts, `ambiguous`, `forgotten` | Unit tests for each; a route test for a conflict |
| V2 failure or low coverage never discards A | Engine exception → `infoNeeds = null` → `reason=engine-<Name>`, empty block. `applied:false` (no evidence) → empty block, counted as `not_retrieved`. Over the time budget → discarded. Nothing above ever removes A content. | Route: engine error → prompt == `off`. Unit: no analysis / no evidence / over time → empty. |
| "Not known" only when neither source has it | For each essential `missing` need, `presence().covers(need)` runs V2's own matcher (`needMatchScore`, newly exported) over A's **user-content lines**. Headers and instruction prose are excluded, so boilerplate never counts. Covered → "Not matched by the needs check" (**not retrieved**). Not covered → "Not known" (**unknown**). | Unit: the same unknown is declared without A coverage and becomes "not matched" with it. Bite 2 (no verification) fails a test. |
| Provenance | Evidence lines carry the date and the source: "they said", or `file "<name>"` | — |
| Privacy filters | V2 uses the same `forgetClean`, `withholdClean`, `recallRedaction` and sensitivity policy as recall. The block joins `recall.block` **before** `scrubSensitiveLines`, and lands inside the same untrusted-content fence and the reviewers' evidence view. | Route: the block is inside the fence |
| User isolation | V2 reads only the asking user's units and facts | Route: isolation |
| Token budget | `AQUA_HYBRID_MAX_TOKENS` (default 400, range 50–4000). Items are kept in priority order: conflict, change, ended, forgotten (1); ambiguity, unknown (2); not-matched (3); evidence by score (4+). Trimmed items are counted. | Unit: never over budget, and the conflict survives trimming. Route: a long history stays within a 120-token cap. |
| Time budget | `AQUA_HYBRID_MAX_MS` (default 50). The engine gets `budget.deadlineMs`: checked between stages, it aborts with `BudgetExceeded` (→ empty block). A result whose `ms` exceeds it is discarded (`reason=over-time`). | Unit: deadline throws; over-time discarded |
| Work budget (very long histories) | `AQUA_HYBRID_MAX_SENTENCES` (default 4000): the engine keeps the most recent N user sentences plus all file sentences | Unit: a 400-message history capped at 50 still applies |
| Safe fallback | Every failure path yields A alone; logs carry `reason` | as above |

## 3. Route integration (`routes/chat.js`)

- **Step 5c¹ (unchanged position).**
  - The engine runs when `AQUA_INFO_NEEDS` is not `off` **or** `AQUA_HYBRID_CONTEXT` is not `off`. It runs **once** and is shared by both.
  - With the hybrid on, the engine gets the work and time budget. Without it, the engine is called exactly as before (verified below).
- **Precedence.** `needsOwnsContext` is now `needsMode === 'on' && hybridMode === 'off' && applied`. With both on, the existing context is kept, and one `warnOnce` notice is printed.
- **`[NEEDS]` line and `AQUA_INFO_NEEDS` feature accounting:** only when `AQUA_INFO_NEEDS` is not `off`, so they are unchanged.
- **New step 5d³** (after recall, before its sensitive scrub):
  - compute `hybridContribution`;
  - with `on`, append the block;
  - log `[HYBRID] mode= reason= added= dup= weak= conflicts= changes= ended= ambiguous= unknowns= not_matched= not_retrieved= question= tokens= trimmed= ms= owner=#<hmac> req=` (counts and labels only);
  - `noteFeature('AQUA_HYBRID_CONTEXT', ran | failed)`.

## 4. Engine changes (`informationNeeds.js`), inert unless the hybrid uses them

| Change | Effect when the hybrid is off |
|---|---|
| `budget` parameter (`maxSentences`, `deadlineMs`) | Absent: no cap, no deadline |
| `results[].scores` (need-match score per candidate) | Metadata only; nothing rendered from it |
| `export needMatchScore(need, text)` | New export only |

**Verification:** A and B arms re-run in Sprint 6 are identical to their Sprint 4 records on v1, held-out v1 and v2-dev: **0 metrics differ and all items are identical, in all six comparisons**.

## 5. Flags (`core/flags.js`)

- **Gate:** `AQUA_HYBRID_CONTEXT` (TRI, default off).
- **Settings:** `AQUA_HYBRID_MAX_TOKENS`, `AQUA_HYBRID_MAX_MS`, `AQUA_HYBRID_MAX_SENTENCES`.
- **Registry census updated:**
  - gates 44 → 45;
  - settings 48 → 51;
  - env names read 92 → 96;
  - boot line "45 gates · 51 settings".
- **Read-site probe** added (`flagReadSiteParity.test.js`).

## 6. Tests

| File | Result |
|---|---|
| `aqua/src/brain/tests/hybridContext.test.js` (new) | **19/19** |
| `aqua/src/routes/tests/hybridContextRoute.test.js` (new). Covers: off/shadow byte-identical, on = off + block on both endpoints; the block inside the fence; content-free `[HYBRID]` line and feature `active`; engine error → `off` prompt; failed provider turn → no facts; isolation; precedence over `AQUA_INFO_NEEDS=on`; long history within budget; impersonal → nothing. | **9/9** |
| `aqua/src/core/tests/flagRegistry.test.js`, `flagReadSiteParity.test.js`, `featureStatus.test.js` | **72/72** |

**Bite checks** (each mutation made, the tests run, the file restored byte-identically):
1. no de-duplication → 1 test fails;
2. no unknown verification → 1 test fails;
3. the hybrid replaces A's recall instead of appending → 3 route tests fail.

## 7. Known limits

- **Precision is A's.** Hybrid v1 never removes anything, so A's irrelevant items and its personal items on impersonal questions remain. Pruning is a separate, later flag (`AQUA_HYBRID_PRUNE`, not built).
- **Stale profile lines remain in A.** The hybrid adds "No longer current … (the profile line above is outdated)" but does not edit A's line. The frozen ACIB scorer still counts A's line as stale, because the annotation is in a different line.
- **V2's own limits are inherited:**
  - lexical matching;
  - conflicts between sentences that share too few words ("is about 17,500" vs "the dealer said the price is 19,000" is not seen);
  - stem collisions ("training" → transport `train`). The hybrid's third-party rule removes the case that surfaced.
- **Prompt tokens rise** by the block (mean +45 to +94 tokens on the development sets; max 223).
- **The `[RECALL]` log line** (pre-existing, outside this work) still prints `owner=<account id>`. This is flagged for the release review.
