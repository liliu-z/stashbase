import { api } from '../api';
import { electronBridge } from '../electronBridge';
import type { Action, State } from './state';
import type { ToastOptions } from './useFeedbackActions';

type Dispatch = (action: Action) => void;
type Toast = (message: string, opts?: ToastOptions) => string;
export type ExternalFileOpenResult = { ok: true } | { ok: false; error: string };

interface OpenExternalFilePathOptions {
  filePath: string;
  suppressToast: boolean;
  selectFile: (name: string) => Promise<void>;
  getState: () => State;
  dispatch: Dispatch;
  toast: Toast;
}

export async function openExternalFilePath({
  filePath,
  suppressToast,
  selectFile,
  getState,
  dispatch,
  toast,
}: OpenExternalFilePathOptions): Promise<ExternalFileOpenResult> {
  let grantIdToRevokeOnFailure: string | null = null;
  try {
    const bridge = electronBridge();
    if (!bridge?.registerPreviewGrant) throw new Error('Electron bridge not available');

    const result = await bridge.registerPreviewGrant(filePath);
    if (result.isInternal) {
      await selectFile(result.relPath);
      return { ok: true };
    }

    grantIdToRevokeOnFailure = result.grantId;
    const currentState = getState();
    const existing = currentState.tabs.find(
      (tab) => tab.file?.isExternal && tab.file.absolutePath === result.absolutePath,
    );
    if (existing) {
      if (currentState.activeTabId !== existing.id) {
        dispatch({ type: 'ACTIVATE_TAB', id: existing.id });
      }
      void bridge.revokePreviewGrant?.(result.grantId);
      return { ok: true };
    }

    const body = {
      name: result.name,
      format: result.format,
      content: '',
      version: 'transient',
      isExternal: true,
      isReadOnly: true,
      grantId: result.grantId,
      absolutePath: result.absolutePath,
    };
    if (result.format === 'md' || result.format === 'html' || result.format === 'json') {
      body.content = (await api.getExternalFileText(result.grantId)).content;
    }

    dispatch({ type: 'FILE_OPEN', body, newTab: true });
    return { ok: true };
  } catch (err: unknown) {
    if (grantIdToRevokeOnFailure) {
      void electronBridge()?.revokePreviewGrant?.(grantIdToRevokeOnFailure);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (!suppressToast) {
      toast(`Could not open external file: ${message}`, { level: 'error' });
    }
    return { ok: false, error: message };
  }
}

interface OpenExternalFilesOptions {
  files: File[];
  openPath: (filePath: string, opts?: { suppressToast?: boolean }) => Promise<ExternalFileOpenResult | void>;
  toast: Toast;
}

export async function openExternalFiles({ files, openPath, toast }: OpenExternalFilesOptions): Promise<void> {
  const bridge = electronBridge();
  let failedCount = 0;
  let lastError = '';

  for (const file of files) {
    const filePath = bridge?.getPathForFile?.(file);
    if (!filePath) {
      failedCount += 1;
      lastError = 'Could not determine file path';
      continue;
    }
    const result = await openPath(filePath, { suppressToast: true });
    if (result && !result.ok) {
      failedCount += 1;
      lastError = result.error;
    }
  }

  if (failedCount === 1) {
    toast(`Could not open external file: ${lastError}`, { level: 'error' });
  } else if (failedCount > 1) {
    toast(`${failedCount} unsupported files could not be opened`, { level: 'error' });
  }
}
