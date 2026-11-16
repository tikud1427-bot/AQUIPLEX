# ACIB v3 — Scenario Authoring Brief

**For:** independent scenario authors and the reviewer.

You will write test scenarios for a personal AI assistant that remembers what a user told it in earlier conversations. Each scenario is a short, invented conversation history followed by one question. Your annotations say what a good answer must use, and what it must not use.

You do **not** need to know how the assistant works, and you should not try to find out. Please do not read its source code, design documents, test results or earlier benchmark files. If you have seen any of them, tell the reviewer before you start.

## 1. What to deliver

| Set | Scenarios | Who sees it afterwards |
|---|---|---|
| **Evaluation set** | **174** | Only the reviewer, until a single final run. Kept outside the code repository. |
| **Development set** | **62** | The engineering team (for tuning). Must not resemble specific evaluation scenarios. |

**Split the work.** At least two authors write the evaluation set; record each scenario's author. Write the development set **after** the evaluation set, with **different** people, names, places and topics, so nothing tuned on it can match an evaluation item.

## 2. Categories (exact counts)

| Category id | Evaluation | Development | What the scenario tests |
|---|---|---|---|
| `personal` | 16 | 6 | Recalling a single fact the user stated |
| `semantic-mismatch` | 24 | 8 | The question uses **different words** from the user's statement ("What's my salary?" after "I make 42k a year"; "What car do I have?" after "I drive a Fiesta"). Evidence and question share **no** content word. |
| `spread` | 16 | 6 | The answer needs 3–6 facts from different conversations |
| `cross-project` | 10 | 4 | Two projects with similar details; the answer must use the right one |
| `cross-person` | 10 | 4 | Facts about different people (the user vs their sister; two people with the same first name) |
| `changing` | 16 | 6 | A fact changed over time, explicitly or implicitly ("the landlord put the rent up to…"); only the current value is correct |
| `contradiction` | 10 | 4 | Two statements conflict (dates, amounts, days); a good answer notices it |
| `missing` | 16 | 6 | A decision question where essential information was never given; a good answer says what is missing or asks |
| `tempting` | 12 | 4 | A history fact shares words or topic with the question but is irrelevant; a good answer ignores it |
| `negative` | 12 | 4 | An impersonal question ("Why is the sky blue?") with a rich personal history; personal details must not be used |
| `uncommon-decision` | 8 | 2 | A decision about an unusual situation outside everyday topics |
| `language-mismatch` | 12 | 4 | The fact was stated in one language and the question is asked in another (e.g. the history says "Trabajo en una panadería en Sevilla", the question asks in English where the user works). Record `languages: { question, evidence }` with language codes. A correct answer may translate the fact, so `match` may be in the question's language. |
| `indirect-reference` | 12 | 4 | The question or history refers to something indirectly ("she", "that place", "the one I mentioned last week", "my brother's new job"). Record `indirect: [{ phrase, resolves }]`: the referring phrase (as a pattern found in the question or history) and the id of the need it refers to. |

**Variety rules**

- Use many domains (work, family, health, money, hobbies, travel, home), many writing styles, and both short and long messages.
- Beyond the `indirect-reference` category, about 1 in 5 other histories should also include indirect references ("she", "that place", "the one I mentioned").
- Language-mismatch scenarios should cover more than one language pair. Use languages you write fluently; a fluent second author checks each one.
- Invented people only. **No real personal data**, no real people's names paired with private facts.

## 2a. Filler library (long and very-long histories)

Each scenario is also run with a **long** history (more than 9,000 characters) and, for a stratified sample, a **very-long** history (more than 60,000 characters). The extra history is **filler**: everyday conversation that has nothing to do with the question.

The evaluation authors write the evaluation set's filler. The development authors write a **separate** library for the development set; the two must share no message.

**The library must be large and varied:**

- **At least 300 distinct messages.** No duplicates, so long histories do not cycle a short list.
- **At least 8 unrelated topics**, for example cooking, travel, weather, sport, films, home repairs, pets or work gossip.
- **Different lengths and wording**, from one-liners to rambling paragraphs. The longest message must be at least 4× the shortest.
- **Realistic ordinary exchanges:**
  - irrelevant personal facts (a colleague's holiday, a neighbour's dog);
  - project details unrelated to any question;
  - dates and preferences;
  - small talk.
- **Some semantically similar but irrelevant material.** For example, someone else's budget, another person's job, or a different project's deadline. It should read as plausible noise near the topic, never as the answer.

**The library must be answer-neutral:**

- **No filler message may change the correct answer to any question.** Do not restate, update, contradict or hint at any scenario's facts, and do not introduce a new value for something a question asks about.
- **The builder rejects any filler message that contains an answer-bearing pattern** of any scenario. This mechanical check is necessary but not sufficient: you and the reviewer confirm the rest.
- **The long and very-long versions of a scenario keep exactly the same answer-bearing history.** Filler is only added, never substituted.
- **Write filler without regard to how any particular assistant configuration might handle it.** It must not be constructed to help or hinder any system.

**Record the library in the dataset file** as `fillerMetadata`:

```json
"fillerMetadata": {
  "composition": "<what the library contains, e.g. 'everyday chat across 12 topics; ~10% similar-but-irrelevant money/work/date talk'>",
  "authors": ["<the authors who wrote it>"],
  "topics": ["cooking", "travel", "…"],
  "messageCount": 320,
  "lengthRange": [18, 412],
  "includesSemanticallySimilarDistractors": true,
  "answerNeutralityReviewedBy": "<who checked that no filler changes a correct answer>"
}
```

