"use strict";

/**
 * workspace.service.js — AQUIPLEX V4.1 SELF-HEALING AI ENGINE
 *
 * V4.1 UPGRADES:
 * - Model priority reordered: groq → gemini → openrouter (free-first)
 * - LLM_MAX_TOKENS reduced: 2500 → 900 (cost-efficient)
 * - Dynamic token fn per model (groq/gemini: 1200, deepseek: 800)
 * - HTTP 402 handling: _skipModel=true, no retry, immediate model switch
 * - Gemini request body fixed: separate system + user parts, no string concat
 * - Retry logic: no retry on _skipModel, _dead, 402, or deprecation
 * - All V4 features preserved: health tracking, cooldown, fallback, parser
 *
 * FIX BATCH 2:
 * - readProjectFiles: guard against null/undefined index.files before .includes()
 * - readSingleFile: removed unsafe `|| filePath !== dir` escape hatch in path check
 * - writeSingleFile: same path check fix
 * - getProjectList: require userId match (no more leaking projects with missing userId)
 * - saveProjectFiles: normalise dir with trailing sep for reliable startsWith check
 */

const fs        = require("fs").promises;
const fsSync    = require("fs");
const path      = require("path");
const mongoose  = require("mongoose");
const Workspace = require("../models/Workspace");
const Bundle    = require("../models/Bundle");

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SESSIONS       = 10;
const MAX_RECENT_OUTPUTS = 20;
const MAX_INSIGHTS       = 4;
const PROJECTS_DIR       = path.join(__dirname, "../data/projects");

const LLM_TIMEOUT_MS      = 35_000;
const LLM_MAX_RETRIES     = 2;
const LLM_RETRY_BASE_MS   = 800;
const LLM_MAX_TOKENS      = 8000;  // V5: full code gen needs space
const MODEL_FAIL_LIMIT    = 2;
const MODEL_COOL_TTL_MS   = 60_000;
const MODEL_DEAD_TTL_MS   = 10 * 60 * 1000;  // 10 min, not 24h
const OUTPUT_MIN_LENGTH   = 100;
const FILE_DELIMITER_REGEX = /={3}\s*FILE:\s*(.+?)\s*={3}/;

const ALLOWED_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs",
  ".ts", ".json", ".svg", ".md", ".txt",
  ".png", ".jpg", ".jpeg", ".gif", ".ico",
  ".woff", ".woff2", ".ttf",
]);

const DEPRECATION_SIGNALS = [
  "decommissioned",
  "no longer supported",
  "not supported",
  "model not found",
  "model_not_found",
];

// Ensure projects dir exists on startup
(async () => {
  try { await fs.mkdir(PROJECTS_DIR, { recursive: true }); } catch {}
})();

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic token limits — cost-optimized per provider
// ─────────────────────────────────────────────────────────────────────────────

function getDynamicTokens(modelId) {
  if (!modelId || typeof modelId !== "string") return 4000;
  if (modelId.includes("anthropic"))   return 8000;
  if (modelId.includes("gemini"))      return 8000;
  if (modelId.includes("llama-3.3") || modelId.includes("llama-3.1-70b")) return 8000;
  if (modelId.includes("qwen"))        return 6000;
  if (modelId.includes("deepseek"))    return 6000;
  if (modelId.includes("groq"))        return 5000;
  if (modelId.includes("openrouter"))  return 4000;
  return 4000;
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED MODEL REGISTRY — priority: groq → gemini → openrouter
// ─────────────────────────────────────────────────────────────────────────────

function buildModelRegistry() {
  const models = [];

  // ── TIER 0: Anthropic Claude — optional, if key present ─────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    models.push({
      id: "anthropic:claude-haiku-4-5",
      isAnthropic: true,
      anthropicModel: "claude-haiku-4-5-20251001",
    });
    models.push({
      id: "anthropic:claude-sonnet-4-5",
      isAnthropic: true,
      anthropicModel: "claude-sonnet-4-5-20251001",
    });
  }

  // ── TIER 1: Groq — primary free inference, fast ──────────────────────────
  if (process.env.GROQ_API_KEY) {
    const h = {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type":  "application/json",
    };
    const groqBase = "https://api.groq.com/openai/v1/chat/completions";

    // PRIMARY: qwen3-32b — best balance (fast + excellent code + free)
    models.push({ id: "groq:qwen/qwen3-32b",             url: groqBase, headers: h, modelName: "qwen/qwen3-32b",             tpmLimit: 12000 });
    // STRONG: llama-3.3-70b — heavy code / long generation
    models.push({ id: "groq:llama-3.3-70b-versatile",    url: groqBase, headers: h, modelName: "llama-3.3-70b-versatile",    tpmLimit: 12000 });
    // ALTERNATE 70b
    models.push({ id: "groq:llama-3.1-70b-versatile",    url: groqBase, headers: h, modelName: "llama-3.1-70b-versatile",    tpmLimit: 12000 });
    // Deepseek r1 distill — strong coder
    models.push({ id: "groq:deepseek-r1-distill-llama-70b", url: groqBase, headers: h, modelName: "deepseek-r1-distill-llama-70b", tpmLimit: 6000 });
    // qwen-qwq-32b — reasoning
    models.push({ id: "groq:qwen-qwq-32b",               url: groqBase, headers: h, modelName: "qwen-qwq-32b",               tpmLimit: 6000 });
    // TINY: 8b instant — for small/fast ops only
    models.push({ id: "groq:llama-3.1-8b-instant",       url: groqBase, headers: h, modelName: "llama-3.1-8b-instant",       tpmLimit: 6000, smallModel: true });
  }

  // ── TIER 2: OpenRouter free — reasoning + fallback ───────────────────────
  if (process.env.OPENROUTER_API_KEY) {
    const h = {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type":  "application/json",
      "HTTP-Referer":  process.env.OPENROUTER_REFERER || "https://aquiplex.com",
      "X-Title":       "Aquiplex",
    };
    const orBase = "https://openrouter.ai/api/v1/chat/completions";
    // Reasoning: 235b Qwen — only for complex tasks
    models.push({ id: "openrouter:qwen3-235b-free",       url: orBase, headers: h, modelName: "qwen/qwen3-235b-a22b:free" });
    // Fallback pool
    models.push({ id: "openrouter:deepseek-v3-free",      url: orBase, headers: h, modelName: "deepseek/deepseek-chat-v3-0324:free" });
    models.push({ id: "openrouter:gemma-3-27b-free",      url: orBase, headers: h, modelName: "google/gemma-3-27b-it:free" });
    models.push({ id: "openrouter:llama-3.3-70b-free",   url: orBase, headers: h, modelName: "meta-llama/llama-3.3-70b-instruct:free" });
  }

  // ── TIER 3: Gemini free — last resort ────────────────────────────────────
  const geminiKey = process.env.Gemini_API_Key || process.env.GEMINI_API_KEY;
  if (geminiKey) {
    models.push({ id: "gemini:gemini-2.5-flash",          isGemini: true, apiKey: geminiKey, geminiModel: "gemini-2.5-flash" });
    models.push({ id: "gemini:gemini-2.0-flash",          isGemini: true, apiKey: geminiKey, geminiModel: "gemini-2.0-flash" });
    models.push({ id: "gemini:gemini-2.0-flash-lite",     isGemini: true, apiKey: geminiKey, geminiModel: "gemini-2.0-flash-lite" });
    models.push({ id: "gemini:gemini-1.5-flash-002",      isGemini: true, apiKey: geminiKey, geminiModel: "gemini-1.5-flash-002" });
  }

  return models;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODEL HEALTH SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

const _modelHealth = new Map();

function _getModelHealth(modelId) {
  if (!_modelHealth.has(modelId)) {
    _modelHealth.set(modelId, { failures: 0, disabledUntil: 0 });
  }
  return _modelHealth.get(modelId);
}

function _isModelHealthy(modelId) {
  return _getModelHealth(modelId).disabledUntil <= Date.now();
}

function _markModelDead(modelId, reason) {
  const h = _getModelHealth(modelId);
  h.failures      = 99;
  h.disabledUntil = Date.now() + MODEL_DEAD_TTL_MS;
  console.error(`[AI ENGINE] ☠ Model DEAD (24h): ${modelId} | ${reason}`);
}

function _recordModelFailure(modelId) {
  const h = _getModelHealth(modelId);
  h.failures += 1;
  if (h.failures >= MODEL_FAIL_LIMIT) {
    h.disabledUntil = Date.now() + MODEL_COOL_TTL_MS * h.failures;
    console.error(`[AI ERROR] Model in cooldown: ${modelId} | failures: ${h.failures}`);
  }
}

function _recordModelSuccess(modelId) {
  const h = _getModelHealth(modelId);
  h.failures      = 0;
  h.disabledUntil = 0;
  console.log(`[AI ENGINE] ✅ Model healthy: ${modelId}`);
}

function _isDeprecationError(text) {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase();
  return DEPRECATION_SIGNALS.some(sig => lower.includes(sig));
}

// ─────────────────────────────────────────────────────────────────────────────
// APP-TYPE DETECTION
// ─────────────────────────────────────────────────────────────────────────────

const APP_TYPE_KEYWORDS = {
  game: [
    "game","snake","tetris","breakout","chess","puzzle","platformer","shooter",
    "rpg","quiz game","trivia","arcade","pong","flappy","dungeon","maze","slots",
    "card game","board game","memory game","2d game","3d game","canvas game",
  ],
  dashboard: [
    "dashboard","admin panel","analytics","metrics","stats","statistics",
    "control panel","management","monitor","overview panel","data panel","kpi",
    "reporting","charts dashboard","business intelligence",
  ],
  tool: [
    "calculator","converter","editor","formatter","generator","validator",
    "timer","clock","stopwatch","password generator","color picker","regex tester",
    "markdown editor","json formatter","base64","encoder","decoder","diff tool",
    "unit converter","currency converter","bmi","loan calculator","budget tool",
  ],
  saas: [
    "saas","landing page","startup","product page","marketing","sales page",
    "waitlist","coming soon","app landing","hero section","pricing page",
    "feature page","sign up page","testimonials",
  ],
  portfolio: [
    "portfolio","personal site","about me","resume","cv","my work","showcase",
    "developer portfolio","designer portfolio","freelancer","hire me",
  ],
  blog: [
    "blog","article","post","news","newsletter","magazine","editorial","writing","journal",
  ],
  ecommerce: [
    "shop","store","ecommerce","e-commerce","product listing","cart","checkout",
    "marketplace","buy","sell","inventory","catalogue",
  ],
  form: [
    "contact form","survey","quiz","questionnaire","feedback form",
    "application form","booking form","registration form","sign up form",
  ],
};

