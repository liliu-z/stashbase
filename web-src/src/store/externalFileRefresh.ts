import { api, versionedAssetUrl } from '../api';
import type { Action, OpenFile } from './state';

interface ExternalFileRefreshOptions {
  file: OpenFile;
  folderPathAtStart: string;
  force: boolean;
  getFolderPath: () => string;
  getActiveFile: () => OpenFile | null;
  dispatch: (action: Action) => void;
}

/** Refreshes a transient grant only when the caller still owns the active tab. */
export async function refreshExternalFile({
  file,
  folderPathAtStart,
  force,
  getFolderPath,
  getActiveFile,
  dispatch,
}: ExternalFileRefreshOptions): Promise<void> {
  const grantId = file.grantId;
  if (!grantId) return;

  try {
    if (
      file.format === 'pdf'
      || file.format === 'image'
      || file.format === 'docx'
      || file.format === 'audio'
    ) {
      const url = versionedAssetUrl(file.name, file.version ?? '', undefined, grantId);
      const response = await fetch(url, { method: 'HEAD' });
      if (!response.ok) throw new Error('Unavailable');
      return;
    }

    const body = await api.getExternalFileText(grantId);
    if (getFolderPath() !== folderPathAtStart) return;
    const latestFile = getActiveFile();
    if (!latestFile?.isExternal || latestFile.grantId !== grantId) return;

    if (force) {
      dispatch({
        type: 'FILE_OPEN',
        body: {
          name: latestFile.name,
          format: latestFile.format,
          content: body.content,
          version: 'transient',
          isExternal: true,
          isReadOnly: true,
          grantId,
          absolutePath: latestFile.absolutePath,
        },
      });
      dispatch({ type: 'SAVE_STATUS', status: { text: 'Reloaded from disk', cls: 'saved' } });
      return;
    }

    if (body.content !== latestFile.content) {
      dispatch({ type: 'FILE_PATCH', patch: { content: body.content } });
    }
  } catch {
    if (getFolderPath() !== folderPathAtStart) return;
    const latestFile = getActiveFile();
    if (
      latestFile?.isExternal
      && latestFile.grantId === grantId
      && (latestFile.format === 'md'
        || latestFile.format === 'html'
        || latestFile.format === 'json')
    ) {
      dispatch({
        type: 'FILE_PATCH',
        patch: { content: '⚠️ This external file is no longer available.' },
      });
    }
  }
}
