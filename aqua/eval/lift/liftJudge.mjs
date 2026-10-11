/**
 * The Lift JUDGE transport — measurement instrumentation, not a product path.
 *
 * The judge must be free to differ from the answerer (a different model
 * family), so it does not go through the product's model registry (which
 * refuses models the product does not itself use). Keys are read from the
 * environment and rotated; no key is ever logged.
 *
 *   gemini  Google GenAI SDK, GEMINI_KEY_<n> / GEMINI_API_KEY
 *   nvidia  OpenAI-compatible integrate.api.nvidia.com, NVIDIA_API_KEY_<n>
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));

const keysMatching = re => Object.keys(process.env).filter(k => re.test(k)).sort().map(k => process.env[k]).filter(Boolean);

export function makeJudge({ provider = 'gemini', model, maxTokens = 2000 } = {}) {
  if (provider === 'gemini') {
    const keys = keysMatching(/^(GEMINI_KEY_\d+|GEMINI_API_KEY)$/);
    let i = 0, GenAI = null;
    return async (system, user) => {
      if (!keys.length) throw new Error('no Gemini key for the judge');
      GenAI ??= (await import('@google/genai')).GoogleGenAI;
      const ai = new GenAI({ apiKey: keys[i++ % keys.length] });
      const r = await ai.models.generateContent({ model, contents: user, config: { systemInstruction: system, temperature: 0, maxOutputTokens: maxTokens } });
      return { text: r.text ?? '', model };
    };
  }
  if (provider === 'nvidia') {
    const keys = keysMatching(/^NVIDIA_API_KEY(_\d+)?$/);
    const OpenAI = require('openai').default ?? require('openai');
    const clients = keys.map(apiKey => new OpenAI({ apiKey, baseURL: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1', timeout: 120_000, maxRetries: 0 }));
    let i = 0;
    return async (system, user) => {
      if (!clients.length) throw new Error('no NVIDIA key for the judge');
      const c = clients[i++ % clients.length];
      const r = await c.chat.completions.create({
        model, temperature: 0, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      return { text: r.choices?.[0]?.message?.content ?? '', model: r.model ?? model };
    };
  }
  throw new Error(`unknown judge provider ${provider}`);
}
