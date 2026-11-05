/**
 * The heading outline for the active document, as a collapsible sidebar tree.
 * A format that never publishes headings says so rather than reading as a
 * document whose outline has not arrived.
 */
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useStore } from 'zustand';

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import type { DocumentTabsRuntime } from '@/features/documents/application/tabs-runtime';
import { sourceName } from '@/features/documents/domain/document';
import { documentViewerFormat } from '@/features/documents/domain/document-format';
import {
  buildDocumentOutline,
  type DocumentOutlineNode,
} from '@/features/documents/domain/outline';
import { documentViewerEntry } from '@/features/documents/ui/source/registry';
import { cn } from '@/lib/utils';

interface OutlineNodeItemProps {
  collapsed: ReadonlySet<string>;
  depth: number;
  node: DocumentOutlineNode;
  runtime: DocumentTabsRuntime;
  toggle(id: string): void;
}

function OutlineNodeItem({ collapsed, depth, node, runtime, toggle }: OutlineNodeItemProps) {
  const subtreeId = useId();
  const { heading } = node;
  const active = runtime.navigation.store.getState().outline.activeId === heading.id;
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(heading.id);
  const label = heading.text || 'Untitled section';
  const buttonProps = {
    'aria-current': active ? ('location' as const) : undefined,
    'aria-label': `Heading level ${heading.level}: ${label}`,
    className: 'pl-8',
    isActive: active,
    onClick: () => runtime.navigation.selectHeading(heading),
    style: {
      '--row-gutter': '8px',
      '--row-gutter-hover': '8px',
    } as CSSProperties,
    title: label,
  };
  const button =
    depth === 0 ? (
      <SidebarMenuButton {...buttonProps} label={label} />
    ) : (
      <SidebarMenuSubButton
        {...buttonProps}
        label={label}
        render={<button aria-label={buttonProps['aria-label']} type="button" />}
      />
    );
  const branch = (
    <>
      {button}
      {hasChildren && (
        <SidebarMenuAction
          aria-controls={subtreeId}
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${label}`}
          className="right-auto left-1"
          onClick={() => toggle(heading.id)}
          title={`${isCollapsed ? 'Expand' : 'Collapse'} ${label}`}
        >
          {isCollapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </SidebarMenuAction>
      )}
      {/* pl-0: every outline row already reserves the 32px chevron slot
          (pl-8), so the sub's own text inset would deepen each level to
          24px. Rail + margin alone give an even 16px step per level. */}
      {hasChildren && (
        <SidebarMenuSub className="pl-0" id={subtreeId} open={!isCollapsed}>
          {node.children.map((child) => (
            <OutlineNodeItem
              collapsed={collapsed}
              depth={depth + 1}
              key={child.heading.id}
              node={child}
              runtime={runtime}
              toggle={toggle}
            />
          ))}
        </SidebarMenuSub>
      )}
    </>
  );

  return depth === 0 ? (
    <SidebarMenuItem>{branch}</SidebarMenuItem>
  ) : (
    <SidebarMenuSubItem>{branch}</SidebarMenuSubItem>
  );
}

/** A quiet line in place of the tree: why there is nothing to show. One
 *  spelling, because the panel is reached two ways and a reader must not meet
 *  two different sentences for the same nothing. */
function OutlineNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('px-4 pt-1 pb-2 text-caption text-muted-foreground', className)}>{children}</p>
  );
}

/** The panel with no document behind it at all. Composition shows this while
 *  no tab is open, so the empty Document outline reads the same whether the
 *  panel was reached with a runtime or without one. */
export function DocumentOutlineEmpty() {
  return (
    <SidebarGroup aria-label="Document outline section" className="min-h-0 p-0">
      <OutlineNote>No outline available</OutlineNote>
    </SidebarGroup>
  );
}

export function DocumentOutline({ runtime }: { runtime: DocumentTabsRuntime }) {
  const activeTabId = useStore(runtime.store, (state) => state.activeTabId);
  const activeTab = useStore(runtime.store, (state) =>
    state.tabs.find((tab) => tab.id === state.activeTabId),
  );
  const failed = useStore(runtime.navigation.store, (state) => state.outlineFailed);
  const outline = useStore(runtime.navigation.store, (state) => state.outline);
  const collapsed = useStore(runtime.navigation.store, (state) => state.outlineCollapsed);
  const menuRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLElement>('[aria-current="location"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [outline.activeId]);

  const tree = useMemo(() => buildDocumentOutline(outline.headings), [outline.headings]);
  if (!activeTabId) return <DocumentOutlineEmpty />;
  const name = activeTab ? sourceName(activeTab.source) : 'Document';
  // A format that never publishes headings says so, instead of reading as a
  // document whose outline has not arrived yet.
  const outlines =
    activeTab === undefined ||
    documentViewerEntry(documentViewerFormat(activeTab.source.path)).outline;
  const outlineSummary = outline.available
    ? `${outline.headings.length} ${outline.headings.length === 1 ? 'heading' : 'headings'}`
    : outlines
      ? failed
        ? 'unavailable'
        : 'loading'
      : 'not available for this file type';

  const toggle = (id: string) => runtime.navigation.toggleOutlineSection(id);

  return (
    <SidebarGroup aria-label="Document outline section" className="min-h-0 p-0">
      <SidebarGroupLabel
        aria-label={`${name} outline, ${outlineSummary}`}
        className="mx-2 h-7 w-auto gap-1.5 px-2 text-caption"
      >
        <FileText aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="min-w-0 truncate" title={name}>
          {name}
        </span>
      </SidebarGroupLabel>
      <SidebarGroupContent>
        {!outline.available ? (
          <OutlineNote className="leading-relaxed">
            {outlines
              ? failed
                ? 'Could not load the outline. Retry opening the document.'
                : 'Loading outline…'
              : 'This file type has no outline.'}
          </OutlineNote>
        ) : tree.length === 0 ? (
          <OutlineNote>No headings in this document</OutlineNote>
        ) : (
          <nav aria-label="Document outline" className="px-2 pb-2">
            <SidebarMenu ref={menuRef}>
              {tree.map((node) => (
                <OutlineNodeItem
                  collapsed={collapsed}
                  depth={0}
                  key={node.heading.id}
                  node={node}
                  runtime={runtime}
                  toggle={toggle}
                />
              ))}
            </SidebarMenu>
          </nav>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
