/**
 * Everything the workspace window is built from, resolved once at startup.
 *
 * The app names one adapter record per feature and nothing below it: which
 * port sits on HTTP, which on a desktop bridge, and how many of them there are
 * is each feature's own business, so a feature that gains a transport does not
 * change this file. What stays here is the wiring a feature cannot do for
 * itself — the bridges and the server origin it is handed — and the few
 * capabilities that belong to the desktop shell rather than to any feature.
 */
import type { ComponentProps } from 'react';

import { createAgentPreferencesAdapter, type AgentPreferencesPort } from '@/features/agent/public';
import {
  createAgentCatalogAdapter,
  createAgentPersonaAdapter,
  createAgentToolsAdapter,
  createAgentContextAdapter,
  createAgentSessionAdapter,
  createScheduledRunsAdapter,
  createScheduledTasksAdapter,
  type AgentCatalogPort,
  type AgentPersonaPort,
  type AgentToolsPort,
  type AgentContextPort,
  type AgentSessionPort,
  type ScheduledRunsPort,
  type ScheduledTasksPort,
} from '@/features/agent/public';
import { createDocumentAdapters, type DocumentAdapters } from '@/features/documents/public';
import { createGalleryIndexAdapter, type GalleryPort } from '@/features/gallery/public';
import {
  createPreparationControlAdapter,
  createPreparationStatusAdapter,
  type PreparationControlPort,
  type PreparationStatusPort,
} from '@/features/preparation/public';
import {
  createExactSearchAdapter,
  createIndexDecisionAdapter,
  createSemanticSearchAdapter,
  type ExactSearchPort,
  type IndexDecisionPort,
  type SemanticSearchPort,
} from '@/features/retrieval/public';
import { createTelemetryAdapter, type TelemetryPort } from '@/features/settings/public';
import {
  createAccountAdapter,
  createAgentRuntimeAdapter,
  createAppearanceAdapter,
  createProjectMathAdapter,
  createSystemTextAdapter,
  createEmbedderAdapter,
  createMcpAccessAdapter,
  createLocalComponentAdapter,
  type LocalComponentPort,
  type AccountPort,
  type AgentRuntimePort,
  type AppearancePort,
  type ProjectMathPort,
  type SystemTextPort,
  type EmbedderPort,
  type McpAccessPort,
} from '@/features/settings/public';
import { createUpdatesAdapter, type UpdatesPort } from '@/features/updates/public';
import {
  createWorkspaceAdapters,
  FileTree,
  ProjectWelcome,
  type WorkspaceAdapters,
  type ProjectFolderPickerPort,
} from '@/features/workspace/public';
import { readBridge } from '@/platform/electron/bridge';
import { createExternalNavigation } from '@/platform/electron/external-navigation';
import { fileManagerLabel } from '@/platform/electron/file-manager';
import { createFolderPicker } from '@/platform/electron/folder-picker';
import { createNotificationsAdapter } from '@/platform/electron/notifications';
import type { WindowLifecycleBridge } from '@/platform/electron/window-lifecycle';
import { createErrorReporter, type ErrorReporter } from '@/platform/error-reporting';
import { createHttpClient } from '@/platform/http/client';
import { createUsageRecorder } from '@/platform/telemetry';
import type { AppearanceSurface } from '@/shared/domain/appearance';
import type {
  DesktopNotificationsPort,
  NotificationPreferencesPort,
} from '@/shared/domain/notifications';

/** The folder chrome's dependencies, as the welcome screen declares them;
 *  the folder window's sidebar takes only the project port from the set. */
type ProjectChrome = Pick<ComponentProps<typeof ProjectWelcome>, 'api' | 'lifecycle'> & {
  folderPicker: ProjectFolderPickerPort;
};

