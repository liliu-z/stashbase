import type { ErrorRequestHandler, RequestHandler } from 'express';
import { telemetry } from './telemetry.ts';
import { setLogErrorReporter } from './log.ts';
import type { ErrorContext } from '../shared/protocols/http/telemetry.ts';
import type { AgentServerEvent } from '../shared/protocols/websocket/agent-session.ts';

/** One fixed feature name, never a dynamic route, query, body, or file path. */
const FEATURES = new Set(['account', 'agents', 'agent', 'project', 'upload', 'asset', 'asset-derived', 'appearance', 'attach', 'embedder', 'files',
  'folders', 'gallery', 'index-status', 'mcp', 'projects', 'search', 'sync', 'terminal',
  'keyword-search', 'local-components', 'turn-changes', 'updates', 'workspace-preferences']);

export function httpErrorReporting(service = telemetry): RequestHandler {
  return (req, res, next) => {
    const asset = /^\/(asset|asset-derived)\//.exec(req.path)?.[1];
    const feature = asset ?? req.path.split('/')[2] ?? '';
    if ((!asset && !req.path.startsWith('/api/')) || feature === 'telemetry' || feature === 'log') { next(); return; }
    // Asset/HEAD/stream handlers can finish without JSON; preserve their body
    // and status while recording the same bounded operation/status once.
    res.once('finish', () => {
      if (res.statusCode >= 400 && !res.locals?.diagnosticReported) {
        service.captureError({ message: 'HTTP request failed', status: res.statusCode },
          { source: 'server', operation: `http.${FEATURES.has(feature) ? feature : 'other'}` });
      }
    });
    const json = res.json;
    res.json = function (body: unknown) {
      if (res.statusCode >= 400 && !res.locals?.diagnosticReported) {
        res.locals.diagnosticReported = true;
        const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
        service.captureError({
          message: typeof value.error === 'string' ? value.error : 'HTTP request failed',
          code: value.code, status: res.statusCode,
          ...(res.locals?.diagnosticError instanceof Error ? {
            stack: res.locals.diagnosticError.stack,
            cause: res.locals.diagnosticError,
          } : {}),
        }, { source: 'server', operation: `http.${FEATURES.has(feature) ? feature : 'other'}` });
      }
      return json.call(this, body);
    };
    next();
  };
}

export const unhandledHttpError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  telemetry.captureError(error, { source: 'server', operation: 'http.unhandled' });
  if (res.headersSent) { _next(error); return; }
  res.locals.diagnosticReported = true;
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  res.status(typeof status === 'number' && status >= 400 && status <= 599 ? status : 500)
    .json({ error: error instanceof Error ? error.message : 'The request failed.' });
};

/** Installation has its own terminal event. Runtime events carry only their
 * error sentence; tool inputs, outputs, prompts, and replies never enter here. */
export function reportAgentRuntimeError(runtime: NonNullable<ErrorContext['runtime']>, event: AgentServerEvent): void {
  if ((event.t === 'error' || event.t === 'exit') && 'message' in event && event.message) {
    telemetry.captureError({ message: event.message,
      ...(event.t === 'error' && event.failure ? { code: event.failure.kind } : {}),
    }, { source: 'agent', operation: event.t === 'exit' ? 'connection' : 'runtime', runtime });
  } else if (event.t === 'skills' && event.state === 'failed') {
    telemetry.captureError(event.error ?? 'Could not load Agent skills', { source: 'agent', operation: 'skills', runtime });
  } else if (event.t === 'steer-result' && !event.ok) {
    telemetry.captureError(event.message ?? 'Could not steer Agent', { source: 'agent', operation: 'steer', runtime });
  }
}

export function installHostErrorReporting(): void {
  setLogErrorReporter((scope, args) => {
    if (scope === 'renderer') return; // Already collected by the renderer error sink.
    // Objects may be entire provider payloads. Keep Error values and sentences only.
    const error = args.find((value) => value instanceof Error);
    const messages = args.filter((value): value is string => typeof value === 'string');
    telemetry.captureError(error ?? messages.join('\n'), { source: 'server', operation: `background.${scope}` });
  });
  // Monitoring does not swallow an uncaught exception or change Node's exit policy.
  process.on('uncaughtExceptionMonitor', (error) => telemetry.captureError(error, { source: 'server', operation: 'uncaught' }));
}
