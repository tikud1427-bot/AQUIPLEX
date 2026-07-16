# AQUIPLEX Stability & UX Sprint (P0) — Completion Report

**Date:** 2026-07-16 · **Scope:** reliability, persistence, cache, freemium, mobile/UX · **No features removed, no behavior simplified.**

**Verification:** 404 backend tests green (398 pre-existing + 6 new), `tsc -b` clean, `vite build` green with build-stamp verified in `dist/index.html` + bundle, `node --check` on every touched platform file.

---

## 0. Executive summary — the three root causes

| Symptom you reported | Actual root cause |
|---|---|
| Chats/memory vanish after upgrades | Every store persisted to `path.join(process.cwd(), '.aqua-*.json')` — **user data lived inside the deploy tree**. Any deploy that replaces the app folder (fresh checkout, release-folder switch, container rebuild, `git clean`) deleted or orphaned all of it. Two aggravators: a `MAX_HISTORY_PER_CONV = 200` rolling splice was **silently deleting messages** beyond 200 per conversation, and titles/pins lived **only in one browser's localStorage**, so a cache clear or second device made history *look* wiped even when messages survived. |
| Three-dot menu / UI breaks until cache clear | A legacy service worker (`public/service-worker.js`, `aquiplex-v2`) cached **everything cache-first** with no `activate` cleanup and no update handling. Its registration code was removed from the repo long ago, but **installed workers persist in browsers indefinitely** — they kept serving stale app shells that referenced hashed chunks each new deploy had deleted. Compounding it: zero cache headers (hashed `/aqua/assets/*` not immutable, `index.html` not `no-cache`). |
| Freemium feels hostile | `usageGuard` deducts credits **on entry**, and `chat.js` never called `req.creditContext.refund()` — **failed generations charged users**. The frontend had zero 402 handling (raw `INSUFFICIENT_CREDITS` string), no balance visibility, no path forward. |

All three are fixed at the root, with migrations, backups, and self-healing — details below.

**Important:** the root-level `.aqua-*.json` files in this repo are your **live data**. They are untouched. On the first boot of this build, the one-time loss-proof migration moves them into the data directory and leaves the originals renamed `*.migrated-to-datadir` as backups.

---

## 1. Every file modified

### New files (7)
| File | Purpose |
|---|---|
| `aqua/src/core/dataDir.js` | Canonical data directory + loss-proof legacy migration (the P0-1/P0-2 root fix) |
| `aqua/src/core/tests/p0Persistence.test.js` | 6 tests covering migration, corrupt recovery, meta patch, trash, no-splice, envelope |
| `public/js/sw-cleanup.js` | Page-side legacy service-worker retirement (idempotent) |
| `aqua-frontend/src/hooks/useVersionGuard.ts` | Deploy detection + stale-chunk self-healing |
| `aqua-frontend/src/api/billing.ts` | Wallet fetch (platform `/api/billing`, cookie-auth fetch) |
| `aqua-frontend/src/stores/walletStore.ts` | Debounced remaining-credits state |
| *(this file)* `STABILITY_SPRINT_REPORT.md` | — |

### Backend — AQUA engine (13 modified)
| File | Change |
|---|---|
| `aqua/src/core/atomicStore.js` | `loadJsonFile` (corrupt file preserved aside → `.bak` recovery → never wipes), `backupOnce` boot snapshot before a process's first write, `wrapStore`/`unwrapStore` schema envelope (rollback-tolerant), **SIGTERM/SIGINT/beforeExit flush of all registered writers** |
| `aqua/src/memory/conversationStore.js` | v4: data-dir path via migration; **removed 200-message rolling delete** (5000 safety valve, warn-only); `meta.updatedAt`; `updateConversationMeta()` whitelisting `title/pinned/archived` (identity fields untouchable); `deriveTitle()`; `clearConversation` snapshots into rolling `.aqua-history-trash.json` (last 40) before delete; schema-1 envelope |
| `aqua/src/mind/mindStore.js` | Data-dir path + corrupt-safe load + envelope (memory = critical user data) |
| `aqua/src/intelligence/learningLedger.js` | Data-dir path + corrupt-safe load |
| `aqua/src/project/projectIndex.js` | Data-dir path + corrupt-safe load |
| `aqua/src/project/projectMemory.js` | Data-dir path + corrupt-safe load |
| `aqua/src/embeddings/vectorStore.js` | Data-dir path + corrupt-safe load |
| `aqua/src/artifacts/artifactStore.js` | Default root → data dir with one-time directory copy-migration (`AQUA_ARTIFACTS_DIR` still wins) |
| `aqua/src/identity/identityLoader.js` | Persisted overrides → data dir (`.aqua-identity-overrides.json`) with legacy migration; shipped identity data stays code-relative (correct) |
| `aqua/src/memory/migrate.js` | Legacy `.aqua-memory.json` looked up in both cwd and data dir |
| `aqua/src/routes/conversations.js` | New `PATCH /:id` (title/pinned/archived, same IDOR-safe ownership guard); list now returns `title/pinned/archived/updatedAt`; sorted by last activity |
| `aqua/src/routes/chat.js` | Server derives + stores title on first message (both endpoints); **`req.creditContext.refund()` on any failed generation** and on user-abort with zero output |
| `aqua/src/core/tests/storePersistence.test.js`, `aqua/src/memory/tests/unified.test.js` | Updated to the new data-dir contract (pin `AQUA_DATA_DIR` to the temp dir; subprocess inherits it) |

