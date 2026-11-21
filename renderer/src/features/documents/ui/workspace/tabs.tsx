/**
 * The open documents' tab strip. A preview tab wears its name in italics and
 * says so in its label; a double click, or Enter on the focused tab, keeps
 * it. Delete or a middle click closes a tab, and every tab is a drag source
 * for its file. A right click, the menu key or Shift+F10 opens the tab's menu. Given a `newTab`, the strip ends in a plus that opens the New tab,
 * a tab holding no document whose page offers the first moves; the New tab
 * sits last and selected, and choosing a document closes it. While the tabs
 * overflow the strip, a list of every open document sits beside the plus.
 */
import { Circle, Plus, X } from 'lucide-react';
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';

import { Button } from '@/components/ui/button';
import { pointAnchor } from '@/components/ui/dropdown';
import { TabItem, Tabs, TabsList } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import type { DocumentRuntime } from '@/features/documents/application/document-runtime';
import type { DocumentTabsRuntime } from '@/features/documents/application/tabs-runtime';
import { isDocumentDirty, sourceName } from '@/features/documents/domain/document';
import { documentViewerFormat } from '@/features/documents/domain/document-format';
import { useDocumentTabs } from '@/features/documents/hooks/use-document-tabs';
import type { NewTab } from '@/features/documents/hooks/use-new-tab';
import { documentViewerEntry } from '@/features/documents/ui/source/registry';
import type { IconComponentProps } from '@/lib/icon-context';
import { cn } from '@/lib/utils';
import { isExternalSource } from '@/shared/domain/external-source';
import type { SourceReference } from '@/shared/domain/source-reference';
import { useRequestSignals } from '@/shared/runtime/use-request-signals';
import { writeSourceDrag } from '@/shared/utils/source-drag';

import { OpenTabsMenu } from './open-tabs-menu';
import { DocumentTabMenu, useTabMenu, type DocumentTabMenuActions } from './tab-menu';

export interface DocumentTabsProps {
  className?: string;
  /** What stands in for the strip with nothing open and no `newTab`. */
  emptyContent?: ReactNode;
  /** Showing a tab's file on disk and copying its path. Absent, the tab menu
   *  offers only closing. */
  menuActions?: DocumentTabMenuActions | undefined;
  /** The New tab the strip's plus opens. Absent, there is no plus. */
  newTab?: NewTab | undefined;
  runtime: DocumentTabsRuntime;
}

/** The New tab's value in the strip; document tabs carry the runtime's ids. */
const NEW_TAB_ID = 'new-tab';

function UnsavedIndicator({ className, ...props }: IconComponentProps) {
  return (
    <Circle
      {...props}
      className={cn('fill-current stroke-none', className)}
      data-unsaved-indicator=""
      size={8}
    />
  );
}

/** Middle-click closing, as browsers and editors do. Pressing the wheel is
 *  refused so Windows does not start autoscroll over the strip; the close
 *  itself waits for the release, like a click. */
function middleClickCloses(close: () => void) {
  return {
    onAuxClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (event.button !== 1) return;
      event.preventDefault();
      close();
    },
    onMouseDown: (event: MouseEvent<HTMLButtonElement>) => {
      if (event.button === 1) event.preventDefault();
    },
  };
}

/** Whether the list scrolls sideways because its tabs no longer fit. Read
 *  when the strip resizes and when the tabs change, since a tab added to a
 *  list already at its widest changes what it holds, not its box. */
function useOverflowing(watch: unknown) {
  const [overflowing, setOverflowing] = useState(false);
  const list = useRef<HTMLDivElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback(() => {
    const node = list.current;
    setOverflowing(node ? node.scrollWidth > node.clientWidth + 1 : false);
  }, []);
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      list.current = node;
      if (!node) return;
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      observer.current = new ResizeObserver(measure);
      observer.current.observe(node);
    },
    [measure],
  );
  useLayoutEffect(measure, [measure, watch]);
  return { overflowing, ref };
}

