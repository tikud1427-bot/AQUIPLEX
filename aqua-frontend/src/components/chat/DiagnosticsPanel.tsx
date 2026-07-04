import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Cpu, Gauge, Sparkles, Brain } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { MessageDiagnostics } from '@/types';

const COST_VARIANT = { low: 'success', medium: 'warning', high: 'danger' } as const;

export function DiagnosticsPanel({ diagnostics }: { diagnostics: MessageDiagnostics }) {
  const [open, setOpen] = useState(false);
  const { provider, taskType, confidence, latencyMs, orchestration, memory, fallbackChain } = diagnostics;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-foreground-secondary/70 transition-colors hover:bg-surface-secondary hover:text-foreground-secondary"
      >
        <Cpu className="h-3 w-3" />
        <span className="font-mono">{provider}</span>
        <span className="text-foreground-secondary/40">·</span>
        <span>{taskType.replace(/_/g, ' ')}</span>
        <span className="text-foreground-secondary/40">·</span>
        <span>{latencyMs != null ? `${latencyMs}ms` : '—'}</span>
        {fallbackChain.length > 1 && (
          <>
            <span className="text-foreground-secondary/40">·</span>
            <span className="text-warning">{fallbackChain.length} attempts</span>
          </>
        )}
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-3 rounded-lg border border-border bg-surface-secondary/50 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="primary">{orchestration.profileLabel}</Badge>
                <Badge>conf {(confidence * 100).toFixed(0)}%</Badge>
                <Badge variant={COST_VARIANT[orchestration.estimatedCost as keyof typeof COST_VARIANT] ?? 'default'}>
                  cost: {orchestration.estimatedCost}
                </Badge>
                <Badge variant={COST_VARIANT[orchestration.estimatedLatency as keyof typeof COST_VARIANT] ?? 'default'}>
                  speed: {orchestration.estimatedLatency}
                </Badge>
                {orchestration.verificationEnabled && (
                  <Badge variant="success">
                    <Sparkles className="h-2.5 w-2.5" /> verified
                  </Badge>
                )}
              </div>

              {orchestration.capabilitiesEnabled.length > 0 && (
                <div>
                  <p className="mb-1 flex items-center gap-1 font-medium text-foreground-secondary">
                    <Gauge className="h-3 w-3" /> Capabilities used
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {orchestration.capabilitiesEnabled.map((c) => (
                      <Badge key={c} variant="outline">{c}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {(memory.extracted > 0 || memory.injected > 0) && (
                <div>
                  <p className="mb-1 flex items-center gap-1 font-medium text-foreground-secondary">
                    <Brain className="h-3 w-3" /> Memory
                  </p>
                  <p className="text-foreground-secondary">
                    {memory.injected > 0 && `${memory.injected} fact${memory.injected === 1 ? '' : 's'} recalled`}
                    {memory.injected > 0 && memory.extracted > 0 && ' · '}
                    {memory.extracted > 0 && `${memory.extracted} new fact${memory.extracted === 1 ? '' : 's'} learned`}
                  </p>
                  {memory.facts.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {memory.facts.slice(0, 5).map((f, i) => (
                        <li key={i} className="truncate text-foreground-secondary/80">
                          <span className="font-mono text-[10px]">{f.key}</span>: {f.value}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {fallbackChain.length > 0 && (
                <div>
                  <p className="mb-1 font-medium text-foreground-secondary">Provider chain</p>
                  <div className="space-y-0.5">
                    {fallbackChain.map((f, i) => (
                      <div key={i} className="flex items-center gap-1.5 font-mono text-[11px]">
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full',
                            f.outcome === 'success' ? 'bg-success' : 'bg-danger',
                          )}
                        />
                        <span className="text-foreground-secondary">{f.provider}</span>
                        <span className="text-foreground-secondary/50">{f.outcome}</span>
                        {f.latencyMs != null && <span className="text-foreground-secondary/50">{f.latencyMs}ms</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