export interface AppDependencies {
  notifications?: DesktopNotificationsPort & NotificationPreferencesPort;
  reportError?: ErrorReporter | undefined;
  /** The appearance the desktop remembered for this window's first paint;
   *  null on a first launch. */
  initialAppearance: AppearanceSurface | null;
  recordUsage: ReturnType<typeof createUsageRecorder>;
  onInputActivity?: WindowLifecycleBridge['onInputActivity'];
  agent: {
    /** Which runtimes a conversation can open on. Settings reads the same
     *  endpoint through its own port for its own question. */
    catalog: AgentCatalogPort;
    preferences?: AgentPreferencesPort;
    context: AgentContextPort;
    persona: AgentPersonaPort;
    /** Default's optional model tools. */
    tools: AgentToolsPort;
    session: AgentSessionPort;
    /** The project's scheduled tasks, for its task list. */
    scheduledTasks?: ScheduledTasksPort;
    /** The runs main hands this window, in the desktop shell only. */
    scheduledRuns?: ScheduledRunsPort;
  };
  /** Opens the bug-report review for this window; null outside Electron. */
  documents: {
    adapters: DocumentAdapters;
    createId: () => string;
    openExternal(href: string): Promise<boolean>;
  };
  /** The shop, and the whole take-this-copy action it does not own itself. */
  gallery: GalleryPort;
  project: ProjectChrome;
  preparation: {
    controlApi: PreparationControlPort;
    statusApi: PreparationStatusPort;
  };
  retrieval: {
    decisionApi: IndexDecisionPort;
    exactSearchApi: ExactSearchPort;
    semanticSearchApi: SemanticSearchPort;
  };
  settings: {
    accountApi: AccountPort;
    agentRuntimeApi: AgentRuntimePort;
    appearanceApi: AppearancePort;
    projectMathApi: ProjectMathPort;
    /** Hands the applied appearance to the desktop's native chrome and
     *  spellchecker. */
    setAppearance: WindowLifecycleBridge['setAppearance'];
    systemTextApi: SystemTextPort;
    telemetryApi: TelemetryPort;
    embedderApi: EmbedderPort;
    mcpAccessApi: McpAccessPort;
    localComponentApi: LocalComponentPort;
  };
  /** Keeping this build current; null outside Electron or when the build has no updater. */
  updates: UpdatesPort | null;
  workspace: {
    adapters: WorkspaceAdapters;
    /** What this platform calls the app that reveals a file. */
    revealLabel: ComponentProps<typeof FileTree>['revealLabel'];
  };
}

export function createDependencies(): AppDependencies {
  const bridge = readBridge();
  const reportError = createErrorReporter(createHttpClient(bridge.runtime.serverOrigin));
  const http = createHttpClient(bridge.runtime.serverOrigin, fetch, reportError);
  const externalNavigation = createExternalNavigation(bridge.externalNavigation);
  const workspace = createWorkspaceAdapters({
    http,
    project: bridge.project,
    serverOrigin: bridge.runtime.serverOrigin,
    workspaceSession: bridge.workspaceSession,
  });
  return {
    ...(bridge.notifications
      ? { notifications: createNotificationsAdapter(bridge.notifications) }
      : {}),
    reportError,
    initialAppearance: bridge.runtime.appearance ?? null,
    recordUsage: createUsageRecorder(http),
    onInputActivity: bridge.windowLifecycle.onInputActivity,
    agent: {
      catalog: createAgentCatalogAdapter(http),
      preferences: createAgentPreferencesAdapter(http),
      persona: createAgentPersonaAdapter(http),
      tools: createAgentToolsAdapter(http),
      context: createAgentContextAdapter(http, bridge.runtime.serverOrigin),
      session: createAgentSessionAdapter(http, bridge.runtime.serverOrigin),
      scheduledTasks: createScheduledTasksAdapter(http, bridge.scheduledTasks),
      ...(bridge.scheduledTasks
        ? { scheduledRuns: createScheduledRunsAdapter(bridge.scheduledTasks) }
        : {}),
    },
    documents: {
      adapters: createDocumentAdapters({
        externalFiles: bridge.externalFiles,
        http,
        serverOrigin: bridge.runtime.serverOrigin,
        windowLifecycle: bridge.windowLifecycle,
      }),
      createId: () => globalThis.crypto.randomUUID(),
      openExternal: externalNavigation.open,
    },
    gallery: createGalleryIndexAdapter(http, bridge.runtime.serverOrigin),
    project: {
      api: workspace.project,
      folderPicker: createFolderPicker(bridge.project, reportError),
      lifecycle: workspace.lifecycle,
    },
    preparation: {
      controlApi: createPreparationControlAdapter(http),
      statusApi: createPreparationStatusAdapter(http),
    },
    retrieval: {
      decisionApi: createIndexDecisionAdapter(http),
      exactSearchApi: createExactSearchAdapter(http),
      semanticSearchApi: createSemanticSearchAdapter(http),
    },
    settings: {
      accountApi: createAccountAdapter(http, bridge.runtime.serverOrigin),
      agentRuntimeApi: createAgentRuntimeAdapter(http),
      appearanceApi: createAppearanceAdapter(http),
      projectMathApi: createProjectMathAdapter(http),
      setAppearance: (appearance) => bridge.windowLifecycle.setAppearance(appearance),
      systemTextApi: createSystemTextAdapter(bridge.textServices),
      telemetryApi: createTelemetryAdapter(http),
      embedderApi: createEmbedderAdapter(http),
      mcpAccessApi: createMcpAccessAdapter(http),
      localComponentApi: createLocalComponentAdapter(http),
    },
    updates: bridge.updates ? createUpdatesAdapter(bridge.updates, reportError) : null,
    workspace: { adapters: workspace, revealLabel: fileManagerLabel() },
  };
}
