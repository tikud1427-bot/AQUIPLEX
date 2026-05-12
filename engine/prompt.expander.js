"use strict";

/**
 * engine/prompt.expander.js — AQUIPLEX PROMPT EXPANSION ENGINE
 *
 * Transforms weak user prompts into rich, structured specs before generation.
 * "build a game" → full product spec with UX goals, design direction, features, quality standards.
 *
 * Uses fast model (Groq/Gemini) for expansion — cheap, quick, big payoff.
 */

const { createLogger } = require("../utils/logger");
const log = createLogger("PROMPT_EXPANDER");

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT TYPE DETECTION (fast, local)
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_PATTERNS = {
  game:       /\b(game|arcade|puzzle|platformer|shooter|rpg|chess|snake|tetris|pong|flappy|clicker|quiz game)\b/i,
  dashboard:  /\b(dashboard|analytics|admin panel|metrics|kpi|data visualization|stats page|reporting)\b/i,
  saas:       /\b(saas|landing page|startup|product page|pricing|waitlist|marketing site)\b/i,
  tool:       /\b(tool|calculator|converter|generator|formatter|validator|checker|encoder|decoder|timer|clock|stopwatch)\b/i,
  portfolio:  /\b(portfolio|personal site|resume|cv|hire me|freelancer|designer portfolio)\b/i,
  ecommerce:  /\b(store|shop|ecommerce|product listing|cart|marketplace|buy|sell)\b/i,
  blog:       /\b(blog|article|magazine|news|editorial|posts|journal)\b/i,
  form:       /\b(form|survey|questionnaire|registration|signup|contact form|multi-step)\b/i,
  app:        /\b(app|application|web app|pwa|todo|notes|task manager|kanban|crm|chat)\b/i,
};

function detectProjectType(prompt) {
  const lower = (prompt || "").toLowerCase();
  for (const [type, re] of Object.entries(TYPE_PATTERNS)) {
    if (re.test(lower)) return type;
  }
  return "static";
}

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN DIRECTION SELECTOR (local — no API needed)
// ─────────────────────────────────────────────────────────────────────────────

const DESIGN_DIRECTIONS = {
  game: [
    "Cyberpunk/Neon: dark background (#0a0a0f), electric cyan/magenta glows, HUD overlays, scanline effects",
    "Retro-Arcade: pixel art aesthetic, bright primary colors, 8-bit inspired UI, CRT screen effect",
    "Dark Sci-Fi: deep space theme, holographic UI elements, blue/purple palette, star particle bg",
  ],
  dashboard: [
    "Glassmorphism Pro: frosted glass cards, deep navy bg (#0f1629), purple/teal accents, blur effects",
    "Luxury Dark: near-black (#0d0d0d), gold accents (#d4af37), crisp typography, minimal borders",
    "Cyberpunk Data: dark teal bg, neon green data viz, monospace fonts, grid lines",
  ],
  saas: [
    "Modern SaaS: dark hero, gradient mesh bg, white/gray body, bold indigo/violet CTAs",
    "Luxury Minimal: almost-white (#fafafa), charcoal text, single gold or emerald accent, tons of space",
    "Bold Editorial: massive sans-serif type, stark black/white, single vivid accent (hot pink/electric blue)",
  ],
  tool: [
    "Glassmorphism+: frosted glass panel, dark radial gradient bg, cyan accent, floating orbs",
    "Monochrome Pro: near-black, white typography, single accent, ultra-clean micro-interactions",
    "Warm Minimal: warm off-white (#fdf8f0), deep brown text, amber/terracotta accent",
  ],
  portfolio: [
    "Dark Creative: near-black (#0c0c0c), animated gradient text, purple/gold palette, particle bg",
    "Editorial Luxury: serif display fonts, cream background, black + single vivid accent, asymmetric grid",
    "Vibrant Modern: white bg, bold color blocks, sans-serif, hover color animations",
  ],
  ecommerce: [
    "Luxury Retail: dark charcoal, gold accents, large product imagery, premium feel",
    "Modern Clean: white/light gray, bold black type, single accent color, generous whitespace",
    "Vibrant Bold: bright accent (#ff3366 or similar), white bg, energetic product cards",
  ],
  app: [
    "Glassmorphism Pro: frosted panels, deep purple/navy bg, soft neon accents",
    "Dark Mode First: #111 base, carefully balanced gray scale, blue/violet action colors",
    "Warm Productivity: #fefefe bg, warm grays, amber/green accent, focused reading layout",
  ],
  static: [
    "Dark Atmospheric: deep charcoal, animated gradient mesh bg, electric violet/teal accents",
    "Luxury Editorial: off-white, serif + sans pairing, gold accent, editorial grid",
    "Bold Brutalist: white bg, thick borders, massive display type, black + 1 vivid accent",
  ],
};

