import { boundedDiagnosticContext, diagnosticContextSchema } from '../shared/protocols/http/telemetry.ts';
import type { RequestHandler } from 'express';
import { telemetry } from './telemetry.ts';
import { validHttpRequestId } from '../shared/protocols/http/request-diagnostics.ts';
import {
  prepareBugReportText,
  type PreparedBugReportText,
} from '../electron/bug-report-redaction.cjs';

const REDACTION_FAILURE_MESSAGE = 'client render error omitted: privacy scan failed';

type ClientErrorLogger = {
  warn(message: string): void;
};

type PrepareText = (input: unknown) => PreparedBugReportText;

function stringField(body: Record<string, unknown>, key: string, fallback = ''): string {
  return typeof body[key] === 'string' ? body[key] : fallback;
}

/**
 * Treat every renderer-supplied field as sensitive. This record lands in the
 * application log, which can later become a user-reviewed bug-report artifact.
 */
export function prepareClientErrorLog(
  input: unknown,
  {
    now = () => new Date(),
    prepareText = prepareBugReportText,
  }: {
    now?: () => Date;
    prepareText?: PrepareText;
  } = {},
): string {
  const body = input && typeof input === 'object'
    ? input as Record<string, unknown>
    : {};
  const message = stringField(body, 'message', '(no message)');
  const at = stringField(body, 'at', now().toISOString());
  const stack = stringField(body, 'stack');
  const componentStack = stringField(body, 'componentStack');
  const url = stringField(body, 'url');
  const raw =
    `client render error @ ${at} (${url}): ${message}`
    + (stack ? `\n${stack}` : '')
    + (componentStack ? `\nComponent stack:${componentStack}` : '');
  const prepared = prepareText(raw);

  return prepared.ok && typeof prepared.text === 'string'
    ? prepared.text
    : REDACTION_FAILURE_MESSAGE;
}

export function createClientErrorHandler(logger: ClientErrorLogger): RequestHandler {
  return (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const operation = ['render', 'uncaught', 'unhandled-rejection', 'http-transport', 'http-response', 'startup', 'native', 'agent-connection', 'folder-picker', 'app-update', 'upload', 'attachment', 'docx-preview', 'pdf-preview', 'resource', 'workspace-session', 'project-lifecycle'].includes(String(body.operation))
      ? String(body.operation) : 'render';
    const context = diagnosticContextSchema.safeParse(boundedDiagnosticContext(body.context));
    telemetry.captureError(body, { source: 'renderer', operation,
      ...(validHttpRequestId(body.request_id) ? { request_id: body.request_id } : {}),
      ...(context.success && context.data.turn_id ? { turn_id: context.data.turn_id } : {}), ...(context.success ? { context: context.data } : {}) });
    // Keep the existing local log sink. Automatic collection owns redaction
    // separately from a user-reviewed bug report.
    logger.warn(prepareClientErrorLog(req.body));
    res.json({ ok: true });
  };
}
