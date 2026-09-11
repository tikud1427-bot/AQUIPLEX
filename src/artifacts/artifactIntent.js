/**
 * AQUA Artifact Engine — Intent Detector (P1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, deterministic, <1ms, zero-LLM — the same discipline as
 * classifier.js and chat.js's isEditIntent(). Decides whether a message is
 * asking AQUA to PRODUCE A FILE, and (when stated or strongly implied) which
 * format. The planner LLM refines the *shape* of the artifact later; it never
 * re-decides *whether* one was wanted.
 *
 * Deliberately conservative — the negative gates are copied from the edit
 * branch's philosophy: questions, how-tos, and explicit "just explain / no
 * file" phrasing ALWAYS take the normal chat path. A missed artifact is a
 * mild inconvenience (the user rephrases); a false positive turns a simple
 * answer into an unwanted download. The detector also returns wants:false
 * when it finds no format signal at all — "write a poem" stays a chat
 * answer; "write a poem as a markdown file" becomes an artifact.
 *
 * Formats map to their TRUE target (pitch deck → pptx) even when that
 * exporter isn't registered yet — the engine gates on the live registry, so
 * P2/P3 formats switch on with zero detector changes. Until then those
 * requests fall through to normal chat, which answers inline (honest, never
 * a wrong-format file).
 */

/** Detector floor — chat.js compares against this before branching. */
export const MIN_ARTIFACT_CONFIDENCE = 0.65;

// ── Negative gates (checked first — any hit means normal chat) ────────────────

