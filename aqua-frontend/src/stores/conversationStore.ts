import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { deleteConversation as apiDeleteConversation, listConversations } from '@/api/conversations';
import { normalizeError } from '@/api/client';
import type { UiConversation } from '@/types';

interface ConversationOverlayEntry {
  pinned: boolean;
  renamedTitle?: string;
  /** First user message, truncated — cached at send-time since GET /conversations never returns content. */
  derivedTitle?: string;
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
              title: ov?.renamedTitle ?? ov?.derivedTitle ?? `Conversation · ${c.id.slice(0, 8)}`,
              messageCount: c.messageCount,
              createdAt: c.meta?.createdAt ?? Date.now(),
              pinned: ov?.pinned ?? false,
              renamedTitle: ov?.renamedTitle,
            };
          });
          set({ items, loading: false });
        } catch (err) {
          set({ error: normalizeError(err).message, loading: false });
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

      togglePin: (id) =>
        set((s) => {
          const entry = s.overlay[id] ?? { pinned: false };
          const overlay = { ...s.overlay, [id]: { ...entry, pinned: !entry.pinned } };
          const items = s.items.map((c) => (c.id === id ? { ...c, pinned: !entry.pinned } : c));
          return { overlay, items };
        }),

      rename: (id, title) =>
        set((s) => {
          const entry = s.overlay[id] ?? { pinned: false };
          const overlay = { ...s.overlay, [id]: { ...entry, renamedTitle: title } };
          const items = s.items.map((c) => (c.id === id ? { ...c, title, renamedTitle: title } : c));
          return { overlay, items };
        }),

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
                { id, title: derivedTitle, messageCount: 1, createdAt: Date.now(), pinned: false },
                ...s.items,
              ];
          return { overlay, items };
        }),

      ensureLocalEntry: (id, createdAt) =>
        set((s) => {
          if (s.items.some((c) => c.id === id)) return s;
          return {
            items: [
              { id, title: 'New conversation', messageCount: 0, createdAt, pinned: false },
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