function detectAppType(prompt) {
  if (!prompt) return "static";
  const lower = prompt.toLowerCase();
  for (const [type, keywords] of Object.entries(APP_TYPE_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return type;
    }
  }
  return "static";
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERACTIVE PROMPT DETECTION
// ─────────────────────────────────────────────────────────────────────────────

function isInteractivePrompt(prompt) {
  if (!prompt) return false;
  const keywords = [
    "timer", "calculator", "game", "todo", "clock", "quiz", "tracker", "pomodoro",
  ];
  const lower = prompt.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN SYSTEM — ULTRA-PREMIUM GENERATION ENGINE v2
// Replaces the old weak prompt with world-class, award-winning output.
// ─────────────────────────────────────────────────────────────────────────────

const DESIGN_FOUNDATIONS = `
══════════════════════════════════════════════════════════════
AQUIPLEX ULTRA ENGINE — WORLD-CLASS GENERATION MANDATE
══════════════════════════════════════════════════════════════

You are an elite creative technologist — the intersection of a senior engineer,
an Awwwards-winning designer, and a game developer who ships legendary products.
Every output you produce must be EXTRAORDINARY. Not good. Not polished. EXTRAORDINARY.

━━━ DESIGN PHILOSOPHY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PICK A BOLD AESTHETIC DIRECTION and execute it with surgical precision:
  • Brutalist/Raw: stark layouts, thick borders, massive type, raw texture
  • Cyberpunk/Neon: dark background, electric glows, HUD-style overlays
  • Glassmorphism+: frosted glass panels, multi-layer depth, ambient blur
  • Art Deco/Geometric: golden ratios, symmetry, ornamental precision
  • Organic/Fluid: blob shapes, flowing gradients, soft shadows
  • Editorial/Magazine: asymmetric grids, expressive typography, drama
  • Luxury/Refined: micro-details, restrained palette, premium materials feel
  • Retro-Futuristic: 80s sci-fi, scan-lines, CRT glow, vector aesthetics
  • Minimalist Zen: extreme white space, single accent, perfect proportions
  • Memphis/Maximalist: bold shapes, clashing colors, pattern overload

Never produce a generic, boring, middle-of-the-road aesthetic. Commit fully.

━━━ TYPOGRAPHY (NON-NEGOTIABLE) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NEVER use: Inter, Roboto, Arial, system-ui, sans-serif as primary.
ALWAYS load from Google Fonts via @import. Pick characterful pairings:

  Display: Playfair Display, Bebas Neue, Syne, DM Serif Display,
    Cormorant, Anton, Righteous, Fraunces, Big Shoulders Display,
    Instrument Serif, Libre Baskerville, Clash Display

  Body: DM Sans, Plus Jakarta Sans, Nunito, Raleway,
    Outfit, Work Sans, Figtree, Manrope, Source Sans 3

  Monospace: JetBrains Mono, Fira Code, IBM Plex Mono, Space Mono

Scale dramatically — use clamp() for fluid type. GIANT headings (vw-based or
clamp 5rem+) create instant visual impact. Vary weights boldly.

━━━ COLOR SYSTEMS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Define a real color system using CSS custom properties:
  :root {
    --bg-primary, --bg-secondary, --bg-tertiary  (3 depth layers)
    --accent-1, --accent-2                       (2 bold accents that pop)
    --text-primary, --text-secondary, --text-muted
    --surface, --surface-hover, --border
    --glow-color                                 (for box-shadows and glows)
  }

DOMINANT + ACCENT strategy: one dark/light foundation, 2 sharp accents.
Avoid rainbow palettes. Avoid timid pastels unless intentionally soft.
Gradient meshes, noise overlays, grain textures = atmosphere and depth.

━━━ MOTION & ANIMATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Animate EVERYTHING meaningful with CSS or JS:
  • Page load: staggered reveal (animation-delay per element, 50-150ms steps)
  • Scroll: IntersectionObserver for fade-in, slide-up, scale-in
  • Hover: transform + box-shadow transitions (200-300ms ease)
  • Micro-interactions: button press scale(0.96), ripple effects
  • Background: floating orbs, animated gradients, particle systems
  • Text: typewriter effect, split-text reveals, gradient text animation

NEVER produce flat static UIs with zero animation. Motion = life.

━━━ SPATIAL COMPOSITION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  • Asymmetric layouts that break grid monotony
  • Overlapping elements (z-index layering)
  • Generous negative space OR controlled density — commit to one
  • Diagonal sections (clip-path: polygon)
  • Full-bleed hero sections (100vh minimum)
  • Sticky nav with blur-backdrop + border on scroll
  • Cards with 3D tilt effect on hover (CSS perspective transforms)

━━━ BACKGROUND ATMOSPHERE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Never plain solid backgrounds. Add depth with:
  • Radial gradient orbs (corners, 30-50% opacity)
  • SVG noise texture overlay (opacity 0.03-0.08)
  • Animated gradient mesh (background-size 400%, keyframe animation)
  • Dot/grid pattern (radial-gradient dot matrix)
  • Floating blur circles (position: fixed, z-index: -1, blur: 80-150px)

━━━ COMPONENT QUALITY BAR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  • Cards: border-radius 16-24px, subtle border (1px rgba), layered shadow
  • Buttons: gradient or solid accent, hover glow (box-shadow with accent),
    active scale(0.96), 0.2s transition, pill or sharp corners (commit to one)
  • Inputs: floating labels or bold placeholders, focus glow ring
  • Badges/Tags: colorful, rounded-full, small text, bold weight
  • Modals: backdrop-blur, centered transform, slide-up animation
  • Scrollbars: styled ::-webkit-scrollbar (thin, accent color)
  • Selection: ::selection with accent background

━━━ OUTPUT FORMAT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Output ONLY file contents. Zero explanations. Zero preamble. No markdown.
2. Separate files with this EXACT delimiter on its own line:
   === FILE: relative/path/to/file.ext ===
3. Start immediately with === FILE: index.html ===
4. Generate ALL files: index.html, style.css, script.js (+ extras as needed).
5. Every file COMPLETE — no placeholders, no TODO, no truncation.
6. Load Google Fonts via <link> in HTML <head>.
7. Load CDN libs via <script src> BEFORE your script.js.
8. Works directly in browser — zero build step.
9. localStorage for all persistence.
10. MOBILE-FIRST responsive (320px to 2560px).`;

const ULTRA_GAME = `
━━━ GAME ENGINEERING STANDARDS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ARCHITECTURE:
  • Proper game loop: const loop = (ts) => { update(dt); render(); rAF(loop); }
  • Delta-time movement (dt-based physics, frame-rate independent)
  • State machine: MENU -> PLAYING -> PAUSED -> GAME_OVER -> WIN
  • Clean class-based entities or entity-component approach

VISUALS (beyond basic canvas):
  • Particle systems: sparks, explosions, trails, ambient particles
  • Screen shake on impacts (canvas translate with damped oscillation)
  • Parallax scrolling layers in background
  • Smooth color lerp for health bars, energy meters
  • Vignette overlay, scanline effect via CSS or canvas overlay
  • HUD: score with digit-roll animation, combo multiplier, timer ring

GAMEPLAY DEPTH:
  • Progressive difficulty curve (speed/spawn rate vs score/time)
  • Power-ups with visual timed expiry bars
  • Combo system (consecutive hits multiply score)
  • High score localStorage persistence
  • Achievement flash notifications on milestones
  • Pause menu with frosted overlay

AUDIO (Web Audio API, zero audio files):
  • Oscillator sound effects: shoot, hit, collect, level-up, death
  • Background: layered oscillators with LFO modulation
  • Master volume control in settings panel

CONTROLS:
  • Keyboard: WASD + Arrow keys + Space/Enter + Escape=pause
  • Touch: on-screen button overlay for mobile
  • Mouse support where applicable

START SCREEN:
  • Animated title with pulsing glow
  • High score display
  • Instructions panel
  • Press-to-start animation`;

const ULTRA_DASHBOARD = `
━━━ DASHBOARD ENGINEERING STANDARDS ━━━━━━━━━━━━━━━━━━━━━━━━

LAYOUT:
  • Collapsible sidebar (250px -> 64px icon rail) smooth CSS transition
  • Top bar: search, notification bell (badge), user avatar dropdown
  • Main area: CSS Grid responsive (auto-fit, minmax(300px, 1fr))
  • Breadcrumb navigation per section

CHARTS (Chart.js CDN: https://cdn.jsdelivr.net/npm/chart.js):
  • Line: animated draw, multiple datasets, gradient fill under curve
  • Bar: grouped or stacked, hover highlights
  • Doughnut: legend, center total label
  • All charts: custom palette matching design system, custom tooltips

KPI CARDS (all of these required):
  • Animated count-up number on load
  • % change badge (green up / red down with arrow)
  • Mini sparkline
  • Icon in accent-colored circle
  • Shimmer skeleton loader state

TABLES:
  • Sortable columns (click -> asc/desc arrow indicator)
  • Row hover highlight
  • Pagination controls
  • Search bar above with live filter
  • Status pills: Active/Inactive/Pending (colored)
  • Action buttons revealed on row hover

INTERACTIVITY:
  • Date range picker that updates all charts
  • Dark/light mode toggle (CSS vars swap, smooth transition)
  • Slide-in notification panel from right
  • Skeleton -> data reveal with fade-in`;

const ULTRA_TOOL = `
━━━ TOOL ENGINEERING STANDARDS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

UX EXCELLENCE:
  • Zero-friction: usable immediately on load (focused input, sample data pre-filled)
  • Real-time output: results update as user types (debounced 150ms)
  • Keyboard-first: Tab nav, Enter submit, Escape clear, Ctrl+Z undo
  • Error states: inline validation, red glow on invalid, helpful hint text
  • Success states: green confirm, subtle celebration animation (scale pop)
  • Empty states: illustrated guide text

POWER FEATURES:
  • History panel: last 10 operations with one-click restore
  • Copy-to-clipboard on every output ("Copied!" checkmark flash)
  • Download output (Blob + URL.createObjectURL) where applicable
  • Share URL: encode state into URL hash for instant sharing
  • Settings panel: theme, options
  • Keyboard shortcut reference (? key toggles panel)

VISUAL FEEDBACK:
  • Processing: skeleton pulse or spinner while computing
  • Smooth 200ms transitions between states
  • Button press: scale(0.96) on :active
  • Tooltip on every icon button
  • Progress bar for multi-step operations

CODE/TEXT TOOLS:
  • Prism.js via CDN for syntax highlighting
  • Line numbers, live word/character count
  • Diff view for before/after
  • Export as .txt/.json/.csv where relevant`;

const ULTRA_SAAS = `
━━━ SAAS LANDING PAGE STANDARDS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HERO (make it unforgettable):
  • 100vh, massive headline (clamp 4rem-8rem)
  • Animated gradient or particle background
  • Gradient text effect or split animated reveal on headline
  • Staggered word/letter fade-in on sub-headline
  • CTA: gradient, hover glow, subtle pulse animation
  • Social proof bar: "X companies trust us" + logo placeholder row

SECTIONS (scroll-triggered animations on all):
  1. LOGO MARQUEE: infinite auto-scroll CSS animation
  2. FEATURES: 6-card grid, icon + title + desc, card tilt on hover
  3. HOW IT WORKS: numbered steps with connecting line, alternating layout
  4. STATS: animated count-up on IntersectionObserver trigger
  5. TESTIMONIALS: card carousel, avatar + quote + star rating
  6. PRICING: 3 tiers, center highlighted, feature checklist, popular badge
  7. FAQ: smooth accordion (one open at a time)
  8. CTA STRIP: full-width gradient, final conversion push
  9. FOOTER: multi-column, social icons, legal links

STICKY NAV:
  • Transparent -> frosted glass on scroll (backdrop-filter)
  • Active section highlighting
  • Mobile hamburger with slide-down drawer`;

const ULTRA_PORTFOLIO = `
━━━ PORTFOLIO STANDARDS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HERO:
  • Name in massive display type
  • Role with typewriter cycling effect (3+ roles)
  • Animated background: particle field, gradient orbs, or abstract art
  • Scroll indicator with animated bounce

SKILLS (not boring progress bars, use one of):
  • Hexagonal grid, tag cloud with size variation,
  • Animated circular SVG progress rings,
  • Skill cards with icons and animated reveal

PROJECTS (centerpiece):
  • Magazine-style grid (vary card sizes)
  • Cards: full image, overlay on hover with tech stack badges
  • Filter tabs: All / Frontend / Backend / Design / Game
  • Lightbox modal: description, links, tech stack, screenshots

CONTACT:
  • Floating label inputs
  • Real-time character count on textarea
  • Client-side validation with animated error messages
  • Success with confetti burst (canvas or CSS keyframe)

EXTRAS:
  • Dark/light mode (icon in nav, localStorage persisted)
  • Custom cursor trail or glow
  • Reading progress bar at top`;

const ULTRA_ECOMMERCE = `
━━━ ECOMMERCE STANDARDS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRODUCT GRID:
  • Masonry or uniform grid (user toggle)
  • Cards: gradient/pattern placeholder image, quick-add button
  • Wishlist heart toggle with animation
  • Rating stars (SVG half-star support)
  • Badge system: NEW, SALE, HOT, OUT OF STOCK

FILTERS (sidebar + mobile drawer):
  • Dual-thumb price range slider (pure CSS/JS)
  • Category checkboxes with count badges
  • Rating filter, color swatches, size selector
  • Active filter chips row with remove x
  • Result count ("Showing 24 of 156 results")

CART (slide-in drawer):
  • Count badge on icon (animates on add)
  • Quantity stepper (-/+ with disabled states)
  • Item remove with slide-out animation
  • Subtotal, tax, free shipping progress bar
  • Checkout -> success modal with order number

PRODUCT DETAIL:
  • Image gallery with thumbnail strip
  • Zoom on hover
  • Variant swatches (color/size)
  • Add to cart with quantity + wishlist button
  • Tabbed: Description / Reviews / Specs`;

const ULTRA_BLOG = `
━━━ BLOG/EDITORIAL STANDARDS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LAYOUT (magazine-style, not boring equal cards):
  • Featured hero post: full-width, overlay text
  • Editorial grid below: large + 2 medium + 4 small cards
  • Vary card sizes intentionally

POST CARDS:
  • Category badge colored by category
  • Author avatar + name + date + read time (from word count)
  • Excerpt with line-clamp: 2
  • Hover: card lifts (translateY -4px + deeper shadow)
  • Image: gradient mesh placeholder per category

READING EXPERIENCE:
  • Article: max-width 680px, line-height 1.8
  • Drop cap on first paragraph
  • Pull quotes (large italic, accent border-left)
  • Reading progress bar (sticky top)
  • Estimated read time

NAVIGATION:
  • Category tabs with pill style
  • Search with live filter + highlight match text
  • Tag cloud sidebar
  • Related posts at bottom
  • Table of contents for long posts`;

const ULTRA_APP = `
━━━ WEB APP ENGINEERING STANDARDS ━━━━━━━━━━━━━━━━━━━━━━━━━━

STATE ARCHITECTURE:
  • Single source of truth: one state object managed by update/render cycle
  • LocalStorage persistence: save/load state on every mutation
  • Undo/redo: circular buffer of last 20 states (Ctrl+Z / Ctrl+Y)
  • URL hash reflects current view for bookmarkability

UI PATTERNS:
  • Sidebar or tab nav with active-state highlighting
  • Modal system: backdrop click closes, ESC closes, focus trap inside
  • Toast notifications: slide-in from bottom-right, 3s auto-dismiss, stack up to 3
  • Skeleton loading: pulse animation placeholder → content reveal
  • Empty states: illustrated SVG icon + headline + CTA button
  • Drag-and-drop where applicable (HTML5 drag API)

KEYBOARD-FIRST:
  • Tab/Shift+Tab navigation through all interactive elements
  • Enter confirms, Escape cancels/closes
  • Ctrl/Cmd+S saves, Ctrl/Cmd+Z undoes
  • ? key shows keyboard shortcut panel

MICRO-INTERACTIONS:
  • Button clicks: scale(0.96) active state
  • Input focus: border + glow ring transition
  • List item add: slide-down + fade-in
  • List item remove: slide-up + fade-out before DOM removal
  • Toggle switches: smooth thumb slide, color transition

DATA MANAGEMENT:
  • Search/filter: instant results (< 16ms via debounce)
  • Sort: multi-column, visual sort arrow indicators
  • Bulk actions: checkbox select all, batch operations
  • Pagination or infinite scroll (prefer virtual scroll for 100+ items)`;

function buildSystemPromptForType(appType) {
  const typeMap = {
    game:       ULTRA_GAME,
    dashboard:  ULTRA_DASHBOARD,
    tool:       ULTRA_TOOL,
    saas:       ULTRA_SAAS,
    portfolio:  ULTRA_PORTFOLIO,
    ecommerce:  ULTRA_ECOMMERCE,
    blog:       ULTRA_BLOG,
    app:        ULTRA_APP,
    form: `
━━━ FORM STANDARDS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Multi-step with animated progress stepper (step circles, connecting line)
• Floating label inputs (label transitions up on focus/fill)
• Real-time validation: debounced 300ms, green check / red x inline
• Password strength meter (segmented bar, color coded)
• Smart field types: phone formatter, credit card spacing, date picker
• Step transitions: slide-left/right CSS animation between steps
• Review step: show all answers before submit
• Submit: loading spinner -> success checkmark SVG stroke animation
• Error recovery: scroll to first error, shake animation on invalid submit`,
    static: `
━━━ STATIC SITE STANDARDS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• 100vh hero with impactful headline and animated background
• At least 5 distinct sections with unique visual treatments
• Sticky nav with scroll-state changes
• Scroll-triggered animations on all sections (IntersectionObserver)
• Rich footer: multi-column, social links, newsletter input
• Responsive: perfect at all breakpoints`,
  };

  return DESIGN_FOUNDATIONS + (typeMap[appType] || typeMap.static);
}

const INTERACTIVE_SYSTEM_ADDENDUM = `

━━━ ABSOLUTE FUNCTIONALITY MANDATE ━━━━━━━━━━━━━━━━━━━━━━━━━

EVERY interaction must be 100% functional. No exceptions:
  YES: ALL buttons have working click handlers
  YES: ALL inputs have change/input/keydown listeners
  YES: Timers use setInterval or requestAnimationFrame with REAL time
  YES: Calculators do CORRECT arithmetic, handle edge cases (div by zero etc)
  YES: Animations are actually running via CSS keyframes or JS
  YES: State machine has proper transitions, no broken states
  NO:  placeholder logic, empty functions, TODO comments, console.log handlers
  NO:  "this would connect to a backend" — mock it locally and fully
  NO:  partial implementations — if a feature is visible, it MUST work`;

// ─────────────────────────────────────────────────────────────────────────────
// LLM HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function _fetchWithTimeout(url, init, timeoutMs = LLM_TIMEOUT_MS) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _isUsable(text) {
  return typeof text === "string" && text.trim().length > OUTPUT_MIN_LENGTH;
}

function _validateRawOutput(text, context = "generation") {
  if (!text || typeof text !== "string") {
    throw new Error(`AI output is null or non-string [${context}]`);
  }
  if (text.trim().length < OUTPUT_MIN_LENGTH) {
    throw new Error(
      `AI output too short (${text.trim().length} chars, min ${OUTPUT_MIN_LENGTH}) [${context}]`
    );
  }
  if (!FILE_DELIMITER_REGEX.test(text)) {
    throw new Error(
      `AI output missing required "=== FILE:" delimiter [${context}]. ` +
      `Raw preview: ${text.slice(0, 120).replace(/\n/g, "↵")}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODEL CALLERS
// ─────────────────────────────────────────────────────────────────────────────

async function _callOpenRouterOrGroq(model, messages) {
  const body = JSON.stringify({
    model:      model.modelName,
    messages,
    max_tokens: getDynamicTokens(model.id),
  });

  const res = await _fetchWithTimeout(model.url, {
    method:  "POST",
    headers: model.headers,
    body,
  });

  // HTTP 402 — credit limit: skip model immediately, no retry
  if (res.status === 402) {
    const errText = await res.text().catch(() => "HTTP 402");
    const err = new Error(`CREDIT_LIMIT: ${errText.slice(0, 200)}`);
    err._skipModel = true;
    throw err;
  }

  const rawText = await res.text().catch(() => `HTTP ${res.status}`);

  if (_isDeprecationError(rawText)) {
    const err = new Error(`Deprecation detected: ${rawText.slice(0, 120)}`);
    err._dead = true;
    throw err;
  }

  if (res.status === 400) {
    const err      = new Error(`HTTP 400: ${rawText.slice(0, 200)}`);
    err._skipModel = true;
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    const err      = new Error(`Auth error HTTP ${res.status} — ${rawText.slice(0, 100)}`);
    err._skipModel = true;
    throw err;
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 200)}`);
  }

  let data;
  try { data = JSON.parse(rawText); }
  catch { throw new Error("Non-JSON response body"); }

  const content = data?.choices?.[0]?.message?.content;
  if (!_isUsable(content)) throw new Error("Empty or unusable response content");

  if (_isDeprecationError(content)) {
    const err = new Error(`Deprecation in response content: ${content.slice(0, 120)}`);
    err._dead = true;
    throw err;
  }

  return content;
}

async function _callGemini(model, messages) {
  const key = model.apiKey;
  if (!key) throw new Error("Gemini API key not configured");

  // Separate system and user prompts — do NOT concatenate into one string
  const systemMsg    = messages.find(m => m.role === "system");
  const userMsg      = messages.find(m => m.role === "user");
  const systemPrompt = systemMsg?.content || "";
  const userPrompt   = userMsg?.content   || "";

  const res = await _fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model.geminiModel || "gemini-2.0-flash"}:generateContent?key=${key}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: systemPrompt },
              { text: userPrompt },
            ],
          },
        ],
        generationConfig: {
          temperature:     0.4,
          maxOutputTokens: getDynamicTokens("gemini"),
        },
      }),
    }
  );

  // HTTP 402 — quota exceeded
  if (res.status === 402) {
    const errText = await res.text().catch(() => "HTTP 402");
    const err = new Error(`CREDIT_LIMIT: ${errText.slice(0, 200)}`);
    err._skipModel = true;
    throw err;
  }

  if (!res.ok) {
    const rawText = await res.text().catch(() => `HTTP ${res.status}`);
    if (_isDeprecationError(rawText)) {
      const err = new Error(`Gemini deprecation: ${rawText.slice(0, 120)}`);
      err._dead = true;
      throw err;
    }
    // 404 = model not found (deprecated/renamed)
    if (res.status === 404) {
      const err = new Error(`Gemini model not found (404): ${model.geminiModel}`);
      err._dead = true;
      throw err;
    }
    // 429 = quota exceeded — cooldown but not dead
    if (res.status === 429) {
      const err = new Error(`Gemini HTTP 429: quota exceeded`);
      throw err;
    }
    throw new Error(`Gemini HTTP ${res.status}: ${rawText.slice(0, 100)}`);
  }

  let data;
  try { data = await res.json(); }
  catch { throw new Error("Gemini non-JSON response"); }

  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!_isUsable(content)) throw new Error("Gemini empty response");
  return content;
}

