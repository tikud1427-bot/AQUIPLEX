# Pilot validation plan: founder project-state memory

**Goal.** Within about 6 weeks, find out whether early-stage founders (a) have
the stale-context problem badly enough to change tools, (b) get value from Aqua
on their real company, and (c) will pay. Decide to continue, narrow or pivot on
pre-set criteria, not on enthusiasm.

Nothing in this plan has been done yet. No one has been contacted.

---

## Phase 0: preconditions (week 0, founders)

These must be done before inviting anyone:

- [ ] Rotate the exposed credentials (`REPO_AUDIT.md` §5) and make the repo private.
- [ ] Ship the release candidate (`RELEASE_MANIFEST_RC_2026-10-17.md`): hotfix + security, billing and reliability fixes. No migrations.
- [ ] **Second release for the pilot workflow.** The Memory page that shows what answers (with per-claim correct and delete) needs this branch's authoritative read mode. It requires migrations 0016–0024 on the production database (all additive; read them first), `AQUA_CANONICAL_READ` left unset, and a decision for existing users: E10-migrated facts are invisible to canonical reads (REPO_AUDIT F4), so either re-extract them or keep the legacy fill. Run `aqua/scripts/e2e-founder-journey.mjs` against staging before inviting anyone.
- [ ] Replace free-tier models with at least one paid key, **especially the extraction provider**. Measured: the Groq free tier allows about 10 extractions per minute for the whole product, and one founder's onboarding burst hits that. Estimated cost on paid gpt-oss-120b: about $0.0025 per turn.
- [ ] Confirm product events are being written in production. Run `scripts/activation-report.mjs --mongo <prod read-only URI>` after one test signup.
- [ ] Load the cost-accounting price table so cost per user is known.

## Phase 1: problem interviews (weeks 1–2)

**Who.** 20 founders or solo operators at pre-seed to seed who use an AI
assistant at least 3 times a week for company work. Mix technical and
non-technical founders.

**Where to find them.** These are candidate channels; pick the ones where the
founders genuinely have access:

- the founders' own network and batchmates `[FOUNDER TO LIST]`;
- incubator or accelerator cohorts the founders belong to;
- founder communities: Indie Hackers, relevant subreddits, X founder circles, local startup meetups;
- warm intros, asking each interviewee for two more.

**Script.** 30 minutes. Ask about the past, not hypotheticals; do not pitch.

1. Walk me through the last time you used AI for something about your company. What did you have to tell it first?
2. When did an AI last give you something based on outdated info about your company? What happened? What did it cost you?
3. How do you keep the AI up to date today: pasting docs, custom instructions, projects, nothing?
4. What do you pay for AI tools today? Who pays?
5. If an assistant always knew your current pricing, plans and decisions, and showed you where it got them, what would you stop doing?
6. Would you trust it with your company's internal context? What would make you not?

**Record** for each interview:

- frequency of re-explaining (per week);
- the last stale-fact incident and its cost;
- the current workaround;
- current spend;
- a trust concern, if any.

**Exit criteria for Phase 1:**

| Result | Decision |
|---|---|
| ≥ 10 of 20 describe a concrete, recent stale-context incident with a real cost (time, an embarrassing send, a wrong decision), **and** ≥ 8 have an active workaround | continue |
| < 5 of 20 | the problem is weak. Test the expansion segment (consultants and agencies with multiple clients) with the same script before building more. |

## Phase 2: design partners on real work (weeks 2–5)

**Who.** The 10 interviewees with the strongest pain who agree to use Aqua for
their real company for 3 weeks.

**Setup, in a 20-minute call with each partner:**

1. They do the onboarding interview and attach one real document (deck, spec or plan).
2. They review the "what I understand" card and correct what's wrong. **Record the corrections**; they measure extraction quality on real data.
3. Ask them to bring Aqua at least 3 real tasks a week: an investor update, a customer email, a plan, a decision memo.

**What we measure** (product events plus a weekly 5-minute check-in):

| Metric | Source | Target to continue |
|---|---|---|
| Activation: chat on ≥ 2 days in the first 7 | product events | ≥ 7 of 10 |
| Week-2 and week-3 usage | product events | ≥ 6 of 10 still using in week 3 |
| Stale-fact incidents (Aqua used an outdated fact) | partner diary plus the check-in question "did Aqua use anything outdated this week?" | trending down; ≤ 1 per partner per week by week 3 |
| Fabricated facts about their company | check-in | ≤ 1 per partner over the pilot |
| Corrections per 100 turns | product events | track; read it alongside interviews |
| "Would you be very disappointed if Aqua went away?" (Sean Ellis question) | week-3 check-in | ≥ 4 of 10 say "very" |
| Cost per active partner per week | cost accounting | known, and below the planned price |

**Run alongside:** Lift v4 (pre-registered). If its decision is SIMPLIFY, switch
the product to the simpler memory path *before* week 3, and say so to the
partners.

**Ethics and privacy.** Partners' company data stays in their own accounts.
Analytics record no content. Do not read partners' conversations without
explicit consent for a specific debugging session. Offer deletion at the end.

## Phase 3: willingness to pay (week 5–6)

- Offer activated partners a paid monthly plan at a fixed price. `[FOUNDER DECISION: INR or USD; suggested range: the price of a mainstream assistant subscription]`
- Count actual payments, not "I would pay".
- Ask non-payers why, and record the reasons.

## Decision rules (set now, applied at week 6)

| Outcome | Decision |
|---|---|
| ≥ 3 of 10 partners pay **and** ≥ 6 of 10 active in week 3 **and** stale incidents trending down | **Continue.** Recruit the next 50 users through the channel that produced the best partners. Start the YC application with real numbers. |
| Strong usage but < 3 pay | **Continue usage, change the price or packaging.** Test team or expansion pricing (shared company state) before broad launch. |
| Pain confirmed but usage collapses by week 3 | **Fix the product.** Find out where the loop breaks (onboarding, answer quality, stale facts) using the event funnel and diaries. Re-run with 5 new partners. |
| Pain not confirmed in Phase 1 **or** ≤ 2 of 10 active in week 3 | **Pivot the segment.** Run the same interviews with consultants and agencies managing multiple clients (the expansion thesis). The architecture then needs per-project scoping. |

## Weekly cadence

- **Monday:** run `activation-report.mjs`; review the funnel and cohort table.
- **Wednesday:** partner check-ins (5 minutes each, 3 fixed questions).
- **Friday:** update `PRODUCT_SCORECARD.md` with measured numbers only. Log every stale or fabrication incident partners report, with how it was fixed.

## Next experiments (in this order)

1. **Lift v4** on a host that stays up (pre-registered; one command). It decides whether the World Model stays the answer context or is simplified to state tracking.
2. **Canonical-read noise.** Reduce the 153 noise lines and raise unknown honesty on the `context-canonical` gate without losing recall. Then re-run the founder journey and v3 or v4 fabrication.
3. **Change capture at volume.** A held-out set of real founder-style change sentences (single and compound), written by someone other than the tuner. Measure the share that reach memory and are used in the next conversation. Target ≥ 95% for single changes.
4. **Problem interviews** (Phase 1): is stale context a frequent, costly pain for founders?
5. **Design-partner usage** (Phase 2): activation (2+ chat days in 7), week-2 and week-3 usage, stale incidents per partner per week, corrections per 100 turns.
6. **Paid conversion** (Phase 3): count payments from activated partners at a fixed monthly price.

