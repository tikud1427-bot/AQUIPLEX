/**
 * First-person self-disclosure — the grammar test, and nothing else.
 *
 * WHY ITS OWN MODULE
 * ------------------
 * Two callers need the identical rule: `conversationEntities` decides whether
 * to emit the speaker as an entity for the turn, and `conversationFacts`
 * decides, sentence by sentence, whether a given sentence is about them. Two
 * copies of a regex like this drift apart inside a sprint.
 *
 * It lives here rather than in conversationEntities because conversationFacts
 * is a PURE builder, pinned by a structural test that it cannot reach a store.
 * conversationEntities imports the entity extractor and the self-entity
 * constants, and selfEntity imports idStore — so importing it would have put
 * persistence back inside the pure builder's dependency graph. That test
 * caught exactly this, which is the reason to keep such tests.
 *
 * This file therefore has ZERO imports, and must keep having zero.
 *
 * WHAT COUNTS AS DISCLOSURE
 * -------------------------
 * A statement the speaker makes ABOUT THEMSELVES. Not an opinion, not a hedge,
 * not a request, not a question. "I'm building the understanding engine" is
 * disclosure; "I think that's right", "I don't know" and "I want you to
 * rewrite this" are not, and treating them as facts fills the world model with
 * the texture of conversation instead of its content.
 *
 * FIRST-PERSON SINGULAR ONLY
 * --------------------------
 * `we` and `our` are deliberately excluded. A group claim is not an individual
 * one: "we're building X" says the team builds X and leaves the speaker's own
 * role unstated. Attributing it to the owner anyway is exactly the quiet
 * inference that puts a wrong line on a summary card.
 */

const SELF_DECLARATION = new RegExp(
  String.raw`\b(?:` +
    String.raw`i(?:'m| am|'ve| have| was| had)\b` +
    // An optional adverb between the pronoun and the verb. Without it,
    // "I usually do deep work in the mornings" — a plain statement of how
    // someone works — matched nothing, because the pattern required `i` and
    // the verb to be adjacent. Bounded to ONE adverb-shaped word so this stays
    // a gap-closer and not a licence to match any `i <anything> <verb>`.
    String.raw`|i (?:\w+ly |just |also |still |often |already )?(?:work|working|build|building|lead|leading|run|running|manage|managing|own|owned|founded|start(?:ed)?|join(?:ed)?|stud(?:y|ied)|live|lived|use|used|prefer|like|love|need|want|focus|care|ship|shipped|write|writing|wrote|code|coding|design|teach|learn|do|did|spend|spent|handle|report|split|block(?:ed)?)\w*\b` +
    String.raw`|my\b` +
  String.raw`)`,
  'i',
);

const NOT_SELF_DECLARATION = new RegExp(
  String.raw`\b(?:` +
    String.raw`i (?:think|thought|guess|wonder|wondered|mean|meant|see|saw|understand|understood|agree|disagree|assume|suppose|believe|feel|hope|wish|doubt|bet|reckon|notice|noticed)\b` +
    String.raw`|i (?:don'?t|do not|didn'?t|can'?t|cannot|won'?t|couldn'?t) (?:know|understand|see|get)\b` +
    String.raw`|i'?m not sure\b` +
    String.raw`|(?:want|need|'?d like|would like) you to\b` +
  String.raw`)`,
  'i',
);

/**
 * Is this ONE sentence a first-person statement about the speaker?
 * Questions are excluded — "what should I work on next?" discloses nothing.
 */
export function isSelfDeclaration(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (s.endsWith('?')) return false;
  if (NOT_SELF_DECLARATION.test(s)) return false;
  return SELF_DECLARATION.test(s);
}

/**
 * Does any sentence in this text disclose something? Sentence-scoped so one
 * hedge cannot suppress a genuine disclosure sitting beside it.
 */
export function hasSelfDeclaration(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .some(isSelfDeclaration);
}