async function _callModel(model, messages) {
  if (model.isAnthropic) return _callAnthropic(model, messages);
  if (model.isGemini)    return _callGemini(model, messages);
  return _callOpenRouterOrGroq(model, messages);
}

async function _callAnthropic(model, messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error("ANTHROPIC_API_KEY missing"); e._skipModel = true; throw e; }
  const sysMsg   = messages.find(m => m.role === "system");
  const userMsgs = messages.filter(m => m.role !== "system");
  const cleaned  = [];
  for (const m of userMsgs) {
    if (cleaned.length && cleaned[cleaned.length - 1].role === m.role) {
      cleaned[cleaned.length - 1].content += "\n" + m.content;
    } else {
      cleaned.push({ role: m.role, content: m.content });
    }
  }
  if (!cleaned.length || cleaned[0].role !== "user") {
    cleaned.unshift({ role: "user", content: "Hello" });
  }
  const maxTok = getDynamicTokens(model.id);
  const res    = await _fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      model.anthropicModel || "claude-haiku-4-5-20251001",
      max_tokens: maxTok,
      system:     sysMsg?.content || undefined,
      messages:   cleaned,
    }),
  });
  if (res.status === 529 || res.status === 503) {
    const e = new Error(`Anthropic overloaded: ${res.status}`); e._skipModel = true; throw e;
  }
  if (res.status === 402 || res.status === 401) {
    const e = new Error(`Anthropic auth/credit: ${res.status}`); e._skipModel = true; throw e;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Anthropic HTTP ${res.status}: ${txt.slice(0, 120)}`);
  }
  const data    = await res.json();
  const content = data?.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
  if (!_isUsable(content)) throw new Error("Anthropic empty response");
  return content;
}

/**
 * Retry wrapper — no retry on _skipModel, _dead, or 402.
 * Immediate throw → triggers model rotation in caller.
 */
async function _withModelRetry(model, messages, label) {
  let lastErr;
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES + 1; attempt++) {
    try {
      return await _callModel(model, messages);
    } catch (err) {
      lastErr = err;
      // No retry: credit limit, deprecation, auth/skip
      if (err._dead || err._skipModel) throw err;
      const reason = err.name === "AbortError" ? "timeout" : err.message;
      console.warn(`[AI ERROR] ${label} | Attempt ${attempt} | ${reason}`);
      if (attempt <= LLM_MAX_RETRIES) {
        await _sleep(LLM_RETRY_BASE_MS * Math.pow(2, attempt - 1));
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// NUCLEAR FALLBACK PAGE — used when ALL models fail in generate mode
// ─────────────────────────────────────────────────────────────────────────────

function _buildFallbackOutput(prompt, lastError) {
  const safePrompt = String(prompt || "your request")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 120);
  const safeError  = String(lastError?.message || "All AI models are currently unavailable")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 200);

  return `=== FILE: index.html ===
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Generation Unavailable — Aquiplex</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="card">
    <div class="icon">⚡</div>
    <h1>Generation Unavailable</h1>
    <p class="subtitle">Could not generate: <strong>${safePrompt}</strong></p>
    <div class="detail">${safeError}</div>
    <div class="actions">
      <button class="btn-primary" onclick="location.reload()">Retry</button>
      <button class="btn-secondary" onclick="history.back()">Go Back</button>
    </div>
  </div>
  <script src="script.js"></script>
</body>
</html>

=== FILE: style.css ===
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0f0f13; color: #e2e8f0;
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh; padding: 24px;
}
.card {
  background: #1a1a24; border: 1px solid #2d2d3d; border-radius: 16px;
  padding: 40px 36px; max-width: 520px; width: 100%; text-align: center;
  box-shadow: 0 8px 32px rgba(0,0,0,.4);
}
.icon { font-size: 48px; margin-bottom: 16px; }
h1 { font-size: 22px; font-weight: 700; color: #f8fafc; margin-bottom: 8px; }
.subtitle { font-size: 14px; color: #94a3b8; margin-bottom: 24px; line-height: 1.5; }
.detail {
  background: #111118; border: 1px solid #2d2d3d; border-radius: 8px;
  padding: 12px 16px; font-size: 12px; color: #64748b; font-family: monospace;
  text-align: left; margin-bottom: 28px; word-break: break-word;
}
.actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
button {
  padding: 10px 22px; border-radius: 8px; font-size: 14px; font-weight: 600;
  cursor: pointer; border: none; transition: opacity .15s;
}
button:hover { opacity: .85; }
.btn-primary   { background: #6366f1; color: #fff; }
.btn-secondary { background: #1e1e2e; color: #94a3b8; border: 1px solid #2d2d3d; }

=== FILE: script.js ===
"use strict";
console.log("[Aquiplex] Fallback page loaded — all AI models failed.");`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TWO-PASS INTERACTIVE GENERATION
// Produces delimiter-formatted output compatible with parseMultiFileOutput
// ─────────────────────────────────────────────────────────────────────────────

function _getInteractiveToks(modelId) {
  if (typeof modelId !== "string") return 4000;
  if (modelId.includes("anthropic"))   return 8000;
  if (modelId.includes("gemini"))      return 6000;
  if (modelId.includes("llama-3.3") || modelId.includes("llama-3.1-70b")) return 5000;
  if (modelId.includes("qwen"))        return 5000;
  if (modelId.includes("deepseek"))    return 5000;
  if (modelId.includes("groq"))        return 4000;
  if (modelId.includes("openrouter"))  return 4000;
  return 3000;
}

async function _callModelRawWS(model, messages, maxToks) {
  // Guard: skip small models for large prompts (avoids 413 on llama-3.1-8b-instant)
  if (model.smallModel) {
    const totalChars = messages.reduce((a, m) => a + (m.content || "").length, 0);
    if (totalChars > 8000) {
      const e = new Error("Prompt too large for small model — skipping");
      e._skipModel = true;
      throw e;
    }
  }

  // ── Anthropic Claude ─────────────────────────────────────────────────────
  if (model.isAnthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");
    const sysMsg = messages.find(m => m.role === "system");
    const userMsgs = messages.filter(m => m.role !== "system");
    const cleaned = [];
    for (const m of userMsgs) {
      if (cleaned.length && cleaned[cleaned.length - 1].role === m.role) {
        cleaned[cleaned.length - 1].content += "\n" + m.content;
      } else {
        cleaned.push({ role: m.role, content: m.content });
      }
    }
    if (!cleaned.length || cleaned[0].role !== "user") {
      cleaned.unshift({ role: "user", content: "Hello" });
    }
    const res = await _fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type":      "application/json",
      },
      body: JSON.stringify({
        model:      model.anthropicModel,
        max_tokens: maxToks || 8000,
        system:     sysMsg?.content || undefined,
        messages:   cleaned,
      }),
    });
    if (res.status === 529 || res.status === 503) {
      const e = new Error(`Anthropic overloaded: ${res.status}`); e._skipModel = true; throw e;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Anthropic HTTP ${res.status}: ${txt.slice(0, 120)}`);
    }
    const data    = await res.json();
    const content = data?.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
    if (!_isUsable(content)) throw new Error("Anthropic empty response");
    return content;
  }

  if (model.isGemini) {
    const key = model.apiKey || process.env.Gemini_API_Key || process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Gemini key missing");
    const sys  = messages.find(m => m.role === "system");
    const user = messages.find(m => m.role === "user");
    const res  = await _fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.geminiModel || "gemini-2.0-flash"}:generateContent?key=${key}`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          contents: [{ role: "user", parts: [
            { text: sys?.content  || "" },
            { text: user?.content || "" },
          ]}],
          generationConfig: { temperature: 0.2, maxOutputTokens: maxToks || _getInteractiveToks("gemini") },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data    = await res.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!_isUsable(content)) throw new Error("Gemini empty response");
    return content;
  }

  const res = await _fetchWithTimeout(model.url, {
    method:  "POST",
    headers: model.headers,
    body:    JSON.stringify({
      model:      model.modelName,
      messages,
      max_tokens: maxToks || _getInteractiveToks(model.id),
      temperature: 0.2,
    }),
  });
  if (res.status === 402) { const e = new Error("CREDIT_LIMIT"); e._skipModel = true; throw e; }
  const rawText = await res.text().catch(() => `HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 100)}`);
  let data;
  try { data = JSON.parse(rawText); } catch { throw new Error("Non-JSON response"); }
  const content = data?.choices?.[0]?.message?.content;
  if (!_isUsable(content)) throw new Error("Empty response content");
  return content;
}

async function _runModelPoolWS(models, messages, label, maxToks) {
  for (const model of models) {
    if (!_isModelHealthy(model.id)) continue;
    try {
      const result = await _callModelRawWS(model, messages, maxToks);
      _recordModelSuccess(model.id);
      return result;
    } catch (err) {
      console.warn(`[AI ENGINE][${label}] ${model.id} failed: ${err.message}`);
      if (err._dead)           _markModelDead(model.id, err.message);
      else if (err._skipModel) _recordModelFailure(model.id);
      else                     _recordModelFailure(model.id);
    }
  }
  throw new Error(`[${label}] All models failed`);
}

// ─────────────────────────────────────────────────────────────────────────────
// FULLSTACK DETECTION
// ─────────────────────────────────────────────────────────────────────────────

const FULLSTACK_KEYWORDS = [
  "fullstack", "full stack", "full-stack",
  "backend", "back-end", "back end",
  "api", "rest api", "express", "node server", "node.js server",
  "database", "mongodb", "postgres", "mysql", "sqlite",
  "auth", "authentication", "login system", "user accounts", "register",
  "crud", "crud app",
  "saas app", "web app with backend", "web application",
  "admin panel with", "dashboard with data", "dashboard with backend",
  "deploy", "deployable", "production ready",
  "server side", "server-side",
];

function isFullstackPrompt(prompt) {
  if (!prompt) return false;
  const lower = prompt.toLowerCase();
  return FULLSTACK_KEYWORDS.some(k => lower.includes(k));
}

// ─────────────────────────────────────────────────────────────────────────────
// FULLSTACK PROJECT GENERATION — 2-pass: plan → generate
// ─────────────────────────────────────────────────────────────────────────────

const FULLSTACK_PLAN_SYSTEM = `You are a senior full-stack architect. Analyze the user's request and return a JSON project plan.