function tabLabel(name: string, dirty: boolean, preview: boolean): string {
  if (dirty) return `${name}, unsaved changes`;
  return preview ? `${name}, preview` : name;
}

function DocumentTab({
  document,
  onClose,
  onContextMenu,
  onKeep,
  onKeyDown,
  preview,
  register,
  source,
  value,
}: {
  document: DocumentRuntime;
  onClose: (tabId: string) => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>, tabId: string) => void;
  onKeep: (tabId: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, tabId: string) => void;
  preview: boolean;
  register: (tabId: string, element: HTMLButtonElement | null) => void;
  source: SourceReference;
  value: string;
}) {
  const dirty = useStore(document.store, (state) =>
    state.editor ? isDocumentDirty(state.editor) : false,
  );
  const name = sourceName(source);
  const icon = documentViewerEntry(documentViewerFormat(source.path)).icon(source.path);

  return (
    <TabItem
      aria-keyshortcuts={preview ? 'Delete Enter' : 'Delete'}
      aria-label={tabLabel(name, dirty, preview)}
      // Italic is inherited by the label, so the tab says "only looking"
      // without the strip's label primitive knowing about previews.
      className={preview ? 'italic' : undefined}
      data-document-dirty={dirty || undefined}
      data-document-preview={preview || undefined}
      draggable
      icon={icon}
      label={name}
      // A double click is the reader asking for the tab to stay; a kept tab
      // has nothing further to give.
      onDoubleClick={preview ? () => onKeep(value) : undefined}
      {...middleClickCloses(() => onClose(value))}
      // The open document is a source the user can hand to another surface —
      // dropping a tab on the Agent composer binds it as explicit context.
      onContextMenu={(event) => onContextMenu(event, value)}
      onDragStart={(event) => writeSourceDrag(event.dataTransfer, source)}
      onKeyDown={(event) => onKeyDown(event, value)}
      onTrailingClick={() => onClose(value)}
      ref={(element) => register(value, element)}
      title={`${isExternalSource(source) ? source.path : `${source.folderPath}/${source.path}`}${dirty ? ' · unsaved changes' : ''}`}
      trailingIcon={dirty ? UnsavedIndicator : X}
      value={value}
    />
  );
}

