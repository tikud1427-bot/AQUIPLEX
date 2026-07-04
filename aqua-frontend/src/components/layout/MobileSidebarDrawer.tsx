import { AnimatePresence, motion } from 'framer-motion';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { useUiStore } from '@/stores/uiStore';

export function MobileSidebarDrawer() {
  const open = useUiStore((s) => s.mobileSidebarOpen);
  const setOpen = useUiStore((s) => s.setMobileSidebarOpen);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
          />
          <motion.div
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 320 }}
            className="fixed inset-y-0 left-0 z-50 shadow-2xl md:hidden"
          >
            <Sidebar collapsed={false} isMobileOverlay onNavigate={() => setOpen(false)} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
