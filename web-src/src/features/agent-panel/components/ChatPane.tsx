/**
 * Right-side chat panel — Cursor-style tabbed chats. Each tab in
 * `state.chatTabs` renders a structured agent panel. Claude routes to the
 * Claude Agent SDK bridge; Codex routes to the Codex app-server bridge.
 * All tabs stay mounted at once so switching preserves each session's
 * state (inactive tabs are absolutely-positioned + `visibility: hidden`).
 * The sidebar's New Chat split button is the one creation entry point;
 * the tabs here switch between (and close) existing chats.
 */
import * as React from 'react';
import type { ReactNode } from 'react';
import '@/features/agent-panel/agent-panel.css';
import { AgentView } from '@/features/agent-panel/components/AgentView';
import { AgentInstructionsControl } from '@/features/agent-panel/components/AgentInstructionsControl';
import { AgentInstructionsModal } from '@/features/agent-panel/components/AgentInstructionsModal';
import { useAgentInstructionsPresence } from '@/features/agent-panel/hooks/useAgentInstructionsEditor';
import { LazyLoadBoundary } from '@/common/components/ErrorBoundary';
import { Button } from '@/common/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/common/components/ui/tabs';
import { agentMeta, isAgentKind } from '@/common/lib/agentCatalog';
import { cn } from '@/common/lib/utils';
import { useAppActions, useChat, useWorkspace } from '@/store/contexts/AppContext';
import { rememberPreferredAgent } from '@/common/lib/agentPreference';
import {
  LIBRARY_SCOPE,
  scopeDisplayName,
} from '@/common/lib/libraryScope';
import type { AgentInstructionsScope } from '@/common/api/api';

/** The inside of one tab body; `status` styles the "no active chat" notice
 *  and the lazy-load error fallback. It has to stay a class string: one of
 *  its two consumers is `LazyLoadBoundary`, which takes a className for its
 *  fallback rather than a child, so there is no element for a component to
 *  own. */
export const chatStatusClass =
  'flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 text-sm text-muted-foreground';

/** Brand glyph for a tab's agent, shown before its title. */
function AgentGlyph({ agent }: { agent: string }) {
  const Icon = agentMeta(agent).Icon;
  return <Icon className="size-3.5 shrink-0" />;
}

export function ChatSessionBoundary({
  tabId,
  active,
  children,
}: {
  tabId: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <LazyLoadBoundary
      className={chatStatusClass}
      label="chat session"
      resetKey={`${tabId}:${active ? 'active' : 'inactive'}`}
    >
      {children}
    </LazyLoadBoundary>
  );
}

