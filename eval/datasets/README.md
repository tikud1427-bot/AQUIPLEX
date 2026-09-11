# Extraction dataset — `extraction-core.v1`

**Blueprint:** E2/PR-2 · 200 labelled sentences

## What a label is

Cases are labelled against the **claim** the blueprint targets — subject,
predicate, object, polarity, modality, time — **not** against what
`files/extractors.js` can currently produce.

```json
{
  "id": "negation-001",
  "cat": "negation",
  "text": "Priya no longer works at Aquiplex.",
  "claims": [{ "s": "Priya", "p": "works_at", "o": "Aquiplex",
               "polarity": "negated", "modality": "fact" }]
}
```

## The trap PR-3 has to avoid

The regex extractor **cannot express polarity at all**. Scored naively against
these labels it reports near zero — and a near-zero baseline is useless: it
says nothing about where the gap is, and it makes any replacement look
miraculous.

So the labels are full and **the scoring must be graded**. PR-3 measures four
levels, and the interesting result is the shape of the drop-off:

| level | question |
|---|---|
| detection | did anything get captured from a sentence that carries a claim? |
| subject | is it about the right entity? |
| predicate | is the relation right? |
| fidelity | polarity + modality + time |

The current extractor is expected to score respectably on detection and **zero
on fidelity**. That contrast *is* the baseline. It is stated here in advance so
PR-3's numbers read as a diagnosis rather than a catastrophe.

## Composition — 200 cases, 167 claims

| category | cases | why it exists |
|---|--:|---|
| identity | 40 | the bread and butter — what someone says about themselves |
| people | 20 | third-person subjects |
| **negation** | 20 | today's extractor stores the **positive** relation |
| **modality** | 25 | intent / hypothetical / question / quote, all stored as fact today |
| **temporal** | 25 | absolute *and* relative; relative resolves to nothing today |
| **decision** | 15 | absent from the engine entirely |
| **task** | 15 | absent from the engine entirely |
| **negative** | 40 | **nothing should be extracted** |

23 negated claims · 37 timed claims (22 relative) · modality spread across all
five values · 20% negatives.

**The negatives are not padding.** Without them precision is unmeasurable, and
an extractor that fires on everything scores perfect recall. This project has
shipped that exact failure twice — `"I need to check the logs"` became a
self-declaration, and a stopword matched a fact.

## Controlled vocabulary

24 predicates, each with **at least two examples**, enforced by test. A
predicate with one example scores 0% or 100% and nothing between — a coin flip
wearing a metric's clothes. Three entries were removed for that reason while v1
was written, rather than padding cases to justify keeping them.

## Limitations — stated, not buried

- **Synthetic.** Authored for this dataset, not sampled from real transcripts.
  Biased toward what the author expected an extractor to find, so a system
  tuned against it can look better than it is.
- **The real dataset is CORRECTIONS-LIVE** (Blueprint Part 11): every user
  correction is a labelled example produced by the person best qualified to
  judge. v1 should be **replaced, not defended**, once corrections accumulate.
- **Single sentences.** Coreference across turns is not represented and cannot
  be measured here.
- **One annotator**, so the labels carry no measured reliability.
- **English only.**

The suite asserts these limitations are still stated. Deleting them fails three
tests — a benchmark that stops admitting what it cannot see is how a project
measures itself into a corner.

## Integrity

The dataset is pinned the way the parser fixtures were in E1/PR-1: shape,
category census, uniqueness, vocabulary and the hard-category thresholds are
all asserted, so a rebalance is a decision a reviewer sees rather than a drift
that quietly changes what every downstream number means.

**Bite, measured:** delete 35 negatives → 5 fail · flatten negation → 1 ·
strip time → 1 · delete the limitations → 3 · let a label invent its subject → 1.

## Four labels this validator caught

