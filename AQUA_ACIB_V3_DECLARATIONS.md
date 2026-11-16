# ACIB v3 — Declarations

**For:** the independent scenario authors, the reviewer and the founder. Each declaration is copied **verbatim** into the freeze manifest; the freeze tool (`scripts/acib-v3-freeze.mjs`) refuses a manifest whose wording differs.

No author or reviewer has been appointed yet. The names below are blanks to be filled in by the people themselves.

## 1. Evaluation-set author (at least two people)

Each author signs before the reviewer's sign-off:

> I wrote the scenarios attributed to me. I have not read the assistant's source code, design documents, test results or earlier benchmark sets, and I have not discussed these evaluation scenarios with its engineering team. I have not included real personal data. Any filler conversations I wrote were written without knowledge of, or intent to favour, any particular system configuration, and do not change the correct answer to any question.

| Field | Value |
|---|---|
| Name | |
| Role (for example: contractor, volunteer) | |
| Date signed (`declaredAt`) | |

**Eligibility.** An author must not be:
- anyone who built the context engine or the hybrid context feature, including AI agents used for it;
- **the founder**;
- **anyone exposed to prior evaluation results**, engine or hybrid internals, or ACIB v1/v2 (listed in `priorResultsExposed`);
- a development-set author;
- the reviewer.

**Founder decision C-5 (2026-11-12):**
- No one may sign on another person's behalf, and no identity, signature, date or declaration may be invented.
- Placeholder or generic names (for example `<independent author 1>`, `TBD`, `Author 1`, `Reviewer`) are refused, and so are dates in the future.
- The freeze stays blocked until two genuinely independent evaluation authors and one genuinely independent reviewer have been appointed and have signed.

## 2. Development-set author(s)

- Development authors write the 62-scenario development set **after** the evaluation set.
- They use different people, names, places and topics from the evaluation set.
- They write their **own, separate filler library** (D-3). The freeze tool refuses a development filler library that shares any message with the evaluation library, or that lists an author who is not a development author.
- They may work with the engineering team.
- They must **not** see the evaluation set.

The freeze tool refuses any overlap of names between development and evaluation authors, and any shared scenario id or question between the two sets.

## 3. Reviewer (one person)

> I checked scenario counts and category balance, spot-checked at least 20 evaluation scenarios for a single defensible answer and reachable annotations, and hold the evaluation file outside the code repository. I am not an author of the assistant's engine or its hybrid context feature, and I have not shared evaluation scenarios with its engineering team.

| Field | Value |
|---|---|
| Name | |
| Date signed (`signedAt`) | |

**The reviewer:**

- receives the evaluation set from the authors;
- runs the builder checks and the freeze;
- keeps the evaluation file **outside** the repository;
- later runs the single evaluation in **reviewer mode** (`AQUA_V3_REVIEWER_MODE=yes`, `--reviewer "<name>"`, results to a directory outside the repository);
- releases only aggregate results until the run is complete.

**The reviewer must not be** an implementation author, a development author, the founder, or anyone exposed to prior evaluation results.

## 4. Founder

Before the freeze:

1. Confirm the analysis specification ([AQUA_ACIB_V3_ANALYSIS_SPEC.md](AQUA_ACIB_V3_ANALYSIS_SPEC.md)), including the minimum practically meaningful improvement. Its sha256 goes into the manifest as `analysisSpecSha256`.
2. Confirm the success criteria (`successCriteriaConfirmedBy`).
3. List every implementation author in `implementationAuthors`, including AI agents used to build the engine or the hybrid.
4. Separately approve the execution and its resource budget (decision D-P2-7).

## 5. Manifest fields (template: `aqua/eval/governance/acib-v3-manifest.template.json`)

| Field | Content |
|---|---|
| `evalAuthors[]` | `{ name, role, declaration (verbatim §1), declaredAt }`, at least 2 |
| `devAuthors[]` | `{ name }`, at least 1, disjoint from the evaluation authors |
| `implementationAuthors[]` | Everyone who built the engine or hybrid |
| `founder` | `{ name }`: never an evaluation author or the reviewer |
| `priorResultsExposed[]` | Everyone who has seen prior evaluation results, engine or hybrid internals, or ACIB v1/v2. None of them may be an evaluation author or the reviewer. |
| `reviewer` | `{ name, signedAt, statement (verbatim §3) }` |
| `successCriteriaConfirmedBy` | Founder and date |
| `analysisSpecSha256` | sha256 of the confirmed analysis specification |
| `evalPath` / `devPath` | Evaluation set **outside** the repository; development set path |

**What code cannot check.** These declarations are recorded, not verified: the tool checks consistency (no overlaps, verbatim wording, dates, hashes), not honesty. Their value comes from the people who sign them.
