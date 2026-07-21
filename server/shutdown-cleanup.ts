/** Failure-isolated server shutdown ladder. Every owner gets a cleanup attempt. */
export interface ShutdownCleanupOptions {
  closeMcp(): Promise<void>;
  cancelModelDownloads(): Promise<string[]>;
  cancelConversions(): Promise<string[]>;
  closeStateDb(): void;
  closeIndexer(): Promise<void>;
  onCancelled?(paths: string[]): void;
  onModelDownloadsCancelled?(ids: string[]): void;
  onError(step: 'mcp-http' | 'model-downloads' | 'conversions' | 'state-db' | 'indexer', error: unknown): void;
}

export async function runShutdownCleanup(options: ShutdownCleanupOptions): Promise<void> {
  try {
    await options.closeMcp();
  } catch (err: unknown) {
    options.onError('mcp-http', err);
  }

  try {
    const cancelled = await options.cancelModelDownloads();
    options.onModelDownloadsCancelled?.(cancelled);
  } catch (err: unknown) {
    options.onError('model-downloads', err);
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
