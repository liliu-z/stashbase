/** Failure-isolated server shutdown ladder. Every owner gets a cleanup attempt. */
export interface ShutdownCleanupOptions {
  closeSpeech?(): Promise<void>;
  closeMcp(): Promise<void>;
  cancelAgentInstalls(): Promise<string[]>;
  closeBundledAgent(): Promise<void>;
  cancelGitHubImports(): Promise<number>;
  cancelConversions(): Promise<string[]>;
  closeStateDb(): void;
  closeIndexer(): Promise<void>;
  onCancelled?(paths: string[]): void;
  onAgentInstallsCancelled?(ids: string[]): void;
  onGitHubImportsCancelled?(count: number): void;
  onError(step: 'speech' | 'mcp-http' | 'agent-installs' | 'bundled-agent' | 'github-imports' | 'conversions' | 'state-db' | 'indexer', error: unknown): void;
}

export async function runShutdownCleanup(options: ShutdownCleanupOptions): Promise<void> {
  try { await options.closeSpeech?.(); }
  catch (err: unknown) { options.onError('speech', err); }
  try {
    await options.closeMcp();
  } catch (err: unknown) {
    options.onError('mcp-http', err);
  }

  try {
    const cancelled = await options.cancelAgentInstalls();
    options.onAgentInstallsCancelled?.(cancelled);
  } catch (err: unknown) {
    options.onError('agent-installs', err);
  }

  try {
    await options.closeBundledAgent();
  } catch (err: unknown) {
    options.onError('bundled-agent', err);
  }

  try {
    const cancelled = await options.cancelGitHubImports();
    options.onGitHubImportsCancelled?.(cancelled);
  } catch (err: unknown) {
    options.onError('github-imports', err);
  }


  try {
    const cancelled = await options.cancelConversions();
    options.onCancelled?.(cancelled);
  } catch (err: unknown) {
    options.onError('conversions', err);
  }

  try {
    options.closeStateDb();
  } catch (err: unknown) {
    options.onError('state-db', err);
  }

  try {
    await options.closeIndexer();
  } catch (err: unknown) {
    options.onError('indexer', err);
  }
}
