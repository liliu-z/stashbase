import { spawn } from 'node:child_process';
import { terminateExtractorTree, waitForExtractorTree } from './extractor-process.ts';

/** Bounded, cancellable CLI probes must never block the shared HTTP server. */
export async function probeAgentCommand(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; shell?: boolean },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      shell: options.shell,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const completion = waitForExtractorTree(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const abort = () => terminateExtractorTree(child);
    const timeout = setTimeout(() => {
      timedOut = true;
      abort();
    }, options.timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-4000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    void completion.then((status) => {
      cleanup();
      if (options.signal?.aborted) reject(new Error('Agent probe was cancelled.'));
      else if (timedOut) reject(new Error(`Agent probe timed out after ${options.timeoutMs}ms.`));
      else resolve({ status, stdout, stderr });
    }, (error) => { cleanup(); reject(error); });
  });
}
