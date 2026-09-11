# AQUIPLEX — relevance gate + claim fidelity + subject recall

Cumulative (sessions 1-4). Supersedes every earlier tarball.

Extract from the REPO ROOT (the directory containing `aqua/`):

    tar xzf aquiplex-relevance-gate-v2.tar.gz

## Verify

    cd aqua
    node scripts/run-tests.mjs     # 2873 tests / 341 suites / 0 fail / 1 skip
    npm run eval:gate              # ALL 7 suites PASS

Run the FULL gate, not one suite. See "the invoice" below.

## Files (14)

NEW  aqua/src/brain/knowledgeExtraction/claimFidelity.js   polarity/modality/time + request gate
NEW  aqua/src/brain/tests/claimFidelity.test.js            17 tests
MOD  aqua/src/brain/knowledgeExtraction/conversationFacts.js  writes fidelity, gates requests
MOD  aqua/src/brain/tests/e6Shadow.test.js                 E6's bar raised deliberately
MOD  aqua/eval/tests/extractionBaseline.test.js            two findings inverted
MOD  aqua/eval/baselines/extraction-core.v1.json           updated deliberately

## Files (retrieval, sessions 1-2)

NEW  aqua/src/pic/questionShape.js                     query understanding + shared scorer
NEW  aqua/src/pic/tests/questionShape.test.js          22 tests
NEW  aqua/src/pic/tests/relevanceGate.test.js          17 tests
MOD  aqua/src/pic/retrievalIntelligence.js             relevance gate + abstention
MOD  aqua/src/brain/contextEngine/index.js             reach gate + self anchoring
MOD  aqua/src/brain/tests/contextEngine.test.js        +4 reach-gate tests
MOD  aqua/src/files/evidenceRetrieval.js               non-finite confidence guard
MOD  aqua/src/files/tests/evidenceQCandRetrieval.test.js
MOD  aqua/eval/tests/retrievalBaseline.test.js         findings inverted to pin the fixes
MOD  aqua/eval/BASELINE.md                             before/after + CE findings
MOD  aqua/eval/baselines/retrieval-core.v1.json        updated deliberately

## The defect

Lane 2b anchored on the owner for any first-person question; lane 3 hopped
every `about` edge scoring each `confidence * 0.5 + 0.05` — an expression in
which the QUERY DOES NOT APPEAR. Four different questions, identical output:

    "What is my job?" / "Which city am I in?" / "Where am I employed?"
    "What is my blood type?"   <- nothing in the store answers this

Not retrieval. A dossier dump triggered by the word "my".

The Context Engine then reimplemented the same defect one layer up, ABOVE the
floor, and silently reversed the fix.

## Measured — retrieval-core.v1, 200 labelled queries, production facade

    recall@8         63.7% -> 72.6%     unknown_honesty  34.4% -> 71.9%
    MRR              56.7% -> 66.4%     noise_lines        131 -> 16
    nDCG@8           55.5% -> 64.8%     superseded       20.0% -> 60.0%
    top1_correct     53.0% -> 62.5%     selfword         50.0% -> 75.0%
    top1_kind        42.9% -> 54.8%     temporal         56.0% -> 68.0%

15 metrics improved, 0 regressed.

Context Engine, same queries:
    silence-query noise   23 -> 16   (zero re-added)
    answerable recall    119 -> 122  (ungated CE was NET HARMFUL, adding 0)

## The invoice

The gate was built against retrieval-core and reported clean against
retrieval-core. The FULL gate then showed it had cost capture-core
retrievability 89.5% -> 78.9%. Two general-English gaps: copular role
statements ("I'm the CTO") and goal statements ("I want to hit 10,000 by
December"). Both fixed; capture-core back to 89.5%.

A metric tuned against one suite gets paid for out of another. Run the gate.

## Measured — extraction-core.v1, 200 cases / 167 labelled claims

    overall_strict     15.0% -> 18.0%     fidelity      0.0% -> 64.7%
    detection_recall   61.3% -> 71.9%     subject       41.3% -> 55.7%
    silence_negatives  75.0% -> 90.0%     false pos        10 -> 4
    predicate           0.0% ->  0.0%     deliberate - see below

    detection_people   55.0% -> 95.0%     detection_temporal  44.0% -> 64.0%

Recall rose and false positives FELL over the same change. Recall bought by
admitting more junk is not an improvement, so both are reported side by side.

Third-person subjects were the blind spot: 58.9% for the speaker against 18.1%
for named third parties. Tier 2 of the solo-proper-noun pass demanded a copula,
so every person who DOES something was invisible ("Dev reports to me", "Rahul
joined the billing team"). A subject is followed by a FINITE VERB, now tested
morphologically rather than by keyword.

The negation line was the serious one. The old lane stored "I don't use
Kubernetes" as an ASSERTED fact: the text kept the "don't", but nothing in the
DATA said the claim was negative, so every consumer re-derived polarity from
prose and two derivations can disagree silently. Polarity, modality and time
are now stored; retrieval reads the stored field first.

Predicate stays 0.0% ON PURPOSE. Choosing `works_at` over `role_is` is a
semantic judgement belonging to E5's schema. A test pins it at zero with the
note that if it moves, the question is not "did it improve" but "did someone fit
a vocabulary to the labels".

## A bug in the gate itself

eval:gate BLOCKED on `n_false_admits 17 -> 16` - it treated admitting less junk
as a regression. The direction table was fine; the test guarding its
COMPLETENESS scanned a hand-listed two baselines, so metrics in gate-core and
capture-core were never checked. Widening it to every baseline immediately found
`n_false_positives` in forensic-edited, undeclared - the gate would have waved
through a DOUBLING of false positives there.

Added a third category, DIAGNOSTIC. Route counts (`n_via_*`) move when an
upstream lane improves: better entity extraction pushed `n_via_cue_proper_noun`
45 -> 29 while `gate_recall` did not move at all. Gating that blocks the build
for getting better; calling it STRUCTURAL would claim the dataset changed, which
is a true statement about the wrong thing.

## Known-open, documented in-tree

- recall_negation 30% is a REACH ceiling, not ranking. "turn down"/"rejected",
  "paused"/"on hold", "database"/"Postgres" share no vocabulary. Needs the E7
  dense lane. No synonym table was written: one tuned to this corpus would
  score well and teach the engine nothing. A test fails if it "solves" without
  a dense lane, so the shortcut cannot land quietly.
- The category-noun lexicon in questionShape.js is a hand-built stand-in for
  semantics E6 will carry on the claim itself.
- The eval adapter seeds evidence without confidence and drops supersededBy.
  Pre-existing; left alone deliberately so adapter-fidelity gains are not
  reported inside a number claiming engine gains.
- 60-fact corpus. Lexical precision degrades with scale; these are upper bounds.
- E6 remains unwired (zero production callers). Not addressable without an LLM
  provider and Postgres. Its bar moved: e6Shadow now requires it to beat 55.1%
  71.9% detection, 55.7% subject recall and 64.7% fidelity - all regexes. A
  model pipeline that cannot outperform surface rules on negation and modality
  has not earned the request path. Predicate stays 0.0%, so E6's gain THERE is
  real rather than inherited.
- A dense retrieval lane needs real embeddings. `src/embeddings/` exists and has
  a test-injection hook, but no model host is reachable from this environment, so
  a dense lane could not be honestly MEASURED here. Not attempted.
- src/files/tests/fileIntelligence2.e2e.test.js is FLAKY under full-suite load
  (a perf assertion that fails when the machine is fast: "now scales at 2.37x,
  so someone fixed it"). Passes 3/3 in isolation. Pre-existing, not weakened.
