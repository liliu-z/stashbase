import { MotionConfig, motion } from 'motion/react';

export default function ManagedDropVeil({
  activeZone,
  sidebarWidth,
  sidebarCollapsed,
}: {
  activeZone: 'sidebar' | 'main' | null;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}) {
  const showSidebarZone = !sidebarCollapsed;
  const sidebarTotalWidth = sidebarWidth + 44;
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        className="fixed inset-0 z-100 flex pointer-events-none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12 }}
        style={{
          fontFamily: 'var(--font-sans)',
        }}
      >
        {showSidebarZone && (
          <div
            className="flex flex-col items-center justify-center border-dashed border-r border-accent/30 transition-all duration-200"
            style={{
              width: `${sidebarTotalWidth}px`,
              backgroundColor: activeZone === 'sidebar' ? 'rgba(var(--accent-rgb), 0.12)' : 'rgba(var(--accent-rgb), 0.04)',
              borderWidth: activeZone === 'sidebar' ? '2px' : '0px',
              borderStyle: 'dashed',
              borderColor: 'var(--accent)',
            }}
          >
            <span className="text-base font-semibold" style={{ color: 'var(--accent)' }}>Copy to library</span>
            <span className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Release to import</span>
          </div>
        )}
        <div
          className="flex-1 flex flex-col items-center justify-center transition-all duration-200"
          style={{
            backgroundColor: activeZone === 'main' ? 'rgba(var(--accent-rgb), 0.12)' : 'rgba(var(--accent-rgb), 0.04)',
            borderWidth: activeZone === 'main' ? '2px' : '0px',
            borderStyle: 'dashed',
            borderColor: 'var(--accent)',
          }}
        >
          <span className="text-base font-semibold" style={{ color: 'var(--accent)' }}>Open temporarily</span>
          <span className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Release to open without copying</span>
        </div>
      </motion.div>
    </MotionConfig>
  );
}