### Platform (7 modified)
| File | Change |
|---|---|
| `index.js` | `/service-worker.js` route (`no-cache, no-store` + `Service-Worker-Allowed`), platform static cache policy (ETag revalidation; 1h for images/fonts), `/aqua/build.json` (reads `<meta name="aqua-build">` from current dist, 5s memo, `no-store`), `/aqua` static split (`assets/` → `immutable, max-age=31536000`; everything else `no-cache`), SPA `index.html` served `no-cache` |
| `public/service-worker.js` | **Permanent kill-switch**: `skipWaiting` → delete all CacheStorage → `clients.claim` → `unregister` → one-shot `client.navigate` reload; **no fetch handler**. Keep deployed at this URL forever so months-stale installs still get cleaned |
| `views/partials/footer.ejs` | Includes `sw-cleanup.js` |
| `views/login.ejs`, `views/signup.ejs`, `views/404.ejs`, `views/error.ejs` | Same include (these lack the footer partial and are the first pages a stale-cached user hits) |

### Frontend (21 modified)
| File | Change |
|---|---|
| `vite.config.ts` | Build stamp: one id per build → `define __BUILD_ID__` + `<meta name="aqua-build">` via `transformIndexHtml` |
| `src/vite-env.d.ts` | `declare const __BUILD_ID__` |
| `src/main.tsx` | SW + CacheStorage purge before render (SPA side of the kill-switch) |
| `src/Root.tsx` | Mounts `useVersionGuard` |
| `src/components/feedback/ErrorBoundary.tsx` | Auto-heals dynamic-import crashes (stale-deploy signature) with one guarded reload before showing the error wall |
| `src/stores/conversationStore.ts` | **Server-first titles/pins**: server fields win; overlay demoted to instant-title seed + offline cache; `togglePin`/`rename` → optimistic + `PATCH` with rollback; `migrateOverlayToServer()` one-time push of legacy localStorage titles/pins (never overwrites a server title, retries silently) |
| `src/api/conversations.ts` | `patchConversation()` |
| `src/types/api.ts` | `ConversationSummary` +`title/pinned/archived/updatedAt`, `PatchConversationResponse`, `StreamErrorEvent` +structured guard fields (`status/code/message/upgradeUrl/totalCredits/costRequired`) |
| `src/types/chat.ts` | `UiConversation` +`updatedAt/archived`; `UiMessage` +`errorCode/errorUpgradeUrl` |
| `src/api/chatStream.ts` | Non-OK pre-stream responses surface the **full structured guard body**; human `message` preferred over machine `error` |
| `src/api/client.ts` | `normalizeError` prefers `body.message` over `body.error` |
| `src/stores/chatStore.ts` | `INSUFFICIENT_CREDITS` branch: friendly copy + toast ("conversations, files, memory are safe") + wallet refresh + CTA fields on the message; wallet refresh after every finished turn |
| `src/components/chat/MessageBubble.tsx` | Credits error renders **Buy credits** CTA (guard-provided URL) + reassurance line instead of a Retry that can't succeed |
| `src/components/layout/Header.tsx` | `CreditsChip`: remaining balance, amber under 15 (≈2 messages), refresh on focus, self-hides for unlimited/unreachable billing |
| `src/components/ui/dialog.tsx` | `max-h-[85vh]` → `85dvh` (mobile keyboard/URL-bar correctness) |
| `src/styles/globals.css` | `.touch-lg`: 44px targets on coarse pointers only (desktop density unchanged) |
| `src/components/sidebar/ConversationItem.tsx`, `src/components/chat/MessageActions.tsx` | `.touch-lg` on the 32px icon buttons |
| `index.html` | Viewport +`interactive-widget=resizes-content` (Chromium keyboard overlap) |
| `src/components/chat/Composer.tsx` | `onFocus` scroll-into-view after keyboard settles (iOS Safari doesn't resize the layout viewport) |
| `src/components/markdown/CodeBlock.tsx` | Explicit `overflowX` panning for long lines on phones |

---

## 2. Every bug fixed

1. **Deploy wipes all conversations/memory/mind/ledger/index/projects/vectors/artifacts/identity-overrides** — data lived in the deploy tree → canonical data dir (`AQUA_DATA_DIR` → `~/.aquiplex` → namespaced cwd fallback) with copy→verify→rename-as-backup migration for every store. *(P0-1, P0-2)*
2. **Silent permanent loss of messages past 200 per conversation** — storage splice removed; model context is budgeted separately in `buildContextWindow`, so the cap bought nothing. *(P0-1)*
3. **Corrupt store file wiped the entire store on next boot** — `JSON.parse` throw used to fall through to an empty store that then overwrote the file. Now: corrupt bytes preserved as `<file>.corrupt-<ts>`, `.bak` recovery attempted, and the file is never overwritten by an empty state on load failure. *(P0-1/2)*
4. **Deploy (SIGTERM) discarded up to 500ms of unflushed writes** — all debounced writers auto-register; signal hooks flush synchronously before exit. *(P0-1/2)*
5. **Rollback to an older build could clobber newer-schema data** — schema envelope: newer-versioned files are snapshotted (`<file>.vN.bak`) before the older build's first write, then loaded best-effort. Legacy bare-object files load forever (schema 0). *(P0-2)*
6. **Deleting a conversation was unrecoverable** — trash snapshot (last 40 deletions) written atomically before removal. *(P0-1 "backups before destructive operations")*
7. **Titles/pins existed only in one browser's localStorage** — server-owned meta + `PATCH` endpoint + first-message server-side title + one-time client migration push. Cache clear / second device / deploy no longer produces a sidebar of `Conversation · a1b2c3d4`. *(P0-1 "history syncing")*
8. **Zombie service worker served stale shells forever** ("menu disappears until cache clear") — kill-switch worker + page-side purge on SPA boot and every EJS page (including login/signup/404/error, which lack the footer). *(P0-3, P1-4)*
9. **No cache-busting contract** — Vite-hashed `/aqua/assets/*` now `immutable, max-age=31536000`; shells (`index.html`, EJS HTML/CSS/JS) `no-cache` with ETag 304s; SW file `no-store`. Old HTML can never pin new chunks; new HTML always loads. *(P0-3)*
10. **Open tabs kept running dead builds after a deploy** — build id stamped into html+bundle; `/aqua/build.json` polled on interval/focus → toast + one guarded hard reload. `vite:preloadError` + ErrorBoundary dynamic-import detection reload once on the stale-chunk signature. Loop-safe via sessionStorage marks. *(P0-3, P1-12)*
11. **Failed generations charged credits** — refund wired into the POST catch, the stream catch, and zero-output user aborts. *(P1-7)*
12. **402 dead end** — raw `INSUFFICIENT_CREDITS` string replaced by the guard's human message, Buy-credits CTA to the guard's `upgradeUrl`, explicit "conversations/files/projects/memory stay saved" copy, wallet chip refresh so the number matches the wall. *(P1-7)*
13. **Machine error codes shown to users generally** — both transport paths now prefer `body.message`. *(P1-12)*
14. **Sidebar ordered by creation, not activity** — list sorted by `updatedAt`. *(P1-9)*
15. **Dialogs overflowed under mobile keyboards** — `85vh → 85dvh`. *(P1-5/6)*
16. **Android keyboard covered the composer** — `interactive-widget=resizes-content`. **iOS**: focus scroll-into-view fallback. *(P1-5)*
17. **32px touch targets on row menus/message actions** — 44px on coarse pointers via `.touch-lg`, desktop unchanged. *(P1-11, P1-4/5)*
18. **Long code lines could bleed on phones** — explicit horizontal panning in non-wrap mode. *(P1-5/6)*

## 3. Performance improvements

- **Immutable hashed-asset caching** — the dominant win: repeat loads of `/aqua` skip re-downloading ~1.1MB gz of vendor/app chunks entirely; deploys transfer only changed chunks. Previously every asset revalidated (or worse, was served stale by the SW).
- **ETag revalidation on platform assets** — unchanged CSS/JS = 304s instead of full bodies, while staying deploy-correct.
- **Wallet fetch debounced (4s window, in-flight dedupe)** — turn-finish + focus collapse to one request.
- **Zero new heavy work on hot paths** — all P0 machinery is boot-time or flush-time; per-message cost added: one `meta.updatedAt` assignment.
- **Investigated & reverted** (documented so it isn't retried blindly): splitting `react-syntax-highlighter` into a manualChunk grew the eager payload 607→534+686kB because it defeated Vite's per-language auto-splitting of Prism grammars. The existing config is already optimal there; the real follow-up is in §5.
- **Verified existing** rAF token batching + memoized `MessageBubble` + lazy `MindPage` remain intact.

## 4. UX improvements

- Seamless deploys: users never clear cache, never see half-broken UI; open tabs announce "AQUA was updated" and refresh themselves once.
- History feels permanent: titles, pins, order, and messages identical across devices, sessions, and releases; deletions recoverable from trash by an operator.
- Freemium with dignity: visible balance before the wall (amber warning ~2 messages out), honest refunds, a wall that names what's preserved and offers one-tap top-up.
- Mobile: keyboard never hides the composer, dialogs fit the visual viewport, thumb-sized targets, pannable code, `dvh`-correct layout (pre-existing safe-area work preserved).
- Errors: human sentences, Retry only where retrying can work, self-healing where the cause is a stale build.

## 5. Remaining technical debt (honest list)

1. **JSON-file store tier** — single-process only, whole-file rewrites, in-memory working set. Fine at current scale; the seam for SQLite/Postgres is now exactly one module (`atomicStore` + `dataDir`). The 2.8MB project index is the first file that will hurt.
2. **Sessions fall back to in-memory** when `connect-mongo` isn't installed/`MONGO_URI` unset — users are logged out by every deploy. `connect-mongo` is in `package.json`; ensure `MONGO_URI` is set in prod (boot log prints which store is active).
3. **`.aqua-history-trash.json` is operator-facing** — no user-visible undo UI yet.
4. **`archived` is stored + returned but has no UI** — sidebar filter/section is a small follow-up.
5. **Legacy overlay migration lingers** — after a few weeks of users hitting `migrateOverlayToServer`, the overlay code in `conversationStore.ts` can be reduced to a pure derived-title cache.
6. **Main bundle 607kB (174kB gz)** — dominated by eager `react-syntax-highlighter` core via `MessageBubble → CodeBlock`. Right fix: `React.lazy` the highlighter itself with a `<pre>` fallback (not a manualChunk — see §3). Deliberately out of surgical scope this sprint.
7. **Wallet endpoint is polled, not pushed** — the chat `done` payload could carry `balanceAfter` (usageGuard already computes it) and delete the extra request.
8. **No E2E/browser test rig** — cross-browser matrix (P1-10) verified by standards-level reasoning (dvh, `interactive-widget`, SW spec) rather than automation; Playwright smoke tests are the gap.
9. **Uploads/attachments are in-memory per conversation** (pre-existing design) — large-file durability across restarts is a separate feature decision.

## 6. Architectural recommendations

1. **Adopt `AQUA_DATA_DIR` as a first-class deploy contract.** Point it at a mounted volume in containers; document `~/.aquiplex` for bare-metal. Back up that one directory = back up the product.
2. **SQLite next, not Postgres yet.** One file in the data dir, WAL mode, per-store tables; swap inside `atomicStore`'s interface. Removes whole-file rewrites and unlocks multi-process without ops burden.
3. **Keep the kill-switch worker deployed indefinitely**; if you ever want a PWA again, use Workbox with `skipWaiting`+`clients.claim`, versioned precache manifests, and navigation-preload — never a hand-rolled cache-first handler.
4. **Promote `/aqua/build.json` to a platform-wide `/healthz`+version endpoint** (build id, engine mount state, store stats from `getStoreStats()`) for deploy verification and uptime checks.
5. **Return `balanceAfter` on chat responses** (see debt #7) and render cost-per-action in the composer tooltip — quota comprehension without extra requests.
6. **Titles: optional async upgrade** — a cheap post-turn model pass writing a better title via the existing `updateConversationMeta` would match frontier-product feel; the plumbing now exists.
7. **Add a 10-minute Playwright smoke** (login → send → refresh → title persists → deploy-swap dist → tab self-reloads) wired to CI; it directly guards everything this sprint fixed.

---

## Deploy notes for this build

1. `cd aqua-frontend && npm install && npm run build` (stamps the build id).
2. Set `MONGO_URI` (sessions) and optionally `AQUA_DATA_DIR` (else `~/.aquiplex`).
3. First boot logs the one-time migrations (`[DATA] Migrated … → …`); originals remain beside the old locations as `*.migrated-to-datadir`.
4. Ship `public/service-worker.js` and keep it at that URL permanently.
5. Verify: `curl -s https://<host>/aqua/build.json` matches `grep aqua-build aqua-frontend/dist/index.html`; hashed asset returns `immutable`; `/service-worker.js` returns `no-store`.
