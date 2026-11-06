#!/usr/bin/env node
/**
 * Answer rubric v2 (2026-11-05). Deterministic, model-free. A proxy for a judge, stated as such.
 *
 * Supersedes nothing: the v1 rubric (scripts/answer-eval-harness.mjs gradeAnswer) and every
 * result graded with it stay as they are. v2 keeps every v1 criterion of the dataset and adds
 * the criteria in criteria.v2.json. What v2 changes, and why, is in README.md.
 *
 *   node grader.v2.mjs grade --answers <answers.jsonl> --contexts <a.json,b.json> --json <out.json> [--v1 <graded.json>]
 *   node grader.v2.mjs selftest      (dataset examples + v2 examples: good must pass, bad must fail)
 *
 * Reads answers only. Never writes outside --json. Never calls a model.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS_PATH = path.join(HERE, '../../datasets/answer-lifecycle.dev.v1.json');
export const DS = JSON.parse(fs.readFileSync(DS_PATH, 'utf8'));
export const CRIT = JSON.parse(fs.readFileSync(path.join(HERE, 'criteria.v2.json'), 'utf8'));
const low = s => String(s ?? '').toLowerCase();

// ── Markers ─────────────────────────────────────────────────────────────────
// v1 markers, kept.
const PAST = /\b(?:previously|used to|before|formerly|former|was|were|had|no longer|left|moved|changed|until|old|earlier|back then|since)\b/i;
const ABSTAIN = /\b(?:i don'?t know|you haven'?t (?:told|shared|mentioned)|i don'?t have|not sure|no record|haven'?t mentioned|i'?m not aware|you didn'?t (?:tell|mention))\b/i;
// v1 DONE plus explicit "reached" forms.
const DONE = /\b(?:completed?|done|passed|achieved|finished|ran|did it|you did|congrat\w*|already|accomplished|reached|attained|now that you(?:'re| are))\b/i;
const NOT_DONE = /\b(?:not yet|haven'?t|hasn'?t|didn'?t|did not|have not|has not|yet to|still (?:training|preparing|working|studying))\b/i;
const OPEN = /\b(?:still (?:open|active|in progress|pending|ongoing|training|preparing|working|studying)|(?:is|are|remains?) (?:open|active|in progress|pending|ongoing)|open goals?|active goals?|not yet|keep at it|keep working|working towards?|work towards?|on track|in progress)\b/i;
// Uncertainty must be the answer's own, addressed to the user: v1's bare "check" matched "we need to check" and a "**Check**" heading.
const UNCERTAIN = /\b(?:uncertain|unclear|not sure|not certain|unsure|can'?t (?:tell|be sure)|unknown|may|might|possibly|perhaps|whether|if (?:it|that|this)(?:'s| is) still|is that still|are you still|does that still|still yours\?)/i;
const VERIFY = /\b(?:check with|confirm with|double-check|verify|worth (?:checking|confirming)|(?:can|could) you confirm|please confirm|let me know|(?:should|could|might want to|may want to|can) (?:check|confirm|ask))\b/i;
const INFER = /\b(?:likely|probably|presumably|seems?|appears? to|i (?:assume|guess|think)|must (?:be|have))\b/i;
// Turning an uncertain item into fact, either way.
const RESOLVE_NEG = /\b(?:no longer (?:relevant|applicable|on your plate|your (?:responsibility|project|concern|task)|yours|needed|required|a priority|active|current)|not (?:on your plate|your responsibility|yours) (?:anymore|any more)|(?:isn'?t|is not|aren'?t|are not) (?:on your plate|yours|your responsibility|relevant)|(?:has been|was) (?:handed|passed) (?:off|over)|is (?:over|closed|cancell?ed))\b/i;
const RESOLVE_POS = /(?:^yes\b|\b(?:is|are) (?:still )?(?:on your plate|yours|your responsibility)\b|\bstill (?:on your plate|yours|your responsibility)\b|\b(?:is|are) due\b|\bdue (?:on|by)\b|\bdeadline\b|\bshould be (?:a |your )?(?:top )?priority\b|\bprioriti[sz]e\b|\bfocus on (?:completing|finishing|delivering)\b)/i;
// Talk about the question or the method, not a claim about the user ("You're asking if…", "we need to check…").
const META = /\b(?:you(?:'re| are) asking|you asked|your question|to determine|we need to|let'?s (?:break|work|think|look))\b/i;
const SCAFFOLD_WORD = /^(?:understand(?:ing)?|approach|check|final|conclusion|answer|summary|reasoning|analysis|step \d+)$/i;
const DEMONSTRATIVE = /\b(?:this|that|the) (?:project|goal|migration|task|deadline|one)\b/i;

const COMMON_CAPS = new Set(['I', 'You', 'Your', 'Yes', 'No', 'As', 'Before', 'After', 'Both', 'Learning', 'Focus', 'Congratulations', 'Not', 'The', 'It', 'That', 'This', 'If', 'Since', 'Keep', 'Good', 'Great', 'Well', 'Sure', 'Is', 'Are', 'Did', 'Do', 'What', 'When', 'Which', 'Who', 'How', 'There', 'Here', 'They', 'We', 'My', 'Our', 'Hi', 'Okay', 'Ok']);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── Answer structure ────────────────────────────────────────────────────────
/**
 * Split an answer into claim units (sentences), keeping the structure a reader uses:
 * section headings (# / bold-only lines), list headers ("Open goals:"), and labelled list items
 * ("1. **Pass the CFA:**") whose indented children inherit the label.
 */
