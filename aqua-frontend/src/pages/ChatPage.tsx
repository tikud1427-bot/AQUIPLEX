import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MessageList } from '@/components/chat/MessageList';
import { EmptyState } from '@/components/chat/EmptyState';
import { Composer } from '@/components/chat/Composer';
import { WorkspaceDashboard } from '@/components/workspace/WorkspaceDashboard';
import { ProjectContextBar } from '@/components/workspace/ProjectContextBar';
import { useChatStore } from '@/stores/chatStore';
import { useUploadStore } from '@/stores/uploadStore';

export function ChatPage() {
  const { conversationId: routeId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const storeConversationId = useChatStore((s) => s.conversationId);
  const messages = useChatStore((s) => s.messages);
  const loadConversation = useChatStore((s) => s.loadConversation);
  const newConversation = useChatStore((s) => s.newConversation);
  const lastLoadedRef = useRef<string | null>(null);

  useEffect(() => {
    if (routeId && routeId !== lastLoadedRef.current) {
      lastLoadedRef.current = routeId;
      loadConversation(routeId);
    } else if (!routeId && storeConversationId) {
      // Navigated to "/" (New chat) while a conversation was active.
      lastLoadedRef.current = null;
      newConversation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  useEffect(() => {
    // First send on "/" just minted a conversationId server-side — reflect
    // it in the URL so refresh, back/forward, and sidebar highlighting all
    // stay in sync with what's actually loaded.
    if (!routeId && storeConversationId) {
      lastLoadedRef.current = storeConversationId;
      navigate(`/c/${storeConversationId}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeConversationId]);

  const showEmptyState = !routeId && messages.length === 0;

  // Workspace dashboard becomes the landing page after an upload: shown
  // whenever an overview exists, the user hasn't dismissed it, and no
  // conversation is on screen yet. First message (or clicking a suggested
  // question) hands the screen back to the message list.
  const overview = useUploadStore((s) => s.overview);
  const showDashboard = useUploadStore((s) => s.showDashboard);
  const dashboardVisible = showDashboard && !!overview && messages.length === 0;

  // The full dashboard already IS the project-context view — only show the
  // compact strip when it's not on screen, so context is never shown twice.
  const showContextBar = !!overview && !dashboardVisible;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showContextBar && <ProjectContextBar />}
      {dashboardVisible ? (
        <WorkspaceDashboard overview={overview} />
      ) : showEmptyState ? (
        <EmptyState />
      ) : (
        <MessageList />
      )}
      <Composer />
    </div>
  );
}
