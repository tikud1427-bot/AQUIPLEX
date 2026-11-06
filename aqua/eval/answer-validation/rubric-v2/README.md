# Answer rubric v2 (frozen 2026-11-05)

A revised deterministic grader for `answer-lifecycle.dev.v1.json`.

**What it leaves alone:**
- The v1 rubric (`scripts/answer-eval-harness.mjs`), the dataset and every v1 result stay byte-identical. The tests check this.
- v2 is a separate grader. Its results are reported beside the v1 results, never instead of them.

## What changes from v1

| v1 behaviour | v2 behaviour |
|---|---|
| Every capitalised word not in the context is an "unsupported name", including sentence openers ("However", "Given") and Markdown headings | Openers are exempt unless they start a multi-word name. Headings and bold labels are reported (`headingWordsNotInContext`) but not scored. Acronyms defined inline ("key performance indicators (KPIs)") are exempt |
| "September" is unsupported when the context dates a line `2026-09-08` | ISO dates in the context also license their month name, abbreviation and weekday |
| `notOpen`: every sentence naming the goal needs a done marker, so a bare list item ("1. Pass the CFA.") fails a correct answer | The answer is split into units that keep its structure: a list item inherits its list header and its labelled parent. At least one unit must mark the goal done; no unit may present it as open (including via an "Open goals:" header); a bare mention is neutral; negated completion ("haven't passed") does not count |
| no check for advice built on stale state | `notCurrent` is applied to the advice question q05 (retired employer and role), and a new `reachedGoal` check: a goal whose target the user already holds may appear only as done, past or uncertain |
| `hedge` matches "check" anywhere, including a "**Check**" heading and "we need to check" | Hedging must be the answer's own: uncertainty words, a question back, or an instruction to the user to verify. Headings and method talk ("To determine this, we need to…") do not count |
| no check for converting uncertainty into fact | `uncertaintyKept`: for an item the context marks uncertain, no unit may resolve it either way (in either direction: "no longer yours / not relevant", or "still yours / due on / prioritise") unless that same unit hedges. A historical mention ("was due on March 3") is allowed; "likely" alone is an inference, not a hedge |
| — | Each tracked claim gets a status: `asserted`, `historical`, `done`, `inferred`, `uncertain` or `meta`. This is recorded in `claims`. A `scaffold` flag records whether a reasoning scaffold (Understand / Approach / Check / Final) leaked into the answer; it is reported, not scored |

**Criteria added per question:** see `criteria.v2.json`. Only q04 and q05 get new criteria. The other questions keep the v1 criteria under v2 checks.

## Provenance (important)

`criteria.v2.json` and the rules were written **after** reading the Cloudflare Mistral primary run. The tests use synthetic text, not that run's answers, but the choice of rules was informed by it. So the v2 scores of that run are **diagnostic**, not confirmatory. Confirmatory evidence needs answers produced after this freeze, or the independent held-out set (`../2026-11-05/HELDOUT_SPEC.md`).

## Known limits

- Single-word invented names at the start of a sentence ("Daniel is your manager.") are not flagged.
- Invented words inside headings are reported, not scored.
- `may` / `might` anywhere in a unit count as a hedge, so a stale claim inside a "you may want to…" sentence escapes `notCurrent`.
- Coreference is limited to "this/that/the project|goal|migration|task|deadline|one" immediately after a unit that named the item.
- Marker lists are English and hand-written. A judge-based grader would still be needed for anything subtler.

## Files

| File | Purpose |
|---|---|
| `grader.v2.mjs` | the rubric (`selftest`, `grade`) |
| `criteria.v2.json` | added criteria, extra examples, provenance |
| `grader.v2.test.mjs` | rule tests (`node --test grader.v2.test.mjs`) |
| `FROZEN.sha256` | hashes of the four files above, taken before any run was graded with v2 |
| `results/` | v2 gradings of preserved runs (written after the freeze) |

```bash
sha256sum -c FROZEN.sha256
node --test grader.v2.test.mjs && node grader.v2.mjs selftest
R=../2026-11-05/answers/primary-cf-mistral-2026-11-05
node grader.v2.mjs grade --answers $R/answers.jsonl \
  --contexts ../2026-11-05/contexts.HEAD.code-defaults.json,../2026-11-05/contexts.DEV.code-defaults.json \
  --v1 $R/graded.json --json results/primary-cf-mistral-2026-11-05.v2.json
```
