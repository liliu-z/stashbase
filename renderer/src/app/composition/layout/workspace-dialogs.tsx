import { useCallback, useState, type ReactNode } from 'react';

import { useWindowCommand } from '@/app/composition/commands/use-window-command';
import type { SettingsCommand } from '@/app/composition/commands/use-workspace-commands';
import { useDependencies } from '@/app/composition/dependency-context';
import type { DocumentTabsRuntime } from '@/features/documents/public';
import { DeveloperTools, Settings } from '@/features/settings/public';
import { useSoftwareUpdate } from '@/features/updates/public';
import { type WorkspaceRuntime } from '@/features/workspace/public';

import { WorkspaceQuickOpen } from './workspace-quick-open';

function isDeveloperShortcut(event: KeyboardEvent): boolean {
  return (
    import.meta.env.DEV &&
    (event.metaKey || event.ctrlKey) &&
    event.altKey &&
    event.shiftKey &&
    event.code === 'KeyD'
  );
}

/** Quick open and Settings, bound to their ports above the workspace. */
export function WorkspaceDialogs({
  documents,
  quickOpen,
  revisionPreview,
  settings,
  renderUpdatePreview,
  workspace,
}: {
  documents: DocumentTabsRuntime | null;
  quickOpen: { close(): void; open: boolean };
  revisionPreview?: ReactNode;
  settings: SettingsCommand;
  renderUpdatePreview?: (onClose: () => void) => ReactNode;
  workspace: WorkspaceRuntime | null;
}) {
  const dependencies = useDependencies();
  const softwareUpdate = useSoftwareUpdate(dependencies.updates);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const closeSettings = settings.close;
  useWindowCommand(
    isDeveloperShortcut,
    useCallback(() => {
      closeSettings();
      setDeveloperOpen(true);
    }, [closeSettings]),
  );
  return (
    <>
      {workspace && documents && (
        <WorkspaceQuickOpen
          documents={documents}
          onClose={quickOpen.close}
          open={quickOpen.open}
          workspace={workspace}
        />
      )}
      {import.meta.env.DEV && (
        <DeveloperTools
          agentRuntimeApi={dependencies.settings.agentRuntimeApi}
          onClose={() => setDeveloperOpen(false)}
          open={developerOpen}
          updatePreview={renderUpdatePreview?.(() => setDeveloperOpen(false))}
        />
      )}
      <Settings
        agentRuntimeApi={dependencies.settings.agentRuntimeApi}
        appearanceApi={dependencies.settings.appearanceApi}
        systemTextApi={dependencies.settings.systemTextApi}
        telemetryApi={dependencies.settings.telemetryApi}
        embedderApi={dependencies.settings.embedderApi}
        mcpAccessApi={dependencies.settings.mcpAccessApi}
        onClose={settings.close}
        onOpenExternal={(href) => void dependencies.documents.openExternal(href)}
        onSectionChange={settings.onSectionChange}
        open={settings.open}
        revisionPreview={revisionPreview}
        section={settings.section}
        softwareUpdate={dependencies.updates ? softwareUpdate : null}
      />
    </>
  );
}
