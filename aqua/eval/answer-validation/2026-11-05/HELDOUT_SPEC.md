# Held-out answer evaluation: specification for an independent evaluator

**Purpose.** To test whether Aqua's answers improve on questions its developers never saw. The development cases (`aqua/eval/datasets/answer-lifecycle.dev.v1.json`, `intent-outcome.*.v1.json`) were written by the same author who built the mechanisms. They cannot show this.

**Who writes it.** Someone who has not worked on the implementation and has not read the development cases. They must not see the code changes or the development results before submitting.

## What to write

One JSON file, `heldout.v1.json`, with this shape (validated by `validate-heldout.mjs`):

```json
{
  "id": "answer-heldout.v1",
  "author": "<name or role — not the implementer>",
  "written": "<date>",
  "lives": {
    "<life id>": ["<user message>", "...", "---", "<message a week later>", "..."]
  },
  "questions": [
    { "id": "h01", "life": "<life id>", "ask": "<question the user asks>",
      "category": "current | historical | goal_status | uncertain_dependency | personal_context | abstention",
      "include": [["<any of these must appear>", "<synonym>"]],
      "notCurrent": ["<a retired value that must not be presented as current>"],
      "notOpen": ["<an achieved goal that must not be presented as open>"],
      "hedge": true,
      "abstain": true,
      "examples": { "good": "<a correct answer>", "bad": "<a plausible wrong answer>" } }
  ]
}
```

`include`, `notCurrent`, `notOpen`, `hedge` and `abstain` are optional; use those that apply. `---` in a life advances simulated time by a week.

**Coverage, at least:**
- 6 lives, written like real people: varied jobs, relationships, goals, money, places;
- 30 questions, at least 4 per category;
- in each life, at least one change, correction, achievement, or ended state;
- plus a statement that *sounds* like a change and isn't: a plan, a hypothetical, someone else's change, a negation.

**Rules for the writer:**
- **Natural messages.** Write messages as a user would, including several facts in one sentence, pronouns, and achievements stated without "finished" or "done".
- **Questions with a single correct answer** given the life, decidable without the system. An abstention question asks for something never stated.
- **Example answers.** A bad example should be the answer a system with stale or wrong memory would give.
- **No borrowing.** Do not reuse names, companies or sentences from the development datasets. The validator rejects overlaps it can detect.

## How it is run (no tuning on it)

1. **The writer submits the file and its SHA-256** to the owner before anyone runs anything.
2. **`node validate-heldout.mjs heldout.v1.json`:** schema, coverage, overlap with the development sets, and the rubric self-test on the writer's examples. Problems go back to the writer to fix. The implementer never edits the questions.
3. **Build the contexts** for the HEAD and DEV code with `scripts/answer-eval-harness.mjs contexts` (pointing `DATASET` at the held-out file), then `prepare`.
4. **Generate answers** with the same authorised, isolated answerer and the same fixed settings as the development comparison (`run-answers.mjs`).
5. **Grade** with the same rubric (`grade`), plus an optional frozen LLM judge as a second grader. Report the two separately.
6. **Report held-out results separately from development results.** Nothing in the implementation changes between submission and grading. If anything is changed afterwards, the set is spent: it becomes a development set, and a new held-out set is needed.

## Decision rule (fixed now)

- **Primary measure:** paired per-question pass rate, DEV minus HEAD, on the held-out set; sign test across questions.
- **Improvement** is claimed only if DEV is better on more questions than it is worse, with p < 0.05 (sign test), *and* no category is worse by more than one question.
- **With 30 questions,** only large effects are detectable. Smaller differences are reported as "not shown", not as "no effect".
