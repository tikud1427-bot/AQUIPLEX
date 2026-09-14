import { scorePairs, crossEncoderInfo } from '../src/brain/contextEngine/crossEncoderLocal.js';

const started = performance.now();
const candidates = [
  { id: 'relevant', statement: 'Aqua is a personal thinking system that understands your digital world.' },
  { id: 'irrelevant', statement: 'The weather forecast says rain is expected tomorrow.' },
];

console.log('E7 PR-8 local cross-encoder smoke');
console.log(JSON.stringify(crossEncoderInfo(), null, 2));
console.log('Loading model (first run may download/cache it)...');

try {
  const scores = await scorePairs('What is Aqua?', candidates);
  if (!Array.isArray(scores) || scores.length !== candidates.length || scores.some(v => !Number.isFinite(v))) {
    throw new Error('invalid score vector');
  }
  console.log('scores', scores.map((score, i) => ({ id: candidates[i].id, score })));
  console.log(`elapsed_ms ${Math.round(performance.now() - started)}`);
  console.log('SMOKE PASS');
} finally {
  // Transformers.js/ONNX may own native resources; give Node a clean tick before exit.
  await new Promise(resolve => setImmediate(resolve));
}
