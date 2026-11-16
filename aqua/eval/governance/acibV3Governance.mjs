/**
 * ACIB v3 governance checks (Sprint 6, 2026-11-11).
 * Plan: AQUA_HYBRID_CONTEXT_BENCHMARK_PLAN.md. Process: AQUA_ACIB_V3_FREEZE_AND_GOVERNANCE.md.
 *
 * Machine-checkable half of the governance. The human half — who wrote the
 * scenarios, who reviewed them — is DECLARED in a manifest and checked for
 * consistency here; it cannot be verified by code and is never assumed.
 *
 *   validateManifest(manifest)            independence + sign-off + declared counts
 *   validateDataset(ds, { role })         schema, counts, category balance, reachable annotations, paraphrase claims
 *   assertOutsideRepo(file, repoRoot)     the held-out eval set must not live in the repository
 *   freezeRecord({ manifest, evalText, devText })   the record written at freeze time
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { tokens } from '../../src/understanding/stateTransition.js';

export const PLAN = Object.freeze({
  version: 'acib-3',
  // Founder decision D-P2-3 (2026-11-12): language-mismatch and indirect-reference added as
  // categories (12 eval / 4 dev each — proposed counts, confirmed with the success criteria).
  evalCount: 174,
  devCount: 62,
  categories: Object.freeze({
    'personal': [16, 6], 'semantic-mismatch': [24, 8], 'spread': [16, 6], 'cross-project': [10, 4], 'cross-person': [10, 4],
    'changing': [16, 6], 'contradiction': [10, 4], 'missing': [16, 6], 'tempting': [12, 4], 'negative': [12, 4], 'uncommon-decision': [8, 2],
    'language-mismatch': [12, 4], 'indirect-reference': [12, 4],
  }),
  // 'unanswerable' added 2026-11-12 (additive): the history cannot answer the question and no single
  // clarifying question would; the right answer says so without inventing a value.
  answerability: Object.freeze(['answerable', 'answerable-with-caveat', 'needs-clarification', 'unanswerable', 'impersonal']),
  // D-3 (2026-11-12): a larger, varied, answer-neutral filler library, authored by the set's own authors.
  filler: Object.freeze({ minDistinctMessages: 300, minTopics: 8, minLengthRatio: 4, veryLongTargetChars: 60000 }),
});

/** Canonical declarations (AQUA_ACIB_V3_DECLARATIONS.md). The manifest must carry them verbatim. */
export const AUTHOR_DECLARATION = 'I wrote the scenarios attributed to me. I have not read the assistant\'s source code, design documents, test results or earlier benchmark sets, and I have not discussed these evaluation scenarios with its engineering team. I have not included real personal data. Any filler conversations I wrote were written without knowledge of, or intent to favour, any particular system configuration, and do not change the correct answer to any question.';
export const REVIEWER_DECLARATION = 'I checked scenario counts and category balance, spot-checked at least 20 evaluation scenarios for a single defensible answer and reachable annotations, and hold the evaluation file outside the code repository. I am not an author of the assistant\'s engine or its hybrid context feature, and I have not shared evaluation scenarios with its engineering team.';

export const sha256 = text => crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');
const norm = s => String(s ?? '').trim().toLowerCase();

