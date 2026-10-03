import {
  type RendererRuntimeConfig,
  rendererRuntimeConfigSchema,
} from '@/protocols/electron/runtime';

import type { ExternalNavigationBridge } from './external-navigation';
import type { ProjectBridge } from './folder-picker';
import type { ProjectLifecycleBridge } from './project-lifecycle';
import type { TextServicesBridge } from './text-services';
import { isUpdatesBridge, type UpdatesBridge } from './updates';
import type { WindowLifecycleBridge } from './window-lifecycle';

interface DesktopWorkspaceSessionBridge {
  read(): Promise<unknown>;
  write(snapshot: unknown): Promise<unknown>;
}

interface DesktopProjectBridge extends ProjectBridge, ProjectLifecycleBridge {}

interface DesktopBridge {
  /** Optional: opening the bug-report review exists only in the desktop shell. */
  externalNavigation: ExternalNavigationBridge;
  project: DesktopProjectBridge;
  runtime: RendererRuntimeConfig;
  textServices: TextServicesBridge;
  /** Optional: keeping this build current exists only in the desktop shell. */
  updates?: UpdatesBridge;
  workspaceSession: DesktopWorkspaceSessionBridge;
  windowLifecycle: WindowLifecycleBridge;
}

declare global {
  interface Window {
    stashbase?: {
      bugReportReview?: unknown;
      externalNavigation?: ExternalNavigationBridge;
      project?: DesktopProjectBridge;
      runtime?: unknown;
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
  return {
    ...(isUpdatesBridge(updates) ? { updates } : {}),
    externalNavigation,
    project,
    runtime,
    textServices,
    windowLifecycle,
    workspaceSession,
  };
}
