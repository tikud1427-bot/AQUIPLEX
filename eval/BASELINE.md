# Extraction baseline — the current engine

**Blueprint:** E2/PR-3 · measured on `extraction-core.v1` (200 cases, 167 claims)
**Configuration:** all understanding flags **ON** — a baseline measures what the
code can do, not what a `.env` currently permits

---

## The number

```
                          before    after
overall_strict_accuracy    15.0%    18.0%     all four levels must hold

detection_recall           61.3%    71.9%
subject_recall             41.3%    55.7%
predicate_accuracy          0.0%     0.0%     ← still structural, deliberately
fidelity_accuracy           0.0%    64.7%     ← polarity · modality · time

silence_on_negatives       75.0%    90.0%     false positives 10 → 4
```

Recall rose and false positives FELL over the same change. That pairing is the
claim worth making: recall bought by admitting more junk is not an improvement,
and the two are reported side by side so the trade cannot hide.

## Detection by category

| category | before | after | reading |
|---|--:|--:|---|
| people | 55.0% | **95.0%** | the copula rule hid every third party who DOES something |
| identity | 85.0% | 90.0% | first-person disclosure was always the lane's strength |
| modality | 68.0% | 72.0% | the mood is stored now, not just the sentence |
| temporal | 44.0% | 64.0% | |
| task | 53.3% | 66.7% | |
| negation | 45.0% | 50.0% | **and it is no longer stored positively** |
| decision | 53.3% | 53.3% | unchanged — the remaining weak spot |

## One zero closed, one left standing on purpose

`predicate_accuracy` and `fidelity_accuracy` were both 0.0%, and both were
described as structural. They were not the same kind of structural.

**Fidelity was reachable and is now read.** Polarity, modality and time are
GRAMMATICAL properties of the sentence — `"I don't"`, `"I want to"`, `"if we"`,
`"she said"`, `"last month"` are marked in the surface form. Reading them is
parsing, not inference, and it needed no schema. The lane writes them onto the
claim (`brain/knowledgeExtraction/claimFidelity.js`).

**Predicate is not, and no attempt was made.** A predicate is a relation drawn
from a controlled vocabulary, and choosing `works_at` over `role_is` is a
semantic judgement belonging to E5's schema and E6's model-backed pipeline.
Surface rules guessing predicate names would score against *this* dataset and
transfer nowhere. A test pins it at zero with the note that if it moves, the
question is not "did it improve" but "did someone fit a vocabulary to the
labels".

## Why the negation line was the serious one

The old baseline recorded `negation detection 45.0%` — **and every one captured
was stored positively.** Not a scoring artefact:

```
user said:   "I don't use Kubernetes."
store held:  "I don't use Kubernetes."   ← as an ASSERTED fact
```

The text kept the `"don't"`, so a careful reader might survive it. But nothing
in the DATA said the claim was negative, so every consumer had to re-derive
polarity from prose — the retrieval gate did exactly that on every read — and
two derivations of the same thing can disagree. The one that disagrees silently
is the one that reaches the model.

Polarity is stored now, and `statementPolarity` reads the stored field first,
falling back to prose only for facts written before this landed and for the
document lane, which does not run through it. Same tier ordering as
`offeredKinds`: what the world model knows beats what a regex can guess.

## Third-person subjects: 18.1% against 58.9%

Splitting `subject_recall` by subject kind showed the lane was not uniformly
weak — it was blind in one direction:

```
SELF  subjects   58.9%
NAMED subjects   18.1%     ← colleagues, reports, counterparties
```

Tier 2 of the solo-proper-noun pass admitted a sentence-initial capitalised word
only when a copula followed it. Sound for *"Razorpay is our competitor"*, and it
rejected every person who DOES something:

```
"Dev reports to me."                  → `reports`    rejected
"Rahul joined the billing team."      → `joined`     rejected
"Maya introduced me to an investor."  → `introduced` rejected
```

Other people are most of a person's world, and the lane could not see them
unless the sentence happened to be copular. A subject is followed by a FINITE
VERB, not specifically by a copula, and that is now tested morphologically
(3rd-person `-s`, regular `-ed`, or the closed irregular class) rather than by
keyword — so it generalises to verbs nobody thought to list.

The false-positive risk this creates is real and is now held entirely by
`COMMON_SUBJECT`, which makes that list load-bearing rather than a second
opinion. Broadening the test began minting `What`, `Why` and SQL keywords as
entity names; both are closed function-word classes and are blocked directly.

## Polar and wh questions are not the same kind of thing

The first version of the question gate dropped every question, reasoning that
"a question asserts nothing". True of the assertion, false of the content:

```
"Do I still report to Priya?"    polar — puts a specific proposition up for
                                 confirmation. The proposition is right there,
                                 and the user's uncertainty about it is itself
                                 worth knowing.
"Why did the deploy fail?"       wh — the thing being asked for is exactly the
                                 part that is missing. Only a presupposition is
                                 left, and storing one as a fact is how a guess
                                 becomes knowledge the user never gave.
```

A polar question keeps its claim under `modality: 'question'` — captured,
explicitly NOT asserted. Gating both cost 3.7 points of detection recall and
bought no honesty, because every negative it caught was wh-shaped anyway.

## The request gate, and the asymmetry behind it

`"Explain how OAuth works to me."` produced a stored fact, because OAuth reads
as an entity and the lane had no notion of a request. The gate is narrow on
purpose — a LEADING imperative, or an explicit please/can-you frame — because
the costs are not symmetric. A missed claim is recoverable: the user says it
again, or it arrives from another turn. An imperative stored as a fact is not.
It sits in the world model and is retrieved later as though the user had told us
something about themselves, which is how a system ends up describing a person
back to themselves using their own to-do list.

## The gate was pointed backwards on three metrics

Found while running the full battery, not by looking for it. `eval:gate`
BLOCKED on `n_false_admits 17 → 16` — it treated **admitting less junk as a
regression**.

The direction table was fine; the test guarding its completeness was not. It
scanned a hand-listed *two* baselines, so metrics living in `gate-core` and
`capture-core` were never checked. A completeness test with a hand-maintained
list of what to be complete over is not a completeness test. Widening it to
every baseline on disk immediately turned up `n_false_positives` in
`forensic-edited`, undeclared — the gate would have waved through a DOUBLING of
false positives on that suite as an improvement.

A third category was missing too. Route counts (`n_via_*`) record which lane
admitted a segment, and they move whenever an upstream lane gets better at its
job: improving the entity extractor pushed `n_via_cue_proper_noun` 45 → 29
while `gate_recall` did not move at all. Gating that blocks the build for
getting better; calling it STRUCTURAL would claim the dataset had changed, which
is worse — a true statement about the wrong thing. They are now DIAGNOSTIC:
reported, compared, never gated.

## The adapter, and the trap it avoids

The baseline is only as honest as the adapter. This one replicates
`conversationIngest.js` step for step — extract → lift the self mention →
resolve → build facts — rather than calling the pieces in a plausible order.

**Three probes written against this lane returned zero facts for every
sentence** before the adapter was right: a wrong argument shape, then a wrong
field name, then a missing resolver step. Any of them would have published a
0% baseline and made every future replacement look miraculous. The extractor
was working each time.

A test now asserts the adapter extracts something real, so that cannot recur
silently.

## The scorer is tested for fairness, not just correctness

A scorer that is accidentally harsh publishes a baseline that is too low, and
then E6 looks like a triumph for reasons that have nothing to do with E6.

So the suite feeds the scorer **synthetic perfect output** and asserts it
scores 100% at every level. The zeros in the published baseline therefore come
from the extractor, not the grader.

**Bite, measured:** loosen `correct` to ignore predicate+fidelity → 1 fail ·
fake precision as perfect → 2 · drive the engine in its dark config → 2 ·
break the adapter (the 0%-baseline trap) → 3.

## What E6 has to beat

**The bar moved, and that is the point of writing it down.** E6 was going to be
compared against a lane that scored 0.0% on fidelity and 61.3% on detection.
Three of those numbers are no longer zero or low, so E6 no longer gets credit
for emitting fidelity *at all* — it has to be BETTER at it than a regex.

| metric | old bar | today | E6 target (Blueprint Part 11) |
|---|--:|--:|--:|
| detection_recall | 61.3% | **71.9%** | ≥ 70% — already cleared by the regex |
| subject_recall | 41.3% | **55.7%** | must beat 55.7% |
| fidelity_accuracy | 0.0% | **64.7%** | ≥ 95% on negation |
| predicate_accuracy | 0.0% | 0.0% | ≥ 85% — **the one E6 gets for free** |
| silence_on_negatives | 75.0% | **90.0%** | must not regress |

A model-backed pipeline that cannot outperform surface rules on negation and
modality has not earned the request path. Predicate is the honest exception: it
needs the schema, no surface rule can reach it, and it stays at zero precisely
so that E6's gain there is real rather than inherited.

`silence_on_negatives` is still the one to watch. An LLM extractor that fires on
requests would trade a real gain in recall for a worse false-positive rate, and
a single averaged accuracy figure would hide it. It is now at 90.0%, so there is
more to lose than there was.