Return ONLY valid JSON — no markdown fences, no explanations.

Schema:
{
  "projectName": "string",
  "projectType": "saas|crud|dashboard|auth|api|ecommerce|blog|tool",
  "stack": {
    "frontend": "vanilla|react|vue",
    "backend": "express",
    "database": "mongodb|sqlite|none",
    "auth": "session|jwt|none"
  },
  "files": ["list of all files to generate"],
  "routes": [
    { "method": "GET|POST|PUT|DELETE", "path": "/api/...", "description": "..." }
  ],
  "dbModels": [
    { "name": "ModelName", "fields": ["field:type", ...] }
  ],
  "envVars": ["VAR_NAME=description", ...],
  "features": ["feature description", ...],
  "deployTarget": "vercel|render|railway|node"
}

Rules:
- Always include: package.json, README.md, .env.example (as env.example.txt), index.html, style.css, script.js
- Always include: server.js for Express backend
- Include route files in routes/ for any app with 3+ routes
- Include model files in models/ for any app with database
- Keep it achievable in a single generation pass
- Max 12 files total`;

const FULLSTACK_GEN_SYSTEM = `You are an expert full-stack developer. Generate a complete, working, deployable project.

RULES:
- Generate EVERY file in the plan — no skipping, no placeholders
- server.js must be a complete Express server with all routes wired
- package.json must have all real dependencies with correct versions
- All API routes must have real logic (not "// TODO")
- Frontend must call the real API endpoints (use fetch('/api/...'))
- Use environment variables from .env.example via process.env
- Include proper error handling (try/catch, res.status(4xx/5xx))
- README must have: setup steps, env vars table, API docs, deploy instructions
- .env.example must list ALL required env vars with descriptions

OUTPUT FORMAT — start immediately, zero preamble:
Use === FILE: filename === delimiter for every file.
For files in subdirectories use: === FILE: routes/users.js ===

Example:
=== FILE: package.json ===
{...}

=== FILE: server.js ===
...

=== FILE: index.html ===
...`;

async function generateFullstackProject(prompt) {
  const allModels = buildModelRegistry();
  if (allModels.length === 0) throw new Error("No models configured");

  // ── Pass 1: Architecture Plan ──────────────────────────────────────────────
  console.log("[AI ENGINE][Fullstack] Pass 1 — architecture plan");

  const planMessages = [
    { role: "system", content: FULLSTACK_PLAN_SYSTEM },
    { role: "user",   content: `Project request: ${prompt}` },
  ];

  let plan = null;
  try {
    const planRaw = await _runModelPoolWS(allModels, planMessages, "Fullstack-Plan", 800);
    const cleaned = planRaw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    plan = JSON.parse(cleaned);
    console.log(`[AI ENGINE][Fullstack] Plan OK: type=${plan.projectType} files=${plan.files?.length} routes=${plan.routes?.length}`);
  } catch (e) {
    console.warn(`[AI ENGINE][Fullstack] Plan parse failed (${e.message}) — using default plan`);
    plan = {
      projectName: "My App",
      projectType: "saas",
      stack: { frontend: "vanilla", backend: "express", database: "none", auth: "none" },
      files: ["package.json", "server.js", "index.html", "style.css", "script.js", "README.md", "env.example.txt"],
      routes: [
        { method: "GET",  path: "/",        description: "Serve frontend" },
        { method: "GET",  path: "/api/health", description: "Health check" },
      ],
      dbModels:  [],
      envVars:   ["PORT=3000", "NODE_ENV=development"],
      features:  [],
      deployTarget: "render",
    };
  }

  // ── Pass 2: Full Code Generation ───────────────────────────────────────────
  console.log("[AI ENGINE][Fullstack] Pass 2 — code generation");

  // Prefer strongest models for fullstack gen
  const genModels = [
    ...allModels.filter(m => m.id.includes("anthropic")),
    ...allModels.filter(m => m.id.includes("llama-3.3-70b")),
    ...allModels.filter(m => m.id.includes("gemini-2.0")),
    ...allModels.filter(m => !m.id.includes("anthropic") && !m.id.includes("llama-3.3-70b") && !m.id.includes("gemini-2.0")),
  ];

  const routeList = (plan.routes || [])
    .map(r => `  ${r.method} ${r.path} — ${r.description}`)
    .join("\n");

  const modelList = (plan.dbModels || [])
    .map(m => `  ${m.name}: ${(m.fields || []).join(", ")}`)
    .join("\n");

  const envList = (plan.envVars || []).join("\n");

  const genUser = `Build this complete ${plan.projectType} project:

PROJECT: ${plan.projectName}
DESCRIPTION: ${prompt}

STACK:
- Frontend: ${plan.stack?.frontend || "vanilla"} HTML/CSS/JS
- Backend: Node.js + Express
- Database: ${plan.stack?.database || "none"}
- Auth: ${plan.stack?.auth || "none"}

FILES TO GENERATE (all of them):
${(plan.files || []).map(f => "  - " + f).join("\n")}

API ROUTES:
${routeList || "  GET / — serve frontend\n  GET /api/health — health check"}

${modelList ? `DATABASE MODELS:\n${modelList}\n` : ""}

ENVIRONMENT VARIABLES:
${envList || "  PORT=3000"}

DEPLOY TARGET: ${plan.deployTarget || "render"}

Generate every file completely. No truncation. No placeholders. Production-ready code.`;

  const genMessages = [
    { role: "system", content: FULLSTACK_GEN_SYSTEM },
    { role: "user",   content: genUser },
  ];

  const rawOutput = await _runModelPoolWS(genModels, genMessages, "Fullstack-Gen", null);

  return { rawOutput, plan, source: "fullstack" };
}

async function generateInteractiveProject(prompt) {
  const allModels = buildModelRegistry();
  if (allModels.length === 0) throw new Error("No models configured");

  // Pass 1: prefer groq (fast) for UI skeleton
  const pass1Models = [
    ...allModels.filter(m => m.id.includes("groq")),
    ...allModels.filter(m => !m.id.includes("groq")),
  ];

  const pass1System = `You are an elite frontend designer and web developer. Generate ONLY index.html and style.css — NO JavaScript.

DESIGN MANDATE — this UI must look EXTRAORDINARY:
- Pick a bold dark aesthetic: cyberpunk neon, glassmorphism, luxury dark, or editorial dark
- Load Google Fonts via <link> — NEVER use system-ui, Arial, Inter, or Roboto as primary font
- Define CSS custom properties in :root: --bg, --surface, --accent-1, --accent-2, --text, --glow
- Animated background: floating gradient orbs (radial-gradient, position:fixed, z-index:-1, blur:100px)
- Page-load animations: @keyframes fadeUp/slideIn on all major elements, staggered animation-delay
- Hover effects: transform + box-shadow glow on all interactive elements
- Cards: border-radius 16-24px, subtle rgba border, multi-layer box-shadow
- Buttons: gradient accent fill, box-shadow glow on hover, scale(0.96) on active
- NEVER plain white background, NEVER system fonts, NEVER flat unstyled elements

OUTPUT FORMAT:
=== FILE: index.html ===
(full HTML — include Google Fonts <link> in <head>)

=== FILE: style.css ===
(full spectacular CSS with CSS vars, animations, hover effects)

RULES:
- Add unique IDs to ALL interactive elements (buttons, inputs, displays).
- Link: <link rel="stylesheet" href="style.css">
- Include: <script src="script.js"></script> at end of body.
- NO inline JavaScript. NO onclick attributes.
- Start output immediately with the first delimiter, no preamble.`;

  const pass1User = `Build the UI structure (HTML + CSS only, NO JS) for: ${prompt}`;

  const pass1Messages = [
    { role: "system", content: pass1System },
    { role: "user",   content: pass1User },
  ];

  console.log("[AI ENGINE][Interactive] Pass 1 — UI skeleton");
  const raw1 = await _runModelPoolWS(pass1Models, pass1Messages, "Pass1-UI", null);

  // Extract HTML from delimiter output
  const htmlMatch = raw1.match(/={3}\s*FILE:\s*index\.html\s*={3}\s*([\s\S]*?)(?:={3}\s*FILE:|$)/i);
  const cssMatch  = raw1.match(/={3}\s*FILE:\s*style\.css\s*={3}\s*([\s\S]*?)(?:={3}\s*FILE:|$)/i);
  if (!htmlMatch?.[1]?.trim()) throw new Error("Pass 1 returned no index.html");

  const htmlContent = htmlMatch[1].trim();
  const cssContent  = cssMatch?.[1]?.trim() || "/* Generated */";

  // Pass 2: prefer 70b groq + gemini for stronger logic
  const pass2Models = [
    ...allModels.filter(m => m.id.includes("llama-3.3-70b")),
    ...allModels.filter(m => m.id.includes("mixtral")),
    ...allModels.filter(m => m.id.includes("gemini-2.0")),
    ...allModels.filter(m => !m.id.includes("llama-3.3-70b") && !m.id.includes("mixtral") && !m.id.includes("gemini-2.0")),
  ];

  const pass2System = `You are an expert JavaScript developer. Generate ONLY raw JavaScript code for script.js.

