import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { agentProcessExitDiagnostic, retireAgentProcess } from './agent-process.ts';
import { diagnosticText } from '../shared/protocols/diagnostics.ts';

const OPEN_CODE_START_TIMEOUT_MS = 15_000;
type OpenCodeChild = ChildProcessByStdio<null, Readable, Readable>;

/** Only startup failures are safe to retry. Cleanup failure fences the owner;
 * no native session operation or model request is replayed here. */
export async function retryOpenCodeHistoryStartup<T>(
  start: (attempt: number) => Promise<T>,
  cancelled: () => boolean,
): Promise<T> {
  try { return await start(0); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (cancelled() || (code !== 'OPENCODE_START_TIMEOUT' && code !== 'AGENT_PROCESS_EXIT')) throw error;
    return start(1);
  }
}

/** Rejection is a retirement barrier, not just a signal sent to the process. */
export async function retireFailedOpenCode(child: OpenCodeChild, cause: unknown): Promise<never> {
  try { await retireAgentProcess(child, 'startup_failed'); }
  catch (cleanup) {
    throw Object.assign(new AggregateError([cause, cleanup], 'OpenCode failed to stop after startup failure.'), {
      code: 'OPENCODE_CLEANUP_FAILED',
    });
  }
  throw cause;
}

export function waitForOpenCodeServer(
  child: OpenCodeChild,
  expectedPort: number,
  exitDiagnostic: ReturnType<typeof agentProcessExitDiagnostic>,
  options: { timeoutMs?: number; onFirstOutput?: () => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outputSeen = false;
    let settled = false;
    const timeoutMs = options.timeoutMs ?? OPEN_CODE_START_TIMEOUT_MS;
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(Object.assign(error, {
        ...(stdout ? { stdout: diagnosticText(stdout) } : {}),
        ...(stderr ? { stderr: diagnosticText(stderr) } : {}),
      }));
      else resolve(url!);
    };
    const inspect = () => {
      if (!outputSeen) { outputSeen = true; options.onFirstOutput?.(); }
      // Only stdout carries the ready announcement. A native log that happens
      // to quote that sentence must not make a runtime ready.
      const match = stdout.match(/opencode server listening on (https?:\/\/[^\s]+)(?=\s)/);
      if (!match) return;
      try {
        const url = new URL(match[1]);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== expectedPort) {
          throw new Error('OpenCode bound an unexpected address.');
        }
        finish(undefined, url.toString().replace(/\/$/, ''));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    const onStdout = (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-8_000); inspect(); };
    const onStderr = (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8_000); inspect(); };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(exitDiagnostic(
      `OpenCode exited during startup (${code ?? signal ?? 'unknown'}).`, code, signal,
    ));
    const timeout = setTimeout(() => finish(Object.assign(new Error(`OpenCode did not start within ${timeoutMs}ms.`), {
      code: 'OPENCODE_START_TIMEOUT',
    })), timeoutMs);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}
