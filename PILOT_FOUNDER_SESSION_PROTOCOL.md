# Founder pilot — session protocol and scoring sheet

Companion to `PILOT_VALIDATION_PLAN.md`, which holds the recruiting, weekly cadence and decision rules.
This file is the **repeatable 45-minute session**: the same seven steps for every founder, scored the
same way, so results across founders can be compared.

**Status: prepared, not run.** No participant has taken part. Every metric below is UNMEASURED until
real sessions happen. Do not report any number from this protocol before then.

## 0. Before any founder is invited (blockers)

| Precondition | Why | Where |
|---|---|---|
| Exposed credentials rotated (Mongo, Google OAuth, session secret, Razorpay, OpenRouter, Serper) | Founders will enter real company data | `WORLD_MODEL_READINESS_2026-10-18.md` §9 |
| Signup fixed: email verification before a password account is usable, no Google merge into an unverified account, unlimited allowlist only for verified identities | Otherwise an attacker can pre-register a founder's email and read what they enter | readiness report §9 (S1, S2) |
| A release containing the open fixes deployed to staging, then production, **with approval** | Cross-account intro-marker write, refund-once, capacity backoff, bounded S8, idempotent retries | readiness report §10 |
| A paid extraction provider key | The free tier serves about 10 extractions per minute for the whole product | `PRODUCT_SCORECARD.md` §3c |
| `aqua/scripts/e2e-founder-journey.mjs` passes on staging | The automated version of this protocol | — |
| Product events confirmed in production (`scripts/activation-report.mjs`, read-only) | Activation and retention are measured from these | — |

## 1. Consent (read aloud, and get a written "yes")

> We're testing whether Aqua keeps an accurate picture of your company over time. You'll use your real
> company information. It's stored in your own account, which no other account can read. Analytics
> record only that an action happened (for example "a chat turn", "a memory corrected"), never what you
> wrote. We won't read your conversations unless you give us permission for a specific debugging
> session. You can delete everything at any time from the Memory page. When the pilot ends we'll offer
> to delete your account entirely. You can stop at any point. Is that OK?

Record: date, participant pseudonym (e.g. P07), consent given (yes/no). **No company name in the
research notes.** Refer to facts by type ("price", "launch date") rather than by value.

## 2. Session script (facilitator)

Use one fresh account per participant. Each step starts in the conversation the step names.

| Step | Conversation | Facilitator asks the founder to… |
|---|---|---|
| 1. Introduce | A | Tell Aqua about the company: what it does, current priorities, the next deadline, pricing, and the biggest blocker, in their own words (3–6 messages). |
| 2. Change | A, then B | In A: change at least two facts in **one** message (e.g. "we moved the launch to X and the price is now Y"). Open conversation B and change a third fact. |
| 3. New conversation | C | Open a new conversation. |
| 4. Current state | C | Ask: "Where does the company stand right now?" |
| 5. What changed, and evidence | C | Ask: "What changed recently, and how do you know?" Then open the Memory page and look at the sources. |
| 6. Plan | C | Ask: "Draft a plan for the next two weeks given our goals and what's blocking us." |
| 7. Correct and verify | C, then D | Find one wrong or outdated belief on the Memory page or in an answer, and correct it. Open conversation D and ask a question whose answer depends on it. |

Afterwards, ask the founder three questions (scores 1–5): How accurate was Aqua's picture of your company?
How useful was the plan? Did you have to repeat yourself? Then ask: "Would you be very disappointed if
you couldn't use this?" (very / somewhat / not).

## 3. Observer scoring sheet (one row per participant)

Before the session, the facilitator lists the facts stated in steps 1–2 (by type), so every count has a
denominator. Scoring is done **with the founder**, who says what's true. The observer never guesses.

| Field | How it's scored | Metric |
|---|---|---|
| facts_stated | count of distinct facts in steps 1–2 | denominator |
| facts_captured | facts the Memory page shows (any wording) | capture rate |
| changes_stated / changes_applied | the 3 changes; applied = Memory shows the new value as current **and** the old one as past or absent | change application rate |
| compound_both_applied | step 2's two-change message: both applied? (yes/no) | compound completeness |
| stale_in_answers | count of outdated values stated as current in steps 4–6 | stale-answer count |
| fabricated | count of company facts in steps 4–6 the founder never said | fabrication count |
| evidence_correct | in step 5, are the cited sources the founder's actual statements? (all / some / none) | attribution |
| acknowledged_unknown | did Aqua say when it didn't know something it was asked? (yes / no / n.a.) | honesty |
| correction_held | step 7: does conversation D use the corrected value? (yes/no) | correction persistence |
| repeat_needed | did the founder re-state a fact Aqua should have known? (count) | re-explanation |
| plan_useful | founder score 1–5 | usefulness |
| accuracy_score, repeat_score, disappointed | founder answers | perceived value |
| p50/p90 latency | from server logs for the session's turns | latency |
| cost | from the cost counters (`aqua_cost_*`) for the session | cost per session |

Automatically measured over the following weeks (no content read):

- activation (chat on ≥ 2 distinct days within 7 days);
- week-1 and week-4 retention;
- corrections per 100 turns (product events);
- re-explanation rate (`/brain/learning`, computed from the World Model);
- payments (Phase 3 of the plan).

## 4. Reporting rules

- Report per participant until there are at least 5; then report counts as "x of n", never percentages
  of fewer than 10.
- Keep the scoring sheet free of company content: types and counts only.
- A session in which Aqua failed for infrastructure reasons (provider outage, deploy) is recorded
  as such and re-run. It is not dropped silently.
- Results here are customer validation. Keep them separate from the synthetic benchmarks (Lift v4 and
  the final evaluation). Neither substitutes for the other.
