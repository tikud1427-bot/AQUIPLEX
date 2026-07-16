# AQUA Universal Artifact Engine — P1→P6 Complete

Status: **all phases shipped**. 88 artifact tests + 366 other suites + 8 edit-runner tests green; boot clean; frontend `tsc -b` + `vite build` clean.

## What it does
Any chat turn that asks for a real file gets one. Auto-detected — no mode picker.
`26 formats`: md, html, css, js, ts, py, json, xml, yaml, csv, svg, mermaid, sql, sh, bat, txt, dockerfile, openapi, postman, k8s, terraform (P1) · pptx, pdf, docx, xlsx (P2) · project (P3).

## Phase map
| Phase | Shipped |
|---|---|
| P1 | Detector → planner → builder → validator → exporters → packager → store; SSE events; REST; chat branch; ArtifactCard |
| P2 | pptx (pptxgenjs), pdf (pdf-lib + layout engine), docx (docx), xlsx (existing dep); shared document model; `generateJson` |
| P3 | `project` exporter (multi-file trees); zero-dep ustar `tarWriter`; zip/tar/tar.gz packaging |
| P4 | Artifacts panel (durable home), preview dialog, scope toggle, rename/delete |
| P5 | Editing: model-edit (binary) + file-edit (text/project); `appendVersion`; `POST /:id/edit`, `/:id/regenerate`; billing |
| P6 | Unicode PDF (DejaVu subset embed); GNU tar longnames; version cap; model cap; edit serialization; version picker + regenerate UI |
| P6.1 | Planner robustness: tolerant JSON (truncation repair), 4096-token plan budget, compact-`structure` prompt, `truncated` flag honored, explicit-format precedence, reasoning-pass skip |

## Architecture
```
chat.js  ─ prepareTurn() ─┬─ [P5] edit intent + artifact in conv? → editEngine → appendVersion
                          ├─ [P1] artifact intent?              → engine.execute
                          └─ normal chat pipeline (fallback for BOTH)
engine.execute: plan → build → exporter.validate → export → validateArtifactFiles → packaging → store
```
Every failure throws → chat.js logs → normal pipeline. **A user request never fails because the artifact path hiccuped.**

## Key invariants (all test-enforced)
- Planner output is untrusted: schema-validated, prototype-pollution proof, one repair retry.
- Every path: `sanitizeRelativePath` + `resolveInsideRoot`. Native executables blocked (ext + magic bytes).
- Versions are immutable full snapshots. v1 stays downloadable forever. Failed edits leave zero trace.
- Untouched files in an edit are byte-identical copies.
- Binary edits go through the persisted content model — binaries are never reverse-engineered.
- Ownership: 404-uniform, no existence oracle (mirrors conversations.js).
- Detector maps to TRUE formats; the registry gates availability.

## Planner robustness (P6.1)
The reported failure — *"Create a 15-slide Series A pitch deck… Export as PPTX"* falling back to chat — was **not** a detection bug (the detector fired at conf 0.9). The planner's 1,500-token budget truncated the plan mid-JSON because the model outlined all 15 slides into `structure`; the strict parser rejected it twice, then gave up.

Fixes:
1. **`extractJson` is tolerant** — repairs truncated JSON (closes strings/brackets, drops dangling keys, progressive trim). `validateSpec()` remains the gate, so repair only recovers *structure*, never invents content.
2. **`PLAN_BUDGET` 1,500 → 4,096** and the prompt caps `structure` to titles-only ("a long plan is a WRONG plan"). Counts go in `constraints`.
3. **The router's `truncated`/`finishReason` flag is honored** — a truncated reply now triggers a *terser* retry instead of an identical one that truncates again.
4. **Explicit formats outrank deliverable nouns** — "Create a report… Export as PPTX" is a deck, not a pdf. Requires export context, so "a report about PDF parsing" is unaffected.
5. **Reasoning pass skipped on artifact turns** — saves a full model call that was built and discarded. `classifyTask()` still labels these `planning` (correct — it ranks providers); the skip is driven by the pure detector, not the classifier.

The builder's `generateJson` gets the same truncation handling — a too-long content model degrades to a shorter artifact with a warning, rather than failing the turn.

## Honest limits (deliberate, documented)
- **PDF is Latin/Cyrillic/Greek + symbols (incl. ₹).** Indic/CJK FAIL validation and suggest .docx — those scripts need text shaping pdf-lib cannot do; embedding a font would render them *wrong*. docx handles all languages today.
- Edits change content, not structure (add/remove files = future work).
- Version cap 20 (v1 + newest 19); middle versions pruned.
- Models >400KB aren't persisted → that artifact can't be model-edited (clear error).

## Config
- `ARTIFACTS_ENABLED=false` → instant rollback to pre-artifact behavior.
- `AQUA_ARTIFACTS_DIR` → relocates the whole store (tests use it).

## Deps added (5)
`pptxgenjs`, `pdf-lib`, `docx` (P2) · `@pdf-lib/fontkit`, `dejavu-fonts-ttf` (P6). Zero for P1/P3.

## Test commands
```
cd aqua && npm run test:artifacts          # 88
cd aqua-frontend && npx tsc -b && npm run build
```
⚠️ Frontend typecheck is `tsc -b`, NOT `tsc --noEmit` — root tsconfig uses `files: []` + project references, so `--noEmit` checks nothing.
