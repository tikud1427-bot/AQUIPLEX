# Answer-level judge rubric (Sprint 4) — independent grading

The judge is a **different model from the one that answered** (a different provider or family). It sees:
- the user's history and files, as plain text;
- the question;
- **one** answer, labelled only "Answer". The arm (A or B), the context sent and the pipeline are hidden from it. Answers are shuffled across arms and scenarios.

It returns JSON only, in this format:

```json
{
  "factual_correctness": 0-2,
  "grounding": 0-2,
  "personalization": 0-2,
  "temporal_accuracy": 0-2 | null,
  "contradiction_handling": 0-2 | null,
  "uncertainty": 0-2 | null,
  "clarification_quality": 0-2,
  "hallucination": true | false,
  "hallucinated_claims": ["..."],
  "notes": "one sentence"
}
```

> **Sprint 6 update.** The prompt actually sent is built by `judgePrompt()` in `eval/answer/judgeRunner.mjs`; that code is the single source. It is the prompt below plus a `confidence` field (0 to 1).
>
> Review routing:
> - Below 0.6 confidence, a malformed reply (after one re-ask), a two-judge gap above 1, or a judge-vs-deterministic gap of 2+ levels all go to human review (`mergeJudgements`).
> - Runner: `scripts/answer-judge.mjs`.

## Prompt (verbatim)

> You are grading an assistant's answer to a user, given everything the user had previously told the assistant.
>
> USER HISTORY (oldest first; files are marked):
> {history}
>
> QUESTION:
> {question}
>
> ANSWER:
> {answer}
>
> Grade strictly from the history. Do not use outside knowledge about the user.
>
> - **factual_correctness:** 2 = every statement about the user matches the history; 1 = minor slip; 0 = a wrong fact about the user.
> - **grounding:** 2 = every user-specific claim can be traced to the history; 0 = claims not in the history.
> - **personalization:** 2 = it uses the details that matter for this question; 1 = generic but correct; 0 = ignores relevant details, or uses irrelevant personal details (on an impersonal question, any personal detail is irrelevant).
> - **temporal_accuracy:** null if nothing changed over time. 2 = uses the latest state; 0 = treats an outdated statement as current.
> - **contradiction_handling:** null if the history does not conflict. 2 = names the conflict and does not silently pick one; 0 = picks one silently.
> - **uncertainty:** null if nothing needed is missing. 2 = says what is unknown and does not invent it; 0 = invents a value.
> - **clarification_quality:** 2 = asks exactly one useful question when essential information is missing, and none when it is not; 1 = asks too many or unhelpful questions; 0 = fails to ask when it must, or asks when it should not.
> - **hallucination:** true if ANY claim about the user, their numbers, people, dates or files is not supported by the history.
>
> Return JSON only.

## Protocol

1. **Same answering model.** Both arms use the same model ID and version, and identical settings (`temperature 0`, `max_tokens 700`, fixed `seed` where supported). The system-prompt instructions are identical. The only difference is the context the pipeline built (arm B = `AQUA_INFO_NEEDS=on`).
2. **Blinding.** The judge never sees arm labels, the context block or the system prompt. Order is randomised with a recorded seed.
3. **Judge calibration first.** The judge grades 20 answers that a human has also graded. Agreement is reported (Cohen's κ per dimension) before any arm comparison is reported.
4. **Two judges where budget allows.** Disagreements above 1 point go to a human.
5. **Report together.** Deterministic grades (`answerGrader.mjs`) are reported beside judge grades, never replaced by them.
6. **No superiority claim unless:**
   - the difference holds on the frozen eval set;
   - the paired bootstrap 95% CI excludes 0;
   - both the deterministic and the judge grades agree in direction.
