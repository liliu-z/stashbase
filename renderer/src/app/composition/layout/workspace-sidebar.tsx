/**
 * The window's left column: the project picker, the panel navigator, and the
 * Gallery, Settings, and account entries at its foot.
 *
 * Every panel it can show is bound here — the file tree to its transport, the
 * chats list to the agent catalog, search to its retrieval ports — so the
 * navigator itself only decides which of them is on screen.
 */
import { Store } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import type { SettingsCommand } from '@/app/composition/commands/use-workspace-commands';
import type { SidebarNavigatorState } from '@/app/composition/commands/use-workspace-commands';
import { useDependencies } from '@/app/composition/dependency-context';
import type { DocumentSources } from '@/app/composition/folder/use-document-sources';
import {
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar-menu';
import {
  AgentChats,
  ChatNavButtons,
  type AgentScope,
  type AgentWorkspaceRuntime,
} from '@/features/agent/public';
import { DocumentHistoryButtons, type DocumentTabsRuntime } from '@/features/documents/public';
import type { FolderSearchReadiness } from '@/features/preparation/public';
import { ProjectSearch } from '@/features/retrieval/public';
import { SidebarAccountRow } from '@/features/settings/public';
import {
  FileImport,
  FileTree,
  ProjectSidebar,
  type ActiveProjectFolder,
  type ProjectEntry,
  type FileTreeRowMarker,
  type WorkspaceRuntime,
} from '@/features/workspace/public';
import { SizeProvider } from '@/lib/size-context';
import type { SourceReference } from '@/shared/domain/source-reference';

import { SidebarModeSwitch } from './sidebar-mode-switch';
import { SidebarNavigator } from './sidebar-navigator';
import { sidebarModes, sidebarPanels } from './sidebar-panels';

export interface WorkspaceSidebarProps {
  activeFolder: ActiveProjectFolder | null;
  agent: { runtime: AgentWorkspaceRuntime; scope: AgentScope | null };
  documents: DocumentTabsRuntime | null;
  folder: {
    /** The Workbench-wide hidden-entry visibility, offered on the tree's own
     *  space. Null while no folder is listed. */
    hiddenFiles: {
      readonly disabled: boolean;
      readonly shown: boolean;
      toggle(): void;
    } | null;
    rowMarkers: Record<string, FileTreeRowMarker>;
    search: FolderSearchReadiness;
  };
  navigator: SidebarNavigatorState;
  /** Opens the Gallery over this window. The folder stays where it is. */
  onBrowseGallery(): void;
  /** The window's entry operation, which the folder header's switcher starts. */
  projectEntry: ProjectEntry;
  /** The corner: cards for work the reader was not watching, such as an
   *  update or preparation that was refused, above the footer's rows. */
  notices?: ReactNode;
  onReprocess(source: SourceReference): void;
  settings: SettingsCommand;
  sources: DocumentSources;
  workspace: WorkspaceRuntime | null;
}

export function WorkspaceSidebar({
  activeFolder,
  agent,
  documents,
  folder,
  navigator: sidebar,
  notices,
  onBrowseGallery,
  onReprocess,
  projectEntry,
  settings,
  sources,
  workspace,
}: WorkspaceSidebarProps) {
  const dependencies = useDependencies();
  // The collapsed column stays mounted off screen, so the arrows leave the
  // band as the titlebar takes them up: one pair is on offer at a time.
  const { isMobile, open } = useSidebar();
  const bandShowsArrows = open && !isMobile;
  // The folder's section folds and unfolds from its header. Window-local and
  // open by default: a folded section is a way of resting the column for a
  // moment, not a standing preference, and the next window starts unfolded.
  const [folderOpen, setFolderOpen] = useState(true);
  const folderContentId = useId();
  // The creates belong to the file tree, so they show while the tree is the
  // panel on screen and nowhere else: over the outline or over search there
  // is nothing for a new file to appear in, and a header action that changes
  // the panel under the reader is a worse offer than no action. The fold is
  // the section's and works in both modes, one state for the one section, so
  // a fold made in Documents holds in Chats and back.
  const creates = sidebar.selected === 'files';
  // A draft, or a folder named in place, beside the tree's selection. The
  // section is unfolded first, because the name is typed in the tree and the
  // creates stay reachable on the header while it is rolled up.
  const requestCreate = workspace
    ? (kind: 'draft' | 'folder') => () => {
        setFolderOpen(true);
        workspace.requestCreate(kind);
      }
    : null;
  const folderRow = (
    <SidebarGroup className="shrink-0 pb-0">
      <ProjectSidebar
        api={dependencies.project.api}
        contentId={folderContentId}
        entry={projectEntry}
        onNewFile={creates ? requestCreate?.('draft') : undefined}
        onNewFolder={creates ? requestCreate?.('folder') : undefined}
        onCollapseAll={creates && workspace ? () => workspace.collapseAll() : undefined}
        onOpenChange={setFolderOpen}
        open={folderOpen}
        revealLabel={dependencies.workspace.revealLabel}
      />
    </SidebarGroup>
  );
  return (
    <Sidebar className="bg-surface-1" variant="inset">
      {/* The whole column sits on the compact step, band included: the
       *  toggle and the arrows are 28px squares with 14px glyphs, the size of
       *  every glyph beneath them, so the band reads as the top of one list
       *  rather than as a larger chrome above it. The workspace titlebar's
       *  mirrored trigger, arrows, and Chat toggle keep the same square. */}
      <SizeProvider size="compact">
        <SidebarHeader className="gap-0 p-0">
          {/* The titlebar band: traffic lights on macOS, then the collapse
           *  control right of them — the same corner the workspace titlebar
           *  shows the reopening trigger in once the sidebar is away. The band
           *  is the whole header: no wordmark, because the welcome screen
           *  carries the brand and a folder window's first row should be the
           *  folder. */}
          {/* pl-2 puts the band's squares on the rows' 8px inset, so a hovered
           *  square and a hovered row share a left edge. Each square is the
           *  ladder's 28, the box every icon button in the window wears, which
           *  leaves its 14px glyph a pixel inside the sidebar's shared 16px
           *  glyph column (folder row, tree, footer). A 30px box landed the
           *  glyph on that column exactly, but it made the band's toggle the
           *  one icon button in the window that was not square, and matching
           *  the collapse controls to each other won over the pixel. With
           *  traffic lights present the shell.css darwin rule widens the
           *  padding past them. */}
          {/* pr-[9px] + the track's 2px + half a 30px item put the switch's
           *  last glyph centre 26px in from the edge, the axis the rows'
           *  trailing actions and the folder header's share. */}
          <div className="workspace-titlebar flex h-11 shrink-0 items-center pr-[9px] pl-2">
            {/* The arrows sit 4px from the square before them: 28 + 4 is the
             *  same 32px glyph pitch the mode switch's 30px items reach with
             *  their own 2px gap, so the band runs at one pitch from the
             *  toggle to the switch even though the two boxes differ. The gap
             *  absorbs the box, so the pitch never moves. */}
            <div className="workspace-titlebar-controls flex items-center">
              <SidebarTrigger aria-label="Hide files sidebar" />
              {/* Back and forward follow the mode: in Chats they step the
               *  window's open Chats in tab order, and in Documents the document
               *  history. A draft does not start here: it makes a document,
               *  so it starts from the card where documents show, from the
               *  strip's New tab. */}
              {bandShowsArrows &&
                activeFolder &&
                (sidebar.mode === 'chats' ? (
                  <ChatNavButtons runtime={agent.runtime} />
                ) : (
                  documents && <DocumentHistoryButtons runtime={documents} />
                ))}
            </div>
            {/* The mode switch holds the band's far end while a folder is open:
             *  Documents or Chats, deciding what the column beneath the folder
             *  shows. It leaves with the folder, and the corner by the lights
             *  keeps its shape either way. */}
            {activeFolder && (
              <div className="workspace-titlebar-controls ml-auto flex items-center">
                <SidebarModeSwitch
                  modes={sidebarModes}
                  onSelect={sidebar.selectMode}
                  selected={sidebar.mode}
                />
              </div>
            )}
          </div>
        </SidebarHeader>
        {/* The folder row heads the content in both modes: under the band in
         *  Chats, under the Documents strip otherwise, so the navigator places
         *  it. With no folder the row still stands, for the project's own
         *  recovery. */}
        {activeFolder ? null : folderRow}
        {activeFolder && (
          <SidebarNavigator
            contentId={folderContentId}
            head={folderRow}
            onSelect={sidebar.select}
            open={folderOpen}
            panels={sidebarPanels({
              chats: agent.scope ? (
                <AgentChats
                  catalog={dependencies.agent.catalog}
                  onOpenAgentSettings={() => settings.openSettings('agents')}
                  runtime={agent.runtime}
                  scheduledTasks={dependencies.agent.scheduledTasks}
                  scope={agent.scope}
                  workspaceName={activeFolder.name}
                />
              ) : null,
              files: workspace ? (
                <FileImport
                  api={dependencies.workspace.adapters.upload}
                  key={workspace.scope.generation}
                  runtime={workspace}
                >
                  {(importFiles) => (
                    <FileTree
                      api={dependencies.workspace.adapters.files}
                      importFiles={importFiles}
                      {...(folder.hiddenFiles ? { hiddenFiles: folder.hiddenFiles } : {})}
                      key={workspace.scope.generation}
                      onOpenSource={sources.open}
                      onReprocess={onReprocess}
                      onScopeLost={sources.recoverLostScope}
                      mutateSources={sources.mutate}
                      revealLabel={dependencies.workspace.revealLabel}
                      rowMarkers={folder.rowMarkers}
                      runtime={workspace}
                    />
                  )}
                </FileImport>
              ) : (
                <p className="px-4 py-2 text-caption text-muted-foreground">Loading files…</p>
              ),
              outline: documents,
              search: (
                <ProjectSearch
                  onConfigureSearch={() => settings.openSettings('search')}
                  active={sidebar.selected === 'search'}
                  activeFolderPath={activeFolder.path}
                  decisionApi={dependencies.retrieval.decisionApi}
                  exactApi={dependencies.retrieval.exactSearchApi}
                  focusRevision={sidebar.focusRevision}
                  indexWarning={folder.search.indexWarning}
                  onNavigate={sources.navigateToMatch}
                  preparation={folder.search.counts}
                  readiness={folder.search.semantic}
                  readyCount={folder.search.readyCount}
                  semanticApi={dependencies.retrieval.semanticSearchApi}
                />
              ),
            })}
            selected={sidebar.selected}
          />
        )}
        {/* pt-0: the list above fades out to the region's edge, and the first
         *  rule's own 4px margin is all the room it wants before the rule. */}
        <SidebarFooter className="pt-0">
          {notices}
          <SidebarMenu>
            {/* Rules bracket the foot: one sets the Gallery shelf off from the
             *  panel above, one sets the person off from the shelf. Settings
             *  lives inside the account menu rather than as a standing row.
             *  `mx-2` on top of the footer's own p-2 insets the rule 16px,
             *  one 8px step inside where a row's hover fill starts, so the
             *  rule reads as a soft break rather than competing with the
             *  rows it separates. The Chats panel's rule keeps the same
             *  16px; it spells it `mx-4` because its own container carries
             *  no padding to add to. */}
            <li className="mx-2 my-1 h-px bg-border" role="none" />
            <SidebarMenuItem>
              <SidebarMenuButton icon={Store} onClick={onBrowseGallery}>
                Gallery
              </SidebarMenuButton>
            </SidebarMenuItem>
            <li className="mx-2 my-1 h-px bg-border" role="none" />
            <SidebarAccountRow
              agentRuntimeApi={dependencies.settings.agentRuntimeApi}
              onOpenAccount={() => settings.openSettings('account')}
              onOpenSettings={() => settings.openSettings()}
            />
          </SidebarMenu>
        </SidebarFooter>
      </SizeProvider>
    </Sidebar>
  );
}
