import {
  FilesError,
  type UploadPort,
  type UploadResult,
} from '@/features/workspace/application/ports';
import type { ErrorReporter } from '@/platform/error-reporting';
import { classifyResponse } from '@/platform/http/classify';

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface UploadResponseBody {
  files?: Array<{ error?: unknown; file?: unknown }>;
  code?: unknown;
  error?: unknown;
}

/** Preserve per-file outcomes so retry cannot duplicate successful imports. */
function settledPaths(body: UploadResponseBody | null, count: number): UploadResult {
  if (!body || !Array.isArray(body.files) || body.files.length !== count) {
    throw new FilesError('outcome-unknown', 'The upload returned an invalid response.');
  }
  const paths: string[] = [];
  const refused: number[] = [];
  body.files.forEach((entry, index) => {
    if (typeof entry?.file !== 'string') {
      throw new FilesError('outcome-unknown', 'The upload returned an invalid response.');
    }
    if (typeof entry.error === 'string') refused.push(index);
    else paths.push(entry.file);
  });
  return { paths, refused };
}

/** Multipart import through `POST /api/upload`. The JSON HTTP client cannot
 *  carry file bodies, so this adapter speaks to the server origin directly. */
export function createUploadAdapter(
  serverOrigin: string,
  fetchRequest: Fetch = fetch,
  reportError?: ErrorReporter,
): UploadPort {
  const target = new URL('/api/upload', serverOrigin);
  return {
    async upload(folderPath, files, signal) {
      const form = new FormData();
      form.set('folder', folderPath);
      for (const file of files) {
        form.append('files', new File([file.blob], file.name, { type: file.blob.type }));
        form.append('paths', file.name);
      }
      let response: Response;
      try {
        response = await fetchRequest(target, { body: form, method: 'POST', signal });
      } catch (error) {
        if (signal.aborted) throw error;
        reportError?.(error, 'upload');
        throw new FilesError('outcome-unknown', 'The upload could not reach StashBase.', {
          cause: error,
        });
      }
      let body: UploadResponseBody | null = null;
      try {
        body = (await response.json()) as UploadResponseBody;
      } catch {
        body = null;
      }
      if (response.status < 200 || response.status >= 300) {
        // Multipart cannot go through the JSON client, so the shared ladder is
        // applied here to the status the upload route answered with.
        const folderGone = body?.code === 'FOLDER_NOT_FOUND' || body?.code === 'NO_FOLDER';
        throw new FilesError(
          folderGone ? 'scope-lost' : classifyResponse({ body, status: response.status }),
          typeof body?.error === 'string' ? body.error : 'The upload failed.',
        );
      }
      try {
        return settledPaths(body, files.length);
      } catch (error) {
        reportError?.(error, 'upload');
        throw error;
      }
    },
  };
}
