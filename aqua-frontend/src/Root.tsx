import { Outlet } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';

export function Root() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
