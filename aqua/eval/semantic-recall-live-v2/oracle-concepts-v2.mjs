/**
 * Harness self-check only (run-live-v2.mjs --oracle). NOT a model of Gemini and
 * NOT used for grading the live run. Crude concept vectors for dataset.v2.json:
 * synonyms share a dimension, dim 0 is a small constant (unrelated texts low),
 * other words get a small hashed component. Shows the harness can register a
 * successful semantic retrieval; its numbers say nothing about real vectors.
 */
export const GROUPS = [
  ['burn', 'spending', 'money', 'monthly', 'month', 'going', 'through', 'rate'],
  ['head', 'hire', 'lead', 'theo', 'offer', 'accepted', 'someone'],
  ['app', 'mobile', 'inkwell', 'phone', 'shelved', 'development', 'building'],
  ['move', 'rotterdam', 'utrecht', 'relocating', 'staying', 'idea'],
  ['invoice', 'qb', 'overdue', 'provider', 'status'],
  ['customer', 'client', 'halvorsen', 'contract', 'renewed', 'enterprise', 'biggest'],
  ['tax', 'rules', 'printed', 'books'],
  ['teach', 'chemistry', 'physics', 'classes', 'subjects', 'larchmont', 'responsible'],
  ['10k', 'race', 'training', 'finished', 'minutes', 'riverside'],
  ['textbook', 'book', 'writing', 'project', 'write'],
  ['promoted', 'department', 'science', 'september'],
  ['half', 'marathon', 'signed'],
  ['bakery', 'runs', 'sister', 'ashford'],
  ['greyhound', 'dog', 'pepper', 'named', 'called', 'rescue', 'adopted'],
  ['sail', 'sailing', 'dinghy', 'certificate', 'learn'],
  ['volunteer', 'food', 'bank', 'help', 'weekends', 'saturdays'],
];

export function conceptVec(text, dim) {
  const v = new Array(dim).fill(0);
  v[0] = 0.3;   // small constant: unrelated texts stay well below the floor
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  GROUPS.forEach((g, i) => { v[i + 1] = words.filter(w => g.includes(w)).length; });
  for (const w of words) {
    if (GROUPS.some(g => g.includes(w))) continue;
    v[30 + ([...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % (dim - 30), 7))] += 0.15;
  }
  return v;
}
