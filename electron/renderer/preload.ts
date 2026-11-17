import { createNotificationsPreload } from '../notifications/preload.ts';
import { createSpeechCapturePreload } from '../speech/preload.ts';

import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { createExternalFilesPreload } from '../external-files/preload.ts';
import { createExternalNavigationPreload } from '../external-navigation/preload.ts';
import { createProjectPreload } from '../project/preload.ts';
import { createScheduledTasksPreload } from '../scheduled-tasks/preload.ts';
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
    externalFiles: createExternalFilesPreload(ipcRenderer, (file) => webUtils.getPathForFile(file)),
    externalNavigation: createExternalNavigationPreload(ipcRenderer),
    notifications: createNotificationsPreload(ipcRenderer),
    speech: createSpeechCapturePreload(ipcRenderer),
    runtime: createRuntimeConfig(process.argv),
    project: createProjectPreload(ipcRenderer),
    scheduledTasks: createScheduledTasksPreload(ipcRenderer),
    textServices: createTextServicesPreload(ipcRenderer),
    workspaceSession: createWorkspaceSessionPreload(ipcRenderer),
    windowLifecycle: createWindowLifecyclePreload(ipcRenderer),
    updates: createUpdatesPreload(ipcRenderer),
  }),
);