While v1 was being written the validator rejected four of my own labels that
claimed `SELF` on sentences with no first-person marker — *"The README says the
project uses Redis"*, *"Design review happens every Thursday"*, *"The team chose
React over Vue"*, *"Final call: the eval harness ships before E3"*. All four
were relabelled to their real subjects. A label that invents its subject is
unscoreable: no extractor could ever be judged against it.

---

# Retrieval dataset — `retrieval-core.v1`

**Blueprint:** E2/PR-4 · 60 corpus facts + 200 queries

## Shape: one corpus, many queries

The standard IR arrangement — a single fixed world state plus queries with
relevance judgments against it. That mirrors real usage (a person with an
accumulated world model asks a question) and it is what makes recall@k, MRR
and nDCG computable. Per-query world states would give 200 corpora of one fact
each and measure nothing.

Two relevance grades: **relevant** (gain 2) and **acceptable** (gain 1). Finer
grades would be invented precision with a single annotator.

## The adversarial set is this project's own scar tissue

These categories are not generic IR difficulty. Each is a failure this
codebase has actually shipped.

| category | n | the failure it encodes |
|---|--:|---|
| direct | 55 | the baseline case |
| category | 32 | *"what is my job"* against *"I run product at Nummo"* — **no lexical overlap at all**; the self-anchor exists for exactly this |
| multi | 28 | more than one fact is genuinely relevant |
| temporal | 25 | the **current** fact must outrank the old one |
| superseded | 10 | `f003` says Intercom and is superseded by `f001`; the outdated fact must never be the answer |
| negation | 10 | asks about what is *not* the case |
| **selfword** | 15 | a query containing "you" — **seven of nine noise lines** in the rollout harness came from one such query, because the self entity is labelled with the literal word `"You"` |
| stopword | 10 | *"what is the capital of France"* once matched a stored fact through the word **"the"** |
| unknown | 15 | nothing answers it; **returning nothing is the correct answer** |

**32 queries expect silence.** Without them an engine that always returns
something scores perfectly and cannot be told apart from one that knows.

The selfword category is deliberately **split** between answerable and silent.
Suppressing noise is easy if you also suppress the genuine *"what do you know
about me"* answers — and avoiding that trade is exactly what the self-label fix
had to do. Both halves are asserted.

## Corpus realism, enforced by test

- both source tiers present, with **document confidence ≥ chat confidence** —
  the trust tier the engine actually applies (file 0.9 > chat 0.6)
- the self entity carries the label `"You"`, because that label is load-bearing
  in production and the adversarial set is meaningless without it
- no fact has zero entities — the lane could never have written one

## Limitations — stated, not buried

- **Synthetic.** Corpus and queries were authored together, so a query is more
  likely to have a findable answer than in real use.
- **One annotator.** Relevance is the most subjective part of any IR benchmark
  and these judgments carry no measured agreement.
- **60 facts is small.** Lexical precision degrades with corpus size, so scores
  here are an **upper bound** on what the same engine would do at 5,000 facts.
  **RETRIEVE-SCALE (Blueprint Part 11) is the missing companion**, and every
  retrieval number this project has ever quoted has this caveat attached.
- Two grades only; English only; single-turn, so cross-turn pronouns are
  unmeasurable.
- **Why-questions are absent.** Causal retrieval has nothing to score against:
  the chain builder deliberately names its output `progression` rather than
  causation because it cannot detect cause. `reason` is therefore *not* in the
  answer-kind vocabulary — a vocabulary entry with no queries behind it would
  be a capability pretending to exist.

## Three problems the tests caught while v1 was written

- two queries labelled `multi` had **one** relevant fact — recategorised
- a `stopword` query (*"how do the tides work?"*) leaked the content word
  **"work"** into the corpus vocabulary — replaced
- the answer-kind `reason` was declared and never used — **removed**, with the
  gap written into the limitations rather than papered over with two invented
  queries

**Bite, measured:** delete every silence query → 8 fail · make the canonical
selfword query answerable → 1 · remove the superseded trap → 2 · invert the
trust tiers → 1 · delete the limitations → 3.
