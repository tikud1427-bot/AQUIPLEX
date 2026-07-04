import { AnimatePresence, motion } from 'framer-motion';

/**
 * Live thinking state shown between send and first token.
 *
 * The label comes from REAL pipeline stage events streamed by the backend
 * ("Checking memory…", "Reading workspace…", "Generating response…") — it
 * is never a scripted animation. No stage yet (request still connecting)
 * falls back to a neutral shimmer.
 */
export function ThinkingIndicator({ stage }: { stage?: { id: string; label: string } }) {
  return (
    <div className="flex items-center gap-2.5 py-1" aria-live="polite" aria-label={stage?.label ?? 'AQUA is thinking'}>
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-foreground-secondary/50"
            animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
            transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }}
          />
        ))}
      </div>

      <AnimatePresence mode="wait">
        {stage && (
          <motion.span
            key={stage.id}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.18 }}
            className="thinking-shimmer text-[13px] text-foreground-secondary"
          >
            {stage.label}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
