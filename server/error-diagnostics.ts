import type { ErrorDiagnostic } from '../shared/protocols/http/telemetry.ts';

// Automatic reporting cannot distinguish an unquoted project/file name from an
// ordinary error sentence. Classify locally and emit only authored summaries;
// the original message remains in the local UI/logs for a reviewed bug report.
const CODES = new Set(`EACCES EPERM ENOENT ENOTDIR EISDIR ENOSPC EROFS EEXIST EBUSY EMFILE ENFILE EINVAL EPIPE ENOMEM EIO ENOTEMPTY EXDEV ECONNREFUSED ECONNRESET ECONNABORTED ENOTFOUND EAI_AGAIN ETIMEDOUT ENETUNREACH EHOSTUNREACH ERR_NETWORK ERR_FAILED ERR_CONNECTION_CLOSED ERR_CONNECTION_REFUSED ERR_INTERNET_DISCONNECTED ERR_CERT_AUTHORITY_INVALID CERT_HAS_EXPIRED DEPTH_ZERO_SELF_SIGNED_CERT UNABLE_TO_VERIFY_LEAF_SIGNATURE ERR_TLS_CERT_ALTNAME_INVALID UND_ERR_CONNECT_TIMEOUT UND_ERR_HEADERS_TIMEOUT UND_ERR_SOCKET SQLITE_BUSY SQLITE_LOCKED SQLITE_CORRUPT SQLITE_ERROR operation-failed runtime-unavailable account-required authentication-required authentication-check-failed unauthorized unavailable invalid-response fatal timeout scope-lost conflict rate-limit quota auth-expired network crash`.split(' '));
const NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'DOMException', 'TimeoutError', 'AbortError']);
const SUMMARIES: Array<[RegExp, string]> = [
  [/EACCES|EPERM|permission|access (?:is )?denied/i, 'Permission denied'],
  [/execution polic|running scripts is disabled/i, 'PowerShell execution policy blocked the installer'],
  [/ECONNREFUSED|connection refused/i, 'Connection refused'],
  [/ENOTFOUND|EAI_AGAIN|name resolution|getaddrinfo/i, 'DNS lookup failed'],
  [/certificate|TLS|SSL/i, 'TLS or certificate failure'],
  [/timed? ?out|ETIMEDOUT|UND_ERR_.*TIMEOUT/i, 'Operation timed out'],
  [/ECONNRESET|socket hang up|connection reset/i, 'Connection reset'],
  [/fetch failed|failed to fetch|network|ENETUNREACH|EHOSTUNREACH/i, 'Network request failed'],
  [/ENOSPC|disk full|no space left/i, 'Disk space exhausted'],
  [/ENOENT|not found|no such file|missing executable/i, 'Required resource not found'],
  [/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i, 'Database is locked'],
  [/SQLITE_CORRUPT|database.*corrupt/i, 'Database is corrupt'],
  [/rate.limit|too many requests|\b429\b/i, 'Rate limit exceeded'],
  [/quota|insufficient.credit/i, 'Account quota exhausted'],
  [/auth|sign.?in|log.?in|\b401\b|\b403\b/i, 'Authentication or authorization failed'],
  [/invalid.*(?:response|frame)|non-text frame|protocol/i, 'Invalid protocol response'],
  [/connection closed|disconnected/i, 'Connection closed unexpectedly'],
  [/installer|installation|install failed/i, 'Installer failed'],
  [/update/i, 'Update failed'],
  [/upload|attach/i, 'Upload failed'],
  [/preview|DOCX|convert/i, 'Document preview or conversion failed'],
  [/picker|folder dialog/i, 'Folder picker failed'],
  [/resource loading|decoding/i, 'Resource loading or decoding failed'],
];
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

function collectDiagnostic(error: unknown): ErrorDiagnostic {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let code: string | undefined;
  let exitCode: number | undefined;
  let status: number | undefined;
  function visit(value: unknown, depth: number): void {
    if (depth > 4 || seen.has(value) || seen.size >= 16) return;
    seen.add(value);
    if (typeof value === 'string') { messages.push(value.slice(0, 32_000)); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') messages.push(record.message.slice(0, 32_000));
    if (typeof record.code === 'string' && CODES.has(record.code)) code ??= record.code;
    exitCode ??= integer(record.exitCode ?? record.exit_code);
    status ??= integer(record.status ?? record.http_status);
    if (value instanceof AggregateError) for (const child of value.errors.slice(0, 8)) visit(child, depth + 1);
    visit(record.cause, depth + 1);
  }
  visit(error, 0);
  const input = messages.join('\n');
  code ??= input.match(/\b(?:E[A-Z_]+|UND_ERR_[A-Z_]+|SQLITE_[A-Z_]+)\b/g)?.find((value) => CODES.has(value));
  // Emit every recognized condition, including a nested network cause. Static
  // summaries make normalization idempotent at both capture entry points.
  const summaries = SUMMARIES.filter(([pattern, summary]) => pattern.test(`${code ?? ''}\n${input}`) || input.includes(summary)).map(([, summary]) => summary);
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  // Line/column locations identify a call in the versioned build. Neither source
  // paths nor function names (which may come from external code) leave the host.
  const stack = typeof record.stack === 'string' ? record.stack.slice(0, 32_000).split('\n')
    .filter((line) => /^\s*at\s/.test(line)).slice(0, 12)
    .flatMap((line) => { const location = /:(\d{1,9}):(\d{1,9})\)?\s*$/.exec(line); return location ? [`    at [frame]:${location[1]}:${location[2]}`] : []; }).join('\n') : '';
  return {
    message: summaries.join('; ') || 'Operation failed',
    ...(typeof record.name === 'string' && NAMES.has(record.name) ? { name: record.name } : {}),
    ...(code ? { code } : {}), ...(stack ? { stack } : {}),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(status !== undefined && status >= 400 && status <= 599 ? { http_status: status } : {}),
  };
}

export function errorDiagnostic(error: unknown): ErrorDiagnostic {
  try { return collectDiagnostic(error); }
  catch { return { message: 'Operation failed' }; }
}


const OPERATIONS = new Set(`render uncaught unhandled-rejection http-transport http-response startup native agent-connection folder-picker app-update upload attachment docx-preview pdf-preview resource workspace-session project-lifecycle mcp-connection install sync connection runtime skills steer`.split(' '));
const HTTP_FEATURES = new Set(`account agents agent asset asset-derived appearance attach embedder files folders gallery index-status mcp projects project search sync terminal keyword-search local-components turn-changes updates workspace-preferences upload other unhandled`.split(' '));
const LOG_SCOPES = new Set(`agent-model-catalog agent-process agent-projects agent-rules agent app-config codex-app-server codex-history codex-agent conversion derived-store docx file-save folder github-import hosted-agent-broker http renderer server index links mcp-http-service mfs opencode-runtime pdf project-file-mutations extractor-runtime rename routes/account routes/attach routes/embedder routes/folders routes/indexing mcp-http routes/project-files routes/folder routes/upload stale-lock state sync turn-changes`.split(' '));
export function diagnosticOperation(value: string): string {
  if (OPERATIONS.has(value)) return value;
  if (value.startsWith('http.') && HTTP_FEATURES.has(value.slice(5))) return value;
  if (value.startsWith('background.') && LOG_SCOPES.has(value.slice(11))) return value.replaceAll('/', '.');
  return 'other';
}