const QUESTION_RE     = /^(how|what|why|where|when|which|who|is|are|does|do|should|can|could|would|will|explain|describe|show\s+me|tell\s+me|walk\s+me)\b/i;
const HOWTO_RE        = /\bhow\s+(do|can|would|to|should)\b/i;
const INLINE_ONLY_RE  = /\b(don'?t|do\s+not|no\s+need\s+to)\s+(generate|create|make|produce|export)\b|\b(no\s+(file|download|artifact)s?|inline|in\s+chat|in\s+the\s+chat|just\s+(show|tell|explain|answer|reply)|explain\s+only|as\s+text\s+here)\b/i;

// ── Positive gates ────────────────────────────────────────────────────────────

const VERB_RE = /\b(create|generate|make|build|write|draft|produce|compose|prepare|export|put\s+together|give\s+me|design|draw|sketch|diagram)\b/i;

// Generic "I want this as a file" cues — allow wants:true with format:null
// (planner resolves format) when a verb is present but no specific format
// noun matched.
const FILEISH_RE = /\b(as\s+a\s+(file|download|document)|downloadable|a\s+file\s+(i|that\s+i)\s+can\s+download|save\s+(it\s+)?as|file\s+for\s+me|\.([a-z0-9]{1,5})\s+file)\b/i;

// ── Explicit format statements ("export as PPTX", "as a .docx file") ─────────
// An explicitly NAMED format is the user's own word and must outrank any
// deliverable noun: "Create a report… Export as PPTX" is a DECK, not the pdf
// that "report" would otherwise imply. Requires an export/format context —
// a bare mention ("a report about PDF parsing") must NOT match.
const FORMAT_TOKENS = {
  pptx:  'pptx|ppt|powerpoint|power\\s*point|keynote',
  docx:  'docx|word\\s+doc(?:ument)?|ms\\s*word',
  xlsx:  'xlsx|xls|excel|spreadsheet|workbook',
  pdf:   'pdf',
  csv:   'csv',
  md:    'md|markdown',
  html:  'html',
  json:  'json',
  yaml:  'ya?ml',
  svg:   'svg',
  sql:   'sql',
  mermaid: 'mermaid',
};

/** "export/save/output/deliver ... as|in|to [a] <fmt>" and "<fmt> file/format". */
const EXPLICIT_FORMAT_RULES = Object.entries(FORMAT_TOKENS).flatMap(([format, alts]) => ([
  { re: new RegExp(`\\b(?:as|in|into|to)\\s+(?:an?\\s+)?(?:${alts})\\b`, 'i'), format, conf: 0.95 },
  { re: new RegExp(`\\b(?:${alts})\\s+(?:file|format|version|export|output|attachment)\\b`, 'i'), format, conf: 0.95 },
  { re: new RegExp(`\\b(?:export|save|output|download)(?:\\s+\\w+){0,3}\\s+(?:${alts})\\b`, 'i'), format, conf: 0.9 },
]));

/**
 * Ordered format rules. First match wins — order therefore encodes
 * precedence (explicit extension beats explicit format statement beats
 * deliverable noun; specific nouns beat generic ones). `conf` is the
 * detector's confidence, not the classifier's.
 */
const FORMAT_RULES = [
  // ── Explicit extensions (highest confidence) ──
  { re: /\.pptx\b/i,                          format: 'pptx',      conf: 0.95 },
  { re: /\.docx\b/i,                          format: 'docx',      conf: 0.95 },
  { re: /\.xlsx\b/i,                          format: 'xlsx',      conf: 0.95 },
  { re: /\.pdf\b/i,                           format: 'pdf',       conf: 0.95 },
  { re: /\.csv\b/i,                           format: 'csv',       conf: 0.95 },
  { re: /\.md\b|\.markdown\b/i,               format: 'md',        conf: 0.95 },
  { re: /\.html?\b/i,                         format: 'html',      conf: 0.95 },
  { re: /\.svg\b/i,                           format: 'svg',       conf: 0.95 },
  { re: /\.json\b/i,                          format: 'json',      conf: 0.95 },
  { re: /\.ya?ml\b/i,                         format: 'yaml',      conf: 0.95 },
  { re: /\.xml\b/i,                           format: 'xml',       conf: 0.95 },
  { re: /\.sql\b/i,                           format: 'sql',       conf: 0.95 },
  { re: /\.sh\b/i,                            format: 'sh',        conf: 0.95 },
  { re: /\.bat\b/i,                           format: 'bat',       conf: 0.95 },
  { re: /\.zip\b/i,                           format: 'project',   conf: 0.9  },
  { re: /\.(tar\.gz|tgz|tar)\b/i,             format: 'project',   conf: 0.9  },

  // ── Explicit format statements — outrank deliverable nouns (see above) ──
  ...EXPLICIT_FORMAT_RULES,

  // ── Explicit format-name words (outrank deliverable nouns — "study notes
  //    as a markdown file" is md, not pdf) ──
  { re: /\bmarkdown\b/i,                      format: 'md',        conf: 0.9  },
  { re: /\bcsv\b/i,                           format: 'csv',       conf: 0.9  },
  { re: /\bsvg\b/i,                           format: 'svg',       conf: 0.9  },
  { re: /\bmermaid\b/i,                       format: 'mermaid',   conf: 0.9  },
  { re: /\byaml\s+file\b/i,                   format: 'yaml',      conf: 0.9  },
  { re: /\bjson\s+file\b/i,                   format: 'json',      conf: 0.9  },
  { re: /\bxml\s+file\b/i,                    format: 'xml',       conf: 0.9  },
  { re: /\bhtml\s+(file|page)\b/i,            format: 'html',      conf: 0.9  },

  // ── Deliverable nouns → true target format ──
  { re: /\b(pitch\s*deck|slide\s*deck|presentation|powerpoint|investor\s+deck|slides)\b/i, format: 'pptx', conf: 0.9 },
  { re: /\b(word\s+doc(ument)?)\b/i,                                           format: 'docx', conf: 0.9 },
  { re: /\b(spreadsheet|financial\s+model|budget\s+(sheet|tracker)|excel)\b/i, format: 'xlsx', conf: 0.9 },
  { re: /\b(invoice|resume|cv\b|cover\s+letter|whitepaper|white\s+paper|research\s+paper|report|e-?book|study\s+notes|certificate)\b/i, format: 'pdf', conf: 0.85 },
  { re: /\b(readme|documentation|docs?\s+file|cheat\s*sheet|study\s+guide|notes\s+file|blog\s+post\s+file|markdown)\b/i, format: 'md',  conf: 0.85 },
  { re: /\b(landing\s+page|web\s*page|html\s+page|portfolio\s+(page|site))\b/i, format: 'html', conf: 0.85 },
  { re: /\b(mermaid|flow\s*chart|architecture\s+diagram|sequence\s+diagram|class\s+diagram|mind\s*map|er\s+diagram)\b/i, format: 'mermaid', conf: 0.85 },
  { re: /\b(svg|vector\s+(graphic|logo|icon)|logo\s+file|icon\s+file)\b/i,     format: 'svg',  conf: 0.85 },
  { re: /\b(openapi|swagger)\s*(spec(ification)?|file|doc)?\b/i,               format: 'openapi', conf: 0.9 },
  { re: /\bpostman\s+collection\b/i,                                           format: 'postman', conf: 0.9 },
  { re: /\bdocker\s*file\b/i,                                                  format: 'dockerfile', conf: 0.9 },
  { re: /\b(docker\s+compose)\b/i,                                             format: 'yaml', conf: 0.85 },
  { re: /\b(kubernetes|k8s)\s+(manifest|deployment|config)s?\b/i,              format: 'k8s',  conf: 0.85 },
  { re: /\bterraform\s+(project|config(uration)?|module|files?)\b/i,           format: 'terraform', conf: 0.85 },
  { re: /\b(sql\s+(dump|schema|script)|database\s+(schema|dump|script))\b/i,   format: 'sql',  conf: 0.85 },
  { re: /\b(shell\s+script|bash\s+script)\b/i,                                 format: 'sh',   conf: 0.85 },
  { re: /\b(batch\s+(file|script))\b/i,                                        format: 'bat',  conf: 0.85 },

  // ── Multi-file project intents (P3 exporter; detector maps truthfully now) ──
  { re: /\b(saas|full[-\s]?stack|entire\s+project|boilerplate|starter\s+(kit|template)|scaffold|clone\s+of|airbnb\s+clone|repo(sitory)?\s+structure|project\s+structure|codebase)\b/i, format: 'project', conf: 0.8 },
  { re: /\b(react|next(\.?js)?|vue|angular|svelte)\s+(app|project|application)\b/i, format: 'project', conf: 0.8 },
  { re: /\b(node(\.?js)?\s+(backend|server|api|project)|express\s+(app|api|server))\b/i, format: 'project', conf: 0.8 },
  { re: /\b(python|java|go(lang)?|rust|c\+\+|flutter|swift|kotlin|android(\s+studio)?)\s+(app|project|application|package)\b/i, format: 'project', conf: 0.8 },
  { re: /\b(zip|tar(ball)?|archive)\s*(it|this|them|file|of)?\b/i,             format: 'project', conf: 0.7 },
];

/**
 * @param {string} userMessage
 * @param {{ hasWorkspaceId?: boolean }} [_ctx] reserved for future gating
 * @returns {{ wants: false, reason: string }
 *         | { wants: true, format: string|null, confidence: number, reason: string, matched?: string }}
 */
export function detectArtifactIntent(userMessage, _ctx = {}) {
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    return { wants: false, reason: 'empty message' };
  }
  const msg = userMessage.trim();

  // Negative gates — mirror the edit branch: questions always explain.
  if (msg.endsWith('?'))        return { wants: false, reason: 'question (trailing ?)' };
  if (QUESTION_RE.test(msg))    return { wants: false, reason: 'question phrasing' };
  if (HOWTO_RE.test(msg))       return { wants: false, reason: 'how-to phrasing' };
  if (INLINE_ONLY_RE.test(msg)) return { wants: false, reason: 'explicit inline/no-file request' };

  if (!VERB_RE.test(msg)) {
    return { wants: false, reason: 'no creation verb' };
  }

  for (const rule of FORMAT_RULES) {
    const m = rule.re.exec(msg);
    if (m) {
      return {
        wants: true,
        format: rule.format,
        confidence: rule.conf,
        matched: m[0],
        reason: `creation verb + "${m[0]}" → ${rule.format}`,
      };
    }
  }

  // Verb + generic file cue, no specific format — planner resolves format.
  if (FILEISH_RE.test(msg)) {
    return {
      wants: true,
      format: null,
      confidence: 0.7,
      reason: 'creation verb + generic file cue — format resolved by planner',
    };
  }

  return { wants: false, reason: 'creation verb but no file/format signal' };
}

