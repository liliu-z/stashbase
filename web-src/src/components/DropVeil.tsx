import { Suspense } from 'react';
import { lazyWithRetry } from './ErrorBoundary';

const ManagedDropVeil = lazyWithRetry(() => import('./ManagedDropVeil'));

/** Drag-import veil. Visibility flows from the global drag handler in
 *  the parent (`useGlobalDragDrop`) via the `hot` prop. Motion is loaded only
 *  when a drag begins, so an optional visual enhancement does not tax startup. */
export function DropVeil({
  hot,
  activeZone,
  sidebarWidth,
  sidebarCollapsed,
}: {
  hot: boolean;
  activeZone: 'sidebar' | 'main' | null;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}) {
  if (!hot) return null;
  return (
    <Suspense fallback={<div className="drop-veil hot">Release to import</div>}>
      <ManagedDropVeil
        activeZone={activeZone}
        sidebarWidth={sidebarWidth}
        sidebarCollapsed={sidebarCollapsed}
      />
    </Suspense>
  );
}
