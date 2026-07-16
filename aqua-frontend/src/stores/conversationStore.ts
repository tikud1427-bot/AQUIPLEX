import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { deleteConversation as apiDeleteConversation, listConversations, patchConversation } from '@/api/conversations';
import { normalizeError } from '@/api/client';
import type { UiConversation } from '@/types';

interface ConversationOverlayEntry {
  pinned: boolean;
  renamedTitle?: string;
  /** First user message, truncated — instant title while the server's derived title syncs. */
  derivedTitle?: string;
  /** P0 — set once this entry's legacy local-only title/pin was pushed to the server. */
  syncedToServer?: boolean;
}

interface ConversationState {
  items: UiConversation[];
  loading: boolean;
  error: string | null;
  searchQuery: string;

  /** id -> overlay. Persisted — this is the only place pin/rename/title live. */
  overlay: Record<string, ConversationOverlayEntry>;

  fetchConversations: () => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
  clearAll: () => Promise<{ succeeded: number; failed: number }>;
  togglePin: (id: string) => void;
  rename: (id: string, title: string) => void;
  migrateOverlayToServer: (rows: Array<{ id: string; serverTitle: string | null }>) => Promise<void>;
  cacheTitle: (id: string, firstMessage: string) => void;
  setSearchQuery: (q: string) => void;
  ensureLocalEntry: (id: string, createdAt: number) => void;
}

/**
 * Conversational openers stripped before title-casing — "how do i fix the
 * auth middleware" reads better as a title than "How Do I Fix The Auth
 * Middleware". Order matters: applied repeatedly so chained fillers
 * ("hey, can you help me...") fully clear before casing.
 */
const FILLER_PATTERNS: RegExp[] = [
  /^(hi|hey|hello|yo|so|ok|okay|well)[,!.\s]+/i,
  /^(can|could|would|will) you\s+/i,
  /^(please|pls)\s+/i,
  /^i('d| would| need| want)\s+(like to |help |to |with )?/i,
  /^help me\s+/i,
  /^(how (do|can|would) i|how to)\s+/i,
  /^(what is|what's|explain|tell me about)\s+/i,
];

const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'our', 'your', 'in', 'on', 'for', 'of', 'to',
  'with', 'and', 'is', 'are', 'it', 'this', 'that',
]);

function stripFiller(text: string): string {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of FILLER_PATTERNS) {
      const next = out.replace(re, '');
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
  }
  return out.trim();
}