export function parseUnits(answer) {
  const units = [];
  const headingWords = [];
  let section = '', header = '', sub = '';
  for (const raw of String(answer ?? '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const indent = raw.match(/^\s*/)[0].length;
    let heading = false, list = false, label = '';
    if (/^#{1,6}\s/.test(line)) { heading = true; line = line.replace(/^#{1,6}\s+/, ''); }
    const lm = line.match(/^(?:[-*•]|\d+[.)])\s+/);
    if (lm) { list = true; line = line.slice(lm[0].length); }
    const bm = line.match(/^\*\*([^*]+?)\*\*\s*:?\s*/);
    if (bm) { label = bm[1].replace(/:\s*$/, '').trim(); line = line.slice(bm[0].length); }
    line = line.replace(/\*\*|__|`/g, '').trim();
    if (heading) { line = line.replace(/:$/, ''); }
    const labelOnly = !line && label;
    if (heading || (labelOnly && !list)) { section = heading ? line : label; header = ''; sub = ''; headingWords.push(section); continue; }
    if (label) headingWords.push(label);
    if (list && indent === 0) sub = '';
    if (labelOnly && list) { sub = label; continue; }
    const scaffold = SCAFFOLD_WORD.test(section) || SCAFFOLD_WORD.test(label);
    const context = list ? `${sub} ${header}` : '';
    const sentences = line.split(/(?<=[.!?;])\s+/).filter(Boolean);
    for (const s of sentences) units.push({ text: s, label: SCAFFOLD_WORD.test(label) ? '' : label, sub: list ? sub : '', context, list, section, scaffold });
    if (!list && /:$/.test(line)) header = line.replace(/:$/, '');
    if (list && indent === 0 && /:$/.test(line)) sub = line.replace(/:$/, '');
  }
  return { units, headingWords };
}

/** Status of one claim unit. */
export function statusOf(unit) {
  const s = `${unit.text} ${unit.context ?? ''}`;
  if (META.test(unit.text)) return 'meta';
  if (UNCERTAIN.test(s) || VERIFY.test(s) || /\?\s*$/.test(unit.text)) return 'uncertain';
  if (INFER.test(s)) return 'inferred';
  if (DONE.test(s) && !NOT_DONE.test(s)) return 'done';
  if (PAST.test(s)) return 'historical';
  return 'asserted';
}

/** Units that are about a term: named in the unit, its label or list header, or by "this project/goal" right after a unit that named it. */
function mentions(units, term) {
  const t = low(term);
  const out = [];
  units.forEach((u, i) => {
    const direct = low(`${u.text} ${u.label} ${u.sub}`).includes(t);
    const anaphor = !direct && i > 0 && DEMONSTRATIVE.test(u.text) && out.includes(units[i - 1]);
    if (direct || anaphor) out.push(u);
  });
  return out.filter(u => !META.test(u.text));
}

// ── Names: what the answer introduces that the context does not hold ───────
function knownText(context, question) {
  const extra = [];
  for (const [, y, m, d] of String(context).matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const month = MONTHS[Number(m) - 1];
    if (!month) continue;
    extra.push(month, month.slice(0, 3), DAYS[new Date(Date.UTC(+y, +m - 1, +d)).getUTCDay()]);
  }
  return low(`${context}\n${question}\n${extra.join(' ')}`);
}

function definedAcronyms(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/((?:[A-Za-z]+\s+){1,6})\(([A-Z]{2,})s?\)/g)) {
    const words = m[1].trim().split(/\s+/);
    const letters = m[2];
    const initials = words.slice(-letters.length).map(w => w[0].toUpperCase()).join('');
    if (initials === letters) out.add(letters);
  }
  return out;
}

export function unsupportedV2(answer, context, question) {
  const known = knownText(context, question);
  const { units, headingWords } = parseUnits(answer);
  const acr = definedAcronyms(answer);
  const isKnown = w => COMMON_CAPS.has(w) || known.includes(low(w)) || acr.has(w.replace(/s$/, ''));
  const flagged = [];
  for (const u of units) {
    const toks = [...u.text.matchAll(/\b[A-Z][a-zA-Z]+\b/g)];
    toks.forEach((m, k) => {
      const w = m[0];
      const before = u.text.slice(0, m.index);
      // Sentence-opening word (only punctuation or quotes before it), unless it opens a multi-word name.
      const opening = /^[\s"'“‘(\-–—]*$/.test(before);
      const nextIsCap = toks[k + 1] && /^\s+$/.test(u.text.slice(m.index + w.length, toks[k + 1].index));
      if (opening && !nextIsCap) return;
      if (!isKnown(w)) flagged.push(w);
    });
  }
  const numbers = String(answer).match(/\b\d[\d-]{4,}\b/g) ?? [];
  const headingUnknown = [...new Set(headingWords.flatMap(h => h.match(/\b[A-Z][a-zA-Z]+\b/g) ?? []).filter(w => !isKnown(w)))];
  return { names: [...new Set([...flagged, ...numbers.filter(n => !known.includes(n))])], headingUnknown };
}

// ── Grade ───────────────────────────────────────────────────────────────────
export function criteriaFor(q) { return { ...q, ...(CRIT.add[q.id] ?? {}) }; }

export function gradeAnswerV2(qIn, answer, context = '') {
  const q = criteriaFor(qIn);
  const a = String(answer ?? '');
  const { units } = parseUnits(a);
  const r = { id: q.id, category: q.category, checks: {}, claims: {} };
  const track = (kind, term) => (r.claims[`${kind}:${term}`] = mentions(units, term).map(u => ({ status: statusOf(u), text: u.text })));

  if (q.include) r.checks.include = q.include.every(group => group.some(t => low(a).includes(low(t))));

  // Retired value: every unit about it must mark it past (v1 rule) or hedge it; list headers are inherited.
  if (q.notCurrent) r.checks.notCurrent = q.notCurrent.every(v => {
    track('notCurrent', v);
    return mentions(units, v).every(u => PAST.test(`${u.text} ${u.context}`) || UNCERTAIN.test(u.text) || VERIFY.test(u.text));
  });

  // Achieved goal: at least one unit marks it done; none presents it as open. A bare list item naming it is neutral.
  if (q.notOpen) r.checks.notOpen = q.notOpen.every(v => {
    track('notOpen', v);
    const ms = mentions(units, v);
    const done = u => DONE.test(`${u.text} ${u.context}`) && !NOT_DONE.test(`${u.text} ${u.context}`);
    return ms.some(done) && !ms.some(u => OPEN.test(`${u.text} ${u.context}`) && !done(u));
  });

  // Goal whose target the user has reached: may be mentioned only as done, past, or uncertain.
  if (q.reachedGoal) r.checks.reachedGoal = q.reachedGoal.every(v => {
    track('reachedGoal', v);
    return mentions(units, v).every(u => {
      const s = `${u.text} ${u.context}`;
      return ((DONE.test(s) && !NOT_DONE.test(s)) || PAST.test(s) || UNCERTAIN.test(s) || VERIFY.test(s)) && !OPEN.test(u.text);
    });
  });

  // Explicitly uncertain item: no unit may resolve it (still yours / no longer yours / due on…) unless that unit hedges.
  if (q.uncertain) r.checks.uncertaintyKept = q.uncertain.every(v => {
    track('uncertain', v);
    return mentions(units, v).every(u => {
      const s = `${u.text} ${u.context}`;
      const hedged = UNCERTAIN.test(s) || VERIFY.test(s) || /\?\s*$/.test(u.text);
      const neg = RESOLVE_NEG.test(s);
      const pos = RESOLVE_POS.test(s) && !PAST.test(s);
      return hedged || !(neg || pos);
    });
  });

  // Hedge: the answer itself expresses uncertainty or asks the user to verify. Headings and method talk do not count.
  if (q.hedge) r.checks.hedge = units.some(u => !META.test(u.text) && (UNCERTAIN.test(u.text) || VERIFY.test(u.text) || /\?\s*$/.test(u.text)));

  if (q.abstain) r.checks.abstain = ABSTAIN.test(a);

  const { names, headingUnknown } = unsupportedV2(a, context || DS.lives[q.life].join(' '), q.ask);
  r.checks.supported = names.length === 0;
  r.unsupported = names;
  r.headingWordsNotInContext = headingUnknown; // reported, not scored: headings are generic labels
  r.scaffold = units.some(u => u.scaffold) || /let'?s (?:break|work) (?:this|through)/i.test(a); // reported, not scored
  r.pass = Object.values(r.checks).every(Boolean);
  return r;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : d; };
const say = (...x) => process.stdout.write(`${x.join(' ')}\n`);
const failed = r => Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);

export function selftestCases() {
  const cases = DS.questions.flatMap(q => [{ q, kind: 'good', text: q.examples.good, want: true }, { q, kind: 'bad', text: q.examples.bad, want: false }]);
  for (const [id, ex] of Object.entries(CRIT.examples)) {
    const q = DS.questions.find(x => x.id === id);
    for (const [kind, text] of Object.entries(ex)) cases.push({ q, kind: `v2:${kind}`, text, want: kind.startsWith('good') });
  }
  return cases;
}

function selftest() {
  let ok = 0;
  const cases = selftestCases();
  for (const c of cases) {
    const g = gradeAnswerV2(c.q, c.text);
    const right = g.pass === c.want;
    if (right) ok++;
    say(`   ${right ? 'ok ' : 'BAD'} ${c.q.id} ${c.kind.padEnd(26)} ${g.pass ? 'pass' : `fail(${failed(g)}${g.unsupported.length ? ` ${g.unsupported}` : ''})`}`);
  }
  say(`   ${ok}/${cases.length} examples graded as intended`);
  process.exitCode = ok === cases.length ? 0 : 1;
}

function grade() {
  const ctx = Object.fromEntries(flag('contexts').split(',').map(f => JSON.parse(fs.readFileSync(f, 'utf8'))).map(c => [c.label, c.contexts]));
  const answers = fs.readFileSync(flag('answers'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const results = answers.map(x => ({ ...gradeAnswerV2(DS.questions.find(q => q.id === x.id), x.answer, ctx[x.condition]?.[x.id] ?? ''), condition: x.condition }));
  const v1 = flag('v1') ? JSON.parse(fs.readFileSync(flag('v1'), 'utf8')) : null;
  const conds = [...new Set(results.map(r => r.condition))];
  say('== rubric v2: per question');
  for (const q of DS.questions) say(`   ${q.id} ${q.category.padEnd(21)} ${conds.map(c => { const r = results.find(x => x.condition === c && x.id === q.id); const o = v1?.find(x => x.condition === c && x.id === q.id); return `${c}: ${r.pass ? 'pass' : `FAIL(${failed(r)})`}${o ? ` [v1 ${o.pass ? 'pass' : 'fail'}]` : ''}`; }).join('   ')}`);
  for (const c of conds) { const rs = results.filter(r => r.condition === c); say(`   ${c}: ${rs.filter(r => r.pass).length}/${rs.length} pass; unsupported names ${rs.reduce((n, r) => n + r.unsupported.length, 0)}; scaffolded answers ${rs.filter(r => r.scaffold).length}`); }
  if (conds.length === 2) {
    const [a, b] = conds;
    const pairs = DS.questions.map(q => [results.find(r => r.condition === a && r.id === q.id), results.find(r => r.condition === b && r.id === q.id)]);
    say(`   paired: ${b} better on ${pairs.filter(([x, y]) => !x.pass && y.pass).map(([x]) => x.id).join(',') || 'none'}; worse on ${pairs.filter(([x, y]) => x.pass && !y.pass).map(([x]) => x.id).join(',') || 'none'}; same on ${pairs.filter(([x, y]) => x.pass === y.pass).length}`);
  }
  const out = flag('json');
  if (out) fs.writeFileSync(out, JSON.stringify({ rubric: CRIT.version, provenance: CRIT.provenance, results }, null, 2));
}

const MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (MAIN) {
  if (argv[0] === 'selftest') selftest();
  else if (argv[0] === 'grade') grade();
  else { say('usage: grader.v2.mjs selftest | grade --answers f --contexts a,b --json out [--v1 graded.json]'); process.exitCode = 2; }
}