STRICT RULES:
- Return ONLY JavaScript code — no markdown fences, no explanations, no file delimiters.
- DO NOT change any HTML IDs or structure.
- Use document.getElementById / querySelector to reference elements.
- Add working event listeners for ALL interactive elements.
- Timers MUST use setInterval or requestAnimationFrame and run in real time.
- Calculators MUST perform correct arithmetic and update the display element.
- Every button MUST have a working event listener.
- No empty functions, no placeholder logic, no TODO comments.`;

  const pass2User = `Given this HTML:

${htmlContent}

Generate ONLY the complete, working script.js for: ${prompt}

Return ONLY JavaScript code.`;

  const pass2Messages = [
    { role: "system", content: pass2System },
    { role: "user",   content: pass2User },
  ];

  console.log("[AI ENGINE][Interactive] Pass 2 — Logic generation");
  const rawJS = await _runModelPoolWS(pass2Models, pass2Messages, "Pass2-Logic", _getInteractiveToks("deepseek"));

  const cleanedJS = rawJS
    .replace(/^```(?:javascript|js)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // Pass 3 — Auto-repair quality gate
  const preRepair = [
    { fileName: "index.html", content: htmlContent },
    { fileName: "style.css",  content: cssContent  },
    { fileName: "script.js",  content: cleanedJS   },
  ];

  let finalFiles = preRepair;
  try {
    const { validateAndRepair } = require("../engine/repair.engine");
    const repairResult = await validateAndRepair(preRepair, { skipRepair: false });
    if (repairResult.repairs.length) {
      console.log("[AI ENGINE][Interactive] Pass 3 repairs: " + repairResult.repairs.join(", "));
    }
    finalFiles = repairResult.files;
  } catch (e) {
    console.warn("[AI ENGINE][Interactive] Repair pass failed (non-fatal): " + e.message);
  }

  const getContent = (name) => (finalFiles.find(f => f.fileName === name) || {}).content || "";

  // Return in delimiter format — compatible with parseMultiFileOutput
  const output =
    "=== FILE: index.html ===\n" + getContent("index.html") + "\n\n" +
    "=== FILE: style.css ===\n"  + getContent("style.css")  + "\n\n" +
    "=== FILE: script.js ===\n"  + getContent("script.js");

  console.log("[AI ENGINE][Interactive] \u2705 Two-pass + repair complete");
  return { rawOutput: output, source: "ai_two_pass", intent: "tool" };
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED AI GENERATION ENGINE — MODEL-FIRST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * generateProjectUnified({ prompt, mode, editMode, previousFiles, targetFile, appType })
 *
 * - generate mode: NEVER throws. Returns nuclear fallback on full failure.
 * - edit mode: THROWS on failure. File is never touched.
 */
async function generateProjectUnified({
  prompt,
  mode          = "generate",
  editMode      = false,
  previousFiles = null,
  targetFile    = null,
  appType       = null,
}) {
  const isEdit = editMode || mode === "edit";

  // Two-pass path for interactive prompts (generate mode only)
  if (!isEdit && isInteractivePrompt(prompt)) {
    try {
      console.log("[AI ENGINE] Interactive prompt detected — using two-pass generation");
      const result = await generateInteractiveProject(prompt);
      if (result?.rawOutput && FILE_DELIMITER_REGEX.test(result.rawOutput)) return result;
    } catch (err) {
      console.warn(`[AI ENGINE] Two-pass failed, falling back to single-pass: ${err.message}`);
    }
  }

  const intent    = appType || detectAppType(prompt);
  const isInteractive = isInteractivePrompt(prompt);
  const sysPrompt = buildSystemPromptForType(intent) + (isInteractive ? INTERACTIVE_SYSTEM_ADDENDUM : "");
  const context   = isEdit ? `edit:${targetFile}` : "generate";

  let userMessage;
  if (isEdit && targetFile && previousFiles) {
    const fileContent = previousFiles[targetFile] || "";
    const ext = targetFile.split(".").pop() || "";
    const lang = ext === "css" ? "CSS" : ext === "js" ? "JavaScript" : "HTML";

    // Build context from OTHER files so AI understands what it's connected to
    const otherFiles = Object.entries(previousFiles)
      .filter(([name]) => name !== targetFile)
      .map(([name, c]) => "--- " + name + " (first 600 chars) ---\n" + (c || "").slice(0, 600))
      .join("\n\n");

    userMessage = [
      "EDIT TASK: Modify " + targetFile + " (" + lang + ")",
      "",
      "INSTRUCTION: " + prompt,
      "",
      "CURRENT FILE CONTENT:",
      fileContent,
      "",
      otherFiles ? "CONNECTED FILES (for context only — DO NOT output these):\n" + otherFiles + "\n" : "",
      "RULES:",
      "- Return ONLY the updated " + targetFile + " content",
      "- Keep ALL existing styles/logic that the instruction does not mention",
      "- Maintain the existing CSS variable names and color scheme",
      "- Do NOT break any existing functionality",
      "- The output must be 100% complete — no truncation, no placeholders",
      "",
      "Return ONLY:",
      "=== FILE: " + targetFile + " ===",
      "[complete updated " + lang + " content here]",
    ].filter(s => s !== null && s !== undefined).join("\n");
  } else {
    userMessage =
      `REQUEST: ${prompt}\n\n` +
      `You MUST follow the system prompt aesthetic mandates exactly.\n` +
      `REQUIRED DESIGN CHECKLIST — verify before output:\n` +
      `✓ Google Font loaded via <link> (NOT system-ui/Arial/Roboto/Inter)\n` +
      `✓ CSS custom properties defined in :root (--bg, --accent, --text etc)\n` +
      `✓ Animated background (gradient orbs, particles, or pattern — NOT plain solid color)\n` +
      `✓ Page-load animations with staggered animation-delay\n` +
      `✓ Hover effects on all interactive elements (transform + transition)\n` +
      `✓ Dark color scheme with vivid accent colors\n` +
      `✓ ALL buttons, inputs, timers, game loops 100% functional\n\n` +
      `OUTPUT FORMAT — start immediately, zero preamble:\n` +
      `=== FILE: index.html ===\n` +
      `=== FILE: style.css ===\n` +
      `=== FILE: script.js ===`;
  }

  const messages = [
    { role: "system", content: sysPrompt },
    { role: "user",   content: userMessage },
  ];

  let MODELS = buildModelRegistry();

  // Interactive prompts: groq 70b first (best free logic model), then gemini, then openrouter
  if (isInteractive) {
    MODELS = [
      ...MODELS.filter(m => m.id.includes("llama-3.3-70b")),
      ...MODELS.filter(m => m.id.includes("mixtral")),
      ...MODELS.filter(m => m.id.includes("gemini-2.0")),
      ...MODELS.filter(m => !m.id.includes("llama-3.3-70b") && !m.id.includes("mixtral") && !m.id.includes("gemini-2.0")),
    ];
    // Apply lower temperature for deterministic logic output
    MODELS = MODELS.map(m => {
      if (!m.isGemini && m.buildBody) {
        return {
          ...m,
          buildBody: (msgs) => ({ ...m.buildBody(msgs), temperature: 0.2 }),
        };
      }
      return m;
    });
  }

  if (MODELS.length === 0) {
    const err = new Error("No API keys configured. Set GROQ_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY.");
    console.error(`[AI ERROR] No models configured`);
    if (isEdit) throw err;
    return {
      rawOutput: _buildFallbackOutput(prompt, err),
      source:    "nuclear_fallback",
      intent,
    };
  }

  let lastError = null;

  for (const model of MODELS) {
    if (!_isModelHealthy(model.id)) {
      console.warn(`[AI ENGINE] Skipping unhealthy model: ${model.id}`);
      continue;
    }

    const label = model.id;
    console.log(`[AI ENGINE] Trying model: ${label}`);

    try {
      const text = await _withModelRetry(model, messages, label);

      _validateRawOutput(text, context);

      _recordModelSuccess(model.id);
      console.log(`[AI ENGINE] ✅ Success | ${label} | ${text.length} chars`);
      return { rawOutput: text, source: "ai", intent };

    } catch (err) {
      lastError = err;

      if (err._dead) {
        _markModelDead(model.id, err.message);
      } else if (err._skipModel) {
        console.warn(`[AI ERROR] ${label} | Model skipped (credit/auth): ${err.message}`);
        _recordModelFailure(model.id);
      } else {
        console.warn(`[AI ERROR] ${label} | ${err.message}`);
        _recordModelFailure(model.id);
      }

      console.log(`[AI ENGINE] Rotating to next model...`);
    }
  }

  console.error(`[AI ERROR] ALL MODELS FAILED | Last: ${lastError?.message}`);

  if (isEdit) {
    throw new Error(
      `AI edit failed — all models exhausted. File was NOT modified. ` +
      `Last error: ${lastError?.message || "unknown"}`
    );
  }

  return {
    rawOutput: _buildFallbackOutput(prompt, lastError),
    source:    "nuclear_fallback",
    intent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSER — strict, never returns empty array, always guarantees index.html
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeFileName(name) {
  if (!name || typeof name !== "string") return "";
  const cleaned = name
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\0/g, "")
    .replace(/\.\.\//g, "")
    .trim();
  if (!cleaned) return "";
  const ext = path.extname(cleaned).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    console.warn(`[PROJECT ENGINE] Rejected file with disallowed extension: ${cleaned}`);
    return "";
  }
  return cleaned;
}

function inferLanguage(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    ".html": "html", ".htm": "html",
    ".css":  "css",
    ".js":   "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts":   "typescript",
    ".json": "json",
    ".md":   "markdown",
    ".svg":  "xml",
    ".txt":  "plaintext",
  };
  return map[ext] || "plaintext";
}

function _fallbackFile(reason = "", content = null) {
  const safeReason = String(reason).replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 200);
  return {
    fileName: "index.html",
    content: content || `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Aquiplex</title></head>
<body style="font-family:system-ui;text-align:center;padding:60px;background:#0f0f13;color:#e2e8f0;">
  <h1 style="margin-bottom:16px;">⚠️ Output Error</h1>
  <p style="color:#94a3b8;margin-bottom:24px;">${safeReason || "The AI returned an unrecognisable response."}</p>
  <button onclick="location.reload()"
    style="background:#6366f1;color:#fff;border:none;padding:10px 24px;border-radius:8px;cursor:pointer;font-size:14px;">
    Retry
  </button>
</body>
</html>`,
    language: "html",
  };
}

