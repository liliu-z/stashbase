/**
 * Tiny structured logger.
 *
 * Replaces scattered `console.log` calls with leveled output that
 * carries an ISO timestamp + a `[scope]` tag. Single-line per record
 * so the dev terminal stays scannable.
 *
 * Levels: debug / info / warn / error. `STASHBASE_LOG=debug` enables
 * the noisy level; anything else logs info+.
 *
 * Not a runtime dependency — just a `console.*` wrapper. We don't
 * need rotation, JSON, or filtering by scope for an MVP.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold: number = LEVELS[(process.env.STASHBASE_LOG as Level) ?? 'info'] ?? LEVELS.info;
let errorReporter: ((scope: string, args: unknown[]) => void) | undefined;

export function setLogErrorReporter(report: (scope: string, args: unknown[]) => void): void {
  errorReporter = report;
}

function emit(level: Level, scope: string, ...args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 23);   // HH:MM:SS.mmm
  // Always write to stderr. stdout is reserved for MCP stdio JSON-RPC —
  // any console.log in a module imported by mcp/server.ts corrupts the
  // protocol stream ("Unexpected non-whitespace character after JSON").
  // Web server logs are unaffected (terminals interleave stdout+stderr).
  console.error(`${ts} ${level.padEnd(5)} [${scope}]`, ...args);
  if (level === 'warn' || level === 'error') {
    try { errorReporter?.(scope, args); } catch { /* Logging never depends on reporting. */ }
  }
}

export function logger(scope: string) {
  return {
    debug: (...args: unknown[]) => emit('debug', scope, ...args),
    info:  (...args: unknown[]) => emit('info',  scope, ...args),
    warn:  (...args: unknown[]) => emit('warn',  scope, ...args),
    error: (...args: unknown[]) => emit('error', scope, ...args),
  };
}

/** Extract a printable message from any thrown value. Use after a
 *  `catch (err: unknown)` — TypeScript won't let you reach `.message`
 *  on `unknown` directly, and the `err instanceof Error ? ... : String(err)`
 *  idiom is verbose enough that callers reach for `any` instead. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Best-effort `.code` reader. Node ErrnoException, our `NO_FOLDER`
 *  wrapper, and Express decorate errors with a string `code` field;
 *  returns undefined for anything else. */
export function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}
