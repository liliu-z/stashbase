import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { diagnosticScope } from './diagnostic-context.ts';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { errorDiagnostic } from './error-diagnostics.ts';
import { telemetry } from './telemetry.ts';
import { setLogErrorReporter } from './log.ts';
import { AGENT_TOOL_RESULT_LIMIT, type ErrorContext, type AgentTurnStage, type AgentToolResult } from '../shared/protocols/http/telemetry.ts';
import { agentClientEventSchema, type AgentServerEvent } from '../shared/protocols/websocket/agent-session.ts';

/** One fixed feature name, never a dynamic route, query, body, or file path. */
const FEATURES = new Set(['account', 'agents', 'agent', 'project', 'upload', 'asset', 'asset-derived', 'appearance', 'attach', 'embedder', 'files',
  'folders', 'gallery', 'index-status', 'mcp', 'projects', 'search', 'sync', 'terminal',
  'keyword-search', 'local-components', 'turn-changes', 'updates', 'workspace-preferences']);

/** A refused request (4xx) is an expected outcome such as a save conflict or a
 * missing file; only a server failure (5xx) is an application error. */
function captureHttp(service: typeof telemetry, status: number, error: unknown, operation: string): void {
  if (status >= 500) service.captureError(error, { source: 'server', operation });
  else service.captureWarning(error, { source: 'server', operation });
}