function parseMultiFileOutput(raw) {
  if (!raw || typeof raw !== "string") {
    console.warn("[PROJECT ENGINE] Parser received empty/null output — using fallback");
    return [_fallbackFile("LLM returned no output")];
  }

  let cleaned = raw
    .replace(/^```[\w]*\n?/gm, "")
    .replace(/^```\s*$/gm, "")
    .trim();

  cleaned = cleaned
    .replace(/={2,}\s*FILE\s*:\s*/gi, "=== FILE: ")
    .replace(/\s*={2,}\s*$/gm, " ===");

  const delimiterRe = /^={3}\s*FILE:\s*(.+?)\s*={3}\s*$/gm;
  const matches     = [];
  let   m;
  while ((m = delimiterRe.exec(cleaned)) !== null) {
    matches.push({ fileName: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }

  if (matches.length === 0) {
    const trimmed = cleaned.trim();
    if (trimmed.toLowerCase().includes("<!doctype") || trimmed.toLowerCase().includes("<html")) {
      console.warn("[PROJECT ENGINE] No FILE delimiters — raw HTML detected, wrapping as index.html");
      return [{ fileName: "index.html", content: trimmed, language: "html" }];
    }
    console.warn("[PROJECT ENGINE] No FILE delimiters and no HTML — using fallback");
    return [_fallbackFile("LLM output had no recognisable file delimiters", trimmed.slice(0, 500))];
  }

  const files = [];
  for (let i = 0; i < matches.length; i++) {
    const cur     = matches[i];
    const next    = matches[i + 1];
    let   content = next ? cleaned.slice(cur.end, next.start) : cleaned.slice(cur.end);
    content       = content.trim();

    if (!content) {
      console.warn(`[PROJECT ENGINE] Skipping empty file block: ${cur.fileName}`);
      continue;
    }

    const safeFileName = sanitizeFileName(cur.fileName);
    if (!safeFileName) {
      console.warn(`[PROJECT ENGINE] Skipping file with rejected name: ${cur.fileName}`);
      continue;
    }

    files.push({ fileName: safeFileName, content, language: inferLanguage(safeFileName) });
  }

  if (files.length === 0) {
    console.warn("[PROJECT ENGINE] All parsed file blocks empty/rejected — using fallback");
    return [_fallbackFile("All file blocks were empty or had disallowed extensions")];
  }

  const hasIndex = files.some(f => f.fileName === "index.html");
  if (!hasIndex) {
    const htmlFile = files.find(f => f.fileName.endsWith(".html"));
    if (htmlFile) {
      console.warn(`[PROJECT ENGINE] Renaming ${htmlFile.fileName} → index.html`);
      htmlFile.fileName = "index.html";
      htmlFile.language = "html";
    } else {
      console.warn("[PROJECT ENGINE] No HTML file found — injecting minimal index.html");
      files.unshift({
        fileName: "index.html",
        content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Generated Project</title>
  ${files.find(f => f.fileName === "style.css") ? '<link rel="stylesheet" href="style.css">' : ""}
</head>
<body>
  ${files.find(f => f.fileName === "script.js") ? '<script src="script.js"></script>' : ""}
</body>
</html>`,
        language: "html",
      });
    }
  }

  if (!files.some(f => f.fileName === "style.css")) {
    files.push({ fileName: "style.css", content: "/* Generated stylesheet */\n", language: "css" });
  }
  if (!files.some(f => f.fileName === "script.js")) {
    files.push({ fileName: "script.js", content: '"use strict";\n// Generated script\n', language: "javascript" });
  }

  console.log(`[PROJECT ENGINE] Parsed ${files.length} file(s): ${files.map(f => f.fileName).join(", ")}`);
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE SYSTEM HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function projectDir(projectId) {
  const safe = String(projectId).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) throw new Error("Invalid projectId");
  return path.join(PROJECTS_DIR, safe);
}

/**
 * Returns the resolved project directory with a trailing separator.
 * Used for reliable startsWith path-traversal checks.
 */
function _projectDirWithSep(projectId) {
  return projectDir(projectId) + path.sep;
}

async function _atomicWrite(filePath, content) {
  const dir     = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function saveProjectFiles(projectId, files, meta = {}) {
  const dir    = projectDir(projectId);
  const dirSep = dir + path.sep;        // FIX: use explicit trailing sep for traversal check
  await fs.mkdir(dir, { recursive: true });

  let existingIndex = {};
  try {
    const raw     = await fs.readFile(path.join(dir, "_index.json"), "utf8");
    existingIndex = JSON.parse(raw);
  } catch {}

  const writeResults = await Promise.allSettled(
    files.map(async file => {
      const filePath = path.resolve(dir, file.fileName); // FIX: resolve so subdirs normalise correctly
      // FIX: startsWith(dirSep) handles both flat and subdir files safely
      if (!filePath.startsWith(dirSep)) {
        throw new Error(`Path traversal rejected: ${file.fileName}`);
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await _atomicWrite(filePath, file.content);
      return file.fileName;
    })
  );

  const written  = [];
  const failures = [];
  for (const r of writeResults) {
    if (r.status === "fulfilled") written.push(r.value);
    else failures.push(r.reason?.message);
  }

  if (failures.length > 0) {
    console.error(`[PROJECT ENGINE] Write failures: ${failures.join("; ")}`);
  }

  if (written.length === 0) {
    throw new Error("All file writes failed — project not saved");
  }

  const index = {
    ...existingIndex,
    ...meta,
    projectId:  String(projectId),
    files:      written,
    updatedAt:  new Date().toISOString(),
    createdAt:  existingIndex.createdAt || new Date().toISOString(),
  };

  await _atomicWrite(path.join(dir, "_index.json"), JSON.stringify(index, null, 2));
  console.log(`[PROJECT ENGINE] Saved project ${projectId} — ${written.length} file(s)`);
  return index;
}

async function readProjectFiles(projectId) {
  const dir = projectDir(projectId);
  try {
    const indexRaw = await fs.readFile(path.join(dir, "_index.json"), "utf8");
    const index    = JSON.parse(indexRaw);
    const files    = [];

    // FIX: guard against null/undefined index.files before iterating
    const indexFiles = Array.isArray(index.files) ? index.files : [];

    for (const fileName of indexFiles) {
      try {
        const content = await fs.readFile(path.join(dir, fileName), "utf8");
        files.push({ fileName, content, language: inferLanguage(fileName) });
      } catch (readErr) {
        console.warn(`[PROJECT ENGINE] Missing file skipped: ${fileName} (${readErr.message})`);
      }
    }

    // FIX: guard against null/undefined before .includes()
    if (!indexFiles.includes("index.html")) {
      try {
        const content = await fs.readFile(path.join(dir, "index.html"), "utf8");
        files.unshift({ fileName: "index.html", content, language: "html" });
        index.files = ["index.html", ...indexFiles];
        console.warn(`[PROJECT ENGINE] index.html recovered from disk`);
      } catch {}
    }

    return { index, files };
  } catch (err) {
    console.warn(`[PROJECT ENGINE] Could not read index for project ${projectId}: ${err.message}`);
    return { index: null, files: [] };
  }
}

async function readSingleFile(projectId, fileName) {
  const safeFile = sanitizeFileName(fileName);
  if (!safeFile) throw new Error("Invalid file name");
  const dir      = projectDir(projectId);
  const filePath = path.resolve(dir, safeFile);   // FIX: resolve for correct normalisation
  // FIX: removed unsafe `|| filePath !== dir` escape hatch — only allow files inside dir
  if (!filePath.startsWith(dir + path.sep)) {
    throw new Error("Forbidden path");
  }
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    throw new Error(`File not found: ${safeFile}`);
  }
}

async function writeSingleFile(projectId, fileName, content) {
  const safeFile = sanitizeFileName(fileName);
  if (!safeFile) throw new Error("Invalid file name");
  const dir      = projectDir(projectId);
  const filePath = path.resolve(dir, safeFile);   // FIX: resolve for correct normalisation
  // FIX: removed unsafe `|| filePath !== dir` escape hatch
  if (!filePath.startsWith(dir + path.sep)) {
    throw new Error("Forbidden path");
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await _atomicWrite(filePath, content);

  const indexPath = path.join(dir, "_index.json");
  try {
    const indexRaw = await fs.readFile(indexPath, "utf8");
    const index    = JSON.parse(indexRaw);
    if (!Array.isArray(index.files)) index.files = [];
    if (!index.files.includes(safeFile)) index.files.push(safeFile);
    index.updatedAt = new Date().toISOString();
    await _atomicWrite(indexPath, JSON.stringify(index, null, 2));
  } catch {
    const fallbackIndex = {
      projectId: String(projectId),
      files:     [safeFile],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await _atomicWrite(indexPath, JSON.stringify(fallbackIndex, null, 2));
  }

  console.log(`[PROJECT ENGINE] Wrote file: ${safeFile} → project ${projectId}`);
}

async function deleteProject(projectId) {
  await fs.rm(projectDir(projectId), { recursive: true, force: true });
}

async function listProjects() {
  try {
    const entries  = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    const projects = [];

    await Promise.all(
      entries.map(async entry => {
        if (!entry.isDirectory()) return;
        try {
          const indexRaw = await fs.readFile(
            path.join(PROJECTS_DIR, entry.name, "_index.json"), "utf8"
          );
          const index = JSON.parse(indexRaw);
          projects.push({
            projectId: index.projectId  || entry.name,
            name:      index.name       || "Untitled Project",
            userId:    index.userId     || null,
            files:     Array.isArray(index.files) ? index.files : [],
            fileCount: Array.isArray(index.files) ? index.files.length : 0,
            createdAt: index.createdAt  || null,
            updatedAt: index.updatedAt  || null,
          });
        } catch {}
      })
    );

    projects.sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });

    return projects;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT SERVICES
// ─────────────────────────────────────────────────────────────────────────────

async function createProject(userId, name, projectId = null) {
  if (!userId) throw new Error("Unauthorized");
  const id  = projectId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = projectDir(id);
  await fs.mkdir(dir, { recursive: true });
  const index = {
    projectId: id,
    name:      (name || "Untitled Project").slice(0, 120),
    userId:    String(userId),
    files:     [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await _atomicWrite(path.join(dir, "_index.json"), JSON.stringify(index, null, 2));
  console.log(`[PROJECT ENGINE] Created project ${id} for user ${userId}`);
  return { success: true, projectId: id, name: index.name };
}

async function generateProject(userId, projectId, prompt) {
  if (!userId)               throw new Error("Unauthorized");
  if (!projectId || !prompt) throw new Error("projectId and prompt are required");

  console.log(`[AI ENGINE] generateProject start | project: ${projectId} | prompt: ${String(prompt).slice(0, 80)}`);

  // ── Stage 1: Prompt Expansion ──────────────────────────────────────────────
  let expandedSpec;
  try {
    const { expandPrompt } = require("../engine/prompt.expander");
    // Build a lightweight AI caller for expansion (uses first healthy model)
    const fastCallAI = async (messages, opts) => {
      const allModels = buildModelRegistry();
      const fast = allModels.find(m => _isModelHealthy(m.id) && !m.smallModel);
      if (!fast) return null;
      return _withModelRetry(fast, messages, "expand").catch(() => null);
    };
    expandedSpec = await expandPrompt(prompt, {
      callAI: fastCallAI,
      seed:   prompt.length,
    });
    console.log(`[AI ENGINE] Prompt expanded: type=${expandedSpec.projectType} aiSpec=${!!expandedSpec.aiSpec}`);
  } catch (e) {
    console.warn(`[AI ENGINE] Prompt expansion failed (non-fatal): ${e.message}`);
    expandedSpec = null;
  }

  const finalPrompt = expandedSpec?.expandedPrompt || prompt;
  const appType     = expandedSpec?.projectType || detectAppType(prompt);

  // ── Stage 2: Generation ────────────────────────────────────────────────────
  // ── Stage 2: Generation ── fullstack path or standard
  let rawOutput, source, intent, fullstackPlan = null;
  const useFullstack = isFullstackPrompt(prompt) || isFullstackPrompt(finalPrompt);

  if (useFullstack) {
    console.log("[AI ENGINE] Fullstack prompt detected — using fullstack generation path");
    try {
      const fsResult = await generateFullstackProject(finalPrompt || prompt);
      rawOutput      = fsResult.rawOutput;
      fullstackPlan  = fsResult.plan;
      source         = fsResult.source;
      intent         = "fullstack";
      console.log(`[AI ENGINE] Fullstack gen complete | files=${fullstackPlan?.files?.length}`);
    } catch (e) {
      console.warn(`[AI ENGINE] Fullstack gen failed, falling back: ${e.message}`);
      const fallback = await generateProjectUnified({ prompt: finalPrompt, mode: "generate", appType });
      rawOutput = fallback.rawOutput;
      source    = fallback.source;
      intent    = fallback.intent;
    }
  } else {
    const result = await generateProjectUnified({ prompt: finalPrompt, mode: "generate", appType });
    rawOutput = result.rawOutput;
    source    = result.source;
    intent    = result.intent;
  }

  const files = parseMultiFileOutput(rawOutput);

  // ── Stage 3: Validation + Auto-Repair ─────────────────────────────────────
  let finalFiles = files;
  let repairResult = null;
  try {
    const { validateAndRepair } = require("../engine/repair.engine");
    const fastCallAI = async (messages, opts) => {
      const allModels = buildModelRegistry();
      const model = allModels.find(m => _isModelHealthy(m.id));
      if (!model) return null;
      return _withModelRetry(model, messages, "repair").catch(() => null);
    };
    repairResult = await validateAndRepair(files, { callAI: fastCallAI, projectType: appType });
    finalFiles   = repairResult.files;
    if (repairResult.repairs.length) {
      console.log(`[AI ENGINE] Repairs applied: ${repairResult.repairs.join(", ")}`);
    }
    console.log(`[AI ENGINE] Quality score: ${repairResult.score}/100`);
  } catch (e) {
    console.warn(`[AI ENGINE] Repair engine failed (non-fatal): ${e.message}`);
  }

  // ── Stage 4: Save Files ────────────────────────────────────────────────────
  let existingMeta = {};
  try {
    const raw    = await fs.readFile(path.join(projectDir(projectId), "_index.json"), "utf8");
    existingMeta = JSON.parse(raw);
  } catch {}

  const meta = {
    name:   (existingMeta.name || String(prompt).slice(0, 80) || "Generated Project"),
    userId: existingMeta.userId || String(userId),
    prompt: String(prompt).slice(0, 500),
    source,
    intent,
    qualityScore:   repairResult?.score ?? null,
    projectType:    appType,
    designDirection: expandedSpec?.designDirection || "",
  };

  const index = await saveProjectFiles(projectId, finalFiles, meta);

  // ── Stage 5: Initialize Project Brain ─────────────────────────────────────
  try {
    const brain = require("../engine/project.brain");
    await brain.initBrain(projectId, {
      name:        meta.name,
      projectType: useFullstack ? (fullstackPlan?.projectType || "fullstack") : appType,
      files:       finalFiles,
      designTheme: expandedSpec?.designDirection || "",
      prompt:      String(prompt).slice(0, 200),
      // Fullstack intelligence
      stack:       fullstackPlan?.stack || null,
      routes:      fullstackPlan?.routes || [],
      dbModels:    fullstackPlan?.dbModels || [],
      envVars:     fullstackPlan?.envVars || [],
      deployTarget: fullstackPlan?.deployTarget || null,
    });
    // Auto-save initial snapshot
    await brain.saveSnapshot(projectId, finalFiles, "v1 — initial generation");
  } catch (e) {
    console.warn(`[AI ENGINE] Brain init failed (non-fatal): ${e.message}`);
  }

  console.log(
    `[AI ENGINE] generateProject complete | project: ${projectId} | ` +
    `source: ${source} | files: ${finalFiles.map(f => f.fileName).join(", ")} | ` +
    `quality: ${repairResult?.score ?? "??"}/100`
  );

  return {
    success:      true,
    projectId,
    appType:      intent,
    name:         index.name,
    files:        finalFiles.map(f => f.fileName),
    fileData:     finalFiles,
    source,
    qualityScore: repairResult?.score ?? null,
    repairs:      repairResult?.repairs ?? [],
    designDirection: expandedSpec?.designDirection || "",
    isFullstack:  useFullstack || false,
    fullstackPlan: fullstackPlan || null,
  };
}

async function editProjectFile(userId, projectId, filename, command) {
  if (!userId)   throw new Error("Unauthorized");
  if (!filename) throw new Error("filename is required");
  if (!command)  throw new Error("edit command is required");

  const safeFilename = sanitizeFileName(filename);
  if (!safeFilename) throw new Error(`Invalid or disallowed filename: ${filename}`);

  console.log(`[AI ENGINE] editProjectFile start | project: ${projectId} | file: ${safeFilename}`);

  const { files: existingFiles } = await readProjectFiles(projectId);
  if (!existingFiles.length) throw new Error("Project not found or has no files");

  const targetExists = existingFiles.some(f => f.fileName === safeFilename);
  if (!targetExists) throw new Error(`File not found in project: ${safeFilename}`);

  const previousFiles = {};
  existingFiles.forEach(f => { previousFiles[f.fileName] = f.content; });

  // ── Snapshot before edit (rollback safety) ────────────────────────────────
  try {
    const brain = require('../engine/project.brain');
    await brain.saveSnapshot(projectId, existingFiles, 'before: ' + String(command).slice(0, 40));
  } catch (e) { /* non-fatal */ }

  // ── Inject Project Brain context into edit prompt ─────────────────────────
  let enrichedCommand = command;
  try {
    const brain = require('../engine/project.brain');
    const brainCtx = await brain.getBrainContext(projectId, { focusFile: safeFilename, maxLength: 600 });
    if (brainCtx) enrichedCommand = brainCtx + "\n\nEDIT INSTRUCTION: " + command;
  } catch (e) { /* non-fatal */ }

  const { rawOutput } = await generateProjectUnified({
    prompt:        enrichedCommand,
    mode:          'edit',
    editMode:      true,
    previousFiles,
    targetFile:    safeFilename,
  });

  const parsed = parseMultiFileOutput(rawOutput);

  if (!parsed.length) {
    throw new Error("AI returned no file content for edit — file was NOT modified");
  }

  const editedFile = parsed.find(f => f.fileName === safeFilename) || parsed[0];
  if (!editedFile || !editedFile.content || editedFile.content.trim().length < 10) {
    throw new Error(`AI returned empty content for ${safeFilename} — file was NOT modified`);
  }

  const writtenFiles = [];
  // CRITICAL: only write the target file the user asked to edit.
  // AI sometimes returns multi-file output (e.g. edits CSS but also emits an
  // index.html skeleton) — writing all of them overwrites files the user never
  // intended to touch, causing blank/broken pages. Strictly ignore extras.
  const targetContent = editedFile.content;
  await writeSingleFile(projectId, safeFilename, targetContent);
  writtenFiles.push(safeFilename);

  if (writtenFiles.length === 0) {
    throw new Error("No files were written during edit — all targets were invalid");
  }

  // ── Update brain after edit ──────────────────────────────────────────────
  try {
    const brain = require('../engine/project.brain');
    const { files: updatedFileData } = await readProjectFiles(projectId).catch(() => ({ files: [] }));
    await brain.updateBrainAfterEdit(projectId, {
      files:       updatedFileData,
      instruction: command,
      updatedFiles: writtenFiles,
    });
  } catch (e) { /* non-fatal */ }

  console.log(`[AI ENGINE] editProjectFile complete | project: ${projectId} | updated: ${writtenFiles.join(", ")}`);

  return {
    success:      true,
    projectId,
    filename:     safeFilename,
    updatedFiles: writtenFiles,
  };
}

async function getProjectList(userId) {
  if (!userId) throw new Error("Unauthorized");
  const all      = await listProjects();
  const strUserId = String(userId);
  // FIX: require explicit userId match — never leak projects with missing/null userId
  const projects = all
    .filter(p => p.userId && p.userId === strUserId)
    .map(p => ({
      projectId: p.projectId,
      name:      p.name,
      fileCount: p.fileCount,
      files:     p.files,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  return { success: true, projects };
}

async function getProjectFiles(userId, projectId) {
  if (!projectId) throw new Error("projectId is required");
  const { index, files } = await readProjectFiles(projectId);
  if (!index) throw new Error("Project not found");

  const sorted = [
    ...files.filter(f => f.fileName === "index.html"),
    ...files.filter(f => f.fileName !== "index.html"),
  ];

  return {
    success:   true,
    projectId,
    name:      index.name || "Untitled Project",
    files:     sorted.map(f => f.fileName),
    fileData:  sorted,
    updatedAt: index.updatedAt || null,
  };
}

async function getProjectFile(userId, projectId, fileName) {
  if (!projectId || !fileName) throw new Error("projectId and fileName are required");
  const content = await readSingleFile(projectId, fileName);
  return { success: true, projectId, fileName, content };
}

async function saveProjectFile(userId, projectId, fileName, content) {
  if (!projectId || !fileName) throw new Error("projectId and fileName are required");
  if (content === undefined || content === null) throw new Error("content is required");
  const safeFile = sanitizeFileName(fileName);
  if (!safeFile) throw new Error(`Invalid or disallowed filename: ${fileName}`);
  await writeSingleFile(projectId, safeFile, content);
  return { success: true, projectId, fileName: safeFile };
}

async function deleteProjectById(userId, projectId) {
  if (!userId)    throw new Error("Unauthorized");
  if (!projectId) throw new Error("projectId is required");
  await deleteProject(projectId);
  console.log(`[PROJECT ENGINE] Deleted project ${projectId}`);
  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUNDLE STEP FALLBACK TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

const INSIGHT_TEMPLATES = [
  (t) => `${t} requires iterative validation to ensure quality output.`,
  (t) => `Key success metric for ${t}: measurable, time-bound deliverable.`,
  (t) => `${t} should be reviewed against initial goals before proceeding.`,
  (t) => `Automating ${t} reduces friction and improves consistency.`,
  (t) => `Cross-functional alignment on ${t} accelerates downstream execution.`,
  (t) => `Document all decisions made during ${t} for audit trail.`,
  (t) => `Risk surface in ${t} is minimized by parallel validation tracks.`,
  (t) => `${t} completion unlocks the critical path to the next milestone.`,
];

const OUTPUT_TEMPLATES = [
  (step, goal) =>
    `## ${step.title || "Step Output"}\n\n` +
    `**Execution Summary:**\n` +
    `This step focused on "${step.description || step.title}". ` +
    `Key deliverables have been identified and structured for downstream use.\n\n` +
    `**Goal Alignment:** ${goal || "No goal specified"}\n\n` +
    `**Next Action:** Review outputs and validate against acceptance criteria.`,

  (step, goal) =>
    `# ${step.title || "Step Complete"}\n\n` +
    `**Summary:** Completed analysis for "${step.description || step.title}".\n\n` +
    `**Key Outputs:**\n` +
    `- Primary deliverable drafted and ready for review\n` +
    `- Dependencies identified and documented\n` +
    `- Risk factors assessed\n\n` +
    `**Goal:** ${goal || "Not specified"}`,

  (step) =>
    `### ${step.title || "Progress Update"}\n\n` +
    `Completed: ${step.description || step.title}\n\n` +
    `This step has been executed according to the defined workflow. ` +
    `All outputs are available for the next phase of execution.`,
];

function generateInsights(title, idx) {
  return INSIGHT_TEMPLATES
    .slice(idx % INSIGHT_TEMPLATES.length)
    .concat(INSIGHT_TEMPLATES.slice(0, idx % INSIGHT_TEMPLATES.length))
    .slice(0, MAX_INSIGHTS)
    .map(fn => fn(title));
}

function generateNextHints(step, steps, idx) {
  const next = steps[idx + 1];
  if (!next) return ["Review all completed steps", "Finalize deliverables", "Archive project artifacts"];
  return [
    `Prepare inputs for: ${next.title || `Step ${idx + 2}`}`,
    `Verify completion criteria for current step`,
    `Align on dependencies before proceeding`,
  ];
}

function generateStepOutput(step, bundle, idx) {
  const templateFn = OUTPUT_TEMPLATES[idx % OUTPUT_TEMPLATES.length];
  const content    = templateFn(step, bundle?.goal || bundle?.title || "");

  return {
    stepIndex:       idx,
    stepTitle:       step.title || `Step ${idx + 1}`,
    content,
    keyInsights:     generateInsights(step.title || `Step ${idx + 1}`, idx),
    nextStepHints:   generateNextHints(step, Array.isArray(bundle?.steps) ? bundle.steps : [], idx),
    confidenceScore: 0.85,
    tokensUsed:      Math.floor(content.length / 4),
    durationMs:      null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKSPACE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getOrCreateWorkspace(userId) {
  if (!userId) throw new Error("Unauthorized");
  let ws = await Workspace.findOne({ userId });
  if (!ws) ws = await new Workspace({ userId }).save();
  return ws;
}

function buildProgressArray(steps, existingProgress = []) {
  return steps.map((_, idx) => {
    const existing = existingProgress.find(p => p && p.step === idx);
    return existing || { step: idx, status: "pending", completedAt: null };
  });
}

function validateBundleId(bundleId) {
  if (!bundleId || !mongoose.Types.ObjectId.isValid(bundleId)) {
    throw new Error("Invalid bundleId");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SANITIZERS — strip internal fields before sending to client
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeBundleForClient(bundle) {
  if (!bundle) return null;
  const obj = bundle.toObject ? bundle.toObject() : { ...bundle };
  return obj;
}

function sanitizeWorkspaceForClient(ws) {
  if (!ws) return null;
  const obj = ws.toObject ? ws.toObject() : { ...ws };
  if (obj.workspaceMemory instanceof Map) {
    obj.workspaceMemory = Object.fromEntries(obj.workspaceMemory);
  }
  return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKSPACE STATE
// ─────────────────────────────────────────────────────────────────────────────

async function getWorkspaceState(userId) {
  if (!userId) throw new Error("Unauthorized");
  const ws = await getOrCreateWorkspace(userId);

  const recentBundleIds = (ws.sessions || [])
    .filter(s => s && s.bundleId)
    .slice(-MAX_SESSIONS)
    .map(s => s.bundleId);

  const [recentBundles, allBundles] = await Promise.all([
    Bundle.find({ _id: { $in: recentBundleIds }, userId }).lean(),
    Bundle.find({ userId }).sort({ updatedAt: -1 }).limit(20).lean(),
  ]);

  const mem = ws.workspaceMemory instanceof Map
    ? Object.fromEntries(ws.workspaceMemory)
    : ws.workspaceMemory || {};

  return {
    success:      true,
    workspace:    sanitizeWorkspaceForClient(ws),
    recentBundles,
    allBundles,
    workspaceMemory: mem,
  };
}

async function getBundleState(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");
  const bundle = await Bundle.findOne({ _id: bundleId, userId });
  if (!bundle) throw new Error("Bundle not found");
  return { success: true, bundle: sanitizeBundleForClient(bundle) };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUNDLE EXECUTION
// ─────────────────────────────────────────────────────────────────────────────

async function runBundle(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");

  const [ws, bundle] = await Promise.all([
    getOrCreateWorkspace(userId),
    Bundle.findOne({ _id: bundleId, userId }),
  ]);

  if (!bundle) throw new Error("Bundle not found");
  if (bundle.status === "completed") {
    return { success: true, bundle: sanitizeBundleForClient(bundle), alreadyComplete: true };
  }

  const steps = Array.isArray(bundle.steps) ? bundle.steps : [];
  if (steps.length === 0) throw new Error("Bundle has no steps");

  bundle.progress = buildProgressArray(steps, bundle.progress || []);
  bundle.status      = "active";
  bundle.currentStep = bundle.progress.findIndex(p => p && p.status !== "completed");
  if (bundle.currentStep === -1) bundle.currentStep = 0;

  if (typeof ws.openSession === "function") ws.openSession(bundleId, steps.length);
  ws.lastOpenBundleId = bundle._id;

  await Promise.all([bundle.save(), ws.save()]);

  return {
    success:   true,
    bundle:    sanitizeBundleForClient(bundle),
    workspace: sanitizeWorkspaceForClient(ws),
  };
}

async function completeStep(userId, bundleId, stepParam, payload = {}) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");

  const idx = parseInt(stepParam, 10);
  if (isNaN(idx) || idx < 0) throw new Error("Invalid step index");

  const [ws, bundle] = await Promise.all([
    getOrCreateWorkspace(userId),
    Bundle.findOne({ _id: bundleId, userId }),
  ]);

  if (!bundle) throw new Error("Bundle not found");
  if (bundle.status === "paused") throw new Error("Bundle is paused — resume before completing steps");

  const steps = Array.isArray(bundle.steps) ? bundle.steps : [];
  if (idx >= steps.length) throw new Error(`Step ${idx} out of range (bundle has ${steps.length} steps)`);

  if (!Array.isArray(bundle.progress) || bundle.progress.length !== steps.length) {
    bundle.progress = buildProgressArray(steps, bundle.progress || []);
  }

  let outputEntry;

  const useAI = payload.useAI === true || payload.aiGenerate === true;
  if (useAI) {
    try {
      const stepPrompt =
        `Project: ${bundle.title || "Untitled"}\n` +
        `Goal: ${bundle.goal || "No goal specified"}\n` +
        `Step: ${steps[idx]?.title || `Step ${idx + 1}`}\n` +
        `Description: ${steps[idx]?.description || "No description"}\n\n` +
        `Provide a detailed, actionable output for this step.`;

      const aiRes     = await generateProjectUnified({ prompt: stepPrompt, mode: "generate" });
      const rawOutput = aiRes.rawOutput;

      outputEntry = {
        stepIndex:       idx,
        stepTitle:       steps[idx]?.title || `Step ${idx + 1}`,
        content:         rawOutput,
        keyInsights:     generateInsights(steps[idx]?.title || `Step ${idx + 1}`, idx),
        nextStepHints:   generateNextHints(steps[idx], steps, idx),
        confidenceScore: 0.95,
        tokensUsed:      rawOutput.length / 4 | 0,
        durationMs:      null,
        projectId:       bundleId,
        files:           [],
        createdAt:       new Date(),
      };
    } catch (llmErr) {
      console.error("[AI ERROR] completeStep | AI generation error:", llmErr.message);
      const fallback = generateStepOutput(steps[idx] || {}, bundle, idx);
      outputEntry = {
        ...fallback,
        content:   `⚠️ Code generation failed: ${llmErr.message}\n\n${fallback.content}`,
        createdAt: new Date(),
      };
    }
  } else {
    const autoOutput = generateStepOutput(steps[idx] || {}, bundle, idx);
    outputEntry = {
      stepIndex:       idx,
      stepTitle:       payload.title            || autoOutput.stepTitle,
      content:         payload.content          || autoOutput.content,
      keyInsights:     payload.keyInsights      || autoOutput.keyInsights,
      nextStepHints:   payload.nextStepHints    || autoOutput.nextStepHints,
      confidenceScore: payload.confidenceScore !== undefined ? payload.confidenceScore : autoOutput.confidenceScore,
      tokensUsed:      payload.tokensUsed       || autoOutput.tokensUsed,
      durationMs:      payload.durationMs       || autoOutput.durationMs,
      createdAt:       new Date(),
    };
  }

  const progEntry = bundle.progress.find((p) => p && p.step === idx);
  if (progEntry) { progEntry.status = "completed"; progEntry.completedAt = new Date(); }
  else           bundle.progress.push({ step: idx, status: "completed", completedAt: new Date() });

  bundle.outputs = (bundle.outputs || []).filter((o) => o && o.stepIndex !== idx);
  bundle.outputs.push(outputEntry);

  const memEntries = payload.memoryEntries || {};
  if (bundle.memory instanceof Map) {
    for (const [k, v] of Object.entries(memEntries)) { if (k && v) bundle.memory.set(k.trim(), String(v).trim()); }
  } else {
    if (!bundle.memory || typeof bundle.memory !== "object") bundle.memory = {};
    for (const [k, v] of Object.entries(memEntries)) { if (k && v) bundle.memory[k.trim()] = String(v).trim(); }
  }

  const nextPending = bundle.progress.findIndex((p, i) => i > idx && p && p.status !== "completed");
  if (nextPending !== -1) { bundle.currentStep = nextPending; bundle.status = "active"; }
  else {
    const allDone      = bundle.progress.every((p) => p && p.status === "completed");
    bundle.status      = allDone ? "completed" : "active";
    bundle.currentStep = allDone ? steps.length - 1 : bundle.currentStep;
  }

  if (typeof ws.pushRecentOutput === "function") {
    ws.pushRecentOutput({
      bundleId, bundleTitle: bundle.title || "Untitled",
      stepIndex: idx, stepTitle: outputEntry.stepTitle, content: outputEntry.content || "",
    });
  }
  if (typeof ws.mergeWorkspaceMemory === "function") ws.mergeWorkspaceMemory(memEntries);

  if (bundle.status === "completed") {
    if (typeof ws.closeSession  === "function") ws.closeSession(bundleId, "completed");
  } else {
    if (typeof ws.updateSession === "function") ws.updateSession(bundleId, { currentStep: bundle.currentStep, status: "running" });
  }

  await Promise.all([bundle.save(), ws.save()]);

  return {
    success:   true,
    bundle:    sanitizeBundleForClient(bundle),
    workspace: sanitizeWorkspaceForClient(ws),
    output:    outputEntry,
  };
}

async function pauseBundle(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");
  const [ws, bundle] = await Promise.all([getOrCreateWorkspace(userId), Bundle.findOne({ _id: bundleId, userId })]);
  if (!bundle) throw new Error("Bundle not found");
  if (bundle.status === "completed") throw new Error("Cannot pause a completed bundle");
  if (bundle.status === "paused") return { success: true, bundle: sanitizeBundleForClient(bundle) };
  bundle.status = "paused";
  if (typeof ws.updateSession === "function") ws.updateSession(bundleId, { status: "paused" });
  await Promise.all([bundle.save(), ws.save()]);
  return { success: true, bundle: sanitizeBundleForClient(bundle), workspace: sanitizeWorkspaceForClient(ws) };
}

async function resumeBundle(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");
  const [ws, bundle] = await Promise.all([getOrCreateWorkspace(userId), Bundle.findOne({ _id: bundleId, userId })]);
  if (!bundle) throw new Error("Bundle not found");
  if (bundle.status === "completed") throw new Error("Bundle already completed");
  const steps    = Array.isArray(bundle.steps) ? bundle.steps : [];
  const progress = Array.isArray(bundle.progress) ? bundle.progress : buildProgressArray(steps, []);
  bundle.progress    = progress;
  const resumeFrom   = progress.findIndex((p) => p && p.status !== "completed");
  bundle.currentStep = resumeFrom !== -1 ? resumeFrom : 0;
  bundle.status      = "active";
  if (typeof ws.openSession === "function") ws.openSession(bundleId, steps.length);
  ws.lastOpenBundleId = bundle._id;
  await Promise.all([bundle.save(), ws.save()]);
  return { success: true, bundle: sanitizeBundleForClient(bundle), workspace: sanitizeWorkspaceForClient(ws) };
}

async function pinBundle(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");
  const ws = await getOrCreateWorkspace(userId);
  if (!Array.isArray(ws.pinnedBundles)) ws.pinnedBundles = [];
  const already = ws.pinnedBundles.some((id) => id && id.toString() === bundleId.toString());
  if (!already) { ws.pinnedBundles.push(new mongoose.Types.ObjectId(bundleId)); await ws.save(); }
  return { success: true, pinned: true, pinnedBundleIds: ws.pinnedBundles.map((id) => id.toString()) };
}

async function unpinBundle(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");
  const ws = await getOrCreateWorkspace(userId);
  if (!Array.isArray(ws.pinnedBundles)) ws.pinnedBundles = [];
  ws.pinnedBundles = ws.pinnedBundles.filter((id) => id && id.toString() !== bundleId.toString());
  await ws.save();
  return { success: true, pinned: false, pinnedBundleIds: ws.pinnedBundles.map((id) => id.toString()) };
}

async function updateWorkspaceMemory(userId, entries = {}) {
  if (!userId) throw new Error("Unauthorized");
  if (!entries || typeof entries !== "object") return { success: true };
  const ws = await getOrCreateWorkspace(userId);
  if (typeof ws.mergeWorkspaceMemory === "function") {
    ws.mergeWorkspaceMemory(entries);
  } else {
    for (const [k, v] of Object.entries(entries)) {
      if (k && v && ws.workspaceMemory instanceof Map) ws.workspaceMemory.set(k.trim(), String(v).trim());
    }
  }
  await ws.save();
  const mem = ws.workspaceMemory instanceof Map ? Object.fromEntries(ws.workspaceMemory) : ws.workspaceMemory || {};
  return { success: true, workspaceMemory: mem };
}

async function autoProgressNext(userId, bundleId) {
  try {
    const bundle = await Bundle.findOne({ _id: bundleId, userId });
    if (!bundle || bundle.status !== "active") return null;
    const steps = Array.isArray(bundle.steps) ? bundle.steps : [];
    const next  = (Array.isArray(bundle.progress) ? bundle.progress : []).findIndex(
      (p) => p && p.status !== "completed"
    );
    if (next === -1 || next >= steps.length) return null;
    return await completeStep(userId, bundleId, next, {});
  } catch (err) {
    console.error("[AI ERROR] autoProgressNext |", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// safeEditFiles — multi-file edit with brain context, rollback, and repair
// ─────────────────────────────────────────────────────────────────────────────

/**
 * safeEditFiles(userId, projectId, fileNames, instruction, opts)
 *
 * Edits one or more project files with:
 *  - Brain context injection
 *  - Pre-edit snapshot for rollback
 *  - Per-file generation with context
 *  - Post-edit validation
 *  - Auto-rollback on critical failure
 *
 * @returns {{ success, updatedFiles, skipped, errors, rolledBack }}
 */
async function safeEditFiles(userId, projectId, fileNames, instruction, opts = {}) {
  const { contextSummary = "" } = opts;

  if (!userId)    throw new Error("Unauthorized");
  if (!projectId) throw new Error("projectId required");
  if (!fileNames?.length) return { success: false, updatedFiles: [], skipped: [], errors: ["No files specified"], rolledBack: false };

  const { files: existingFiles } = await readProjectFiles(projectId);
  if (!existingFiles.length) return { success: false, updatedFiles: [], skipped: [], errors: ["Project not found or empty"], rolledBack: false };

  // Build previous files map for rollback + context
  const previousFiles = {};
  existingFiles.forEach(f => { previousFiles[f.fileName] = f.content; });

  // Snapshot before edit
  try {
    const brain = require("../engine/project.brain");
    await brain.saveSnapshot(projectId, existingFiles, "before: " + String(instruction).slice(0, 40));
  } catch (e) { /* non-fatal */ }

  const updatedFiles = [];
  const skipped      = [];
  const errors       = [];

  // Inject Brain context
  let brainCtx = "";
  try {
    const brain = require("../engine/project.brain");
    brainCtx = await brain.getBrainContext(projectId, { maxLength: 500 });
  } catch (e) { /* non-fatal */ }

  const allContext = [brainCtx, contextSummary].filter(Boolean).join("\n");

  for (const fileName of fileNames) {
    const safeFilename = sanitizeFileName(fileName);
    if (!safeFilename) { skipped.push({ fileName, errors: ["Invalid filename"] }); continue; }
    if (!previousFiles[safeFilename]) { skipped.push({ fileName: safeFilename, errors: ["File not found"] }); continue; }

    try {
      // Build enriched instruction for this file
      const enrichedInstruction = allContext
        ? allContext + "\n\nEDIT INSTRUCTION: " + instruction
        : instruction;

      const { rawOutput } = await generateProjectUnified({
        prompt:        enrichedInstruction,
        mode:          "edit",
        editMode:      true,
        previousFiles,
        targetFile:    safeFilename,
      });

      // Parse the output for this specific file
      const parsed = parseMultiFileOutput(rawOutput);
      const updated = parsed.find(f => f.fileName === safeFilename);

      if (!updated || !updated.content || updated.content.trim().length < 10) {
        errors.push(`${safeFilename}: AI returned empty/invalid content`);
        skipped.push({ fileName: safeFilename, errors: ["Empty AI output"] });
        continue;
      }

      // Write file
      await writeSingleFile(projectId, safeFilename, updated.content);
      updatedFiles.push(safeFilename);

    } catch (e) {
      errors.push(`${safeFilename}: ${e.message}`);
      skipped.push({ fileName: safeFilename, errors: [e.message] });
    }
  }

  // If ALL files failed, attempt rollback
  if (updatedFiles.length === 0 && fileNames.length > 0) {
    try {
      for (const fn of fileNames) {
        const sf = sanitizeFileName(fn);
        if (sf && previousFiles[sf]) await writeSingleFile(projectId, sf, previousFiles[sf]);
      }
    } catch (e) { /* rollback best-effort */ }

    return { success: false, updatedFiles: [], skipped, errors, rolledBack: true };
  }

  // Update brain after successful edits
  try {
    const brain = require("../engine/project.brain");
    const { files: updatedFileData } = await readProjectFiles(projectId).catch(() => ({ files: [] }));
    await brain.updateBrainAfterEdit(projectId, {
      files:       updatedFileData,
      instruction: String(instruction).slice(0, 200),
      updatedFiles,
    });
  } catch (e) { /* non-fatal */ }

  return {
    success:      true,
    updatedFiles,
    skipped,
    errors,
    rolledBack:   false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVENIENCE RE-EXPORTS — new engine modules
// ─────────────────────────────────────────────────────────────────────────────

const _promptExpander = require("../engine/prompt.expander");
const _projectBrain   = require("../engine/project.brain");
const _repairEngine   = require("../engine/repair.engine");

module.exports = {
  generateProjectUnified,
  getWorkspaceState,
  getBundleState,
  runBundle,
  completeStep,
  pauseBundle,
  resumeBundle,
  pinBundle,
  unpinBundle,
  updateWorkspaceMemory,
  autoProgressNext,
  createProject,
  generateProject,
  editProjectFile,
  getProjectList,
  getProjectFiles,
  getProjectFile,
  saveProjectFile,
  deleteProjectById,
  detectAppType,
  isFullstackPrompt,
  generateFullstackProject,
  parseMultiFileOutput,
  readSingleFile,
  writeSingleFile,
  saveProjectFiles,
  projectDir,
  PROJECTS_DIR,
  safeEditFiles,
  // New engine modules
  promptExpander: _promptExpander,
  projectBrain:   _projectBrain,
  repairEngine:   _repairEngine,
};