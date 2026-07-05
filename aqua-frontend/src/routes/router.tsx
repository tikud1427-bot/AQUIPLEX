import { lazy, Suspense } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { Root } from '@/Root';
import { ChatPage } from '@/pages/ChatPage';

const MindPage = lazy(() => import('@/pages/MindPage'));

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Root />,
    children: [
      { index: true, element: <ChatPage /> },
      { path: 'c/:conversationId', element: <ChatPage /> },
      {
        path: 'mind',
        element: (
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-foreground-secondary">Opening the mind…</div>}>
            <MindPage />
          </Suspense>
        ),
      },
    ],
  },
], { basename: '/aqua' });
