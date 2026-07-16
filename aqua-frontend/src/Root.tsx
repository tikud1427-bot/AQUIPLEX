import { Outlet } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useVersionGuard } from '@/hooks/useVersionGuard';

export function Root() {
  // P0 (cache) — deploy detection + stale-chunk self-healing for every route.
  useVersionGuard();
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