// ── P5: artifact EDIT intent (pure, message-only) ─────────────────────────────
// "change slide 5", "fix the pricing table", "rename the README heading".
// Deliberately requires BOTH a modification verb AND an artifact-part noun;
// whether an artifact actually exists in the conversation is the caller's
// check (chat.js consults the store index) — this stays pure.

const EDIT_VERB_RE = /\b(change|update|edit|revise|modify|fix|adjust|rewrite|reword|rename|replace|remove|delete|add|insert|swap|reorder|shorten|expand|tweak|correct)\b/i;

const ARTIFACT_PART_RE = /\b(slide|deck|presentation|pdf|docx?|document|report|invoice|resume|whitepaper|sheet|spreadsheet|workbook|tab|readme|dockerfile|manifest|artifact|download(ed)?\s+file|the\s+file|section|heading|title|subtitle|bullet|paragraph|row|column|cell|page|diagram|logo|schema|the\s+(zip|tar))\b/i;

/**
 * @param {string} userMessage
 * @returns {{ wants: false, reason: string } | { wants: true, confidence: number, reason: string }}
 */
export function detectArtifactEditIntent(userMessage) {
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    return { wants: false, reason: 'empty message' };
  }
  const msg = userMessage.trim();

  if (msg.endsWith('?'))        return { wants: false, reason: 'question (trailing ?)' };
  if (QUESTION_RE.test(msg))    return { wants: false, reason: 'question phrasing' };
  if (HOWTO_RE.test(msg))       return { wants: false, reason: 'how-to phrasing' };
  if (INLINE_ONLY_RE.test(msg)) return { wants: false, reason: 'explicit inline request' };

  const verb = EDIT_VERB_RE.exec(msg);
  if (!verb) return { wants: false, reason: 'no modification verb' };
  const part = ARTIFACT_PART_RE.exec(msg);
  if (!part) return { wants: false, reason: 'modification verb but no artifact-part noun' };

  return {
    wants: true,
    confidence: 0.8,
    reason: `"${verb[0]}" + "${part[0]}" — edit of an existing artifact`,
  };
}
