import { Suspense, useRef, useState } from 'react';
import { HistoryIcon } from '@/common/components/icons';
import type { AgentKind } from '@/common/lib/agentCatalog';
import { useAppActions } from '@/store/contexts/AppContext';
import type { HistoryScope } from '@/common/lib/libraryScope';
import { lazyWithRetry } from '@/common/components/ErrorBoundary';
import { Button } from '@/common/components/ui/button';
import { cn } from '@/common/lib/utils';
import { PopupLoadingStatus } from '@/common/components/ui/status';

/* The popover and its session list load at the interaction boundary
 * rather than with the window. The boundary lives here rather than in the
 * feature barrel because this button is the menu's only caller — an export
 * the barrel kept would be public API with nothing outside the feature
 * reading it. */
const SessionHistoryMenu = lazyWithRetry(() =>
  import('@/features/agent-panel/components/SessionHistoryMenu').then((mod) => ({ default: mod.SessionHistoryMenu })));

/** History clock on a sidebar scope header: opens the merged
 *  session-history menu for that scope (all agents' sessions, newest
 *  first). Picking a session records a pending resume in the store and
 *  ensures a suitable chat tab is active (the New Chat blank-tab reuse
 *  rule); that tab's AgentView consumes the request and resumes the
 *  session within this scope. */
export function ScopeHistoryButton({
  scope,
  label,
  className,
  onOpenChange,
}: {
  scope: HistoryScope;
  /** Accessible name + tooltip, e.g. "Chat history in Notes". */
  label: string;
  /** Placement adjustments from the hosting row (e.g. the chat header's
   *  titlebar-band centring). */
  className?: string;
  /** Lets the owning header hold its hover-revealed cluster visible
   *  while the menu is open. */
  onOpenChange?: (open: boolean) => void;
}) {
  const { actions, dispatch } = useAppActions();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  function setOpenReported(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
  }

  function resumeSession(agent: AgentKind, sessionId: string, folder: string | null) {
    setOpenReported(false);
    // The row's own scope, not the menu's: the all-scope history resumes
    // each session in the folder (or library) it belongs to.
    dispatch({
      type: 'CHAT_RESUME_REQUEST',
      resume: { agent, sessionId, folder },
    });
    actions.activateChatTab(agent);
  }

  const rect = open ? buttonRef.current?.getBoundingClientRect() : undefined;

  return (
    <>
      <Button
        ref={buttonRef}
        variant="ghost"
        /* icon-sm with a 3.5 glyph: the chat header's control size —
         * the same pair AgentInstructionsControl and the floating
         * chat-panel toggle use, so the three sit as one family. */
        size="icon-sm"
        className={cn('text-muted-foreground aria-expanded:bg-active aria-expanded:text-foreground', className)}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpenReported(!open)}
      >
        <HistoryIcon className="size-3.5" /></Button>
      {open && (
        <Suspense
          fallback={(
            <PopupLoadingStatus
              label="Opening history…"
              left={rect?.left ?? 0}
              top={(rect?.bottom ?? 0) + 4}
              onCancel={() => setOpenReported(false)}
            />
          )}
        >
          <SessionHistoryMenu
            scope={scope}
            ariaLabel={label}
            triggerRef={buttonRef}
            onClose={() => setOpenReported(false)}
            onResume={resumeSession}
          />
        </Suspense>
      )}
    </>
  );
}
