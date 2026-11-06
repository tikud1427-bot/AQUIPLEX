/**
 * Harness self-check only (run-live.mjs --oracle). NOT a model of Gemini.
 *
 * Crude concept vectors for dataset.v1.json: synonyms share a dimension, dim 0 is
 * a constant (so unrelated texts sit around 0.3–0.7 cosine, like real embedding
 * models' anisotropy), other words get a small hashed component. Its purpose is
 * to show the harness CAN detect a successful semantic retrieval, so a live
 * failure means something. Its cosine values and its "best threshold" say nothing
 * about real vectors.
 */
export const GROUPS = [
  ['seed', 'round', 'investors', 'investor', 'angel', 'cap', 'series', 'fundraising', 'money', 'ventures', 'larkspur', 'invested', 'put'],
  ['marathon', 'race', 'finish', 'line', 'training', 'half', 'oakridge', 'crossed', 'complete'],
  ['pilot', 'licence', 'flying', 'planes', 'lessons'],
  ['office', 'leeds', 'bristol', 'moved', 'station'],
  ['design', 'team', 'leads', 'runs', 'charge', 'priya', 'tomas'],
  ['launch', 'release', 'date', 'slipped', 'planned', 'product', 'supplier'],
  ['blood', 'pressure'],
];

export function conceptVec(text, dim) {
  const v = new Array(dim).fill(0);
  v[0] = 1;
  const words = String(text).toLowerCase().match(/[a-z]+/g) ?? [];
  GROUPS.forEach((g, i) => { v[i + 1] = words.filter(w => g.includes(w)).length; });
  for (const w of words) {
    if (GROUPS.some(g => g.includes(w))) continue;
    v[20 + ([...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % (dim - 20), 7))] += 0.15;
  }
  return v;
}
