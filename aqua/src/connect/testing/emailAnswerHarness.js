/**
 * TEST-ONLY harness (Gmail Phase 4): the retrieval → answer interface with an
 * INJECTED FAKE model. Never imported by production code (the boundary test in
 * gmailConnector.test.js forbids testing/ imports). No real model ever receives
 * Gmail content: the harness proves the real provider path is refused in the
 * very request that holds the evidence.
 *
 *   chat request (scope `user`)
 *     → retrieveEmailEvidence (taints the request with external:gmail)
 *     → formatEmailEvidenceForPrompt (refuses outside such a request)
 *     → assertEgress(real providers)  → EGRESS_BLOCKED   (recorded)
 *     → model(…)  = the injected in-process fake
 *     → answer validation: every sentence cites [E#]; every citation exists;
 *       citations of superseded evidence are reported.
 */
import { runWithDataClass, assertEgress } from '../../core/egressGuard.js';
import { retrieveEmailEvidence, formatEmailEvidenceForPrompt } from '../gmail/emailContext.js';

export async function answerWithEmailEvidence({ principal, question, model, now = Date.now(), providers = ['groq', 'gemini', 'nvidia', 'openrouter'] } = {}) {
  if (typeof model !== 'function') throw new TypeError('an injected fake model is required');
  return runWithDataClass('user', async () => {
    const bundle = retrieveEmailEvidence({ principal, question, now });
    const prompt = formatEmailEvidenceForPrompt(bundle);
    const providerRefusals = {};
    for (const p of providers) {
      try { assertEgress(p, 'generate'); providerRefusals[p] = false; }
      catch (e) { providerRefusals[p] = e?.code === 'EGRESS_BLOCKED'; }
    }
    const answer = String(await model({ system: prompt, question, evidence: bundle.evidence }) ?? '');
    const refs = new Map(bundle.evidence.map(e => [e.ref, e]));
    const cited = [...new Set([...answer.matchAll(/\[(E\d+)\]/g)].map(m => m[1]))];
    const sentences = answer.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
    const result = {
      answer, prompt, bundle, cited,
      unknownCitations: cited.filter(r => !refs.has(r)),
      uncitedSentences: sentences.filter(s => !/\[E\d+\]/.test(s)),
      citesSuperseded: cited.filter(r => refs.get(r)?.status === 'superseded'),
      providerRefusals,
    };
    result.valid = cited.length > 0 && result.unknownCitations.length === 0 && result.uncitedSentences.length === 0;
    return result;
  });
}
