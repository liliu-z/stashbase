/** Composes the window title row across welcome, document, and Chat states. */
import { AnimatePresence, motion } from 'framer-motion';

import type { SidebarMode } from '@/app/composition/commands/use-workspace-commands';
import { Button } from '@/components/ui/button';
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { Tooltip } from '@/components/ui/tooltip';
import { ChatNavButtons, ChatTitle, type AgentWorkspaceRuntime } from '@/features/agent/public';
import {
  DocumentHistoryButtons,
  DocumentTabs,
  useHasOpenDocuments,
  type DocumentTabMenuActions,
  type NewTab,
  type DocumentTabsRuntime,
} from '@/features/documents/public';
import { useIcon } from '@/lib/icon-context';
import { SizeProvider } from '@/lib/size-context';
import { collapseTween, spring } from '@/lib/springs';
import { cn } from '@/lib/utils';

/** How the corner controls and the Welcome title enter and leave. */
const FADE = {
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: spring.fast.exit },
  initial: { opacity: 0 },
  transition: spring.fast,
} as const;

/** The window's title row. Its shared slot shows the open documents' tabs,
 *  ending in the plus that opens the New tab, and otherwise stays empty: the
 *  Chat pane names its own conversation in its header, so the row never has
 *  to, and a hidden panel takes the name away with it. With no folder open
 *  there is no workspace on screen at all, and the row says Welcome instead,
 *  which is what is on screen. A draft starts from the New tab's page, not
 *  from a standing button: it makes a document, and the strip is where
 *  documents show. The expanded sidebar's header carries the collapse
 *  control and the document history's back and forward; only while the
 *  sidebar is collapsed does this titlebar host them, the reopening trigger
 *  and the arrows ahead of the strip, in the same window corner they left.
 *  The chat panel's toggle mirrors that
 *  trigger at the row's far right: the same square in the opposite corner
 *  with the mirrored glyph, present in every folder state so the panel can
 *  always be brought back from where it was hidden, and alone there, so the
 *  corner never changes shape. New chat lives with the conversation, in the
 *  pane's own header, and a hidden pane takes it along. In the sidebar's
 *  Chats mode the Chat has the whole card: the open documents leave it and
 *  their tabs leave this row, whose shared slot names the chat instead, and
 *  the corner rests as empty room, since there is no document pane for the
 *  toggle to give width to. */