function pickDesignDirection(projectType, seed) {
  const pool = DESIGN_DIRECTIONS[projectType] || DESIGN_DIRECTIONS.static;
  // Use seed (from prompt length or time) for variety
  const idx = Math.abs((seed || 0)) % pool.length;
  return pool[idx];
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE TEMPLATES (local — no API needed)
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE_TEMPLATES = {
  game: [
    "State machine: MENU → PLAYING → PAUSED → GAME_OVER → WIN",
    "requestAnimationFrame game loop with delta-time physics",
    "Score system with localStorage highscore persistence",
    "Progressive difficulty curve (speed/density increases with score)",
    "Particle effects on collisions/pickups",
    "Web Audio API sound effects (no files — oscillators only)",
    "Touch/mobile controls overlay",
    "Pause menu with overlay",
    "Animated start screen with instructions",
  ],
  dashboard: [
    "Collapsible sidebar (250px → 64px icon rail)",
    "Real-time KPI cards with count-up animations",
    "Chart.js charts (line, bar, doughnut) with custom palettes",
    "Sortable/filterable data table with pagination",
    "Dark/light mode toggle (CSS vars swap)",
    "Date range picker affecting all charts",
    "Notification bell with badge count",
    "Skeleton loading states → data reveal",
    "Responsive grid (auto-fit minmax)",
  ],
  saas: [
    "Sticky nav: transparent → frosted glass on scroll",
    "100vh hero with animated gradient background",
    "Logo marquee (infinite CSS scroll animation)",
    "6-card feature grid with hover 3D tilt",
    "Animated count-up stats on IntersectionObserver",
    "3-tier pricing table with highlighted popular tier",
    "Smooth accordion FAQ",
    "Testimonial carousel",
    "Full-width CTA strip",
    "Multi-column footer",
  ],
  tool: [
    "Zero-friction: usable immediately on load, sample data pre-filled",
    "Real-time output as user types (debounce 150ms)",
    "Copy-to-clipboard on all outputs ('Copied!' flash)",
    "History panel: last 10 operations with restore",
    "Keyboard shortcuts (Enter=run, Escape=clear, Ctrl+Z=undo)",
    "Download output as file (Blob API)",
    "URL hash state sharing",
    "Error states with inline validation and hints",
    "Empty states with illustrated guide text",
  ],
  portfolio: [
    "Name in massive display type with animated entrance",
    "Typewriter role cycling effect (3+ roles)",
    "Animated particle/orb background",
    "Project grid: magazine-style varying card sizes",
    "Project cards with tech stack badge overlay on hover",
    "Filter tabs: All / Frontend / Backend / Design",
    "Skills grid (NOT boring progress bars — use hex/ring/cloud)",
    "Contact form with floating labels + confetti on submit",
    "Dark/light mode toggle",
    "Custom cursor glow or trail",
  ],
  app: [
    "LocalStorage persistence for all state",
    "Real-time UI updates (no page refresh)",
    "Keyboard-first navigation (Tab, Enter, Escape)",
    "Empty states with illustrated prompts",
    "Undo/redo system",
    "Search/filter with instant results",
    "Notification/toast system",
    "Responsive mobile layout",
  ],
  static: [
    "100vh hero with animated background and staggered headline entrance",
    "Sticky nav with scroll-state transformation",
    "5+ distinct sections with unique visual treatments",
    "IntersectionObserver scroll animations on all sections",
    "Rich multi-column footer with newsletter input",
    "Mobile-first responsive at all breakpoints",
  ],
};

function getFeatureTemplate(projectType) {
  return FEATURE_TEMPLATES[projectType] || FEATURE_TEMPLATES.static;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUALITY STANDARDS (local)
// ─────────────────────────────────────────────────────────────────────────────

const QUALITY_STANDARDS = `
QUALITY MANDATE:
• Google Fonts via @import — NEVER system-ui/Arial/Roboto/Inter as primary
• CSS custom properties in :root for all colors, spacing, radii
• Animated background: gradient orbs, mesh, particles — NEVER plain solid
• Page-load staggered animations (50-150ms delay steps per element)
• IntersectionObserver scroll reveals on all sections
• Hover: transform + box-shadow glow (200-300ms ease) on ALL interactive elements
• Cards: 16-24px border-radius, rgba border, multi-layer shadow
• Buttons: gradient or solid accent, hover glow, active scale(0.96)
• Mobile-first responsive (320px → 2560px), fluid type with clamp()
• Styled scrollbars (::-webkit-scrollbar), ::selection with accent
• 100% functional — zero placeholder logic, zero empty handlers
• localStorage for all persistence
• Zero build step — works directly in browser`;

// ─────────────────────────────────────────────────────────────────────────────
// AI-POWERED EXPANSION (uses fast model when available)
// ─────────────────────────────────────────────────────────────────────────────

async function _tryAIExpansion(prompt, projectType, callAI) {
  if (!callAI || typeof callAI !== "function") return null;

  const expansionPrompt = `You are a senior product designer and UX architect. A user wants to build: "${prompt}"

Expand this into a rich product specification. Be SPECIFIC and CONCRETE. Return ONLY valid JSON (no markdown fences):

{
  "refined_name": "...",
  "tagline": "...",
  "target_user": "...",
  "core_features": ["feature 1", "feature 2", "feature 3", "feature 4", "feature 5"],
  "ux_goals": ["goal 1", "goal 2", "goal 3"],
  "unique_twist": "What makes this version special and memorable (1 sentence)",
  "content_suggestions": ["specific content item 1", "specific content item 2", "specific content item 3"]
}

Be creative. Make the product genuinely useful and impressive. Features should be concrete, not generic.`;

  try {
    const raw = await callAI([
      { role: "system", content: "You are a product designer. Return only valid JSON, no markdown, no explanation." },
      { role: "user", content: expansionPrompt },
    ], { temperature: 0.7, maxTokens: 600 });

    if (!raw) return null;
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const start = cleaned.indexOf("{");
    const end   = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    log.warn(`AI expansion failed: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * expandPrompt(prompt, opts) → ExpandedPrompt
 *
 * @param {string} prompt - raw user prompt
 * @param {{ callAI?: Function, seed?: number }} opts
 * @returns {Promise<{
 *   originalPrompt: string,
 *   expandedPrompt: string,
 *   projectType: string,
 *   designDirection: string,
 *   features: string[],
 *   aiSpec: object|null,
 * }>}
 */
async function expandPrompt(prompt, opts = {}) {
  const { callAI, seed } = opts;
  const projectType    = detectProjectType(prompt);
  const designDir      = pickDesignDirection(projectType, seed ?? prompt.length);
  const features       = getFeatureTemplate(projectType);

  // Try AI expansion for richer spec
  let aiSpec = null;
  if (callAI) {
    aiSpec = await _tryAIExpansion(prompt, projectType, callAI);
  }

  // Build expanded prompt
  const parts = [];

  parts.push(`BUILD REQUEST: ${prompt}`);

  if (aiSpec) {
    if (aiSpec.refined_name) parts.push(`PROJECT NAME: ${aiSpec.refined_name}`);
    if (aiSpec.tagline)      parts.push(`TAGLINE: ${aiSpec.tagline}`);
    if (aiSpec.target_user)  parts.push(`TARGET USER: ${aiSpec.target_user}`);
    if (aiSpec.unique_twist) parts.push(`UNIQUE TWIST: ${aiSpec.unique_twist}`);
    if (aiSpec.core_features?.length) {
      parts.push(`CORE FEATURES:\n${aiSpec.core_features.map(f => `  • ${f}`).join("\n")}`);
    }
    if (aiSpec.ux_goals?.length) {
      parts.push(`UX GOALS:\n${aiSpec.ux_goals.map(g => `  • ${g}`).join("\n")}`);
    }
    if (aiSpec.content_suggestions?.length) {
      parts.push(`CONTENT TO INCLUDE:\n${aiSpec.content_suggestions.map(c => `  • ${c}`).join("\n")}`);
    }
  } else {
    // Fallback: use template features
    parts.push(`REQUIRED FEATURES:\n${features.map(f => `  • ${f}`).join("\n")}`);
  }

  parts.push(`DESIGN DIRECTION: ${designDir}`);
  parts.push(QUALITY_STANDARDS);

  const expandedPrompt = parts.join("\n\n");

  log.info(`expandPrompt: type=${projectType} aiSpec=${!!aiSpec} expandedLen=${expandedPrompt.length}`);

  return {
    originalPrompt: prompt,
    expandedPrompt,
    projectType,
    designDirection: designDir,
    features,
    aiSpec,
  };
}

module.exports = {
  expandPrompt,
  detectProjectType,
  pickDesignDirection,
  getFeatureTemplate,
};
