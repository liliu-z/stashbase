/**
 * Transport-neutral failure from a Project Operation.
 *
 * Express turns this into its established JSON envelope; MCP adapters turn it
 * into a tool error. Keeping the semantic status/code together avoids making
 * each adapter rediscover project access and readiness failures.
 */
export class ProjectOperationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProjectOperationError';
  }
}

export function projectOperationError(message: string, status = 400, code?: string): ProjectOperationError {
  return new ProjectOperationError(message, status, code);
}
