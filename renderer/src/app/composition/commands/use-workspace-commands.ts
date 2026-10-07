/**
 * The window's chrome: which sidebar panel is showing, which command surface is
 * open, how far startup has come, and what the notice strip says.
 *
 * None of it belongs to a single feature and all of it answers to the same few
 * inputs, so it is composed once here and the shell only decides what each part
 * is given. The two pieces of state the shell used to reach through two further
 * hooks for — the open Settings section and the selected sidebar panel — are
 * held here directly: a hook whose whole body was a call to another hook made
 * the shell four levels deep to answer "which panel is showing".
 */
import { useCallback, useRef, useState } from 'react';

import { useBootProgress } from '@/app/bootstrap/use-boot-progress';
import type { TurnReview } from '@/app/composition/folder/use-turn-review';
import {
  useWorkspaceNotices,
  type WorkspaceNotice,
} from '@/app/composition/folder/use-workspace-notices';
import type { DocumentTabsRuntime } from '@/features/documents/public';
import type { SettingsSectionId, SettingsTarget } from '@/features/settings/public';
import type {
  ProjectRegistrySnapshot,
  WorkspaceRuntime,
  WorkspaceSessionController,
} from '@/features/workspace/public';
import { useCommandSurface, type CommandSurface } from '@/shared/runtime/use-command-surface';

import type { PreparationCommands } from './use-preparation-commands';
import { useQuickOpenCommand } from './use-quick-open-command';
import { useSidebarSearchCommand } from './use-sidebar-search-command';

/** Every panel the sidebar can show. A panel is named, never numbered: the
 *  index the tab strip wants is derived from the registry, so inserting a panel
 *  cannot silently repoint a comparison somewhere else. */
export type SidebarPanelId = 'files' | 'outline' | 'search' | 'chats';

/** The sidebar's two modes, switched from its titlebar band. Documents holds
 *  Files, Document outline, and Search under one tab strip; Chats is the
 *  folder's conversations and needs no strip of its own. */
export type SidebarMode = 'documents' | 'chats';

/** Which mode a panel belongs to. Chats is its own mode; every other panel
 *  is a way of looking at the folder's documents. */
export function sidebarModeOf(panel: SidebarPanelId): SidebarMode {
  return panel === 'chats' ? 'chats' : 'documents';
}

export interface SidebarNavigatorState {
  /** Bumped every time Search is summoned, so the field refocuses even when the
   *  panel was already showing. */
  focusRevision: number;
  /** The mode the selected panel belongs to. */
  mode: SidebarMode;
  /** Opens the sidebar on Search and puts the caret in its field. */
  openSearch(): void;
  select(panel: SidebarPanelId): void;
  /** Switches mode. Chats lands on the Chats panel; Documents comes back to
   *  whichever documents panel was showing last, so a trip to Chats and back
   *  does not lose a search in progress. */
  selectMode(mode: SidebarMode): void;
  selected: SidebarPanelId;
}

export interface SettingsCommand {
  close(): void;
  onSectionChange(id: SettingsSectionId): void;
  open: boolean;
  openSettings(section?: SettingsTarget): void;
  section: SettingsTarget;
}

export interface WorkspaceCommands {
  navigator: SidebarNavigatorState;
  /** Things raised by work the reader did not ask about directly. */
  notices: readonly WorkspaceNotice[];
  quickOpen: Pick<CommandSurface, 'close' | 'open'>;
  settings: SettingsCommand;
  /** True once the window has settled far enough to show the Agent. */
  started: boolean;
}

/** Settings opens where a reader looking for a setting expects to land: the
 *  first section in the nav. A surface that means a specific section (the
 *  Agent panel's own setup links) names it. */
const DEFAULT_SECTION: SettingsSectionId = 'general';

export function useWorkspaceCommands({
  documents,
  hostFailure,
  project,
  preparation,
  revisions,
  session,
  workspace,
}: {
  documents: DocumentTabsRuntime | null;
  hostFailure: string | null;
  project: ProjectRegistrySnapshot | null;
  preparation: Pick<PreparationCommands, 'dismissFailure' | 'failure'>;
  revisions: TurnReview;
  session: WorkspaceSessionController;
  workspace: WorkspaceRuntime | null;
}): WorkspaceCommands {
  const memberCount = project?.projects.length ?? 0;
  const sidebarRuntime = session.runtime;

  const settingsSurface = useCommandSurface();
  const [section, setSection] = useState<SettingsTarget>(DEFAULT_SECTION);
  const presentSettings = settingsSurface.present;
  const openSettings = useCallback(
    (next: SettingsTarget = DEFAULT_SECTION) => {
      setSection(next);
      presentSettings();
    },
    [presentSettings],
  );

  const [selected, setSelected] = useState<SidebarPanelId>('files');
  // The documents panel to come back to from Chats. A ref rather than state:
  // nothing renders from it, and it only changes inside the select calls.
  const documentsPanel = useRef<SidebarPanelId>('files');
  const select = useCallback((panel: SidebarPanelId) => {
    if (sidebarModeOf(panel) === 'documents') documentsPanel.current = panel;
    setSelected(panel);
  }, []);
  const selectMode = useCallback((mode: SidebarMode) => {
    setSelected(mode === 'chats' ? 'chats' : documentsPanel.current);
  }, []);
  const [focusRevision, setFocusRevision] = useState(0);
  const openSearch = useCallback(() => {
    sidebarRuntime.setSidebarOpen(true);
    select('search');
    setFocusRevision((revision) => revision + 1);
  }, [select, sidebarRuntime]);

  useSidebarSearchCommand(memberCount > 0, openSearch);
  const quickOpen = useQuickOpenCommand(workspace, documents);
  const started = useBootProgress({
    memberCount,
    settled: session.status.kind === 'ready' && project !== null,
  });
  const notices = useWorkspaceNotices({
    dismissPreparationFailure: preparation.dismissFailure,
    dismissRevisionFailure: revisions.dismiss,
    hostFailure,
    preparationFailure: preparation.failure,
    revisionFailures: revisions.failures,
  });

  return {
    navigator: {
      focusRevision,
      mode: sidebarModeOf(selected),
      openSearch,
      select,
      selectMode,
      selected,
    },
    notices,
    quickOpen,
    settings: {
      close: settingsSurface.close,
      onSectionChange: setSection,
      open: settingsSurface.open,
      openSettings,
      section,
    },
    started: started && project !== null,
  };
}
