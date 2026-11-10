import type { GitHubImportErrorCode } from '../shared/protocols/http/github-import.ts';

export type GitHubImportStage = 'staging' | 'download' | 'extraction' | 'inspection' | 'publication' | 'registration';

export class GitHubImportError extends Error {
  retainedPath?: string;
  stage: GitHubImportStage | undefined;

  constructor(
    message: string,
    readonly code: Exclude<GitHubImportErrorCode, 'OUTCOME_UNKNOWN'>,
    readonly status = 400,
    options?: ErrorOptions & { stage?: GitHubImportStage },
  ) {
    super(message, options);
    this.name = 'GitHubImportError';
    this.stage = options?.stage;
  }
}
