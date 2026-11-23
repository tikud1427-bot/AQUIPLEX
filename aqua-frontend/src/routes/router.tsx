import { lazy } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { Root } from '@/Root';
import { ChatPage } from '@/pages/ChatPage';
import { PrivacyPolicyPage } from '@/pages/PrivacyPolicyPage';
import { NotFoundPage, RouteError } from '@/components/feedback/RouteError';
import { LazyRoute } from '@/components/feedback/LazyRoute';

const MindPage = lazy(() => import('@/pages/MindPage'));
const IntroPage = lazy(() => import('@/pages/IntroPage'));
const ProjectsPage = lazy(() => import('@/pages/ProjectsPage'));
const MemoryPage = lazy(() => import('@/pages/MemoryPage'));
const GmailIntelligencePage = lazy(() => import('@/pages/GmailIntelligencePage'));

/* Fixture preview, DEV builds only.
   The `import()` has to live INSIDE the guard, not beside it. A top-level
   `lazy(() => import(...))` is an unconditional dynamic import: Vite emits the
   chunk regardless of what the route table does with it, and the dev page +
   every fixture string ship to production. Inside the branch, `import.meta.env.DEV`
   is substituted with `false` at build time and Rollup drops the whole thing.
   The build verifies this — see CHANGES.md. */
const devRoutes = import.meta.env.DEV
  ? (() => {
      const DevMarkdownPage = lazy(() => import('@/pages/DevMarkdownPage'));
      return [
        {
          path: 'dev/markdown',
          element: (
            <LazyRoute label="Loading fixtures…">
              <DevMarkdownPage />
            </LazyRoute>
          ),
        },
      ];
    })()
  : [];


export const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <Root />,
      // Without this, any thrown route error renders React Router's built-in
      // developer page — unstyled, with a stack trace and no way back.
      errorElement: <RouteError />,
      children: [
        { index: true, element: <ChatPage /> },
        { path: 'c/:conversationId', element: <ChatPage /> },

        {
          path: 'projects',
          element: <LazyRoute label="Looking for your projects…"><ProjectsPage /></LazyRoute>,
        },
        {
          path: 'memory',
          element: <LazyRoute label="Reading what AQUA remembers…"><MemoryPage /></LazyRoute>,
        },
        {
          path: 'mind',
          element: <LazyRoute label="Opening the mind…"><MindPage /></LazyRoute>,
        },
        {
          path: 'email',
          element: <LazyRoute label="Reading your email knowledge…"><GmailIntelligencePage /></LazyRoute>,
        },

        {
          // "Getting to Know You" — never /onboarding, never /setup. The URL is
          // part of the vocabulary, and a person who looks at it should see the
          // same word the product uses everywhere else.
          path: 'understanding/start',
          element: <LazyRoute label="Getting ready to listen…"><IntroPage /></LazyRoute>,
        },

        {
          path: 'privacy',
          element: <PrivacyPolicyPage />,
        },

        ...devRoutes,

        // Catch-all lives inside the shell on purpose: a mistyped or stale URL
        // should leave the sidebar in place so the next click is obvious.
        {
          path: '*',
          element: <NotFoundPage />,
        },
      ],
    },
  ],
  { basename: import.meta.env.VITE_APP_BASENAME || '/aqua' }
);