/** Independence and sign-off, as declared. Returns { ok, errors[] }. */
export function validateManifest(m) {
  const errors = [];
  if (m?.version !== PLAN.version) errors.push(`version must be "${PLAN.version}"`);
  const authors = (m?.evalAuthors ?? []).map(a => norm(a.name)).filter(Boolean);
  const impl = (m?.implementationAuthors ?? []).map(norm).filter(Boolean);
  if (authors.length < 2) errors.push('at least two eval-set authors are required');
  if (!impl.length) errors.push('implementationAuthors must be declared (who builds the engine/hybrid)');
  const overlap = authors.filter(a => impl.includes(a));
  if (overlap.length) errors.push(`eval-set authors must not be implementation authors: ${overlap.join(', ')}`);
  const r = m?.reviewer;
  if (!r?.name || !r?.signedAt || !r?.statement) errors.push('reviewer sign-off required: reviewer.name, reviewer.signedAt, reviewer.statement');
  else {
    if (impl.includes(norm(r.name))) errors.push('the reviewer must not be an implementation author');
    if (Number.isNaN(Date.parse(r.signedAt))) errors.push('reviewer.signedAt must be a date');
  }
  if (!m?.evalPath) errors.push('evalPath required (a path OUTSIDE the repository)');
  if (!m?.devPath) errors.push('devPath required');
  if (m?.successCriteriaConfirmedBy == null) errors.push('successCriteriaConfirmedBy required (the founder confirms the criteria before the freeze)');
  // Declarations (verbatim) — the human half, declared and recorded; it cannot be verified by code.
  for (const a of m?.evalAuthors ?? []) {
    if (a?.declaration !== AUTHOR_DECLARATION) errors.push(`evalAuthors[${a?.name ?? '?'}]: the author declaration must be recorded verbatim`);
    if (!a?.declaredAt || Number.isNaN(Date.parse(a.declaredAt))) errors.push(`evalAuthors[${a?.name ?? '?'}]: declaredAt must be a date`);
  }
  if (r?.statement && r.statement !== REVIEWER_DECLARATION) errors.push('reviewer.statement must be the reviewer declaration, verbatim');
  // Development authors: different people from the evaluation authors (no shared scenarios, names or domains).
  const dev = (m?.devAuthors ?? []).map(a => norm(a?.name ?? a)).filter(Boolean);
  if (!dev.length) errors.push('devAuthors required (who wrote the development set)');
  const devOverlap = dev.filter(d => authors.includes(d));
  if (devOverlap.length) errors.push(`development authors must not be evaluation authors: ${devOverlap.join(', ')}`);
  if (r?.name && dev.includes(norm(r.name))) errors.push('the reviewer must not be a development author (development authors work with the engineering team)');
  // C-5 (2026-11-12): independence cannot be impersonated. The founder and everyone exposed to prior
  // evaluation results, engine/hybrid internals or ACIB v1/v2 (priorResultsExposed) — as well as every
  // implementation author — are barred from being an evaluation author or the reviewer. Template
  // placeholders and generic labels are refused, and no declaration may be dated in the future.
  const founder = norm(m?.founder?.name);
  if (!founder) errors.push('founder.name required (the founder can never be an evaluation author or the reviewer)');
  const exposed = new Set([...(m?.priorResultsExposed ?? []).map(norm), ...impl, ...(founder ? [founder] : [])].filter(Boolean));
  if (!Array.isArray(m?.priorResultsExposed)) errors.push('priorResultsExposed[] required: everyone who has seen prior evaluation results, engine or hybrid internals, or ACIB v1/v2 (may be empty only if truly no one has)');
  const barred = authors.filter(a => exposed.has(a));
  if (barred.length) errors.push(`evaluation authors must be independent: ${barred.join(', ')} is the founder, an implementation author or exposed to prior evaluation results`);
  if (r?.name && exposed.has(norm(r.name))) errors.push('the reviewer must be independent: not the founder, an implementation author or anyone exposed to prior evaluation results');
  const PLACEHOLDER = /^<.*>$|^(?:tbd|tba|todo|n\/?a|none|unknown|anonymous|placeholder|test|someone|author|reviewer|founder)\s*\d*$|independent (?:author|reviewer)/i;
  for (const n of [...(m?.evalAuthors ?? []).map(a => a?.name), r?.name, ...(m?.devAuthors ?? []).map(a => a?.name ?? a)]) if (n != null && PLACEHOLDER.test(String(n).trim())) errors.push(`"${n}" is a placeholder, not an appointed person`);
  const future = d => d && !Number.isNaN(Date.parse(d)) && Date.parse(d) > Date.now() + 24 * 3600 * 1000;
  for (const a of m?.evalAuthors ?? []) if (future(a?.declaredAt)) errors.push(`evalAuthors[${a.name}]: declaredAt is in the future`);
  if (future(r?.signedAt)) errors.push('reviewer.signedAt is in the future');
  // Pre-registration: the analysis specification is frozen WITH the data.
  if (!/^[0-9a-f]{64}$/.test(String(m?.analysisSpecSha256 ?? ''))) errors.push('analysisSpecSha256 required: sha256 of the pre-registered analysis specification (AQUA_ACIB_V3_ANALYSIS_SPEC.md)');
  return { ok: !errors.length, errors };
}

