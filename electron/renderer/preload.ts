import { contextBridge, ipcRenderer } from 'electron';

import { createExternalNavigationPreload } from '../external-navigation/preload.ts';
import { createProjectPreload } from '../project/preload.ts';
import { createTextServicesPreload } from '../text-services/preload.ts';
import { createUpdatesPreload } from '../updates/preload.ts';
import { createWorkspaceSessionPreload } from '../workspace/preload.ts';
import { createWindowLifecyclePreload } from '../window/preload.ts';
import { stampDocumentMarks } from './document-marks.ts';
import { createRuntimeConfig } from './runtime.ts';

stampDocumentMarks(ipcRenderer, document, process.platform);

contextBridge.exposeInMainWorld(
  'stashbase',
  Object.freeze({
    externalNavigation: createExternalNavigationPreload(ipcRenderer),
    runtime: createRuntimeConfig(process.argv),
    project: createProjectPreload(ipcRenderer),
    textServices: createTextServicesPreload(ipcRenderer),
    workspaceSession: createWorkspaceSessionPreload(ipcRenderer),
    windowLifecycle: createWindowLifecyclePreload(ipcRenderer),
    updates: createUpdatesPreload(ipcRenderer),
  }),
);
