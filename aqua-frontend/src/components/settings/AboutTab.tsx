import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AquaLogo } from '@/components/common/AquaLogo';
import { getHealth } from '@/api/health';
import { normalizeError } from '@/api/client';
import type { HealthResponse } from '@/types';
import { cn } from '@/lib/utils';

type Status = 'operational' | 'degraded' | 'offline';

/**
 * Product-facing status only. We derive one overall signal from the backend
 * and never surface providers, models, routing, circuit states, or latency —
 * the user should never see implementation details.
 */
function deriveStatus(health: HealthResponse | null, error: string | null): Status {
  if (error || !health) return 'offline';
  const anyOpen = Object.values(health.providers).some((p) => p.circuitState === 'open');
  return anyOpen ? 'degraded' : 'operational';
}

const STATUS_META: Record<Status, { label: string; dot: string; text: string }> = {
  operational: { label: 'All systems operational', dot: 'bg-success', text: 'text-foreground' },
  degraded: { label: 'Running with reduced capacity', dot: 'bg-warning', text: 'text-foreground' },
  offline: { label: 'Can’t reach AQUA', dot: 'bg-danger', text: 'text-danger' },
};

export function AboutTab() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    getHealth()
      .then((h) => { setHealth(h); setError(null); })
      .catch((err) => { setHealth(null); setError(normalizeError(err).message); })
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  const status = deriveStatus(health, error);
  const meta = STATUS_META[status];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center">
          <AquaLogo size={40} />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">AQUA</p>
          <p className="text-xs text-foreground-secondary">Your AI workspace on the AQUIPLEX platform</p>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">Status</p>
          <Button size="icon-sm" variant="ghost" onClick={load} disabled={loading} aria-label="Refresh status">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-secondary/40 px-3 py-2.5 text-xs text-foreground-secondary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking status…
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-secondary/40 px-3 py-2.5">
              <span className={cn('h-2 w-2 rounded-full', meta.dot)} />
              <span className={cn('text-sm', meta.text)}>{meta.label}</span>
            </div>
            {health && (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs">
                <span className="text-foreground-secondary">Uptime</span>
                <span className="font-mono text-foreground">{health.uptime.uptimeHuman}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}