export function httpErrorReporting(service = telemetry): RequestHandler {
  return (req, res, next) => {
    const asset = /^\/(asset|asset-derived)\//.exec(req.path)?.[1];
    const feature = asset ?? req.path.split('/')[2] ?? '';
    if ((!asset && !req.path.startsWith('/api/')) || feature === 'telemetry' || feature === 'log') { next(); return; }
    const turnId = req.header('x-stashbase-agent-turn-id');
    const scope = { request_id: randomUUID(), ...(turnId && validTurnId(turnId) ? { turn_id: turnId } : {}), context: { method: req.method, route: req.path } };
    res.setHeader('x-request-id', scope.request_id);
    // Asset/HEAD/stream handlers can finish without JSON; preserve their body
    // and status while recording the same bounded operation/status once.
    res.once('finish', () => {
      if (res.statusCode >= 400 && !res.locals?.diagnosticReported) {
        diagnosticScope.run(scope, () => captureHttp(service, res.statusCode, { message: 'HTTP request failed', status: res.statusCode },
          `http.${FEATURES.has(feature) ? feature : 'other'}`));
      }
    });
    const json = res.json;
    res.json = function (body: unknown) {
      if (res.statusCode >= 400 && !res.locals?.diagnosticReported) {
        res.locals.diagnosticReported = true;
        scope.context.route = typeof req.route?.path === 'string' ? req.route.path : req.path;
        const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
        captureHttp(service, res.statusCode, {
          message: typeof value.error === 'string' ? value.error : 'HTTP request failed',
          code: value.code ?? res.locals?.diagnosticError?.code, status: res.statusCode,
          ...(res.locals?.diagnosticError instanceof Error ? {
            stack: res.locals.diagnosticError.stack,
            cause: res.locals.diagnosticError,
          } : {}),
        }, `http.${FEATURES.has(feature) ? feature : 'other'}`);
      }
      return json.call(this, body);
    };
    diagnosticScope.run(scope, next);
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
const validTurnId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const agentStates = new WeakMap<object, { runtime?: NonNullable<ErrorContext['runtime']>; interrupted: boolean; closing: boolean; finished?: boolean; lastError?: string; stage?: AgentTurnStage; tools?: Map<string, AgentToolResult['category']>; completedTools?: Set<string> }>();
const agentCaptures = new WeakMap<object, ReturnType<typeof telemetry.scoped>>();
const agentProcessSnapshots = new WeakMap<object, () => NonNullable<ErrorContext['context']>>();
const agentDiagnostics = new WeakMap<object, Omit<ErrorContext, 'source' | 'operation' | 'runtime'>>();
/** Installed before runtime listeners; connection identity exists even if setup fails. */
export function attachAgentDiagnostics(connection: WebSocket, runtime: NonNullable<ErrorContext['runtime']>, connectionId?: string, windowId?: string): void {
  agentDiagnostics.set(connection, { context: { connection_id: connectionId && validTurnId(connectionId) ? connectionId : randomUUID(),
    ...(windowId && validTurnId(windowId) ? { window_id: windowId } : {}),
    ...(process.env.STASHBASE_SERVER_INSTANCE_ID && validTurnId(process.env.STASHBASE_SERVER_INSTANCE_ID)
      ? { host_instance_id: process.env.STASHBASE_SERVER_INSTANCE_ID } : {}) } });
  agentStates.set(connection, { runtime, interrupted: false, closing: false });
  agentCaptures.set(connection, telemetry.scoped());
  connection.on('message', (raw) => {
    try {
      const event = agentClientEventSchema.parse(JSON.parse(raw.toString()));
      const state = agentStates.get(connection)!;
      if (event.t === 'interrupt') state.interrupted = true;
      if (event.t === 'close') {
        state.closing = true;
        updateAgentDiagnosticContext(connection, { close_initiator: 'client', close_reason: 'client_close' });
      }
    } catch { /* Runtime validation owns invalid commands. */ }
  });
  connection.once('error', (error: NodeJS.ErrnoException) => updateAgentDiagnosticContext(connection, {
    close_initiator: 'unknown', close_reason: 'socket_error',
    ...(typeof error.code === 'string' ? { socket_error_code: error.code.slice(0, 160) } : {}),
    ...(Number.isSafeInteger(error.errno) ? { socket_error_errno: error.errno } : {}),
  }));
  connection.once('close', (code) => {
    updateAgentDiagnosticContext(connection, agentProcessSnapshots.get(connection)?.() ?? {});
    const details = agentDiagnostics.get(connection);
    const state = agentStates.get(connection);
    const intentional = state?.closing === true;
    const closedContext = { ...details?.context, ...(typeof code === 'number' ? { close_code: code } : {}),
      close_initiator: details?.context?.close_initiator ?? 'unknown' as const,
      close_reason: details?.context?.close_reason ?? 'socket_closed' as const };
    agentCaptures.get(connection)?.({ event: 'agent_connection_closed', runtime, ...details, context: closedContext });
    if (details?.turn_id && !state?.finished) {
      if (!intentional) agentCaptures.get(connection)?.({ event: 'application_error', source: 'agent', runtime,
        operation: 'connection', ...details, context: closedContext,
        diagnostic: { message: 'Agent WebSocket closed during an active turn', code: 'AGENT_CONNECTION_LOST' } });
      telemetry.observeTurn(details.turn_id, { outcome: intentional ? 'cancelled' : 'interrupted', reason: intentional ? 'session_closed' : 'connection_lost' });
    }
    agentProcessSnapshots.delete(connection);
    agentDiagnostics.delete(connection);
    agentCaptures.delete(connection);
    agentStates.delete(connection);
  });
}

/** Read pending method names at socket closure, before the runtime disposes RPCs. */
export function setAgentProcessSnapshot(connection: object, snapshot: () => NonNullable<ErrorContext['context']>): void {
  agentProcessSnapshots.set(connection, snapshot);
}

/** Process generation and closure evidence enrich the existing socket identity. */
export function updateAgentDiagnosticContext(connection: object, context: NonNullable<ErrorContext['context']>): void {
  const details = agentDiagnostics.get(connection);
  if (details) details.context = { ...details.context, ...context };
}

export function markAgentDiagnosticClosing(connection: object, reason: NonNullable<ErrorContext['context']>['close_reason']): void {
  const state = agentStates.get(connection);
  const details = agentDiagnostics.get(connection);
  // Runtime disposal also follows socket errors. Cleanup cannot turn that
  // observed transport failure into an intentional cancellation.
  if (details?.context?.close_reason === 'socket_error') return;
  if (state) state.closing = true;
  if (!details?.context?.close_reason) updateAgentDiagnosticContext(connection, { close_initiator: 'server', close_reason: reason });
}

export function agentDiagnosticStage(connection: object, stage: AgentTurnStage): void {
  const state = agentStates.get(connection);
  if (state?.stage === stage) return;
  if (state) state.stage = stage;
  const details = agentDiagnostics.get(connection);
  if (details) details.context = { ...details.context, stage };
  telemetry.observeTurn(details?.turn_id, { stage, ...(stage === 'host_accepted' && state?.runtime ? { runtime: state.runtime } : {}),
    ...(details?.context ? { context: details.context } : {}) });
}

export function beginAgentDiagnosticTurn(connection: object, turnId: string | undefined, context: NonNullable<ErrorContext['context']> = {}): void {
  agentCaptures.set(connection, telemetry.scoped());
  agentStates.set(connection, { runtime: agentStates.get(connection)?.runtime, interrupted: false, closing: false });
  const previous = agentDiagnostics.get(connection);
  agentDiagnostics.set(connection, {
    ...(turnId && validTurnId(turnId) ? { turn_id: turnId } : {}),
    context: { ...previous?.context, connection_id: previous?.context?.connection_id ?? randomUUID(), ...context },
  });
  agentDiagnosticStage(connection, 'host_accepted');
}

/** Only recognize an error prefix; never retain arbitrary tool output or paths. */
function toolFailureKind(content: string): NonNullable<NonNullable<ErrorContext['context']>['tool_failure_kind']> {
  // Codex MCP failures stringify a structured error. Inspect only its explicit
  // code/message, not result/content blocks that may contain source documents.
  if (content.trimStart().startsWith('{') && content.length <= 16_384) {
    try {
      const value = JSON.parse(content);
      const error = value?.error && typeof value.error === 'object' ? value.error : value;
      if (error && typeof error === 'object' && !Array.isArray(error)) {
        for (const field of ['code', 'message']) {
          if (typeof error[field] !== 'string') continue;
          const kind = toolFailurePrefix(error[field]);
          if (kind !== 'unknown') return kind;
        }
      }
    } catch { /* Unrecognized tool output retains the unknown category. */ }
  }
  return toolFailurePrefix(content);
}

function toolFailurePrefix(content: string): NonNullable<NonNullable<ErrorContext['context']>['tool_failure_kind']> {
  const prefix = content.slice(0, 256).trimStart().replace(/^Error:\s*/i, '');
  if (/^(ENOENT\b|file not found\b|no such file or directory\b)/i.test(prefix)) return 'not_found';
  if (/^(EACCES\b|EPERM\b|permission denied\b|access denied\b)/i.test(prefix)) return 'permission_denied';
  if (/^(invalid (arguments|parameters)\b|validation error\b)/i.test(prefix)) return 'invalid_arguments';
  if (/^(ETIMEDOUT\b|timeout\b|(?:operation|request|tool) timed out\b)/i.test(prefix)) return 'timeout';
  return 'unknown';
}

/** Native adapters expose both MCP names and display names. Classify only the
 * name; arguments, file paths and outputs never inform exported workload. */
function toolCategory(raw: string): AgentToolResult['category'] {
  const name = raw.replace(/^mcp__.+?__|^stashbase_/i, '').replace(/^.*:/, '');
  return /^(read|read_file|view_file|view_file_outline)$/i.test(name) ? 'read'
    : /^(write|edit|patch|apply_patch|multiedit|multi_edit|write_file|edit_file|file change|write_to_file|replace_file_content|multi_replace_file_content)$/i.test(name) ? 'write'
    : /^(bash|shell|run_command|command_status)$/i.test(name) ? 'shell'
    : /^(grep|glob|list|search|search_project|semantic_search|keyword_search|web[ _]?search|web[ _]?fetch|grep_search|find_by_name|list_dir|search_web|read_url_content)$/i.test(name) ? 'search'
    : /^(task|agent|spawn_agent)$/i.test(name) ? 'agent' : 'other';
}

export function reportAgentRuntimeError(runtime: NonNullable<ErrorContext['runtime']>, event: AgentServerEvent, connection?: object, cause?: unknown): void {
  if (connection && !agentDiagnostics.has(connection)) beginAgentDiagnosticTurn(connection, undefined);
  const context = connection ? agentDiagnostics.get(connection) ?? {} : {};
  const state = connection ? agentStates.get(connection) : undefined;
  if (connection) {
    if (event.t === 'tool' && !state?.completedTools?.has(event.id)) {
      agentDiagnosticStage(connection, 'tool_running');
      if (state) {
        state.tools ??= new Map();
        if (!state.tools.has(event.id) && state.tools.size >= AGENT_TOOL_RESULT_LIMIT) state.tools.delete(state.tools.keys().next().value!);
        state.tools.set(event.id, toolCategory(event.name));
      }
    }
    if (event.t === 'permission') agentDiagnosticStage(connection, 'waiting_permission');
    if (event.t === 'text' || event.t === 'thinking') agentDiagnosticStage(connection, 'response_started');
  }
  const capture = (error: unknown, details: ErrorContext) => {
    const scoped = connection ? agentCaptures.get(connection) : undefined;
    if (scoped) scoped({ event: 'application_error', ...details, diagnostic: errorDiagnostic(error) });
    else telemetry.captureError(error, details);
  };
  const duplicateToolResult = event.t === 'tool-result' && state?.completedTools?.has(event.id);
  if (event.t === 'tool-result' && !duplicateToolResult) {
    telemetry.observeTurn(context.turn_id, { tool_result: {
      call_id: event.id, category: state?.tools?.get(event.id) ?? 'other', outcome: event.isError ? 'failed' : 'success',
    } });
    if (state && event.id && event.id.length <= 512) {
      state.completedTools ??= new Set();
      if (state.completedTools.size >= AGENT_TOOL_RESULT_LIMIT) state.completedTools.delete(state.completedTools.values().next().value!);
      state.completedTools.add(event.id);
    }
  }
  if ((event.t === 'error' || event.t === 'exit') && 'message' in event && event.message) {
    // A runtime error can be immediately followed by an exit carrying that
    // same explanation for the UI. The first report owns its original cause.
    if (event.t !== 'exit' || state?.lastError !== event.message) {
      capture({ message: event.message, ...(cause ? { cause } : {}),
        ...(event.t === 'error' && event.failure ? { code: event.failure.kind } : {}),
      }, { ...context, source: 'agent', operation: event.t === 'exit' ? 'connection' : 'runtime', runtime });
    }
  } else if (event.t === 'tool-result' && event.isError && !duplicateToolResult) {
    // Tool output can contain source text. Export only fixed categories, never the matched text.
    capture({ message: 'Agent tool call failed', code: 'AGENT_TOOL_FAILED' }, { ...context,
      context: { ...context.context, tool_call_id: event.id, tool_category: state?.tools?.get(event.id) ?? 'other',
        tool_failure_kind: toolFailureKind(event.content) },
      source: 'agent', operation: 'tool', runtime });
  } else if (event.t === 'skills' && event.state === 'failed') {
    capture(event.error ?? 'Could not load agent skills', { ...context, source: 'agent', operation: 'skills', runtime });
  } else if (event.t === 'steer-result' && !event.ok) {
    capture(event.message ?? 'Could not steer agent', { ...context, source: 'agent', operation: 'steer', runtime });
  }
  if (state) state.lastError = event.t === 'error' ? event.message : undefined;
  if (event.t === 'tool-result') state?.tools?.delete(event.id);
  if (context.turn_id && (event.t === 'turn-end' || event.t === 'error' || event.t === 'exit')) {
    const cancelled = state?.interrupted || (event.t === 'exit' && 'reason' in event);
    const failed = event.t === 'error' || (event.t === 'turn-end' && event.isError) || (event.t === 'exit' && 'message' in event && Boolean(event.message));
    if (state) state.finished = true;
    telemetry.observeTurn(context.turn_id, {
      outcome: cancelled ? 'cancelled' : failed ? 'failed' : event.t === 'turn-end' ? 'success' : 'interrupted',
      reason: state?.interrupted ? 'user_cancelled' : event.t === 'exit' && 'reason' in event ? 'scope_removed'
        : failed ? 'runtime_error' : event.t === 'turn-end' ? 'completed' : 'connection_lost',
    });
    if (connection && (event.t === 'turn-end' || event.t === 'exit')) agentDiagnostics.set(connection, { context: context.context });
  }

}

export function installHostErrorReporting(service = telemetry): void {
  setLogErrorReporter((scope, args, level) => {
    if (scope === 'renderer') return; // Already collected by the renderer error sink.
    // Objects may be entire provider payloads. Keep Error values and sentences only.
    // A logged Error is classified alone: the surrounding sentence is a local
    // log template and must not decide the reported cause.
    const error = args.find((value) => value instanceof Error);
    const messages = args.filter((value): value is string => typeof value === 'string');
    const context = { source: 'server', operation: `background.${scope}`, context: { action: messages.join(' ').slice(0, 200) } } as const;
    if (level === 'warn') service.captureWarning(error ?? messages.join('\n'), context);
    else service.captureError(error ?? messages.join('\n'), context);
  });
  // Monitoring does not swallow an uncaught exception or change Node's exit policy.
  process.on('uncaughtExceptionMonitor', (error) => service.captureError(error, { source: 'server', operation: 'uncaught' }));
}
