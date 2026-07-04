import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getHealth } from '@/api/health';
import { normalizeError } from '@/api/client';
import type { HealthResponse } from '@/types';
import { cn } from '@/lib/utils';

const CIRCUIT_VARIANT = {
  closed: 'success',
  half_open: 'warning',
  open: 'danger',
} as const;

export function AboutTab() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    getHealth()
      .then(setHealth)
      .catch((err) => setError(normalizeError(err).message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent">
          <span className="text-sm font-bold text-white">AQ</span>
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">AQUA</p>
          <p className="text-xs text-foreground-secondary">Frontend for the AQUIPLEX platform</p>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">Backend status</p>
          <Button size="icon-sm" variant="ghost" onClick={load} disabled={loading} aria-label="Refresh status">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-foreground-secondary" />
          </div>
        ) : error ? (
          <p className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2.5 text-xs text-danger">
            Could not reach AQUA backend — {error}
          </p>
        ) : health ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface-secondary/40 px-3 py-2 text-xs">
              <span className="text-foreground-secondary">Uptime</span>
              <span className="font-mono text-foreground">{health.uptime.uptimeHuman}</span>
            </div>

            <div className="space-y-1.5">
              {Object.entries(health.providers).map(([name, p]) => (
                <div key={name} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-medium text-foreground">{name}</span>
                    <Badge variant={CIRCUIT_VARIANT[p.circuitState as keyof typeof CIRCUIT_VARIANT] ?? 'default'}>
                      {p.circuitState.replace('_', ' ')}
                    </Badge>
                  </div>
                  <div className="text-right text-[11px] text-foreground-secondary">
                    <span>{p.successRate} success</span>
                    <span className="mx-1 text-foreground-secondary/40">·</span>
                    <span>{p.avgLatencyMs}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
