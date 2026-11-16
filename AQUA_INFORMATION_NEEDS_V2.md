# AQUA Information Needs Engine V2

**Sprint 4, 2026-11-11** · `aqua/src/brain/contextEngine/informationNeeds.js` · gate `AQUA_INFO_NEEDS`, **off by default** (unchanged) · uncommitted · not deployed

## 1. Why V2: the Sprint 3 engine did not generalise

Before any Sprint 4 code was written, ACIB v2's 100-scenario evaluation set was frozen. Both arms were then run on it.

| ACIB v2 eval (frozen `002208e4…`), Sprint 3 engine | Short | Long |
|---|---|---|
| Recall | **0.63** (arm A: 0.98) | **0.63** (arm A: 0.79) |
| Correct cases | **58/100** (arm A: 95) | **58/100** (arm A: 74) |
| Unknown handling | 0.23 | 0.23 |
| Contradiction handling | 0.44 | 0.44 |

The Sprint 3 numbers (dev 17/17, held-out 10/10) came from two small sets written by the same engineer. On an independent set, **the engine was worse than the existing pipeline**. On short histories it lost 37 cases that arm A got right.

## 2. Root causes

These were diagnosed on a **new development set** (`acib.v2.dev`, 40 scenarios, written after the eval freeze) and on the two Sprint 3 sets. The eval set's items were not read before its single run.

1. **"Impersonal" by surface form.**
   - A question with no "I/my" was treated as general, and the engine sent nothing *while still owning the context*, so arm A's context was dropped too. Examples: "When is the school play?", "Who runs the data pipeline?", "What's the building door code?".
   - This was the largest single cause.
   - The reverse error also existed: any capitalised word made a question personal ("How far is **the Moon** from **Earth**?").
2. **Decision forms without a pronoun** ("Is a new kitchen worth it?", "Is now a good time to ask for a raise?") were read as general.
3. **Decisions saw only the option.** The user's situation in the same domain shares no word with the question. "Should I take the Marlow & Pike job?" missed "I make 45k at Hollin Studio" and "I'm learning a lot from my boss".
4. **A figure was not cost evidence.** "A newer used van is around 12,000" has no cost word.
5. **Changes that do not repeat the question's words were missed.** "What car do I drive?" against "Sold the Focus, I have a Kia Niro now". Also, "left" meaning *remaining* ("9 days of leave left") was read as an ending, so a contradiction became a false supersession.
6. **Contradictions in dates, days and ordinals were invisible.** Only amounts with units were compared.
7. **Unknowns existed only where a template existed.** This is the held-out 0.50 question, covered in §4.

## 3. What V2 adds: general mechanisms, no per-scenario templates

| Mechanism | What it does |
|---|---|
| **Anchoring** (`anchorTerms`) | A question is personal when its words (excluding common words) occur in something the user said or uploaded. A definitional question ("What is a credit score?") needs a proper-noun tie. A capitalised word alone no longer makes a question personal. |
| **Advice forms** (`ADVICE_FORM`) | "should I/we", "can we afford", "is it a good time/idea", "worth it", "does it make sense" are treated as decisions. |
| **The decision model** | Any decision without a specific template is read as five things. **Option:** essential only when the question points at a specific one ("the offer", "the cottage"). **Situation:** the user's statements in the decision's life domain(s), taken from the question *and* from what they said about the option. **Resources:** money is essential when it costs something; time when it needs care or study; ties when it means moving. **Effects:** how customers respond, for price changes. **Criteria:** essential only when nothing but the option is known. |
| **Life domains** (`DOMAINS`) | Broad vocabularies for work, money, home, family, health, learning, business, pets and transport, plus phrase cues for tenure and new competition. |
| **Figures as evidence** | A sentence with a money figure counts for money and cost needs. Resource needs never reuse the option's own sentence: the MBA's price is not the user's savings. |
| **Change following** (`followChanges`) | A later change or correction that names the same thing (shared capitalised words) is pulled in, and marks the earlier statement "since changed". |
| **Remaining "left"** (`changeOf`) | "N days left", "5,000 left in the budget" are not endings. |
| **Value comparison** (`amounts`) | Compares amounts, ordinal days ("the 9th"), dates ("3 March") and weekdays. Single-value questions ("how much / when / which") and comparisons conflict on any shared subject. |
| **Fact staleness by label** | A later change naming the fact's label with another value ends it. Example: "the gym raised the membership fee to 38" ends `membership fee: 30`. |
| **Standing constraints** | A food suggestion needs the user's diet; a gift needs what the person enjoys. |
| **Third-party facts as quotes** | Facts about other people (siblings, partner, friends…) travel as the user's own sentence, which keeps who-is-who. |
| **One clarifying question** (`clarifyingQuestion`) | When information is **insufficient**: exactly one question, about the most important gap. Order: ambiguity first ("Which Sam…?"), then conflict ("Which is right: … or …?"), then the first missing essential need. **No question** when information is sufficient or only partially missing. |
| **Safe fallback** | A factual question for which *nothing* was found returns `applied:false (no-evidence)`, and the existing pipeline serves the turn. The engine never sends an empty context for a lookup it could not read. |

Unchanged:
- deterministic, with no model, embeddings or database;
- read-only (proved by a test);
- the same privacy path (forget list, sensitivity policy, withheld sentences);
- the gate semantics;
- the route integration.

## 4. Held-out unknown handling stuck at 0.50: investigation

`ho-pricing` ("Is it a good time to raise our price?") needs the unknown "how customers would respond". The Sprint 3 engine had no concept of a decision that affects other people, so no need could be *missing*.

