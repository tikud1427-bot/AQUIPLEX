# Aqua Information Needs Engine — Design

**Date:** 2026-11-10 (Sprint 3) · **Module:** `aqua/src/brain/contextEngine/informationNeeds.js` · **Gate:** `AQUA_INFO_NEEDS` (off by default) · Implementation: [AQUA_INFORMATION_NEEDS_ENGINE_IMPLEMENTATION.md](AQUA_INFORMATION_NEEDS_ENGINE_IMPLEMENTATION.md) · Results: [AQUA_ACIB_V1_COMPARISON_RESULTS.md](AQUA_ACIB_V1_COMPARISON_RESULTS.md)

## 1. Problem

ACIB v1 showed that production context is chosen by **resemblance, not need**:
- Below 8,000 characters of history, episodic recall quotes everything the user ever said.
- Above it, recall ranks by keyword overlap with the question.
- Alongside both, the profile, the cognitive model and the PIC lane run on every turn, mostly unconditioned on the question.

For "Should I hire another developer?" on a long history, the model received **1 of 6** decision-critical facts beside 14 irrelevant items. Nothing ever said what was *not* known.

The repository already contained the right idea in `brain/contextEngine/queryPlan.js`: decision questions have a goal / deadline / blockers / constraints / prior-plans template and a sufficiency contract. But it was reachable only inside Context Engine V2, over Postgres predicates, and that path is off in production.

## 2. Principle

> Understand what the question requires, find evidence for each requirement, say what is missing, and send the **smallest sufficient** context.

The goal is not more context. In the benchmark, the engine sends 20% fewer prompt tokens (long history) while recall rises from 0.83 to 1.00.

## 3. Pipeline (one call per turn, deterministic, no model, no DB)

```
question ──A──▶ understanding ──B──▶ requirements ──C──▶ evidence per requirement
                                                             │
                                  context ◀── render ◀──E── sufficiency ◀──D── status per requirement
```

**A — Understand.** Built from `queryPlan.isDecisionForm`, `pic/questionShape.analyseQuestion` and the classifier label. It determines:
- **intent:** `decision | planning | comparison | recall | status | lookup | personal-other | general`;
- **personal vs impersonal:** first-person reference or a named person;
- **entities:** capitalised names and relation nouns (sister, landlord, co-founder…);
- **time sensitivity:** `currency`;
- **advice vs factual**, and **multi-fact**.

An impersonal question (`general`) needs no personal context at all.

**B — Requirements.** These are conditional on the question, not a universal checklist. Each requirement has an id, a label, *essential* or *helpful*, a vocabulary, and optional entity or co-requirement terms.

| Question kind | Requirements (essential*) |
|---|---|
| hiring decision | team composition*, departures, money available*, burn/runway*, revenue, workload & roadmap*, previous hiring decisions, cost of the hire* |
| affordability ("can I/we afford X") | cost of X*, money available*, income / monthly saving*, spending & runway |
| any other decision | facts about the option*, money involved, commitments & constraints, timing |
| planning | the people mentioned*, the trip* (if mentioned), that day's fixed commitments* (if a day is mentioned), food & dietary needs* (if a meal is mentioned), preferences about it; training plans → current goals*, constraints |
| comparison | what each source says* |
| recall / status | what the named entity said or its status*, who the entity is |
| lookup | the one thing asked about* (relation and attribute terms; single-valued when asked about the present) |

The decision family follows the planner's structure: essential slots, a sufficiency contract, and `isDecisionForm`. It is expressed over the stores production has, rather than canonical predicates.

**C — Evidence.** Retrieved per requirement from the stores production has:
- **Structured facts** (`longTermMemory.getFacts`).
- **The user's own sentences** across conversations, and **lines of files** they uploaded. These come from `episodicRecall.collectUnits`, which is user-scoped, with the recall privacy pipeline applied:
  - the forget list (`forgetClean`, `redactionsFor`);
  - the sensitivity policy (`withholdClean`, `recallRedaction`).
