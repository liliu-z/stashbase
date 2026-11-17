import {
  type RendererRuntimeConfig,
  rendererRuntimeConfigSchema,
} from '@/protocols/electron/runtime';

import { isExternalFilesBridge, type ExternalFilesBridge } from './external-files';
import type { ExternalNavigationBridge } from './external-navigation';
import type { ProjectBridge } from './folder-picker';
import type { NotificationsBridge } from './notifications';
import type { ProjectLifecycleBridge } from './project-lifecycle';
import { isScheduledTasksBridge, type ScheduledTasksBridge } from './scheduled-tasks';
import type { TextServicesBridge } from './text-services';
import { isUpdatesBridge, type UpdatesBridge } from './updates';
import type { WindowLifecycleBridge } from './window-lifecycle';

interface DesktopWorkspaceSessionBridge {
  read(): Promise<unknown>;
  write(snapshot: unknown): Promise<unknown>;
}

interface DesktopProjectBridge extends ProjectBridge, ProjectLifecycleBridge {}

interface DesktopBridge {
  speech?: { authorize(active: boolean): Promise<boolean> };
  /** Optional: opening a dropped file in place needs its location on disk,
   *  which only the desktop shell can read. */
  externalFiles?: ExternalFilesBridge;
  notifications?: NotificationsBridge;
  /** Optional: opening the bug-report review exists only in the desktop shell. */
  externalNavigation: ExternalNavigationBridge;
  project: DesktopProjectBridge;
  runtime: RendererRuntimeConfig;
  /** Optional: scheduled tasks run only in the desktop shell. */
  scheduledTasks?: ScheduledTasksBridge;
  textServices: TextServicesBridge;
  /** Optional: keeping this build current exists only in the desktop shell. */
  updates?: UpdatesBridge;
  workspaceSession: DesktopWorkspaceSessionBridge;
  windowLifecycle: WindowLifecycleBridge;
}

declare global {
  interface Window {
    stashbase?: {
      speech?: { authorize(active: boolean): Promise<boolean> };
      notifications?: NotificationsBridge;
      bugReportReview?: unknown;
      externalFiles?: unknown;
      externalNavigation?: ExternalNavigationBridge;
      project?: DesktopProjectBridge;
      runtime?: unknown;
      scheduledTasks?: unknown;
      textServices?: TextServicesBridge;
      updates?: unknown;
      workspaceSession?: DesktopWorkspaceSessionBridge;
      windowLifecycle?: WindowLifecycleBridge;
    };
  }
}

export function readBridge(globalWindow: Window = window): DesktopBridge {
  const runtime = rendererRuntimeConfigSchema.parse(globalWindow.stashbase?.runtime);
  const externalNavigation = globalWindow.stashbase?.externalNavigation;
  const project = globalWindow.stashbase?.project;
  const workspaceSession = globalWindow.stashbase?.workspaceSession;
  const windowLifecycle = globalWindow.stashbase?.windowLifecycle;
  if (!externalNavigation || typeof externalNavigation.open !== 'function') {
    throw new Error('External navigation is unavailable.');
  }
  if (
    !project ||
    typeof project.chooseFolder !== 'function' ||
    typeof project.notifyFolderRemoved !== 'function' ||
    typeof project.onFolderRemoved !== 'function' ||
    typeof project.onPrepareFolderRemoval !== 'function' ||
    typeof project.prepareFolderRemoval !== 'function' ||
    typeof project.onEnterFolder !== 'function' ||
    typeof project.onEntryCancelled !== 'function' ||
    typeof project.cancelEntry !== 'function' ||
    typeof project.setActiveFolder !== 'function'
  ) {
    throw new Error('The project folder picker is unavailable.');
  }
  if (
    !workspaceSession ||
    typeof workspaceSession.read !== 'function' ||
    typeof workspaceSession.write !== 'function'
  ) {
    throw new Error('Workspace session persistence is unavailable.');
  }
  if (
    !windowLifecycle ||
    typeof windowLifecycle.onPrepareContextRelease !== 'function' ||
    typeof windowLifecycle.setAppearance !== 'function'
  ) {
    throw new Error('The window lifecycle is unavailable.');
  }
  const textServices = globalWindow.stashbase?.textServices;
  if (
    !textServices ||
    typeof textServices.listFonts !== 'function' ||
    typeof textServices.spellcheckLanguages !== 'function'
  ) {
    throw new Error('Text services are unavailable.');
  }
  const updates = globalWindow.stashbase?.updates;
  const scheduledTasks = globalWindow.stashbase?.scheduledTasks;
  const externalFiles = globalWindow.stashbase?.externalFiles;
  return {
    ...(globalWindow.stashbase?.speech ? { speech: globalWindow.stashbase.speech } : {}),
    ...(isExternalFilesBridge(externalFiles) ? { externalFiles } : {}),
    ...(globalWindow.stashbase?.notifications
      ? { notifications: globalWindow.stashbase.notifications }
      : {}),
    ...(isUpdatesBridge(updates) ? { updates } : {}),
    ...(isScheduledTasksBridge(scheduledTasks) ? { scheduledTasks } : {}),
    externalNavigation,
    project,
    runtime,
    textServices,
    windowLifecycle,
    workspaceSession,
  };
}
