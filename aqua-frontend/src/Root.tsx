import { Outlet } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useVersionGuard } from '@/hooks/useVersionGuard';

export function Root() {
  useVersionGuard();

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}