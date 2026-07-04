# AQUA AI — Frontend

Production frontend for the AQUA backend (`aqua/`), built with React 19, TypeScript, Vite 6, Tailwind CSS v4, Zustand, and Radix UI.

## Getting started

```bash
npm install
cp .env.example .env      # defaults to http://localhost:3000, edit if your backend runs elsewhere
npm run dev                # http://localhost:5173
```

The backend must be running separately (`node server.js` from the `aqua/` directory). This app never assumes it — every request has real loading, error, and offline states.

```bash
npm run build      # type-checks then builds to dist/
npm run preview    # serve the production build locally
npm run lint
```

## Architecture

```
src/
  api/          One file per backend route group (chat, conversations, memory, project, health).
                 No component ever calls axios directly.
  stores/       Zustand, one store per concern: chat, conversation, settings, ui, upload.
  components/   chat/ sidebar/ markdown/ upload/ settings/ layout/ ui/ (primitives)
  types/api.ts  Wire types mirrored from the backend's actual route handlers — every field
                 here was checked against aqua/src/routes/*.js, and the read-heavy ones
                 (health, conversations, memory, project) were also verified against the
                 live server's real responses, not just the source.
```

## Where this intentionally departs from a generic AI-chat spec

The build brief called for a fairly standard "premium AI chat app" feature set. AQUA's actual
backend doesn't support all of it, and the instruction to treat the backend as the source of
truth took priority over matching the brief literally. Specifically:

- **No token streaming.** `POST /chat` returns one JSON payload, not an SSE/stream. `socket.io`
  is a backend dependency but no socket server is ever attached in `server.js`. The composer
  shows a thinking indicator while the request is in flight rather than faking a typewriter
  effect on text that already fully arrived.
- **File attach is text/source only.** `aqua/src/project/fileIngester.js` explicitly drops
  images, PDFs, and other binaries (`IGNORE_EXTS` + a binary-content sniff) — it's a code
  indexer, not a document parser. The composer's paperclip button reads text/code files
  client-side and inlines them into the message; there's a separate **Upload Project** action
  (zip or folder) for real backend-indexed codebase context. Neither one claims to handle PDFs,
  DOCX, or images, because the backend can't back that claim up.
- **No paste-image support.** Same reason — there's nowhere on the backend for an image to go.
- **Conversation pin/rename/title are client-only**, persisted in `localStorage`
  (`stores/conversationStore.ts`'s `overlay`). The backend has no endpoints for any of the
  three; titles are derived from each conversation's first message instead of invented.
- **Regenerate / edit-and-resend replay as new turns.** There's no "replace last message"
  endpoint — every `/chat` call appends to server history — so both actions drop the affected
  messages from the local view and send a fresh request rather than pretending to rewrite
  server-side state that can't actually be rewritten.
- **"Clear all chats" loops the single-conversation `DELETE`** since there's no bulk-delete
  route, then refetches from the server rather than trusting the client's guess at what
  survived a partially-failed loop.
- **Stop-generating aborts the in-flight request** (there's no partial stream to cut off).

None of this is a placeholder or a TODO — each is the actual, complete behavior given what the
backend can do today. If any of the backend gaps above get filled in (an SSE endpoint, a
rename/pin route, PDF ingestion), the corresponding frontend piece is isolated enough to swap
in without touching the rest.

## What wasn't live-tested

Every read-only route (`/provider-health`, `/conversations`, `/conversations/:id`,
`/memory/:id`, `/project/workspaces`) and the full project-upload round trip
(create → upload → index → delete) were verified against your actual running server during
this build. `POST /chat` was **not** fired — doing so would have spent real provider credits
and written a test message into your real conversation history, so that contract is verified
against `chat.js`'s source rather than a live call. Worth sending one real message after your
first `npm run dev` to confirm the shape still matches exactly.
