# Product thesis — 2026-10-15

**Status: hypothesis.** No customer interviews, payment tests or retention data
exist in this repository. Every claim about customers below is an assumption to
test (see `PILOT_VALIDATION_PLAN.md`). Every claim about the technology cites
measured evidence or is labelled unmeasured.

---

## 1. What the evidence says before choosing anything

1. **The engineering is real.** There are about 4,600 automated tests, and they pass today. The pipeline is a durable job system that turns conversations and documents into dated, sourced, correctable claims. Supersession, disputes and deletion are all implemented.
2. **The headline technical claim is not yet true.** On held-out data, the World Model answered 73% of questions correctly. Simple retrieval memory scored 79%, and pasting the full history scored 95%. The World Model also fabricated more (`REPO_AUDIT.md` §3). The one setting where it could win, long histories that don't fit in context, has **never been measured to completion** (v4).
   - **On the exact job this thesis targets, it is the worst option today.** The stale-answer rate on held-out v3 (answers that used a value the user had since changed) was **World Model 15.2%, simple memory 9.1%, full history 1.0%** (`PRODUCT_SCORECARD.md` §2).
   - Engineering consequence: for short and medium projects, the product should put the recent cross-conversation history in front of the model directly. It should rely on the World Model only where history overflows the context window. That is the "hybrid" condition already pre-registered for v4. The choice must be made by the v4 result, not by preference for the architecture.
3. **There is no customer evidence.** There are no analytics (until today), no recorded interviews, and no revenue data in the repo.
4. **The product surface tries to be several products:** a chat assistant, a "mind" profile, codebase intelligence, an artifact generator, an AI-tools directory, a project-plan "bundles" generator and a blog.

So the company should not be built on "our memory architecture is better". It
should be built on a specific job where *current, sourced, correctable project
state* matters. Then it should measure whether Aqua does that job better than
the cheap alternatives.

---

## 2. Candidate directions

Scores run from 1 (weak) to 5 (strong). They are judgement calls from repo
evidence and general market knowledge, not research.

| Criterion | A. "AI that remembers you" (consumer assistant) | B. Codebase intelligence for developers | **C. Project-state memory for early-stage founders** | D. Client-engagement memory for consultants / small agencies | E. Cited document Q&A for one vertical |
|---|---|---|---|---|---|
| Problem severity and frequency | 2: mild annoyance | 4 | 3: re-explaining context daily; stale facts cause wrong drafts | 4: wrong scope or deadline costs money | 3 |
| Who pays | consumer (weak) | developer or employer | founder (own card, small) | the consultant (business expense) | a business |
| Why switch from the alternative | 1: ChatGPT, Claude and Gemini ship memory for free | 1: Cursor, Claude Code and Copilot are IDE-native; upload-a-zip is worse | 3: incumbents' memory is opaque, stale and hard to correct per fact | 3 | 2: NotebookLM is free |
| Demonstrable edge today | 1: WM ≤ simple memory | 2: the call graph exists, nothing measured | 2–3: supersession, provenance and deletion are built; the quality lift is unproven | 2: same tech, **but no per-project scoping** | 2 |
| Hard to copy | 1 | 1 | 2–3: if the lift is real on long histories, the claim pipeline is months of work | 3 | 1 |
| Time to useful first experience | 5 | 3 | **5**: the onboarding interview and "what I understand" card already exist | 2: needs project scoping and integrations | 4 |
| Distribution | weak | crowded | founder communities; the founder is in the segment | outbound and referrals, slower | vertical-dependent |
| Retention potential | 2 | 4 | 3–4: a project lasts months | 4 | 3 |
| Path to a large company | 2 | 4, but taken | 3, expanding to small teams' shared project memory | 4 | 3 |
| Founder fit | — | medium | **high**: the two co-founders (per `/founders`) are early-stage founders themselves and live this problem `[FOUNDERS TO CONFIRM]` | low | unknown |
| Strongest evidence against | incumbents give it away | incumbents own the IDE | founders are price-sensitive; ChatGPT Projects may be "good enough" | the architecture can't separate clients yet | commodity |
| **Total (rough)** | 15 | 22 | **31** | 27 | 20 |