## Regenerating

```bash
npm run eval -- extraction-core
npm run eval -- extraction-core --json eval/baselines/extraction-core.v1.json
```

The committed baseline is asserted to reproduce. If it drifts, extraction
behaviour changed — that is either a regression or an improvement, and either
way it gets named in the PR that moves it.

---

# Retrieval baseline — the current engine

**Blueprint:** E2/PR-5 · measured on `retrieval-core.v1` (60 facts, 200 queries)
**Path:** `pic/core.js retrieveKnowledge()` — the exact facade the chat spine calls
**Configuration:** all understanding flags **ON**

---

## The numbers

Two columns. The left is the engine as first measured; the right is after the
relevance gate landed. Both were produced by `npm run eval -- retrieval-core`
on the same dataset, same adapter, same seed — nothing about the measurement
changed between them.

```
                  before    after
recall@8           63.7%    72.6%
MRR                56.7%    66.4%
nDCG@8             55.5%    64.8%
top1_correct       53.0%    62.5%
top1_kind          42.9%    54.8%    the top hit is the KIND of thing asked for

unknown_honesty    34.4%    71.9%    ← unanswerable queries that get silence
noise_lines          131       16    ← across 9 of 32 silence-expecting queries
```

## Recall by category

| category | before | after | reading |
|---|--:|--:|---|
| direct | 96.4% | **100%** | verbatim retrieval does exactly what it was built for |
| multi | 67.9% | 71.4% | |
| temporal | 56.0% | 68.0% | |
| selfword | 50.0% | 75.0% | |
| category | 40.6% | 46.9% | bridged by the kind signal; the remainder is vocabulary distance |
| superseded | 20.0% | **60.0%** | currency is now conditional on the question's tense |
| negation | 20.0% | 30.0% | **reach-limited — see finding 4** |

## What was wrong, and what closed it

All three original findings had **one cause**. Lane 2b anchored on the owner
for any first-person question, and lane 3 hopped every `about` edge from that
anchor scoring each `confidence * 0.5 + 0.05` — an expression in which the
**query does not appear**. Four different questions returned byte-identical
output:

```
"What is my job?"        ─┐
"Which city am I in?"     ├─►  f004, f015, f042, f017, f033, f047, f052, f060
"Where am I employed?"    │
"What is my blood type?" ─┘    ← nothing in the store answers this one
```

That is not retrieval. It is a dossier dump triggered by the word *"my"*, and
it explains all of it: the noise, the honesty gap, the flat `top1_kind` (the
top hit was literally the same fact every time), and both recall gaps — the
real answer was crowded out of the eight-item budget by the same eight facts.

**1. The superseded fact wins → CLOSED (20% → 60%).** Supersession is now
conditional on the question's tense. A superseded fact is withheld from a
present-tense question and **admitted** to a question about the past, because
L5 says nothing is deleted, and a reader that can never see a superseded claim
has deleted it at read time. *"Where do I not work anymore?"* is answered by
*"I used to work at Intercom"* — the exact fact a blanket filter buries.

**2. Every noisy query is first-person → CLOSED (34.4% → 71.9% honesty,
131 → 16 noise lines).** The self-anchor has a relevance gate, and behind it a
sufficiency check: a *typed* question may be answered on the kind signal alone
(*"where do I work"* → *"I run product at Nummo"*, zero shared vocabulary), but
a question whose **topic noun is unknown** may not. So *"Who is my dentist?"*
returns silence while *"Who is my co-founder?"* answers — same interrogative,
and the difference falls out of one rule rather than a list of things to
suppress. Unknown stays unknown.

**3. The top hit is the right kind less than half the time → IMPROVED
(42.9% → 54.8%).** Kind is now a graded signal that reads the **world model
first** (a graph-typed entity scores 1.0) and its own surface patterns second.
The ordering matters more than the number: the signal improves as extraction
improves, so E6's typed claims raise this without touching the ranker.

**4. NEW FINDING — negation recall is limited by REACH, not ranking
(20% → 30%).** Polarity is now read on both sides, which fixed the *precision*
half: an affirmative fact no longer answers a negated question. Recall stays
low for a different reason entirely — *"What did we turn down?"* and *"We
rejected the Bangalore relocation"* share no vocabulary, as do
*"paused"*/*"on hold"* and *"database"*/*"Postgres"*. No surface rule reaches
those. The dense lane does. **A synonym table tuned to this corpus would score
well here and teach the engine nothing**, so none was written.

## The Context Engine sat above this floor and undid part of it