export default function ChatPane() {
  const state = useChat();
  const workspace = useWorkspace();
  const { dispatch } = useAppActions();
  // The panel renders with or without a window folder: chats are scoped
  // per tab (a library folder, or the whole library), so a no-folder
  // window can still hold library-wide chats.
  const tabs = state.chatTabs;
  const activeId = state.activeChatTabId;
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const activeInstructionsScope = React.useMemo<AgentInstructionsScope | null>(() => {
    const folderPath = typeof activeTab?.boundFolder === 'string'
      ? activeTab.boundFolder
      : activeTab?.boundFolder === null
        ? null
        : workspace.folderPath || null;
    return folderPath ? { kind: 'folder', path: folderPath } : null;
  }, [activeTab?.boundFolder, workspace.folderPath]);
  const [instructionsScope, setInstructionsScope] = React.useState<AgentInstructionsScope | null>(null);
  const instructionsPresence = useAgentInstructionsPresence(activeInstructionsScope);

  return (
    <aside
      className="chat-pane-shell"
      aria-label="Agent chat"
      aria-hidden={!state.chatOpen || undefined}
      inert={!state.chatOpen || undefined}
    >
      {/* One `Tabs` root spans the strip AND the panes: Base UI pairs a tab
        * with its panel through generated ids and owns roving focus and
        * arrow-key movement, which the hand-rolled tablist this replaced
        * re-implemented by hand against `document.getElementById`. */}
      <Tabs
        className="min-h-0 flex-1"
        value={activeId}
        onValueChange={(value) => dispatch({ type: 'CHAT_TAB_ACTIVATE', id: String(value) })}
      >
        {/* Cursor-style tab strip. Scrolls horizontally when many tabs are
          * open; new tabs come from the sidebar's New Chat button, so the
          * list itself is tabs-only. Agent Instructions is the one panel-level
          * action beside it; pr-10 keeps both clear of the shell's floating
          * chat toggle (TitlebarControls).
          *
          * Geometry mirrors the document strip (`.tab-strip` in
          * workspace.css): 6px above, NOTHING below, tabs bottom-aligned.
          * The two strips sit side by side across the window, so a 4px
          * bottom pad here left the chat tabs floating above a line the
          * document tabs sat on. Change one, change both. */}
        <div className="chat-tab-row flex min-h-8 items-end gap-1 pt-1.5 pr-10 pl-2">
          <TabsList
            // The strip has always selected on arrow-key movement (panes
            // are already mounted, so there is nothing to pay for it).
            activateOnFocus
            aria-label="Chat sessions"
            className="scrollbar-quiet flex-1 overflow-x-auto overflow-y-hidden data-[orientation=horizontal]:items-end data-[orientation=horizontal]:border-b-0"
          >
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                // A tab chip carries its own close button and a <button>
                // cannot nest one. Base UI's non-native mode keeps the
                // role, the roving tabindex, and Enter/Space activation
                // while rendering a <div>.
                nativeButton={false}
                render={<div />}
                title={tab.title}
                onClick={() => {
                  if (isAgentKind(tab.agent)) rememberPreferredAgent(tab.agent);
                }}
                // APG tabs pattern: the focused tab closes on Delete. The
                // visual × below stays pointer-only (aria-hidden, out of
                // the tab order), so this key is the keyboard close path.
                onKeyDown={(event) => {
                  if (event.key === 'Delete') {
                    event.preventDefault();
                    dispatch({ type: 'CHAT_TAB_CLOSE', id: tab.id });
                  }
                }}
                className={cn(
                  // text-sm (12px) + py-1.5 (6px) + rounded-t-sm (the 6px
                  // control-role top corners) = the document tab's exact
                  // type size, vertical padding, and radius (`.tab` in
                  // workspace.css), so both strips' tabs stand the same
                  // height in the same voice.
                  'group/tab inline-flex max-w-45 min-w-0 items-center gap-1.5 rounded-none rounded-t-sm border border-transparent border-b-0 py-1.5 pr-1.5 pl-2.5 text-sm select-none',
                  // bg-canvas, not bg-background: an active tab takes the
                  // colour of the surface it fronts, and this one fronts
                  // the chat canvas — `bg-background` is the document
                  // pane's paper white, which made the tab a bright chip
                  // floating on a panel it is supposed to open into. The
                  // border, weight, and text colour carry the selection.
                  // `data-active`, which is what Base UI actually stamps on
                  // the selected tab — the primitive's own `data-selected:`
                  // rules never match and are dead weight here.
                  'data-active:border-border data-active:bg-canvas data-active:font-medium data-active:text-foreground data-active:hover:bg-canvas',
                )}
              >
                <AgentGlyph agent={tab.agent} />
                {/* min-w-0 lets the label shrink so the ellipsis renders. */}
                <span className="min-w-0 overflow-hidden text-ellipsis">{tab.title}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    'size-4 rounded-sm text-lg/none text-muted-foreground',
                    // Hidden by default — surfaces on tab hover, on the
                    // focused tab (:focus-within also matches the tab itself
                    // holding focus), or for the active tab, avoiding
                    // clutter with many tabs open.
                    tab.id === activeId
                      ? 'opacity-100'
                      : 'opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100',
                  )}
                  // Pointer affordance only: a `tab` may not contain an
                  // interactive descendant, and a focusable-but-invisible
                  // control is a keyboard trap — so the × leaves the
                  // accessibility tree and the tab order. Keyboard users
                  // close the FOCUSED tab with Delete (the trigger's
                  // onKeyDown above).
                  aria-hidden
                  tabIndex={-1}
                  title="Close tab"
                  // The list selects on focus and focus bubbles, so without
                  // this a pointer press on an inactive tab's × (which still
                  // focuses a tabindex=-1 button) would select that tab on
                  // the way to closing it.
                  onFocus={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    dispatch({ type: 'CHAT_TAB_CLOSE', id: tab.id });
                  }}
                >×</Button>
              </TabsTrigger>
            ))}
          </TabsList>
          {activeTab && activeInstructionsScope && (
            <AgentInstructionsControl
              scopeName={scopeDisplayName(activeInstructionsScope)}
              customized={instructionsPresence.customized}
              onOpen={() => setInstructionsScope(activeInstructionsScope)}
            />
          )}
        </div>
        <div className="relative min-h-0 flex-1">
          {tabs.map((tab) => (
            <TabsContent
              key={tab.id}
              value={tab.id}
              // Every session stays mounted so switching tabs preserves its
              // state. `flex` in the pane class also outranks the UA
              // `[hidden] { display: none }` Base UI stamps on the inactive
              // panels, so they keep their layout (and their transcript
              // scroll position) instead of collapsing — `invisible` is
              // what actually hides them, exactly as before.
              keepMounted
              // ...which is also why the inactive panes need `aria-hidden`
              // stated here. Base UI hides a kept-mounted panel with the
              // `hidden` ATTRIBUTE, whose entire effect is the UA's
              // `display: none` — and the `flex` above is precisely what
              // outranks that. So the pane stays laid out AND stays in the
              // accessibility tree, and every mounted session's transcript
              // and composer answer as though they were on screen. The
              // hand-rolled panel this replaced stamped `aria-hidden` for
              // this reason; the conversion dropped it, and the functional
              // journeys caught it as `[aria-label="Message agent"]`
              // resolving to one composer per open chat.
              aria-hidden={tab.id === activeId ? undefined : true}
              // One tab body. Inactive panes stay mounted (preserving each
              // session's state) but render invisible and inert.
              className={cn('absolute inset-0 flex flex-col', tab.id === activeId ? 'visible' : 'invisible pointer-events-none')}
            >
              <ChatSessionBoundary tabId={tab.id} active={tab.id === activeId}>
                {/* Keyed by tab id AND agent: when the New Chat split button
                  * switches a blank tab's agent in place, the old agent's
                  * idle connection tears down with its unmounting AgentView
                  * and the new agent connects on a fresh mount. */}
                <AgentView
                  key={`${tab.id}:${tab.agent}`}
                  active={tab.id === activeId}
                  id={tab.id}
                  title={tab.title}
                  agent={isAgentKind(tab.agent) ? tab.agent : 'claude'}
                  initialScope={tab.boundFolder === null ? LIBRARY_SCOPE : undefined}
                />
              </ChatSessionBoundary>
            </TabsContent>
          ))}
          {tabs.length === 0 && (
            <div className={chatStatusClass}>
              No active chat. Click <strong>New Chat</strong> in the sidebar to
              start one.
            </div>
          )}
        </div>
      </Tabs>
      {instructionsScope && (
        <AgentInstructionsModal
          scope={instructionsScope}
          onSaved={instructionsPresence.setCustomized}
          onCancel={() => setInstructionsScope(null)}
        />
      )}
    </aside>
  );
}