/** Schema and balance checks for a built dataset (same scenario schema as ACIB v1/v2, plus v3 fields). */
export function validateDataset(ds, { role }) {
  const errors = [];
  const want = role === 'eval' ? PLAN.evalCount : PLAN.devCount;
  const S = ds?.scenarios ?? [];
  if (S.length !== want) errors.push(`${role}: ${S.length} scenarios, plan says ${want}`);
  // D-3: the filler library for the long and very-long regimes. Mechanical checks only — the authors
  // and the reviewer attest the rest (realism, no favouring of any configuration).
  const F = PLAN.filler;
  const filler = Array.isArray(ds?.filler) ? ds.filler.map(String) : null;
  if (!filler) errors.push(`${role}: filler[] required (the set's own filler library, ≥ ${F.minDistinctMessages} distinct messages)`);
  else {
    const keys = filler.map(t => t.trim().toLowerCase());
    if (new Set(keys).size !== filler.length) errors.push(`${role}: filler[] contains duplicate messages (each message must be distinct)`);
    if (filler.length < F.minDistinctMessages) errors.push(`${role}: filler[] has ${filler.length} messages, at least ${F.minDistinctMessages} distinct messages are required (very-long histories must not cycle a small list)`);
    const lens = filler.map(t => t.length);
    if (lens.length && Math.max(...lens) < F.minLengthRatio * Math.min(...lens)) errors.push(`${role}: filler message lengths are too uniform (the longest must be ≥ ${F.minLengthRatio}× the shortest)`);
    // Answer neutrality (mechanical): no filler message may contain an answer-bearing pattern of ANY
    // scenario (required facts, their evidence, current/stale values, contradicting values).
    const answerBearing = S.flatMap(s => [
      ...(s.needs ?? []).filter(n => n.required).flatMap(n => [...(n.match ?? []), ...(n.evidence ?? [])]),
      ...(s.temporal ? [...(s.temporal.current ?? []), ...(s.temporal.stale ?? [])] : []),
      ...(s.contradiction ? [...(s.contradiction.a ?? []), ...(s.contradiction.b ?? [])] : []),
    ]).map(p => new RegExp(p, 'i'));
    const changing = filler.filter(t => answerBearing.some(r => r.test(t)));
    if (changing.length) errors.push(`${role}: ${changing.length} filler message(s) contain answer-bearing patterns and could change a correct answer (first: "${changing[0].slice(0, 60)}")`);
  }
  if (!Number.isInteger(ds?.fillerTargetChars)) errors.push(`${role}: fillerTargetChars required (long regime)`);
  if (!Number.isInteger(ds?.veryLongFillerTargetChars) || ds.veryLongFillerTargetChars < F.veryLongTargetChars) errors.push(`${role}: veryLongFillerTargetChars ≥ ${F.veryLongTargetChars} required (very-long stress regime)`);
  const md = ds?.fillerMetadata;
  if (!md) errors.push(`${role}: fillerMetadata required { composition, authors[], topics[], messageCount, lengthRange, includesSemanticallySimilarDistractors, answerNeutralityReviewedBy }`);
  else {
    if (!md.composition) errors.push(`${role}: fillerMetadata.composition required (what the library contains)`);
    if (!Array.isArray(md.authors) || !md.authors.length) errors.push(`${role}: fillerMetadata.authors required (the set's own authors control its filler)`);
    if (!Array.isArray(md.topics) || md.topics.length < F.minTopics) errors.push(`${role}: fillerMetadata.topics must list ≥ ${F.minTopics} unrelated topics`);
    if (filler && md.messageCount !== filler.length) errors.push(`${role}: fillerMetadata.messageCount (${md.messageCount}) ≠ filler[] length (${filler.length})`);
    if (filler?.length && JSON.stringify(md.lengthRange) !== JSON.stringify([Math.min(...filler.map(t => t.length)), Math.max(...filler.map(t => t.length))])) errors.push(`${role}: fillerMetadata.lengthRange must equal [shortest, longest] message length`);
    if (md.includesSemanticallySimilarDistractors !== true) errors.push(`${role}: fillerMetadata.includesSemanticallySimilarDistractors must be true (some similar-but-irrelevant material is required)`);
    if (!md.answerNeutralityReviewedBy) errors.push(`${role}: fillerMetadata.answerNeutralityReviewedBy required (who checked that no filler changes a correct answer)`);
  }
  const ids = new Set();
  const byCat = {};
  for (const s of S) {
    if (ids.has(s.id)) errors.push(`duplicate id ${s.id}`); ids.add(s.id);
    byCat[s.category] = (byCat[s.category] ?? 0) + 1;
    if (!PLAN.answerability.includes(s.answerability)) errors.push(`${s.id}: answerability must be one of ${PLAN.answerability.join(', ')}`);
    if (!Array.isArray(s.authors) || !s.authors.length) errors.push(`${s.id}: authors missing`);
    const texts = [...(s.history ?? []).map(h => h.text), ...(s.uploads ?? []).map(u => u.content)];
    for (const n of s.needs ?? []) {
      const ev = (n.evidence ?? []).map(e => new RegExp(e, 'i'));
      if (!texts.some(t => ev.some(r => r.test(t)))) errors.push(`${s.id}/${n.id}: evidence pattern matches no source text`);
      // Language mismatch: the correct answer may TRANSLATE the fact, so its match patterns need not
      // occur in the (other-language) history; the evidence pattern must.
      if (s.category !== 'language-mismatch' && !texts.some(t => (n.match ?? []).some(m => new RegExp(m, 'i').test(t)))) errors.push(`${s.id}/${n.id}: match patterns match no source text`);
      if (n.paraphrase) {
        // A paraphrase need's evidence must share NO content token with the question.
        const evText = texts.find(t => ev.some(r => r.test(t))) ?? '';
        const q = new Set(tokens(s.question));
        const shared = tokens(evText).filter(t => q.has(t) && t.length > 2);
        if (shared.length) errors.push(`${s.id}/${n.id}: marked paraphrase but shares "${shared.join(', ')}" with the question`);
      }
    }
    // v3 category- and answerability-specific annotations (graded by eval/answer/answerGraderV3.mjs).
    const needIds = new Set((s.needs ?? []).map(n => n.id));
    if (s.category === 'language-mismatch') {
      const L = s.languages ?? {};
      if (!L.question || !L.evidence || L.question === L.evidence) errors.push(`${s.id}: language-mismatch needs languages { question, evidence } with two different language codes`);
    }
    if (s.category === 'indirect-reference') {
      const ind = Array.isArray(s.indirect) ? s.indirect : [];
      if (!ind.length) errors.push(`${s.id}: indirect-reference needs indirect[{ phrase, resolves }]`);
      for (const r of ind) {
        if (!r?.phrase || !texts.concat(s.question).some(t => new RegExp(r.phrase, 'i').test(t))) errors.push(`${s.id}: indirect phrase "${r?.phrase}" occurs in neither the question nor the history`);
        if (!needIds.has(r?.resolves)) errors.push(`${s.id}: indirect.resolves "${r?.resolves}" is not a need id`);
      }
    }
    if (s.answerability === 'needs-clarification' && !(s.unknowns ?? []).length && !(s.expectedQuestionMatch ?? []).length) errors.push(`${s.id}: needs-clarification requires unknowns[] or expectedQuestionMatch[] (what the clarifying question should target)`);
    if (s.answerability === 'unanswerable' && !(s.unknowns ?? []).length) errors.push(`${s.id}: unanswerable requires unknowns[] (the facts the history does not contain, so a guess can be detected)`);
    if (s.answerability === 'impersonal' && (s.needs ?? []).some(n => n.required)) errors.push(`${s.id}: an impersonal scenario must have no required personal needs`);
    for (const t of s.tempting ?? []) if (!(t?.match ?? []).length) errors.push(`${s.id}: tempting item ${t?.id ?? '?'} needs match patterns`);
  }
  for (const [cat, [e, d]] of Object.entries(PLAN.categories)) {
    const n = byCat[cat] ?? 0, w = role === 'eval' ? e : d;
    if (n !== w) errors.push(`${role}: category ${cat} has ${n}, plan says ${w}`);
  }
  for (const cat of Object.keys(byCat)) if (!PLAN.categories[cat]) errors.push(`${role}: unknown category ${cat}`);
  return { ok: !errors.length, errors, byCategory: byCat };
}

