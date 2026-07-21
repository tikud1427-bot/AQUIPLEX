# File Intelligence 2.0 — Evidence Understanding (spec gap closure)

Full-repo survey (2026-07-21) vs the "world's most powerful AI File
Intelligence" brief. **9/13 requirements were already live** in FI V1–V3 +
PIC: evidence graph (evidenceStore = source of truth + reasoningGraph),
timelines with uncertainty merged across files, cross-file reasoning over
one knowledge space (pdf/docx/pptx/xlsx/csv/odt/epub, image vision+OCR,
audio speech, video scenes, zip/tar repos, source/json/logs), the Citation
Engine (universal Evidence locator: page/slide/sheet/table/cell/¶/§/
lineRange/timestamp/frame/speaker/nestedPath — `formatCitation`), full
provenance + lifecycle + versioning + epistemic tiers, multimodal fusion
(every modality → same UKO → same facts → one graph), confidence at every
layer, PIC integration, and a 107-test files+reasoning battery. Rebuilding
any of that would violate "extend, don't duplicate."

**Four real gaps, closed here** — zero new deps, all additive, fail-open:

## 1. Entity breadth (spec 2)
`files/extractors.js` ENTITY_PATTERNS +8 identifier types: `phone`, `ip`,
`mac`, `hash` (md5/sha1/sha256), `coordinate`, `code_symbol`,
`chemical` (CAS numbers + digit-bearing formulas gated on chemistry
context), `medical_code` (ICD-shaped, clinical-context gated),
`legal_cite` (X v. Y, §, "Section N of the … Act"). Mirrored in
`graphBuilder.guessType`; all added to the resolver's HARD_TYPE_BLOCK —
identifier-class entities are exact-identity, never fuzzy-merged. The
existing decision to keep people/orgs under one `name` type (identity >
classification; see graphBuilder's comment) is deliberately preserved.
Pre-existing `version` regex hardened against matching IP prefixes.

## 2. Causality (spec 3)
`queryEngine.whatCausedThis(effect)` — candidate causes = events PRECEDING
the effect in the merged raw timeline, scored by shared resolved entities +
explicit causal cues in the effect's text ("following/because/due to …",
stopword-filtered) + temporal proximity. Ranks over `extractEvents →
buildTimeline` directly (the presentation remap in `timelineAcross` drops
entities). Derived, capped 0.95, every candidate cited. Not causation
proof — an evidence-backed lead ranking, labeled as such.

## 3. Research Intelligence (spec 9) — `reasoning/researchEngine.js`
Pure over injected stores + graph; reuses the sibling contradiction
detector, never re-derives: `compareFiles` (shared entities, agreements =
same normalized claim dual-cited, disagreements, uniques), 
`consensusReport` (corroborated ≥2 files / contested-on-`contradicts`-edge
/ single-source; read-only corroboration boost mirroring consolidation's
shape), `hypothesisCandidates` (asserted finding verbs vs hedged
may/might/suggests), `researchGaps` (`about`-degree-0 entities, single-file
entities, zero-fact files, open disputes, timeline anchoring ratio),
`literatureOverview` (one row per file: topics, key entities, claim +
contested counts).

## 4. Forensic pipeline (spec 10) — `files/forensicEngine.js`
Deterministic integrity signals from what ingest already persists —
findings, not verdicts, each { severity, confidence, files, explanation,
citations }: `duplicate_content` (same sha256, different names),
`revised_document` (same name, different hash, versions ordered),
`edited_number` (same sentence number-masked, figures differ across files
— the doctored-figure signature), `future_dated_content`,
`scanned_document` (OCR evidence on a 'document' = broken digital text
layer), `weak_evidence_file` (mean conf < 0.6), `deep_nesting` (≥2 archive
levels), `assertion_without_entities`. `fileForensics(ukoId)` = per-file
dossier (hash, methods mix, confidence stats, dates, own findings).
Supporting fix in `relationshipEngine.conflictKind`: significant-figure
comparison (≥4 digits, non-year) so a shared date can no longer mask a
disagreeing amount; original rule kept as fallback; word-overlap bar
raised to ≥4 on the new path to stay conservative.

## Integration (spec 12)
Everything rides the PIC facade — `pic/core.js` gains `getForensics`,
`getResearch(mode)`, `compareKnowledgeFiles`, `whatCaused`: injectable
deps, `AQUA_PIC=off` silences all four, failures count in PIC metrics and
return null. Routes never touch stores:
```
GET /intelligence/forensics[?file=<ukoId>]
GET /intelligence/research?mode=consensus|hypotheses|gaps|overview
GET /intelligence/compare?a=<ukoId>&b=<ukoId>
GET /intelligence/cause?q=<effect text>
```

## Performance (spec, deliberate)
All new engines are single linear passes over facts/UKOs (the masked-
statement grouping is O(facts)); no new indexes — same documented posture
as the memory audit (swap seams stand, DATABASE_MIGRATION_PLAN owns the
scale story). Perf-guarded by test: forensics + 2× research + cause over
300 facts / 6 files < 1.5 s combined.

## Tests (spec 13)
`npm run test:files` → **128/128** (107 prior + 21 new:
`forensicEngine.test.js` 9, `researchEngine.test.js` 6,
`fileIntelligence2.e2e.test.js` 6 — the e2e runs the REAL
`ingestFiles` lifecycle on a mixed doc/image/source batch via the
documented parser-injection seam, then drives all four PIC surfaces, the
kill switch, and the perf budget). Full battery green: memory 135, mind 34,
pic 38, identity 31, upload 16, cognition 55, search 52. Live HTTP smoke on
all four endpoints (conflict corpus): contested=2, disagreement cited both
sides, cause ranked the funding round at 0.95 with citation.
