import { createBrowserRouter } from 'react-router-dom';
import { Root } from '@/Root';
import { ChatPage } from '@/pages/ChatPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Root />,
    children: [
      { index: true, element: <ChatPage /> },
      { path: 'c/:conversationId', element: <ChatPage /> },
    ],
  },
], { basename: '/aqua' });