/** Title Case, but leaves identifiers/acronyms alone (ALLCAPS, camelCase, dotted paths). */
function toTitleCase(text: string): string {
  return text
    .split(' ')
    .map((w, i) => {
      if (!w) return w;
      const lower = w.toLowerCase();
      if (i > 0 && TITLE_STOPWORDS.has(lower)) return lower;
      if (/[A-Z]{2,}/.test(w) || /[._/-]/.test(w)) return w;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function deriveTitle(text: string): string {
  const raw = text.trim().replace(/\s+/g, ' ');
  if (!raw) return 'New conversation';

  const stripped = stripFiller(raw).replace(/^[,\-–—:]+\s*/, '');
  const base = (stripped || raw).replace(/[?!.]+$/, '');
  const cased = toTitleCase(base) || 'New conversation';

  const LIMIT = 42;
  if (cased.length <= LIMIT) return cased;
  const cut = cased.slice(0, LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

export const useConversationStore = create<ConversationState>()(
  persist(
    (set, get) => ({
      items: [],
      loading: false,
      error: null,
      searchQuery: '',
      overlay: {},

      fetchConversations: async () => {
        set({ loading: true, error: null });
        try {
          const res = await listConversations();
          const overlay = get().overlay;
          const items: UiConversation[] = res.conversations.map((c) => {
            const ov = overlay[c.id];
            return {
              id: c.id,
              // P0 — the SERVER owns titles/pins now (survives cache clears,
              // second devices, deploys). Overlay only bridges the gap for
              // rows created before the server learned to store them.
              title:
                c.title ??
                ov?.renamedTitle ??
                ov?.derivedTitle ??
                `Conversation · ${c.id.slice(0, 8)}`,
              messageCount: c.messageCount,
              createdAt: c.meta?.createdAt ?? Date.now(),
              updatedAt: c.updatedAt ?? c.meta?.createdAt ?? 0,
              pinned: c.title != null ? c.pinned : (ov?.pinned ?? false),
              archived: c.archived ?? false,
              renamedTitle: ov?.renamedTitle,
            };
          });
          set({ items, loading: false });
          void get().migrateOverlayToServer(res.conversations.map((c) => ({ id: c.id, serverTitle: c.title })));
        } catch (err) {
          set({ error: normalizeError(err).message, loading: false });
        }
      },

      /**
       * P0 one-time migration — push legacy localStorage-only titles/pins up
       * to the server so every device sees them. Runs after each list fetch,
       * skips entries already marked synced, fails silently (retries on the
       * next fetch). Never overwrites a title the server already has.
       */
      migrateOverlayToServer: async (serverRows) => {
        const { overlay } = get();
        for (const { id, serverTitle } of serverRows) {
          const ov = overlay[id];
          if (!ov || ov.syncedToServer) continue;
          const patch: { title?: string; pinned?: boolean } = {};
          if (!serverTitle && (ov.renamedTitle || ov.derivedTitle)) {
            patch.title = ov.renamedTitle ?? ov.derivedTitle;
          }
          if (ov.pinned) patch.pinned = true;
          try {
            if (Object.keys(patch).length > 0) await patchConversation(id, patch);
            set((s) => ({
              overlay: { ...s.overlay, [id]: { ...s.overlay[id], syncedToServer: true } },
            }));
          } catch {
            /* offline / old backend — retry on the next fetch */
          }
        }
      },

      removeConversation: async (id) => {
        const prev = get().items;
        set({ items: prev.filter((c) => c.id !== id) });
        try {
          await apiDeleteConversation(id);
        } catch (err) {
          set({ items: prev, error: normalizeError(err).message });
          throw err;
        }
      },

      clearAll: async () => {
        const ids = get().items.map((c) => c.id);
        let succeeded = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            await apiDeleteConversation(id);
            succeeded++;
          } catch {
            failed++;
          }
        }
        set({ overlay: {} });
        // Refetch from the server rather than reasoning about which ids
        // survived a partially-failed bulk-delete loop — it's the only
        // source of truth the backend gives us.
        await get().fetchConversations();
        return { succeeded, failed };
      },

      togglePin: (id) => {
        const current = get().items.find((c) => c.id === id)?.pinned ?? false;
        const next = !current;
        set((s) => {
          const entry = s.overlay[id] ?? { pinned: false };
          const overlay = { ...s.overlay, [id]: { ...entry, pinned: next } };
          const items = s.items.map((c) => (c.id === id ? { ...c, pinned: next } : c));
          return { overlay, items };
        });
        // Server-owned (P0) — fire-and-forget with rollback on failure.
        patchConversation(id, { pinned: next }).catch(() => {
          set((s) => ({
            items: s.items.map((c) => (c.id === id ? { ...c, pinned: current } : c)),
            overlay: { ...s.overlay, [id]: { ...(s.overlay[id] ?? { pinned: false }), pinned: current } },
          }));
        });
      },

      rename: (id, title) => {
        const prevTitle = get().items.find((c) => c.id === id)?.title;
        set((s) => {
          const entry = s.overlay[id] ?? { pinned: false };
          const overlay = { ...s.overlay, [id]: { ...entry, renamedTitle: title } };
          const items = s.items.map((c) => (c.id === id ? { ...c, title, renamedTitle: title } : c));
          return { overlay, items };
        });
        // Server-owned (P0) — fire-and-forget with rollback on failure.
        patchConversation(id, { title }).catch(() => {
          if (prevTitle !== undefined) {
            set((s) => ({ items: s.items.map((c) => (c.id === id ? { ...c, title: prevTitle } : c)) }));
          }
        });
      },

      cacheTitle: (id, firstMessage) =>
        set((s) => {
          const entry = s.overlay[id] ?? { pinned: false };
          if (entry.derivedTitle || entry.renamedTitle) return s;
          const derivedTitle = deriveTitle(firstMessage);
          const overlay = { ...s.overlay, [id]: { ...entry, derivedTitle } };
          const exists = s.items.some((c) => c.id === id);
          const items = exists
            ? s.items.map((c) => (c.id === id ? { ...c, title: derivedTitle } : c))
            : [
                { id, title: derivedTitle, messageCount: 1, createdAt: Date.now(), updatedAt: Date.now(), pinned: false, archived: false },
                ...s.items,
              ];
          return { overlay, items };
        }),

      ensureLocalEntry: (id, createdAt) =>
        set((s) => {
          if (s.items.some((c) => c.id === id)) return s;
          return {
            items: [
              { id, title: 'New conversation', messageCount: 0, createdAt, updatedAt: createdAt, pinned: false, archived: false },
              ...s.items,
            ],
          };
        }),

      setSearchQuery: (searchQuery) => set({ searchQuery }),
    }),
    {
      name: 'aqua-conversation-overlay',
      partialize: (s) => ({ overlay: s.overlay }),
    },
  ),
);
