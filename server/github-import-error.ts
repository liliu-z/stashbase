import type { GitHubImportErrorCode } from '../shared/protocols/http/github-import.ts';

export class GitHubImportError extends Error {
  retainedPath?: string;

  constructor(
    message: string,
    readonly code: Exclude<GitHubImportErrorCode, 'OUTCOME_UNKNOWN'>,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'GitHubImportError';
  }
}