- **Scoring:** vocabulary hits using the recall tokenizer, gated by co-requirement and entity terms. At most 3 candidates are kept per requirement, preferring structured facts.
- **Bounds:** at most 12 quotes and 3,600 characters for the turn.
- **Never evidence:**
  - questions, and requests to the assistant;
  - a stored fact whose source is a question or request (the observer currently stores facts *from questions*);
  - collection items that only appear inside requests;
  - a stored value that is a cut-off piece of a longer number in its own source sentence.

**D — Evaluate.** Every requirement gets a status:

| Status | Rule |
|---|---|
| found | current, unqualified evidence (fact or sentence) |
| missing | nothing found |
| uncertain | only hedged statements ("might", "not sure", "thinking about") — a stated desire or agreement is *not* a hedge |
| contradictory | two current, unqualified statements about the same requirement with different amounts of the same unit, neither marked as a change |
| outdated | only superseded evidence: a later statement that changes or corrects it (`stateTransition.changeKind`/`corrects`) on the same subject; also a stored fact the user's later words change, even when the profile was never updated |
| forgotten | the user later said "forget my X" — earlier statements about X are dropped, even if no fact held X |
| ambiguous | one name in the question, several full names in the user's world ("Alex" → Alex Chen, Alex Rivera) |

Every item carries **provenance**: its source (fact / said / file), date, and — for facts — the user's own sentence. Inference is never presented as fact: the engine does not read Mind beliefs, predictions or goals, which are inferred or question-polluted.

**E — Sufficiency.**
- **insufficient** — an essential requirement is missing, forgotten, contradictory or ambiguous. Directive: do not invent; ask **one** targeted question if it changes the answer, otherwise answer conditionally.
- **partial** — something is uncertain, outdated or optional-and-missing. Directive: answer and state the uncertainty.
- **sufficient** — answer directly.

## 4. Rendering — the smallest sufficient context

Two blocks, in the formats the prompt already uses:
1. **`--- INFORMATION NEEDS ---`** (in the memory slot): one line per known structured fact (value + date + the user's sentence), and per *No longer current*, *Not known*, *Uncertain*, *Conflicting* and *ambiguous* finding, then the sufficiency directive.
2. **The user's words** for each requirement. These use the existing recall renderer, inside the existing UNTRUSTED fence, chronological, with `↳ since changed — now: "…"` on outdated quotes.

## 5. Production integration and safety

- **Where:** `routes/chat.js prepareTurn`, step 5c¹ — after memory retrieval, before the knowledge lane, recall and prompt construction. Both `/chat` and `/chat/stream` use it.
- **Gate `AQUA_INFO_NEEDS`:**
  - `off` (default) — not run; the prompt is byte-identical to before. Verified: arm A re-run = frozen baseline, 0 of 213 metrics differ.
  - `shadow` — run, log counts only (`[NEEDS] …`), prompt unchanged.
  - `on` — when the engine understood the question (`applied`), its blocks **replace** the identity/profile/cognitive block, the PIC lane and whole-history recall. Otherwise the existing pipeline serves the turn.
- **Fail-open:** any engine error means the existing pipeline serves the turn, recorded as `failing` in `/provider-health` `features`.
- **Unchanged:**
  - memory writes (`memoryObserve`, turn commit / rollback);
  - user isolation (stores are read by owner and by `meta.userId`);
  - the sensitivity scrub (applied again to the engine's blocks);
  - semantic recall stays off, there is no Postgres, and there is no model call.

## 6. Non-goals and known limits

- **Hand-built lexical vocabularies and templates.** Decision kinds without a template get generic needs only. The held-out "raise our price" case found no "churn" unknown, and was deliberately not patched.
- **No new store and no new memory semantics.** The engine reads what exists. It works around three capture defects (question-derived facts, truncated numbers, question-as-goal) rather than fixing them at the source.
- **No paraphrase understanding beyond stems and a small hyponym map** (dog → greyhound…). Semantic recall stays disabled (D-4).