/** The held-out set lives outside the repository, so implementation authors working in it never have it. */
export function assertOutsideRepo(file, repoRoot) {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(file));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`the evaluation set must not be stored inside the repository (${file})`);
}

export function freezeRecord({ manifest, evalText, devText, scorerText, analysisSpecText = null }) {
  return {
    version: PLAN.version,
    frozenAt: new Date().toISOString(),
    eval: { sha256: sha256(evalText), count: JSON.parse(evalText).scenarios.length, location: 'outside the repository (path withheld)' },
    dev: { sha256: sha256(devText), count: JSON.parse(devText).scenarios.length },
    scorer: scorerText ? { sha256: sha256(scorerText) } : null,
    analysisSpec: { sha256: manifest.analysisSpecSha256 ?? null, verified: analysisSpecText != null && sha256(analysisSpecText) === manifest.analysisSpecSha256 },
    devAuthors: (manifest.devAuthors ?? []).map(a => ({ name: a?.name ?? a })),
    evalAuthors: manifest.evalAuthors.map(a => ({ name: a.name, role: a.role ?? null, declaredAt: a.declaredAt ?? null })),
    implementationAuthors: manifest.implementationAuthors,
    founder: manifest.founder?.name ?? null,
    priorResultsExposed: manifest.priorResultsExposed ?? [],
    reviewer: { name: manifest.reviewer.name, signedAt: manifest.reviewer.signedAt, statement: manifest.reviewer.statement },
    successCriteriaConfirmedBy: manifest.successCriteriaConfirmedBy,
    rules: ['one run per implementation', 'aggregates only until the run is complete', 'no edits; a change is a new version'],
  };
}
