/**
 * The sidebar's Chats panel: the folder's conversations, listed by day under
 * a Recent label, with New chat above them and rename and delete on each
 * row. The panel sits on the sidebar's row, the compact step the whole
 * column under the band reads; the header's history popover is the quick
 * way in, this is the manager.
 */
import { CalendarClock, MessageCirclePlus, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { Button } from '@/components/ui/button';
import { InputField, InputGroup } from '@/components/ui/input-group';
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { SidebarGroupLabel } from '@/components/ui/sidebar-group-label';
import { Tooltip } from '@/components/ui/tooltip';
import {
  buildConversationGroups,
  type AgentConversationItem,
  type AgentHistoryEntry,
} from '@/features/agent/domain/conversation-history';
import { useConversationHistory } from '@/features/agent/hooks/use-conversation-history';
import { useScheduledRunSessions } from '@/features/agent/hooks/use-scheduled-tasks';
import type { AgentChatsProps } from '@/features/agent/ui/workspace-lazy';
import { FailureLine } from '@/shared/ui/failure-notice';

import { ConversationTree } from './conversation-tree';
import { DeleteConversationDialog } from './delete-conversation-dialog';

export default function AgentChats({
  runtime,
  scheduledTasks,
  scope,
  workspaceName,
}: AgentChatsProps) {
  const tasksShown = useStore(runtime.store, (state) => state.surface === 'scheduled-tasks');
  const history = useConversationHistory(runtime, scope);
  const scheduledRuns = useScheduledRunSessions(scheduledTasks, scope.path, history.history);
  const activeId = useStore(runtime.store, (state) => state.activeId);
  const tabs = useStore(runtime.store, (state) => state.tabs);
  const [query, setQuery] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const filterField = useRef<HTMLDivElement | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentHistoryEntry | null>(null);
  const conversationGroups = useMemo(
    // While the tasks stand in the chat's place, no chat row reads as open.
    () =>
      buildConversationGroups({
        activeId: tasksShown ? '' : activeId,
        history: history.history,
        scope,
        tabs,
      }),
    [activeId, history.history, scope, tabs, tasksShown],
  );
  const filteredGroups = conversationGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        item.title.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    }))
    .filter((group) => group.items.length > 0);
  const conversationCount = conversationGroups.reduce(
    (total, group) => total + group.items.length,
    0,
  );
  // The field opens in place of the section's name, so it opens focused:
  // the click that asked for it was the reader reaching for the keyboard.
  useEffect(() => {
    if (!filterOpen) return;
    filterField.current?.querySelector('input')?.focus();
  }, [filterOpen]);

  // A folded list cannot show what a filter did to it, so asking to search
  // unfolds the section first.
  const openFilter = () => {
    setListOpen(true);
    setFilterOpen(true);
  };
  // Closing takes the query with it. A filter left standing behind a name
  // would hide chats with nothing on screen to say why.
  const closeFilter = () => {
    setQuery('');
    setFilterOpen(false);
  };

  const closeDelete = () => {
    history.clearMutationFailure();
    setDeleteTarget(null);
  };

  const rename = (conversation: AgentConversationItem, title: string) => {
    history.clearMutationFailure();
    if (conversation.entry) {
      void history.rename(conversation.entry, title);
      return;
    }
    if (!conversation.tabId) return;
    const session = runtime.session(conversation.tabId);
    session?.rename(title);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label={`Chats in ${workspaceName}`}>
      {/* New chat is the panel's primary action, so it is a standing sidebar
       *  row, the same row the footer's Gallery and the list beneath are:
       *  first by position, told by its plus, and never larger. The wrapper's
       *  px-2 and the row's own inset put its glyph on the shared 16px column
       *  with the footer rows' and the folder header's. */}
      <div className="shrink-0 px-2 pt-2 pb-1">
        <SidebarMenu aria-label="Chat actions">
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label="Start new chat"
              icon={MessageCirclePlus}
              onClick={() => runtime.newChat(undefined, scope)}
            >
              New chat
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* The chats this project starts on its own, at their times. */}
          {scheduledTasks && (
            <SidebarMenuItem>
              <SidebarMenuButton
                icon={CalendarClock}
                isActive={tasksShown}
                onClick={() => runtime.showScheduledTasks(true)}
              >
                Scheduled tasks
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          aria-label={`Conversation tree in ${workspaceName}`}
          className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2"
        >
          {/* The list is one section under a Chats label that folds it, the
           *  way a day group folds under its own header: the same caption
           *  size and grey as those headers, the same hover, and the fold
           *  chevron at its end under the pointer. p-0: the scroll region
           *  already carries the 8px inset. */}
          <SidebarGroup
            className="p-0"
            collapsible
            headerActions={
              filterOpen ? undefined : (
                <Tooltip content="Search chats" side="bottom">
                  <Button
                    aria-label="Search chats"
                    className="size-6"
                    data-sidebar="group-action"
                    onClick={openFilter}
                    size="icon-compact"
                    variant="ghost"
                  >
                    <Search aria-hidden="true" />
                  </Button>
                </Tooltip>
              )
            }
            onOpenChange={setListOpen}
            open={listOpen}
          >
            {/* Searching, the section's name gives way to the field on its
             *  own row: the same 28px, the same inset, so the header changes
             *  what it holds rather than the list gaining a row. Placed
             *  before the label so it stays out of the fold, and the label
             *  is hidden rather than dropped, because it is the group's
             *  toggle and the collapse is split around it. Leaving the row
             *  with nothing typed closes it again; a standing query keeps it,
             *  since the list is filtered and the reader has to see by what. */}
            {filterOpen && (
              // No padding of its own: the row has to stand exactly as tall
              // as the label it replaces, or opening the search shoves every
              // day group and chat beneath it down a step. A box reads
              // tighter over the first group than a line of text does, and
              // that is the price of a list that does not move.
              <div
                className="w-full shrink-0"
                onBlur={(event) => {
                  if (query) return;
                  if (event.currentTarget.contains(event.relatedTarget)) return;
                  closeFilter();
                }}
                ref={filterField}
              >
                <InputGroup className="w-full gap-0" size="compact">
                  <InputField
                    action={
                      <Tooltip content="Close search" side="bottom">
                        <Button
                          aria-label="Close search"
                          className="size-5"
                          onClick={closeFilter}
                          size="icon-compact"
                          variant="ghost"
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </Tooltip>
                    }
                    autoComplete="off"
                    label="Search chat titles"
                    labelHidden
                    onChange={setQuery}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        closeFilter();
                      }
                    }}
                    placeholder="Search"
                    resting="outline"
                    spellCheck={false}
                    value={query}
                  />
                </InputGroup>
              </div>
            )}
            {/* The attribute, not a class: while the field has the row the
             *  label is not a toggle, so it should leave the accessibility
             *  tree too, and it is kept mounted only because the group splits
             *  its collapse around it. */}
            <SidebarGroupLabel
              className="h-7 text-caption text-muted-foreground hover:bg-hover hover:text-foreground"
              hidden={filterOpen}
            >
              Chats
            </SidebarGroupLabel>
            {query && filteredGroups.length === 0 && (
              <p className="px-2 py-1 text-caption text-muted-foreground">No matching chats.</p>
            )}
            {history.historyLoading && conversationCount === 0 && (
              <p className="px-2 py-1 text-caption text-muted-foreground">Loading chats…</p>
            )}
            {!history.historyLoading && conversationCount === 0 && !history.historyFailure && (
              <p className="px-2 py-1 text-caption text-muted-foreground">
                No chats yet in {workspaceName}.
              </p>
            )}
            <ConversationTree
              groups={filteredGroups}
              onActivate={runtime.activate}
              onDelete={(entry) => {
                history.clearMutationFailure();
                setDeleteTarget(entry);
              }}
              onRename={rename}
              onRestore={(entry) => void runtime.restore(entry)}
              scheduled={scheduledRuns}
            />
            {history.mutationFailure && deleteTarget === null && (
              <FailureLine className="px-2 py-1" tone="input">
                {history.mutationFailure}
              </FailureLine>
            )}
            {history.historyFailure && (
              <div className="px-2 py-1">
                <FailureLine tone="input">{history.historyFailure}</FailureLine>
                <Button
                  className="mt-2"
                  leadingIcon={RefreshCw}
                  onClick={() => void history.retry()}
                  size="compact"
                  variant="ghost"
                >
                  Retry
                </Button>
              </div>
            )}
          </SidebarGroup>
        </div>
        {/* The list fades out at its foot instead of being cut by the
         *  footer's rule, the same way the transcript fades under the Chat
         *  header; the footer keeps no padding above its first rule, so the fade
         *  ends 4px short of the rule; over the paper the gradient is invisible. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-6 bg-gradient-to-t from-surface-1 to-transparent"
        />
      </div>
      <DeleteConversationDialog
        entry={deleteTarget}
        failure={history.mutationFailure}
        onClose={closeDelete}
        onDelete={history.remove}
        pending={history.mutationPending}
        workspaceName={workspaceName}
      />
    </div>
  );
}
