import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { useUiStore } from '@/stores/uiStore';
import type { ToastVariant } from '@/types';
import { cn } from '@/lib/utils';
import { useEffect } from 'react';

const ICONS: Record<ToastVariant, React.ElementType> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const ICON_COLOR: Record<ToastVariant, string> = {
  success: 'text-success',
  error: 'text-danger',
  warning: 'text-warning',
  info: 'text-primary',
};

function ToastRow({ id, variant, title, description, action, durationMs }: {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}) {
  const dismiss = useUiStore((s) => s.dismissToast);
  const Icon = ICONS[variant];

  useEffect(() => {
    if (!durationMs) return;
    const t = setTimeout(() => dismiss(id), durationMs);
    return () => clearTimeout(t);
  }, [id, durationMs, dismiss]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-lg"
      role="status"
    >
      <Icon className={cn('mt-0.5 h-4.5 w-4.5 shrink-0', ICON_COLOR[variant])} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && <p className="mt-0.5 text-xs text-foreground-secondary">{description}</p>}
        {action && (
          <button
            onClick={action.onClick}
            className="mt-1.5 text-xs font-medium text-primary hover:underline"
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => dismiss(id)}
        className="shrink-0 rounded p-0.5 text-foreground-secondary/60 hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}

export function ToastViewport() {
  const toasts = useUiStore((s) => s.toasts);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2 sm:bottom-6 sm:right-6">
      <AnimatePresence mode="popLayout">
        {toasts.map((t) => (
          <ToastRow key={t.id} {...t} />
        ))}
      </AnimatePresence>
    </div>
  );
}