The builder checks that `messageCount` and `lengthRange` match the library exactly. The dataset also sets `fillerTargetChars` (9,000) and `veryLongFillerTargetChars` (at least 60,000).

**The very-long regime is a separate stress test.** It shows how answers hold up as history grows; it is never part of the main improvement result.

## 3. Scenario format (JSON)

```json
{
  "id": "sm-salary-01",
  "category": "semantic-mismatch",
  "authors": ["<author name>"],
  "answerability": "answerable",
  "history": [
    { "id": "m1", "conv": "c-a", "text": "I make about 42k a year at the depot." },
    { "id": "m2", "conv": "c-b", "text": "My sister just started a nursing course." }
  ],
  "question": "How much am I paid?",
  "needs": [
    { "id": "pay", "required": true, "match": ["42k", "42,000"], "evidence": ["make about 42k"], "paraphrase": true }
  ],
  "distractors": [ { "id": "sister", "match": ["nursing"] } ]
}
```

| Field | Meaning |
|---|---|
| `id` | Unique; a category prefix plus a number |
| `history[]` | The user's past messages, oldest first. `conv` groups messages into conversations. |
| `question` | What the user asks now |
| `needs[]` | Facts a correct answer must contain. `match`: regular expressions, at least one of which a correct answer contains. `evidence`: a pattern that finds the source sentence in the history. `required`: true for essential facts. `paraphrase: true` when the evidence shares no content word with the question. |
| `distractors[]` / `tempting[]` | Facts that must **not** appear (`tempting` = shares words or topic with the question) |
| `temporal` | For `changing`: `{ "current": ["<pattern>"], "stale": ["<pattern>"] }`. The current value must appear; a stale value must not be asserted as current. |
| `contradiction` | For `contradiction`: `{ "a": ["<pattern>"], "b": ["<pattern>"] }`: a good answer mentions both conflicting values or flags the conflict |
| `unknowns[]` | For `missing`: `[{ "id", "label", "match": ["<pattern>"] }]`, the facts never given. A good answer says each is unknown or asks for it. |
| `crossEntity[]` | For `cross-project` / `cross-person`: `[{ "id", "forbid": ["<pattern>"] }]`, the other entity's facts that must not be attributed |
| `answerability` | `answerable` (the history contains the answer) · `answerable-with-caveat` (answerable, but a good answer qualifies it, e.g. the fact may be outdated) · `needs-clarification` (essential information is missing; one good question would resolve it) · `unanswerable` (the history cannot answer it and no single question would; a good answer says so without guessing; requires `unknowns[]`) · `impersonal` (a general question; personal details must not be used) |
| `expectedQuestion` | For `needs-clarification`: what one good clarifying question would target (a label, not wording) |
| `expectedQuestionMatch[]` | Optional patterns a good clarifying question would contain (otherwise the `unknowns[].match` patterns are used). A `needs-clarification` scenario needs one or the other. |
| `languages` | `language-mismatch` only: `{ "question": "en", "evidence": "es" }` |
| `indirect[]` | `indirect-reference` only: `[{ "phrase": "<pattern>", "resolves": "<need id>" }]` |
| `tempting[]` | `[{ "id", "match": ["<pattern>"] }]`; each needs at least one pattern |

Optional `uploads[]` (`{ "name", "content" }`) represent a document the user shared.

## 4. Quality checks (run by the builder; failures are returned to you)

- Every `evidence` and `match` pattern is found in the history (`match` is exempt for language-mismatch, where the answer may translate).
- Every `paraphrase` need truly shares no content word with the question.
- Ids are unique, and category counts are exact.
- Language-mismatch scenarios declare two different languages.
- Every indirect-reference phrase is found, and resolves to a real need.
- `needs-clarification` scenarios say what to ask about.
- `unanswerable` scenarios list their `unknowns[]`.
- **Only facts the history actually contains go in `needs`.** Missing information goes in `unknowns`, never in `needs`, so a careful answer is never marked wrong for not knowing it.
- `impersonal` scenarios have no required personal needs.
- **No development scenario shares an id or a question with an evaluation scenario.**
- **Filler (§2a):**
  - at least 300 distinct messages, at least 8 topics, and varied lengths;
  - no filler message containing an answer-bearing pattern;
  - `fillerMetadata` complete and accurate;
  - the evaluation filler written by the evaluation authors, and the development filler by the development authors;
  - no message shared between the two libraries.
- The declarations are in [AQUA_ACIB_V3_DECLARATIONS.md](AQUA_ACIB_V3_DECLARATIONS.md) and must be signed verbatim.
- **Each scenario has one defensible correct answer.** Ask yourself: would two careful people agree on what a good answer contains?

## 5. Rules

1. Do not look at the assistant's code, documentation, test results or earlier benchmark sets (v1, v2).
2. Do not discuss evaluation scenarios with the engineering team. Send the evaluation set **only to the reviewer**.
3. Do not change a scenario after the reviewer's sign-off; a change means a new version.
4. Record your name in `authors` on every scenario you wrote.

## 6. Declarations (to the reviewer, before sign-off)

Each author confirms in writing:

> I wrote the scenarios attributed to me. I have not read the assistant's source code, design documents, test results or earlier benchmark sets, and I have not discussed these evaluation scenarios with its engineering team. I have not included real personal data. Any filler conversations I wrote were written without knowledge of, or intent to favour, any particular system configuration, and do not change the correct answer to any question.

The **reviewer** confirms:

> I checked scenario counts and category balance, spot-checked at least 20 evaluation scenarios for a single defensible answer and reachable annotations, and hold the evaluation file outside the code repository. I am not an author of the assistant's engine or its hybrid context feature.
