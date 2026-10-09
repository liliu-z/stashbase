/**
 * The GitHub acquisition transport.
 *
 * Every refusal this route raises is one the reader can act on — a private or
 * missing repository, a destination already taken, an unsupported repository
 * shape — so the adapter maps the server's code to the sentence rather than
 * forwarding its prose. A code this build does not know falls back to the
 * ladder's own line instead of being guessed at.
 */
import { validateFolderName } from '@/contracts/folder-name';
import { parseGitHubRepositoryUrl } from '@/contracts/github-import';
import { ProjectImportError, type GitHubImportPort } from '@/features/workspace/application/ports';
import type { HttpClient } from '@/platform/http/client';
import {
  githubImportFailureSchema,
  githubImportRequestSchema,
  githubImportResultSchema,
  type GitHubImportErrorCode,
} from '@/protocols/http/github-import';

const REFUSALS: Readonly<Record<GitHubImportErrorCode, string>> = {
  DOWNLOAD_FAILED: 'That repository could not be downloaded. Check your connection and try again.',
  LOCAL_IMPORT_FAILED:
    'The local copy could not be saved or registered. Check destination permissions and disk space, then try again.',
  DESTINATION_EXISTS:
    'That destination already exists. Choose a different name, or open the existing folder. Its contents may be different from this repository.',
  INVALID_ARCHIVE: 'That repository snapshot contains invalid or unsupported files.',
  ARCHIVE_TOO_LARGE: 'That repository snapshot is too large to import.',
  IMPORT_CANCELLED: 'The import was cancelled. You can try again.',
  IMPORT_INCOMPLETE:
    'Some files were kept after the import failed. Inspect the retained folder, then choose a different name or remove it before retrying.',
  OUTCOME_UNKNOWN:
    'The import result could not be confirmed. Check again before starting another copy.',
  INVALID_FOLDER_NAME: 'That folder name cannot be used. Choose a different one.',
  INVALID_GITHUB_URL: 'Enter a complete https://github.com/<owner>/<repo> URL.',
  PRIVATE_OR_NOT_FOUND: 'That repository is private or does not exist.',
  UNSUPPORTED_LFS: 'Repositories that use Git LFS are not supported yet.',
  UNSUPPORTED_SUBMODULES: 'Repositories with submodules are not supported yet.',
};

export function createGitHubImportAdapter(client: HttpClient): GitHubImportPort {
  const receipts = new Map<string, string>();
  const unknown = () => new ProjectImportError(REFUSALS.OUTCOME_UNKNOWN, 'unknown');
  return {
    async home(signal) {
      const response = await client.request({ path: '/api/folder-home', signal });
      const parsed = githubImportResultSchema.safeParse(response.body);
      if (response.status !== 200 || !parsed.success)
        throw new ProjectImportError('The copy destination is unavailable.', 'refused');
      return parsed.data.path;
    },
    // The URL and destination-name rules are the server's own, mapped here
    // because this is the layer where a repository contract becomes feature
    // vocabulary. Refusing inline with a second approximation would let the
    // two drift; the server still parses both again, so this is feedback
    // rather than authority.
    folderNameIssue: (name) => validateFolderName(name),
    readUrl: (raw) => {
      const parsed = parseGitHubRepositoryUrl(raw);
      return parsed.ok
        ? { folderName: parsed.parsed.defaultFolderName, ok: true as const }
        : { message: parsed.message, ok: false as const };
    },
    async run(url, folderName, signal) {
      const input = githubImportRequestSchema.parse({ folderName, url });
      const key = JSON.stringify(input);
      const previous = receipts.get(key);
      const id = previous ?? crypto.randomUUID();
      receipts.set(key, id);
      const receiptPath = `/api/github/import/${id}`;
      const cancel = () => {
        void client.request({ path: receiptPath, method: 'DELETE' }).catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (signal.aborted) {
          cancel();
          throw unknown();
        }
        let response;
        try {
          response = await client.request(
            previous
              ? { path: receiptPath, signal }
              : {
                  path: '/api/github/import',
                  method: 'POST',
                  body: { ...input, operationId: id },
                  signal,
                },
          );
        } catch {
          // A lost response does not mean the server failed to publish. Recover
          // this exact receipt; never infer ownership from a destination name.
          if (signal.aborted) throw unknown();
          try {
            response = await client.request({ path: receiptPath, signal });
          } catch {
            throw unknown();
          }
        }
        if (response.status >= 200 && response.status < 300) {
          const parsed = githubImportResultSchema.safeParse(response.body);
          if (!parsed.success) throw unknown();
          receipts.delete(key);
          return parsed.data.path;
        }
        const failure = githubImportFailureSchema.safeParse(response.body);
        if (!failure.success || !failure.data.code || failure.data.code === 'OUTCOME_UNKNOWN')
          throw unknown();
        receipts.delete(key);
        const { code, destination, retainedPath } = failure.data;
        throw new ProjectImportError(
          code === 'DESTINATION_EXISTS' && destination?.directory === false
            ? 'A file already uses that destination. Choose a different folder name.'
            : REFUSALS[code],
          code === 'DESTINATION_EXISTS' ? 'conflict' : retainedPath ? 'retained' : 'refused',
          destination ?? null,
          retainedPath ?? null,
        );
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
  };
}
