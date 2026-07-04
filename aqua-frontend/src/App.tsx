import { RouterProvider } from 'react-router-dom';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { PreferencesProvider } from '@/providers/PreferencesProvider';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { router } from '@/routes/router';

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <PreferencesProvider>
          <RouterProvider router={router} />
        </PreferencesProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