---

## 3. Decision

**One segment.** Early-stage founders and solo operators (pre-seed to seed, 1–10
people) who use an AI assistant several times a week to think, write and plan
around *one* evolving company.

**One painful problem.** Each AI conversation starts from nothing. Founders paste
the same background again and again. When something changes — pricing, the
launch date, the stack, a hire, the ICP — the assistant keeps reasoning from the
old version. That produces drafts, investor updates and plans with stale facts.
And the founder can't see or fix what the AI "believes".

**One promise.** *"Aqua knows where your project stands: what's current, what
changed, and where it learned it. You can correct or delete any of it."*

**One principal workflow.**

1. **Tell it once.** A two-minute interview, plus optionally a deck, spec or notes.
2. **See what it understood.** A card of facts, each with its source and date, correctable in one click. This is the activation moment.
3. **Work.** Ask for an investor update, a launch plan or a pricing email. Aqua uses the current facts and says where they came from.
4. **Things change.** You say "we moved launch to May 2". Aqua retires the old date (supersession) instead of averaging the two.
5. **Come back.** The welcome line picks up from the current state, not a stale goal.

**The moment that should make a founder say "this is different":** in a new
conversation days later, they ask for an investor update. Aqua uses last week's
new pricing, not the old one. It shows the sentence and date it learned it
from. And when the founder says "that's wrong", the fix holds in every later
conversation.

### Why not the others

- **A** has no defensible edge against free incumbent memory, and our evidence shows no quality lead.
- **B** competes with IDE-native tools that hold the code live; an upload model is structurally weaker. Codebase intelligence stays as a *supporting* input (founders upload their repo), not the product.
- **D** is the strongest *expansion*. Its pain is sharper and willingness to pay is higher. But it requires per-project World Model scoping and probably email or drive integrations. That would be the next product if C validates the core loop.
- **E** is a commodity.

### What gets demoted (not deleted)

These stay reachable at their current URLs, are no longer promoted, and are
candidates for removal after a data check:

- bundles;
- the AI-tools directory;
- the blog and "write";
- the artifact generator as a headline;
- the "Mind" profile vocabulary. Keep the UI; lead with "project state".

Removal needs a data-retention decision, because existing users may have bundles.

---

## 4. Key assumptions (ranked by risk)

1. **Founders feel the stale-context pain enough to switch tools.** If they don't, nothing else matters. *Test:* problem interviews and a usage diary (pilot plan).
2. **Aqua actually beats "paste a doc into ChatGPT Projects"** on the stale-fact task, especially once history outgrows the context window. *Test:* complete v4 (it includes long personas and the hybrid condition), and track stale rate as the primary quality metric (scorecard §2 and §4). **Currently unproven. On short histories, the evidence points the other way.**
3. **Seeing and correcting what the AI believes is a reason to pay,** not just a nice-to-have. *Test:* Memory-page usage and correction rates (instrumented today).
4. **Founders will pay about $10–20 per month** (or the INR equivalent). *Test:* a paid pilot after activation (pilot plan, week 4).
5. **Free-tier providers can be replaced with paid ones at a margin** at that price. *Test:* set the cost-accounting price table, then measure cost per completed task.

## 5. Unresolved questions

- Does the founder have access to 20–30 target users for interviews? `[UNKNOWN — FOUNDER TO PROVIDE]`
- Is aquiplex.com currently used by anyone, and how much? `[UNKNOWN — run scripts/activation-report.mjs after deploy]`
- India-first (INR, Razorpay) or global (USD) for the first paying cohort? This decides the payment stack. `[FOUNDER DECISION]`
- Does the Android app matter for this segment, or is it a desktop-web job? `[TEST IN PILOT]`
- Should the expansion to D (multiple clients, per-project scoping) be designed now or deferred? Recommendation: defer until C retains users.
