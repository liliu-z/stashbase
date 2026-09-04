import { PlusIcon } from '@/common/components/icons';
import { Button } from '@/common/components/ui/button';
import { readPreferredAgent } from '@/common/lib/agentPreference';
import { useAppActions } from '@/store/contexts/AppContext';

/** The launcher-row recipe the sidebar's top group shares: a quiet
 *  min-h-7 ghost row whose label lands on the common gutter line. New
 *  Chat defines the anatomy; the Gallery and Choose Folder rows reuse
 *  it so the group reads as one family. */
export const launcherRowClass =
  'h-auto min-h-7 w-full min-w-0 justify-start gap-2 px-2 text-left text-base font-normal text-muted-foreground';

/** Full-width New Chat entry at the sidebar's top (Cursor's "New
 *  Agent" position) — the app's ONE chat-creation entry point, and a
 *  PURE action: one row, one target. Which agent the chat uses is the
 *  blank chat's own business now — the composer carries the agent pill,
 *  where the choice is visible at the point of use — and chat History
 *  lives with the chat pane, so neither crowds this row any more.
 *  Clicking reuses the one completely blank tab regardless of its agent
 *  (`newChatPlan`); any content, draft, attachments, or resumed session
 *  means a fresh tab instead. It opens the chat panel when hidden. The
 *  tab's scope resolves to the window default (current folder, else
 *  Library) on connect. */
export function NewChatButton() {
  const { actions } = useAppActions();

  return (
    /* A quiet full-width pill row, not a boxed button — the sidebar's
     * rows carry the hierarchy. Secondary ink at rest like every
     * launcher row below; the ghost hover pays full ink back. */
    <div className="flex-none px-1.5 pt-2 pb-3">
      <Button
        variant="ghost"
        size="sm"
        className={launcherRowClass}
        title="Start a chat in the current folder, or across the whole library"
        onClick={() => actions.activateChatTab(readPreferredAgent())}
      >
        {/* 16px slot around the 14px glyph — every launcher row does
          * this, so the label lands on the shared gutter line. */}
        <span className="inline-flex size-4 flex-none items-center justify-center">
          <PlusIcon className="size-3.5 text-muted-foreground" />
        </span>
        <span className="min-w-0 truncate">New Chat</span>
      </Button>
    </div>
  );
}