The general fix is part of the decision model: a decision that changes what others pay has an **effects** need. Its vocabulary is about *response* (churn, cancellations, complaints, demand, competitors), not about *size*. A first version also matched "we have 1,200 subscribers", which is the customer base, not a response; that was corrected.

Held-out unknown handling is now 1.00. **This is post-hoc:** the held-out v1 set was already contaminated by Sprint 3's fixes, and this case was known. The honest measure of unknown handling is the v2 eval set (§5): 0.85 short, 0.69 long.

## 5. Results

The full tables are in [AQUA_ACIB_V2_BENCHMARK.md](AQUA_ACIB_V2_BENCHMARK.md).

**Development sets** (used to build V2):

| Set (scenarios) | V2 recall / precision | Correct | T / C / U / X |
|---|---|---|---|
| v2-dev (40), short and long | 1.00 / 0.84 | 40/40, 40/40 | 1.00 everywhere |
| v1 dev (17) | 1.00 / 0.84 | 17/17 | 1.00 everywhere |
| held-out v1 (10), post-hoc | 1.00 / 0.81 | 10/10 | 1.00 everywhere |

**Evaluation set, single untouched run** (`acib.v2.eval`, 100 scenarios):

| Metric | A short | Sprint 3 B short | **V2 B short** | A long | Sprint 3 B long | **V2 B long** |
|---|---|---|---|---|---|---|
| Recall | 0.98 | 0.63 | **0.94** | 0.79 | 0.63 | **0.86** |
| Precision | 0.55 | 0.60 | **0.80** | 0.16 | 0.60 | **0.68** |
| Temporal | 0.73 | 0.55 | **0.82** | 0.55 | 0.55 | **0.64** |
| Contradiction | 0.50 | 0.44 | **0.94** | 0.50 | 0.44 | **0.94** |
| Unknown handling | 0.00 | 0.23 | **0.85** | 0.00 | 0.23 | **0.69** |
| Personal items on impersonal | 15 | 4 | **0** | 77 | 4 | **13** |
| Correct cases | **95** | 58 | 88 | 74 | 58 | **82** |
| Mean prompt tokens | 1,392 | 1,211 | 1,307 | 1,417 | 1,214 | 1,321 |

Engine time on the eval set: mean **3.4 ms**, p95 **6.8 ms**. There are no extra model calls.

**How to read it:**
- V2 fixes most of the generalisation failure: +30 correct short, +24 long, versus Sprint 3.
- It beats the existing pipeline on long histories (82 vs 74 correct), on precision, contradictions and unknowns.
- **It is still worse than the existing pipeline on short histories: 88 vs 95 correct.**
- Long-history recall (0.86) is below the 0.95 target.
- In the long regime, the fallback hands 22 turns to arm A's broad context. That is where the 13 personal items on impersonal questions come from (`ng-translate@long` fell back).

**Remaining failure classes,** diagnosed after the single run and **not** fixed against the eval set:
- **Lexical misses that trigger the fallback (22 of 200 cases).** The question's word and the user's word differ: "car" / "I drive a Skoda", "salary" / "I make 42k", "working hours" / "night shifts", "phone" / "iPhone". In the short regime the fallback rescues them; in the long regime arm A's own recall often misses them too.
- **Situation outside the domain vocabularies:**
  - a boiler, for a bonus decision;
  - the laptop's age, for an equipment decision;
  - "drowning in admin", for hiring an assistant;
  - an employment-contract clause;
  - parental leave, for team risk;
  - a paid study day.
- **Change verbs the change detector does not know:** "put the rent up to 1,050" left `rent: 950` current (stale 3 short / 2 long).

## 6. What this means for rollout

- **`on` for all users is not justified** by this evidence. It would lose short-history cases that the existing pipeline answers.
- **`shadow` is safe** (see [AQUA_RENDER_SHADOW_READINESS.md](AQUA_RENDER_SHADOW_READINESS.md)). It measures exactly these gaps on real traffic: the rates of `applied`, `no-evidence` fallback, intents and sufficiency.

**Next engineering step,** to be evaluated on a *new* frozen set:
- a meaning-level match for question ↔ statement (the lexical-miss class). The C9 embedding work is the candidate, and it needs approval for live embedding calls.
- a **hybrid** that keeps arm A's lanes when the engine's recall is thin, instead of all-or-nothing ownership.

## 7. Tests

| Test file | Result |
|---|---|
| `brain/tests/informationNeedsV2.test.js` (new). Covers anchoring, impersonal questions with capitalised words, the decision model's conditional essentials, figures as cost, savings not taken from the price, change following with the "since changed" mark, remaining-left conflicts, ordinal and weekday conflicts, exactly one clarifying question or none, the no-evidence fallback, and third-party quoting. Histories are written for the tests, not taken from the eval set. | 17/17 |
| `brain/tests/informationNeeds.test.js` (Sprint 3) | 24/24 |
| `routes/tests/informationNeedsRoute.test.js` | 7/7 |

**Updated Sprint 3 unit tests.** Five assertions pinned V1 behaviour that V2 changes on purpose. Each was updated with the V1 expectation kept in a comment:
- a name alone is no longer personal (the anchored form is tested);
- affordability gains a non-essential `situation` need;
- a trip gains `dates*`.

Two new tests found real defects before the freeze:
- a change at the same timestamp was not followed;
- "sign up" was not an acquisition verb.

**Post-eval change.** One behaviour-neutral change was made after the evaluation run: a test seam, `__failNextForTests`. The eval B arm was re-run afterwards and is byte-identical: 0 of 133 metrics differ, and every scenario's items are identical (`eval/acib/results/sprint4-implementation.hashes.txt`).
