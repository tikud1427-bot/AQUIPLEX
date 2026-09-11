/**
 * AQUA Artifact Engine — PPTX Exporter (P2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Real PowerPoint decks via pptxgenjs (the library the CTO pitch deck was
 * hand-built with — this productizes that layout knowledge). Content model
 * ('slides') is a title slide + bulleted content slides with speaker notes;
 * layout is DETERMINISTIC — the LLM decides words, this module decides
 * geometry, so every deck comes out aligned.
 *
 * Theme: 'light' (default) or 'dark' via spec.theme / model.theme — the
 * dark palette matches the hand-built investor deck aesthetic.
 */
import PptxGenJS from 'pptxgenjs';
import { registerExporter } from './registry.js';
import { ensureExtension, cleanStringList } from './common.js';

const SLIDES_SCHEMA_HINT = `{
  "title": "<deck title>",
  "subtitle": "<one-line subtitle>",
  "theme": "light",
  "slides": [
    { "title": "<slide heading>", "bullets": ["<point>", "<point>"], "notes": "<speaker notes>" }
  ]
}
("theme" is "light" or "dark"; 8-15 slides for a full deck unless the user asked otherwise; 3-6 tight bullets per slide — never paragraphs)`;

const GUIDANCE = 'A real presentation deck: one idea per slide, 3-6 tight bullets (max ~12 words each), concrete numbers over adjectives, speaker notes that carry the narration.';

const LIMITS = { MAX_SLIDES: 50, MAX_BULLETS: 8, MAX_BULLET_LEN: 220, MAX_NOTES: 2_000 };

const THEMES = {
  light: { bg: 'FFFFFF', ink: '1A1A1E', soft: '6B6B73', accent: '6C5CE7', bar: 'EDEBFB' },
  dark:  { bg: '111114', ink: 'F4F4F6', soft: 'A0A0AA', accent: '8B7CF6', bar: '1E1E26' },
};

function normalizeModel(json, spec) {
  const theme = json?.theme === 'dark' || spec.theme === 'dark' ? 'dark' : 'light';
  const slides = [];
  for (const raw of Array.isArray(json?.slides) ? json.slides : []) {
    if (slides.length >= LIMITS.MAX_SLIDES) break;
    if (!raw || typeof raw !== 'object') continue;
    const title   = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '';
    const bullets = cleanStringList(raw.bullets, LIMITS.MAX_BULLETS, LIMITS.MAX_BULLET_LEN);
    if (!title && !bullets.length) continue;
    slides.push({
      title: title || `Slide ${slides.length + 1}`,
      bullets,
      notes: typeof raw.notes === 'string' ? raw.notes.trim().slice(0, LIMITS.MAX_NOTES) : '',
    });
  }
  return {
    title:    (typeof json?.title === 'string' && json.title.trim()) ? json.title.trim().slice(0, 200) : spec.title,
    subtitle: typeof json?.subtitle === 'string' ? json.subtitle.trim().slice(0, 300) : '',
    theme,
    slides,
  };
}

registerExporter('pptx', {
  label: 'PowerPoint presentation',
  extensions: ['.pptx'],
  mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  contentModel: 'slides',
  guidance: GUIDANCE,
  schemaHint: SLIDES_SCHEMA_HINT, // P5 — model-edit prompts reuse the build schema

  async build({ spec, helpers }) {
    const json = await helpers.generateJson({
      spec, file: spec.files[0], schemaHint: SLIDES_SCHEMA_HINT, formatGuidance: GUIDANCE,
    });
    return normalizeModel(json, spec);
  },

  validate(model) {
    const errors = [];
    if (!model?.slides?.length) errors.push('deck model produced no slides');
    for (const s of model?.slides ?? []) {
      if (!s.bullets.length && s === model.slides[0]) continue; // section-divider slides allowed
    }
    return { valid: errors.length === 0, errors };
  },

  async export(model, { spec }) {
    const T = THEMES[model.theme] ?? THEMES.light;
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
    pptx.layout = 'WIDE';
    pptx.author = 'AQUA';
    pptx.title  = model.title;

    // ── Title slide ──
    const cover = pptx.addSlide();
    cover.background = { color: T.bg };
    cover.addShape('rect', { x: 0, y: 0, w: 0.28, h: 7.5, fill: { color: T.accent } });
    cover.addText(model.title, {
      x: 0.9, y: 2.5, w: 11.5, h: 1.6,
      fontFace: 'Calibri', fontSize: 40, bold: true, color: T.ink, align: 'left',
    });
    if (model.subtitle) {
      cover.addText(model.subtitle, {
        x: 0.9, y: 4.05, w: 11.0, h: 0.9,
        fontFace: 'Calibri', fontSize: 18, color: T.soft, align: 'left',
      });
    }

    // ── Content slides ──
    for (const s of model.slides) {
      const slide = pptx.addSlide();
      slide.background = { color: T.bg };
      slide.addShape('rect', { x: 0, y: 0, w: 13.33, h: 0.14, fill: { color: T.accent } });
      slide.addText(s.title, {
        x: 0.7, y: 0.45, w: 12.0, h: 0.9,
        fontFace: 'Calibri', fontSize: 28, bold: true, color: T.ink,
      });
      slide.addShape('rect', { x: 0.72, y: 1.36, w: 1.1, h: 0.06, fill: { color: T.accent } });

      if (s.bullets.length) {
        slide.addText(
          s.bullets.map(b => ({ text: b, options: { bullet: { code: '2022', indent: 14 }, breakLine: true } })),
          {
            x: 0.75, y: 1.75, w: 11.9, h: 5.1,
            fontFace: 'Calibri', fontSize: 17, color: T.ink,
            lineSpacingMultiple: 1.35, valign: 'top',
          },
        );
      }
      if (s.notes) slide.addNotes(s.notes);
    }

    const buffer = await pptx.write({ outputType: 'nodebuffer' });
    return {
      files: [{
        path: ensureExtension(spec.files[0].path, '.pptx'),
        buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }],
    };
  },
});

export {};
