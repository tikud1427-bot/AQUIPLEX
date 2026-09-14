import { createHuggingFaceCrossEncoder } from '../src/brain/contextEngine/crossEncoder.js';

const adapter = createHuggingFaceCrossEncoder();
const score = await adapter.scorePair(
  'What is Aqua?',
  { statement: 'Aqua is a context-aware personal AI.' },
);
console.log(JSON.stringify({ model: adapter.model, score }));
