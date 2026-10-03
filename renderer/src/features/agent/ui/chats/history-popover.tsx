/**
 * The Chat pane's own way to the rest of the folder's conversations: a
 * popover under the header's clock with a search field and the recent chats,
 * newest first, each with how long ago it last moved. A row opens the
 * conversation, switching to its tab when one is open and restoring it from
 * history otherwise, and the popover closes behind it. Renaming and deleting
 * stay with the sidebar's Chats panel; this is the quick way back, not the
 * manager.
 */
import { Popover } from '@base-ui/react/popover';
import { Clock } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { Button } from '@/components/ui/button';
import { CommandItem, CommandList } from '@/components/ui/command-menu';
import { Tooltip } from '@/components/ui/tooltip';
import type { AgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import {
  buildConversationGroups,
  type AgentConversationItem,
} from '@/features/agent/domain/conversation-history';
import { scopeLabel, type AgentScope } from '@/features/agent/domain/session';
import { ageLabel } from '@/features/agent/domain/time';
import { useConversationHistory } from '@/features/agent/hooks/use-conversation-history';
import { SearchField, SearchPopup, useSearchListKeys } from '@/shared/ui/search-popover';

const ROW_LIMIT = 50;

/** Five rows stand in the popover at once, so a page key moves by five. */
const ROW_PAGE_SIZE = 5;

export function ChatHistoryPopover({
  runtime,
  scope,
}: {
  runtime: AgentWorkspaceRuntime;
  scope: AgentScope;
}) {
  const listId = useId();
  const searchField = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // "Now" is read as the popover opens, so the ages hold still while the
  // list is in front of the reader.
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const history = useConversationHistory(runtime, scope);
  const activeId = useStore(runtime.store, (state) => state.activeId);
  const tabs = useStore(runtime.store, (state) => state.tabs);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return buildConversationGroups({ activeId, history: history.history, now, scope, tabs })
      .flatMap((group) => group.items)
      .filter((item) => needle === '' || item.title.toLowerCase().includes(needle))
      .slice(0, ROW_LIMIT);
  }, [activeId, history.history, now, query, scope, tabs]);

  const openConversation = (row: AgentConversationItem) => {
    setOpen(false);
    if (row.tabId) runtime.activate(row.tabId);
    else if (row.entry) void runtime.restore(row.entry);
  };

  const { activeIndex, onKeyDown, setActiveIndex } = useSearchListKeys({
    field: searchField,
    onChoose: openConversation,
    open,
    pageSize: ROW_PAGE_SIZE,
    rows,
  });

  const loading = history.historyLoading && rows.length === 0;
  const empty = !loading && rows.length === 0 && !history.historyFailure;

  return (
    <Popover.Root
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setNow(Date.now());
        else setQuery('');
      }}
      open={open}
    >
      <Tooltip content="Chat history" side="bottom">
        <Popover.Trigger
          render={
            // The same compact square as New chat beside it.
            <Button aria-label="Chat history" size="icon-compact" variant="ghost" />
          }
        >
          <Clock aria-hidden="true" />
        </Popover.Trigger>
      </Tooltip>
      <SearchPopup label="Chat history">
        <SearchField
          activeIndex={activeIndex}
          field={searchField}
          label="Search chat titles"
          listId={listId}
          onKeyDown={onKeyDown}
          onQueryChange={setQuery}
          placeholder="Search chat titles"
          query={query}
          rowCount={rows.length}
        />
        {loading && (
          <p className="px-4 py-3 text-caption text-muted-foreground" role="status">
            Loading chats…
          </p>
        )}
        {history.historyFailure && (
          <div className="px-4 py-3 text-caption">
            <p>{history.historyFailure}</p>
            <Button size="compact" variant="ghost" onClick={() => void history.retry()}>
              Retry
            </Button>
          </div>
        )}
        {empty && (
          <p className="px-4 py-3 text-caption text-muted-foreground" role="status">
            {query.trim() ? 'No matching chats.' : `No chats yet in ${scopeLabel(scope)}.`}
          </p>
        )}
        {rows.length > 0 && (
          <CommandList
            activeIndex={activeIndex}
            aria-label="Recent chats"
            // Five rows before the list scrolls: enough to find a recent
            // chat, short enough to leave the empty Chat's greeting in view
            // beneath the popover.
            className="max-h-40"
            id={listId}
            onActiveIndexChange={setActiveIndex}
          >
            {rows.map((row, index) => {
              const age = ageLabel(row.lastModified, now);
              return (
                <CommandItem
                  aria-label={`${row.title}, ${age}`}
                  id={`${listId}-row-${index}`}
                  key={row.id}
                  onClick={() => openConversation(row)}
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">{row.title}</span>
                  <span className="ml-auto shrink-0 text-caption text-muted-foreground tabular-nums">
                    {age}
                  </span>
                </CommandItem>
              );
            })}
          </CommandList>
        )}
      </SearchPopup>
    </Popover.Root>
  );
}