/* ──────────────────────────────────────────────────────────────────────────
   THE SPEAKER'S WORLD — a SECOND, WIDER predicate. Read this before using it.
   ──────────────────────────────────────────────────────────────────────────
   `isSelfDeclaration` above is about the INDIVIDUAL and excludes `we`/`our`
   on purpose, because a group claim attributed to one person is the quiet
   inference that puts a wrong line on a summary card. That reasoning is
   correct and unchanged — nothing above this line moved.

   But it was being applied to a second question it does not answer. Measured
   on a seven-turn session that was all situation and almost no proper nouns,
   only 2 of 7 sentences produced anything:

       ✗ "our biggest problem right now is churn in the first 30 days"
       ✗ "we decided to ship the new pricing tiers on Friday"
       ✗ "we're hiring two engineers this quarter"

   Those are the sentences carrying what is actually going on in someone's
   work, and the world model was throwing all of them away.

   WHY THE PLURAL IS SAFE HERE AND NOT THERE
   -----------------------------------------
   The card's exclusion protects a BELIEF — a claim of the form "Maya is X",
   minted by the Mind and rendered as a line the user reads as AQUA's opinion
   of them. A world-model FACT is a different object: it stores the sentence
   verbatim with provenance and asserts nothing beyond "this was said". The
   retrieved line reads

       • our biggest problem is churn in the first 30 days [Conversation c1 · ¶1]

   — the "our" is right there in the text, so nothing is being attributed to
   the individual that the individual did not say. Facts never reach the
   belief writer, so this cannot put a line on the card.

   The never-fuse invariant is untouched: it is about NAMES reaching the self
   node, and `we`/`our` are deixis, not names. The negative test still holds.

   USE `isSelfDeclaration` for anything that mints a claim ABOUT THE PERSON.
   USE THIS for deciding whether a sentence belongs to their world at all.
   ────────────────────────────────────────────────────────────────────────── */

/** First-person plural — the speaker's team, company or project. */
const SPEAKERS_WORLD = new RegExp(
  String.raw`\b(?:` +
    String.raw`we(?:'re| are|'ve| have| were| had|'ll| will)\b` +
    String.raw`|we (?:\w+ly |just |also |still |often |already )?(?:work|build|lead|run|manage|own|founded|start(?:ed)?|ship(?:ped)?|launch(?:ed)?|decide(?:d)?|hire|hiring|hired|use|used|need|want|plan(?:ned)?|move(?:d)?|switch(?:ed)?|pick(?:ed)?|chose|choose)\w*\b` +
    String.raw`|our\b` +
  String.raw`)`,
  'i',
);

/** Plural counterparts of the singular hedges — an opinion is still not a fact. */
const NOT_SPEAKERS_WORLD = new RegExp(
  String.raw`\b(?:` +
    String.raw`we (?:think|thought|guess|wonder|wondered|assume|suppose|believe|feel|hope|wish|doubt|reckon)\b` +
    String.raw`|we (?:don'?t|do not|didn'?t|can'?t|cannot|won'?t|couldn'?t) (?:know|understand|see|get)\b` +
    String.raw`|we'?re not sure\b` +
  String.raw`)`,
  'i',
);

/**
 * Is this ONE sentence about the speaker's world — themselves OR their group?
 * Same exclusions as `isSelfDeclaration`: questions, hedges and requests are
 * the texture of a conversation, not its content.
 */
export function isAboutSpeakersWorld(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (s.endsWith('?')) return false;
  if (isSelfDeclaration(s)) return true;
  if (NOT_SELF_DECLARATION.test(s) || NOT_SPEAKERS_WORLD.test(s)) return false;
  return SPEAKERS_WORLD.test(s);
}

/** Sentence-scoped, so one hedge cannot suppress a real statement beside it. */
export function hasSpeakersWorld(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .some(isAboutSpeakersWorld);
}
