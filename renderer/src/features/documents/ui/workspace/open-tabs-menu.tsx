/** The list of every open document, for a strip too narrow to show them all.
 *  It appears only while the tabs overflow, beside the plus, and choosing a
 *  row brings that document in front, which scrolls its tab into view. Each
 *  row names its folder, so two files with one name stay apart. */
import { ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DropdownContent, DropdownMenu, DropdownTrigger } from '@/components/ui/dropdown';
import { MenuItem } from '@/components/ui/menu-item';
import { Tooltip } from '@/components/ui/tooltip';
import { sourceName } from '@/features/documents/domain/document';
import { isExternalSource } from '@/shared/domain/external-source';
import type { SourceReference } from '@/shared/domain/source-reference';
import { parentPathOf } from '@/shared/utils/file-path';

export interface OpenTab {
  id: string;
  source: SourceReference;
}

function projectTabCollisions(tabs: readonly OpenTab[]): Set<string> {
  const projects = new Map<string, string>();
  const collisions = new Set<string>();
  for (const { source } of tabs) {
    if (isExternalSource(source)) continue;
    const path = source.path.replace(/\\/gu, '/');
    const project = projects.get(path);
    if (project !== undefined && project !== source.folderPath) collisions.add(path);
    projects.set(path, source.folderPath);
  }
  return collisions;
}

function tabFolder(source: SourceReference, collisions: ReadonlySet<string>): string {
  const folder = parentPathOf(source.path);
  if (isExternalSource(source)) return folder || source.path;
  if (!collisions.has(source.path.replace(/\\/gu, '/'))) return folder;
  return folder ? `${folder} · ${source.folderPath}` : source.folderPath;
}

export function OpenTabsMenu({
  activeTabId,
  onSelect,
  tabs,
}: {
  /** The document in front, or null while the New tab is. */
  activeTabId: string | null;
  onSelect(tabId: string): void;
  tabs: OpenTab[];
}) {
  const collisions = projectTabCollisions(tabs);
  return (
    <DropdownMenu>
      <Tooltip content="All open tabs" side="bottom">
        <DropdownTrigger
          render={
            <Button
              aria-label={`All open tabs (${tabs.length})`}
              className="shrink-0"
              size="icon-compact"
              variant="ghost"
            >
              <ChevronDown aria-hidden="true" />
            </Button>
          }
        />
      </Tooltip>
      {/* The menu takes its name from the button that opens it. */}
      <DropdownContent align="end" className="w-64">
        {tabs.map((tab) => {
          const folder = tabFolder(tab.source, collisions);
          return (
            <MenuItem
              checked={tab.id === activeTabId}
              key={tab.id}
              label={sourceName(tab.source)}
              onSelect={() => onSelect(tab.id)}
              {...(folder ? { description: folder } : {})}
            />
          );
        })}
      </DropdownContent>
    </DropdownMenu>
  );
}
