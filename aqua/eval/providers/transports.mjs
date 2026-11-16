/**
 * Transports for the evaluation provider manager (2026-11-11).
 *
 *   mockTransport(script)  tests: scripted responses, never leaves the process
 *   liveTransport()        REAL network — refuses to exist unless
 *                          AQUA_EVAL_LIVE_APPROVED=yes (explicit, per run).
 *                          NOT exercised during implementation: the request
 *                          formats below follow the providers' public REST
 *                          documentation and are UNVERIFIED against live APIs.
 *
 * A transport receives { provider, model, credential, messages, settings } and
 * returns { status, headers, json, bodyText, text?, usage? }. The credential's
 * value is read only to build the auth header, which is never logged.
 */
import { revealForRequest } from './credentials.mjs';

export class LiveTransportRefused extends Error { constructor() { super('live transport refused: set AQUA_EVAL_LIVE_APPROVED=yes for an approved run'); this.name = 'LiveTransportRefused'; } }

/** script: array of responses, or a function (call) => response. Records calls WITHOUT credential values. */
export function mockTransport(script) {
  const calls = [];
  const t = async ({ provider, model, credential, messages, settings }) => {
    const call = { provider, model, envName: credential.envName, n: calls.length, messages, settings };
    calls.push(call);
    const r = typeof script === 'function' ? await script(call) : script[Math.min(calls.length - 1, script.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  t.calls = calls;
  return t;
}

export function liveTransport({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env.AQUA_EVAL_LIVE_APPROVED !== 'yes') throw new LiveTransportRefused();
  return async ({ provider, model, credential, messages, settings }) => {
    let url, init;
    if (provider === 'groq') {
      url = 'https://api.groq.com/openai/v1/chat/completions';
      // OpenAI-compatible body. Only known generation settings are sent (no arbitrary keys).
      const body = { model, messages };
      for (const k of ['temperature', 'max_tokens', 'top_p', 'seed', 'reasoning_effort']) if (settings[k] !== undefined) body[k] = settings[k];
      init = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${revealForRequest(credential)}` }, body: JSON.stringify(body) };
    } else if (provider === 'gemini') {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const generationConfig = {};
      if (settings.temperature !== undefined) generationConfig.temperature = settings.temperature;
      if (settings.max_tokens !== undefined) generationConfig.maxOutputTokens = settings.max_tokens;
      if (settings.top_p !== undefined) generationConfig.topP = settings.top_p;
      // Thinking models spend output tokens on reasoning; a budget (0 = off where the model allows it) is explicit config.
      if (settings.thinking_budget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: settings.thinking_budget };
      init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': revealForRequest(credential) },
        body: JSON.stringify({ contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), generationConfig }) };
    } else throw new Error(`unsupported provider ${provider}`);
    const r = await fetchImpl(url, init);
    const bodyText = await r.text();
    let json = null; try { json = JSON.parse(bodyText); } catch { /* error bodies */ }
    const headers = Object.fromEntries([...r.headers.entries()].filter(([k]) => /retry-after|ratelimit/i.test(k)));
    const text = provider === 'groq' ? json?.choices?.[0]?.message?.content : json?.candidates?.[0]?.content?.parts?.map(p => p.text).join('');
    const u = provider === 'groq' ? json?.usage : json?.usageMetadata && { prompt_tokens: json.usageMetadata.promptTokenCount, completion_tokens: json.usageMetadata.candidatesTokenCount };
    const finishReason = provider === 'groq' ? json?.choices?.[0]?.finish_reason ?? null : json?.candidates?.[0]?.finishReason ?? null;
    return { status: r.status, headers, json: r.ok ? null : json, bodyText: r.ok ? '' : bodyText.slice(0, 2000), text, usage: u ?? null, finishReason };
  };
}
