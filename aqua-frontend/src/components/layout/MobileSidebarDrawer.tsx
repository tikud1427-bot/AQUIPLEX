import { useRef } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { useUiStore } from '@/stores/uiStore';

/**
 * The drawer used to be a bare motion.div: focus stayed on the page behind
 * it, Escape did nothing, and nothing told a screen reader a modal surface
 * had opened. Radix's Dialog primitive supplies the focus trap, Escape,
 * aria-modal and scroll lock; framer-motion still owns the movement via
 * `asChild` + `forceMount`, so the slide is unchanged.
 */
export function MobileSidebarDrawer() {
  const open = useUiStore((s) => s.mobileSidebarOpen);
  const setOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const reduce = useReducedMotion();
  // Same as ArtifactsPanel (2026-10-17): with the exit animation's delayed
  // unmount, focus did not return to "Open menu". Capture it before Radix moves
  // focus in, restore it on close.
  const returnFocus = useRef<HTMLElement | null>(null);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="fixed inset-0 z-40 bg-black/40 md:hidden"
              />
            </DialogPrimitive.Overlay>

            <DialogPrimitive.Content
              asChild
              forceMount
              aria-describedby={undefined}
              onOpenAutoFocus={() => { returnFocus.current = document.activeElement as HTMLElement | null; }}
              onCloseAutoFocus={(e) => {
                const el = returnFocus.current;
                if (el && document.contains(el)) { e.preventDefault(); el.focus(); }
              }}
            >
              <motion.div
                initial={reduce ? false : { x: '-100%' }}
                animate={{ x: 0 }}
                exit={reduce ? { opacity: 0 } : { x: '-100%' }}
                transition={reduce ? { duration: 0.01 } : { type: 'spring', damping: 32, stiffness: 320 }}
                className="fixed inset-y-0 left-0 z-50 shadow-2xl focus:outline-none md:hidden"
              >
                {/* Radix requires an accessible name for the dialog. It is the
                    drawer's purpose, not decoration, so it is announced but
                    not drawn — the visible header is the Sidebar's own. */}
                <DialogPrimitive.Title className="sr-only">Conversations</DialogPrimitive.Title>
                <Sidebar collapsed={false} isMobileOverlay onNavigate={() => setOpen(false)} />
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
