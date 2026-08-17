import { Suspense, useEffect, useState } from 'react';
import { lazyWithRetry } from './ErrorBoundary';
import { useOverlayLayer } from './OverlayStack';
import { ModalLoadingStatus } from './ui/status';

export type SettingsSection = 'general' | 'appearance' | 'agents' | 'embedding' | 'transcription' | 'mcp';

export interface SettingsModalProps {
  initialSection: SettingsSection;
  isTopmost: boolean;
  onClose: () => void;
}

interface OpenDetail {
  section?: SettingsSection;
}

const ManagedSettingsModal = lazyWithRetry(() => import('./ManagedSettingsModal'));

export function openSettings(section?: SettingsSection): void {
  window.dispatchEvent(
    new CustomEvent<OpenDetail>('stashbase-open-settings', { detail: { section } }),
  );
}

/** Event ownership stays eager; the managed dialog and settings panels load
 * only when Settings is first opened. */
export function SettingsPortal() {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>('appearance');
  const layer = useOverlayLayer(open);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent<boolean>('stashbase-overlay-blocking', { detail: open }));
    return () => {
      window.dispatchEvent(new CustomEvent<boolean>('stashbase-overlay-blocking', { detail: false }));
    };
  }, [open]);

  useEffect(() => {
    function onOpen(event: Event) {
      const detail = (event as CustomEvent<OpenDetail>).detail;
      if (detail?.section) setSection(detail.section);
      setOpen(true);
    }
    window.addEventListener('stashbase-open-settings', onOpen);
    return () => {
      window.removeEventListener('stashbase-open-settings', onOpen);
    };
  }, []);

  if (!open) return null;
  return (
    <Suspense
      fallback={(
        <ModalLoadingStatus
          label="Opening Settings…"
          isTopmost={layer.isTopmost}
          onCancel={() => setOpen(false)}
        />
      )}
    >
      <ManagedSettingsModal
        initialSection={section}
        isTopmost={layer.isTopmost}
        onClose={() => setOpen(false)}
      />
    </Suspense>
  );
}