The gate above is the PIC floor. In production `chat.js` calls it through the
Context Engine, which under `AQUA_CONTEXT_V2=on` adds a second lane: hop every
`about` edge from every focus entity and admit whatever comes back. That is the
same defect the floor gate closes, reimplemented one layer up — and because it
runs ABOVE the floor, it silently reversed it.

Measured on the same 200 queries:

```
                              floor    after CE
32 silence-expecting queries     16          23     +7 noise, 6 queries
168 answerable queries          122         119     -3 answers
answers CE contributed            —           0
```

Not merely noisier — **net harmful**. The flood of hopped facts crowded real
answers out of the eight-item budget, and the lane contributed nothing of its
own to offset it.

**The sharpest part was a self-knowledge failure.** The user's self entity is
labelled `You` — AQUA's name for the user, written from AQUA's point of view.
Matching that label against query tokens got the reference backwards in both
directions at once:

```
"Can you fix your own bug?"  → MATCHED   → hopped the user's whole dossier
                                            ...but "you" means AQUA
"Where do I work?"           → NO MATCH  → "I" shares no letters with "You"
                                            ...and first person IS the user
```

The self entity is now anchored on first-person scope — the signal the floor
already computes — and never on the word "you". The reach lane is gated with
the **same scorer** the floor uses, imported from `questionShape.js` rather
than copied, because two gates that can disagree about the same fact will.
Floor items are never re-judged: the assembler selects from the pool, it does
not re-litigate the floor.

After: silence-query noise back to 16 with zero re-added, answerable recall
back to 122, and `reachGated` reports what the lane withheld.

## Running one suite is not running the gate

The relevance gate was built against `retrieval-core` and reported clean
against `retrieval-core`. The full gate then showed it had cost **capture-core**
`retrievability_rate 89.5% → 78.9%`, four facts written and unreachable instead
of two.

Two real gaps, both in general English rather than anything corpus-specific:

- **Copular role statements.** The role patterns were verb-only, so *"I'm the
  CTO at Halcyon Labs"* offered no role and *"What is my role?"* could not
  reach a statement that answers it in five words.
- **Goal statements.** *"What is my target?"* against *"I want to hit 10,000
  active merchants by December"* shares no vocabulary at all. `goal` is now a
  kind of its own — it is named in the canonical world model beside facts and
  preferences, and without a kind it was reachable only by luck.

Both fixed; capture-core is back to 89.5%. The lesson is in the process, not
the patch: **a metric tuned against one suite will be paid for out of another,
and only the full gate shows the invoice.**

## Two things this number is not

**The corpus is 60 facts.** Lexical precision degrades with scale and these are
an upper bound. RETRIEVE-SCALE is unbuilt.

**The adapter still understates the engine in two places.** It seeds evidence
without a `confidence` and drops `supersededBy` from the dataset, so the
engine's currency filter is never exercised by the harness — the 60% above is
earned by tense-conditional ranking alone. Both are adapter-fidelity bugs, both
predate this work, and both were left alone deliberately: fixing them moves the
baseline, and adapter gains must not be reported inside a number claiming
engine gains.

## The adapter can lie in two places, not one

A retrieval benchmark has a **world** and a **query path**, and a badly built
world scores the seeder rather than the engine.

The world is seeded with the same node and edge shapes `conversationIngest`
writes — fact node, `asserts` edge, and an **`about` edge per entity**. Those
edges are what Lane 3 hops across; without them the facts sit in the store off
every graph path that reaches them.

**One real miss, caught by reading the code rather than assuming it:** the self
node was first seeded as `data.isSelf`, but the engine looks for
`data.entityType === 'self'`. Lane 2b stayed dark and the whole baseline was
understated until the predicate was read. A test now asserts a first-person
query returns something.

**Bite:** unmark the self node → 1 fail · stop seeding `about` edges → 1 ·
fake unknown-honesty as perfect → 1 · flatten the nDCG grades → 1.

## Caveat that travels with every number here

**60 facts is a small corpus.** Lexical precision degrades as a corpus grows,
so these are an **upper bound** on the same engine at 5,000 facts.
RETRIEVE-SCALE (Blueprint Part 11) remains unbuilt, and every retrieval figure
this project has ever quoted carries this caveat.

## What E7 has to beat

| metric | today | E7 target |
|---|--:|--:|
| recall@10 | 63.7% | ≥ 85% |
| nDCG@10 | 55.5% | ≥ 75% |
| top1_kind | 42.9% | ≥ 90% |
| unknown_honesty | 34.4% | ≥ 90% |
| noise_lines | 131 | ≤ current |
