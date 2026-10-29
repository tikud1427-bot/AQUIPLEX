/**
 * Is a document topic a real KNOWLEDGE DOMAIN? (2026-10-28)
 *
 * Production's Understanding → Knowledge showed "Domain:alpha, Domain:frac,
 * Domain:beta, Domain:gamma, Domain:tan, Domain:bar": the enrichment pipeline's
 * topics for a maths PDF were LaTeX command names, and understanding/fileBridge.js
 * turned every one into a `domain:` belief. A topic counts only when it is not
 * markup or a symbol, AND it is either in the domain vocabulary below or was
 * seen in at least two independent sources.
 */

/** LaTeX commands, Greek letters and function names: markup, never a domain. */
const MARKUP = new Set(`
  alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi omicron pi varpi rho
  sigma varsigma tau upsilon phi varphi chi psi omega frac dfrac tfrac sqrt sum prod int iint oint lim limsup liminf
  sin cos tan sec csc cot arcsin arccos arctan sinh cosh tanh log ln exp min max sup inf det dim ker deg arg gcd
  bar hat vec dot ddot tilde overline underline widehat widetilde overrightarrow left right big bigg begin end
  mathrm mathbf mathit mathcal mathbb mathsf mathtt text textbf textit emph cdot cdots ldots vdots ddots times div pm mp
  infty partial nabla leq geq neq approx equiv sim simeq propto subset subseteq supset in notin cup cap forall exists
  quad qquad hline label ref cite item section subsection usepackage documentclass displaystyle operatorname mod pmod
  rightarrow leftarrow implies iff mapsto to prime circ ast star angle triangle
`.trim().split(/\s+/));

/** Fields of knowledge a person can be "familiar with". Slug form (underscores). */
const DOMAINS = new Set(`
  mathematics maths math calculus algebra linear_algebra geometry trigonometry statistics probability number_theory
  differential_equations discrete_mathematics topology physics mechanics thermodynamics electromagnetism quantum_mechanics
  optics chemistry organic_chemistry biochemistry biology genetics neuroscience ecology medicine anatomy pharmacology
  nursing public_health economics microeconomics macroeconomics finance accounting investing banking marketing sales
  advertising branding law contract_law tax management operations supply_chain logistics entrepreneurship startups
  fundraising venture_capital product_management project_management human_resources education pedagogy history
  geography political_science sociology psychology philosophy linguistics literature writing journalism art design
  ui_design ux_design graphic_design architecture civil_engineering mechanical_engineering electrical_engineering
  electronics robotics computer_science software_engineering programming web_development frontend backend mobile_development
  machine_learning deep_learning artificial_intelligence ai data_science data_engineering data_analysis databases
  cloud_computing devops networking cybersecurity security cryptography blockchain distributed_systems operating_systems
  algorithms data_structures computer_vision natural_language_processing nlp game_development agriculture energy climate
  real_estate healthcare insurance retail ecommerce hospitality music film photography sports nutrition
`.trim().split(/\s+/));

const slug = s => String(s ?? '').toLowerCase().trim().replace(/^domain:/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Markup, a symbol, or too short to mean anything: never a domain, whatever the count. */
export function isMarkupTopic(topic) {
  const s = slug(topic);
  if (!s || s.length < 3 || !/[a-z]{3,}/.test(s)) return true;
  return s.split('_').every(part => MARKUP.has(part) || part.length < 2);
}

export function isKnownDomain(topic) {
  return DOMAINS.has(slug(topic));
}

/**
 * May this topic be shown as a domain? `sources` = how many independent
 * sources (files / conversations) it came from.
 */
export function isRealDomain(topic, { sources = 1 } = {}) {
  if (isMarkupTopic(topic)) return false;
  return isKnownDomain(topic) || sources >= 2;
}

/** "domain:machine_learning" → "Machine learning". */
export function domainLabel(topic) {
  const words = slug(topic).replace(/_/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}
