import type { ErrorReporter } from '@/platform/error-reporting';
import {
  type ProjectFolderDialogFailure,
  type ProjectFolderDialogRequest,
  type ProjectFolderDialogResponse,
} from '@/protocols/electron/project';

export interface ProjectBridge {
  chooseFolder(request?: Partial<ProjectFolderDialogRequest>): Promise<ProjectFolderDialogResponse>;
}

export type ProjectFolderPickerResult =
  | { status: 'selected'; folderPath: string }
  | { status: 'cancelled' }
  | { status: 'failed'; failure: ProjectFolderDialogFailure['failure'] };

export interface ProjectFolderPickerPort {
  chooseFolder(request?: Partial<ProjectFolderDialogRequest>): Promise<ProjectFolderPickerResult>;
}

export function mapFolderSelection(
  response: ProjectFolderDialogResponse,
): ProjectFolderPickerResult {
  if (!response.ok) return { status: 'failed', failure: response.failure };
  if (response.folderPath === null) return { status: 'cancelled' };
  return { status: 'selected', folderPath: response.folderPath };
}

export function createFolderPicker(
  bridge: ProjectBridge,
  reportError?: ErrorReporter,
): ProjectFolderPickerPort {
  return {
    async chooseFolder(request) {
      try {
        const result = mapFolderSelection(await bridge.chooseFolder(request));
        if (result.status === 'failed')
          reportError?.(new Error(`Folder picker failed: ${result.failure.kind}`), 'folder-picker');
        return result;
      } catch (error) {
        reportError?.(error, 'folder-picker');
        throw error;
      }
    },
  };
}