export function WorkspaceTitlebar({
  agent,
  chatPaneOpen,
  documents,
  hasActiveFolder,
  mode,
  newTab,
  onToggleChatPane,
  sidebarNotices,
  tabMenu,
}: {
  agent: AgentWorkspaceRuntime;
  chatPaneOpen: boolean;
  documents: DocumentTabsRuntime | null;
  hasActiveFolder: boolean;
  /** The sidebar mode the collapsed column was last in, which is what the
   *  arrows here step: the open Chats, or else the document history. */
  mode: SidebarMode;
  /** The New tab the strip's plus opens. */
  newTab: NewTab;
  onToggleChatPane(): void;
  /** True while the sidebar's foot holds a notice, which a collapsed sidebar
   *  takes off screen with it. */
  sidebarNotices: boolean;
  /** Showing a tab's file on disk and copying its path, for the tab menu. */
  tabMenu?: DocumentTabMenuActions | undefined;
}) {
  const PanelRight = useIcon('panel-right');
  // The compact square, the one the sidebar's band draws its toggle and
  // arrows at, so the corner holds the same square in both sidebar states.
  const size = 'icon-compact' as const;
  const chatPaneLabel = chatPaneOpen ? 'Hide chat panel' : 'Show chat panel';
  const chatHasCard = hasActiveFolder && mode === 'chats';
  const { isMobile, open } = useSidebar();
  // Nothing open means the strip is a single plus with the Chat pane's own
  // header directly beneath it, which is what the slot's inset below reads.
  const hasOpenDocuments = useHasOpenDocuments(documents);
  const lonePlus = !newTab.open && !hasOpenDocuments;
  // While the sidebar is on screen the collapse control lives in its own
  // header; this titlebar hosts the reopening trigger only once the sidebar
  // is away (or renders as a sheet), in the same window corner it left.
  const showsTrigger = isMobile || !open;
  return (
    <header className="workspace-titlebar relative flex h-11 shrink-0 items-center border-b border-border px-2">
      {/* Welcome is centred on the whole row, not on the slot between the
       *  corners: the left corner also holds the traffic lights' room, so the
       *  slot's centre sits right of the window's and the word would miss the
       *  lockup centred beneath it. It takes no pointer, so the corner's
       *  trigger stays reachable under it. */}
      <AnimatePresence initial={false}>
        {!hasActiveFolder && (
          <motion.div
            {...FADE}
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            key="welcome"
          >
            <span className="truncate text-caption font-medium text-foreground">Welcome</span>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="workspace-titlebar-controls flex items-center">
        <AnimatePresence initial={false}>
          {showsTrigger && (
            <motion.div {...FADE} className="flex items-center" key="sidebar-controls">
              <SizeProvider size="compact">
                {/* A notice in the collapsed sidebar's foot leaves a dot on
                 *  the control that brings it back. A card floated in the
                 *  window's lower left instead would cover the composer,
                 *  which spans that corner in narrow windows. */}
                <span className="relative flex">
                  <SidebarTrigger
                    aria-description={sidebarNotices ? 'Has notices' : undefined}
                    aria-label="Show files sidebar"
                  />
                  {sidebarNotices && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-foreground ring-2 ring-background"
                      data-testid="sidebar-notice-dot"
                    />
                  )}
                </span>
                {hasActiveFolder &&
                  (mode === 'chats' ? (
                    <ChatNavButtons runtime={agent} />
                  ) : (
                    documents && <DocumentHistoryButtons runtime={documents} />
                  ))}
              </SizeProvider>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {/* Where the slot starts follows what stands under it. Beside an open
       *  document the strip keeps no padding of its own, so the row's 8px
       *  inset is where the first tab starts. With nothing open the strip is
       *  only the plus and the Chat has the whole pane beneath: the row's
       *  inset alone would centre the plus's 14px glyph 2px left of the
       *  header's 16px mark, so the slot adds those 2px and the two share one
       *  column. With the sidebar collapsed the corner controls come first
       *  and the slot leaves the band's 2px gap after them. */}
      <div
        className={cn(
          'relative flex min-w-0 flex-1 pr-2',
          showsTrigger || lonePlus ? 'pl-0.5' : 'pl-0',
        )}
      >
        {/* The strip holds its place and is COVERED rather than dismissed. The
         *  Chat taking the card is one surface expanding leftwards over the
         *  row, and the titlebar is part of what it expands over, so the same
         *  edge crosses the strip: it is occluded on the sweep instead of
         *  dissolving under a title fading up through it. It also stays
         *  mounted while covered, so coming back uncovers the tabs that were
         *  there rather than building them again. */}
        {hasActiveFolder && documents && (
          <div
            aria-hidden={chatHasCard || undefined}
            // `isolate`: the strip layers internally — a selected background
            // under the labels, a focus ring over them — and those z-indices
            // would otherwise compete with the cover in the row's own stacking
            // context, so the labels painted through it while the ground was
            // hidden. Contained here, the cover simply comes later and wins.
            className="isolate flex min-w-0 flex-1"
            inert={chatHasCard || undefined}
          >
            <DocumentTabs
              className="workspace-titlebar-controls max-w-full"
              menuActions={tabMenu}
              newTab={newTab}
              runtime={documents}
            />
          </div>
        )}
        <AnimatePresence initial={false}>
          {chatHasCard && (
            // The cover's own edge, travelling the way the pane's seam does
            // and on the same step, so one edge appears to cross the whole
            // window rather than two surfaces agreeing to change at once.
            // `bg-background` is the row's own ground: the cover has to be
            // opaque or it would reveal the strip it is meant to hide.
            // The name reads from the left, where the strip it covers starts
            // and where the pane's own name row keeps its mark: the cover is
            // laid against the slot's padding box, so its own 8px carries the
            // mark to the 16px inset that row uses, and the chat is named in
            // the same column in both layouts.
            <motion.div
              animate={{ clipPath: 'inset(0 0 0 0%)' }}
              className="absolute inset-0 flex items-center bg-background pl-2"
              exit={{ clipPath: 'inset(0 0 0 100%)' }}
              initial={{ clipPath: 'inset(0 0 0 100%)' }}
              key="chat"
              transition={collapseTween.slow}
            >
              <ChatTitle runtime={agent} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {hasActiveFolder && !chatHasCard ? (
        <div className="workspace-titlebar-controls shrink-0">
          <Tooltip content={chatPaneLabel} side="bottom">
            <Button
              aria-label={chatPaneLabel}
              aria-expanded={chatPaneOpen}
              onClick={onToggleChatPane}
              size={size}
              variant="ghost"
            >
              <PanelRight aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
      ) : (
        <div aria-hidden="true" className="size-7 shrink-0" />
      )}
    </header>
  );
}