export function DocumentTabs({
  className,
  emptyContent = null,
  menuActions,
  newTab,
  runtime,
}: DocumentTabsProps) {
  const { activate, activeTabId, close, closeTabs, keep, tabs } = useDocumentTabs(runtime);
  const menu = useTabMenu();
  const signalFor = useRequestSignals<'close-menu'>();
  // The tab pills are the ladder's segment height, one step under the row's
  // control, so the plus takes the compact square, the same 28px the pills
  // beside it stand at, rather than the row's 36px.
  const size = 'icon-compact' as const;
  const focusAfterClose = useRef(false);
  const tabElements = useRef(new Map<string, HTMLButtonElement>());
  const newTabOpen = newTab?.open ?? false;
  // A rename can widen a tab as much as opening one can.
  const strip = useOverflowing(
    `${newTabOpen}:${tabs.map((tab) => sourceName(tab.source)).join('/')}`,
  );

  useLayoutEffect(() => {
    if (!focusAfterClose.current || !activeTabId) return;
    focusAfterClose.current = false;
    tabElements.current.get(activeTabId)?.focus();
  }, [activeTabId]);

  useLayoutEffect(() => {
    if (!activeTabId) return;
    tabElements.current.get(activeTabId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  const plus = newTab && (
    <Tooltip content="New tab" side="bottom">
      <Button
        aria-label="New tab"
        // The ladder's square, the box every icon button in the window
        // wears. Which column its glyph lands on is the row's business, not
        // the strip's: the titlebar's slot owns that inset, and only it
        // knows what stands under the plus.
        className="shrink-0"
        onClick={newTab.add}
        size={size}
        variant="ghost"
      >
        <Plus aria-hidden="true" />
      </Button>
    </Tooltip>
  );

  if (tabs.length === 0 && !newTabOpen) {
    return plus ? (
      <div className={cn('flex min-w-0 items-center', className)}>{plus}</div>
    ) : (
      emptyContent
    );
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tabId: string) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      menu.show({ anchor: event.currentTarget, tabId });
    } else if (event.key === 'Delete') {
      event.preventDefault();
      focusAfterClose.current = true;
      close(tabId);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      keep(tabId);
    }
  };

  const onTabContextMenu = (event: MouseEvent<HTMLButtonElement>, tabId: string) => {
    event.preventDefault();
    menu.show({ anchor: pointAnchor(event.clientX, event.clientY), tabId });
  };

  // Closing from the menu hands focus to whichever tab is then in front, as
  // Delete does, rather than leaving it on a tab that has gone.
  const closeFromMenu = (tabIds: string[]) => {
    const signal = signalFor('close-menu');
    void closeTabs(tabIds).then((closed) => {
      if (!closed || signal.aborted || runtime.signal.aborted) return;
      const active = runtime.store.getState().activeTabId;
      if (active) tabElements.current.get(active)?.focus();
    });
  };
  const menuTabIndex = menu.shown ? tabs.findIndex((tab) => tab.id === menu.shown?.tabId) : -1;
  const menuTab = menuTabIndex >= 0 ? tabs[menuTabIndex] : undefined;
  const others = menuTab ? tabs.filter((tab) => tab.id !== menuTab.id).map((tab) => tab.id) : [];
  const toRight = tabs.slice(menuTabIndex + 1).map((tab) => tab.id);

  const registerTab = (tabId: string, element: HTMLButtonElement | null) => {
    if (element) tabElements.current.set(tabId, element);
    else tabElements.current.delete(tabId);
  };

  return (
    <div className={cn('flex min-w-0 items-center', className)}>
      <Tabs
        className="min-w-0 flex-1 overflow-hidden"
        onValueChange={(value) => {
          if (value === NEW_TAB_ID) return;
          // A document chosen is a document in front: the New tab goes.
          newTab?.close();
          activate(value);
        }}
        value={newTabOpen ? NEW_TAB_ID : (activeTabId ?? '')}
      >
        <TabsList
          aria-label="Open documents"
          className="scrollbar-hide max-w-full overflow-x-auto"
          ref={strip.ref}
        >
          {tabs.map((tab) => {
            const document = runtime.getDocument(tab.id);
            if (!document) return null;
            return (
              <DocumentTab
                document={document}
                key={tab.id}
                onClose={close}
                onContextMenu={onTabContextMenu}
                onKeep={keep}
                onKeyDown={onTabKeyDown}
                preview={tab.preview}
                register={registerTab}
                source={tab.source}
                value={tab.id}
              />
            );
          })}
          {newTab?.open && (
            <TabItem
              aria-keyshortcuts="Delete"
              label="New tab"
              {...middleClickCloses(newTab.close)}
              onKeyDown={(event) => {
                if (event.key !== 'Delete') return;
                event.preventDefault();
                newTab.close();
              }}
              onTrailingClick={newTab.close}
              trailingIcon={X}
              value={NEW_TAB_ID}
            />
          )}
        </TabsList>
      </Tabs>
      {strip.overflowing && (
        <OpenTabsMenu
          activeTabId={newTabOpen ? null : activeTabId}
          onSelect={(tabId) => {
            newTab?.close();
            activate(tabId);
          }}
          tabs={tabs}
        />
      )}
      {plus}
      {menuTab && (
        <DocumentTabMenu
          actions={menuActions}
          commands={{
            close: () => closeFromMenu([menuTab.id]),
            closeAll: () => closeFromMenu(tabs.map((tab) => tab.id)),
            closeOthers: others.length ? () => closeFromMenu(others) : null,
            closeToRight: toRight.length ? () => closeFromMenu(toRight) : null,
          }}
          menu={menu}
          name={sourceName(menuTab.source)}
          source={menuTab.source}
        />
      )}
    </div>
  );
}
