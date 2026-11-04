/**
 * Where every composed piece of the workspace window is put on screen.
 *
 * The layout owns arrangement and nothing else. It is handed regions that are
 * already bound — the sidebar, the title row, the split pane, the floating
 * dialogs — and decides only where each sits and which of them the window is
 * far enough along to show. No adapter is named here and no state is derived;
 * anything conditional is a question the composition has already answered.
 */
import type { ReactNode } from 'react';

import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import type { WorkspaceSessionController } from '@/features/workspace/public';

import '@/app/shell.css';

export interface WorkspaceComposition {
  /** Quick open and Settings. */
  dialogs: ReactNode;
  /** Outcomes of the reader's requests that float over the workspace. */
  floatingNotices: ReactNode;
  /** True while the project has a folder open to show. */
  hasActiveFolder: boolean;
  /** The notice strip, composed by the shell inside the account provider. */
  notices: ReactNode;
  /** The Agent beside the open document. */
  panes: ReactNode;
  session: WorkspaceSessionController;
  sidebar: ReactNode;
  /** True once the window has a project and the Agent may be shown. */
  started: boolean;
  titlebar: ReactNode;
  /** The empty-project invitation, shown while no folder is open. */
  welcome: ReactNode;
}

export function WorkspaceLayout({
  dialogs,
  floatingNotices,
  hasActiveFolder,
  notices,
  panes,
  session,
  sidebar,
  started,
  titlebar,
  welcome,
}: WorkspaceComposition) {
  return (
    <SidebarProvider
      className="workspace-shell h-svh min-h-0 overflow-hidden bg-surface-1"
      persist={false}
      onOpenChange={session.runtime.setSidebarOpen}
      onWidthChange={(width) => {
        const pixels = Number.parseFloat(width);
        if (Number.isFinite(pixels)) session.runtime.setSidebarWidth(pixels);
      }}
      open={session.shell.sidebarOpen}
      width={`${session.shell.sidebarWidth}px`}
    >
      {dialogs}
      {sidebar}

      <SidebarInset className="min-h-0 overflow-hidden">
        {titlebar}
        {notices}

        <section aria-label="Agent workspace" className="relative min-h-0 flex-1">
          {started ? (
            <div className="h-full min-h-0">
              <div
                aria-hidden={!hasActiveFolder}
                className={hasActiveFolder ? 'h-full min-h-0' : 'hidden'}
              >
                {panes}
              </div>
              {!hasActiveFolder && welcome}
            </div>
          ) : (
            welcome
          )}
          {floatingNotices}
        </section>
      </SidebarInset>
    </SidebarProvider>
  );
}
