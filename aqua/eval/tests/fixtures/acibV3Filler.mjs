/**
 * TEST FIXTURE ONLY — a synthetic filler library that satisfies the D-3 mechanical rules (≥ 300
 * distinct messages, ≥ 8 topics, varied lengths, metadata). It is not evaluation material and was
 * not authored by any appointed person; real ACIB v3 filler is written by the independent authors.
 */
const TOPICS = ['weather', 'cooking', 'football', 'gardening', 'films', 'travel', 'music', 'cars', 'pets', 'books', 'board games', 'hiking'];
const SHAPES = [
  (p, i, t) => `${p} note ${i} on ${t}.`,
  (p, i, t) => `${p} note ${i} on ${t}: I tried something new this week and it went better than I expected, honestly.`,
  (p, i, t) => `${p} note ${i} on ${t}, a long ramble: ${'we talked about it for ages and nothing was decided, which is completely fine by me. '.repeat(3)}`,
  (p, i, t) => `Quick one about ${t} (${p}${i}).`,
  (p, i, t) => `${p} note ${i} on ${t}; my neighbour had opinions about it too, as usual, and so did her cousin.`,
];
export function makeFiller(prefix, n = 320) {
  return Array.from({ length: n }, (_, i) => SHAPES[i % SHAPES.length](prefix, i, TOPICS[i % TOPICS.length]));
}
export function fillerMetadata(filler, authors) {
  const lens = filler.map(t => t.length);
  return {
    composition: 'FIXTURE: synthetic everyday chatter across unrelated topics, five message shapes of different lengths',
    authors, topics: TOPICS, messageCount: filler.length, lengthRange: [Math.min(...lens), Math.max(...lens)],
    includesSemanticallySimilarDistractors: true, answerNeutralityReviewedBy: authors[0],
  };
}
/** Dataset-level filler fields for a fixture set. */
export function fillerFields(prefix, authors) {
  const filler = makeFiller(prefix);
  return { filler, fillerTargetChars: 9000, veryLongFillerTargetChars: 60000, fillerMetadata: fillerMetadata(filler, authors) };
}
