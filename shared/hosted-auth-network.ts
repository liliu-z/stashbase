/** Private host/native transport. Never exposed through the renderer bridge. */
export const AUTH_BASE_URL = 'https://api.stashbase.ai/api/auth';
export const AUTH_REQUEST_LIMIT = 64 * 1024;
export const AUTH_RESPONSE_LIMIT = 1024 * 1024;
export const AUTH_TIMEOUT_MS = 10_000;
export const ALLOWANCE_RELAY_PATH = '/agent-usage';
export const ALLOWANCE_API_URL = 'https://api.stashbase.ai/v1/agent/usage?include=reservations';
export const AUTH_PATHS = new Set([
  '/electron/token', '/get-session', '/token', '/sign-out',
  '/email/send', '/desktop/email/verify', '/account/methods', '/account/otp/send',
  '/account/email/send', '/account/email/verify',
  '/account/google/link', '/account/google/unlink', '/account/link/status',
]);

/** Usage delivery shares the relay so analytics follow the system proxy too.
 * The relay owns the fixed ingestion destination; callers supply only a batch. */
export const USAGE_RELAY_PATH = '/usage';
export const USAGE_REQUEST_LIMIT = 4 * 1024 * 1024;

export function usageBatchUrl(destination: { projectToken: string; host: string }): string | undefined {
  return destination.projectToken.startsWith('phc_') && destination.host.startsWith('https://')
    ? `${destination.host.replace(/\/$/, '')}/batch/` : undefined;
}

export function authMethod(path: string): 'GET' | 'POST' {
  return path === '/get-session' || path === '/token' ? 'GET' : 'POST';
}

/** Only error codes cross the native boundary; raw transport messages can
 * contain URLs, proxy credentials or authentication payloads. */
export function authNetworkError(error: unknown): Error & { code: string } {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  function visit(value: unknown, depth = 0): void {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) return;
    seen.add(value);
    const item = value as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(item.code)) codes.push(item.code);
    if (typeof item.message === 'string') {
      const chromium = item.message.match(/\bnet::(ERR_[A-Z0-9_]+)\b/);
      if (chromium) codes.push(chromium[1]);
    }
    if (item.name === 'TimeoutError') codes.push('ETIMEDOUT');
    if (item.name === 'AbortError') codes.push('ABORT_ERR');
    visit(item.cause, depth + 1);
    if (Array.isArray(item.errors)) item.errors.slice(0, 4).forEach(cause => visit(cause, depth + 1));
  }
  visit(error);
  const code = codes.at(-1) ?? 'NETWORK_ERROR';
  let detail = 'The network request could not complete. Check your connection and system proxy.';
  if (/PROXY|TUNNEL/.test(code)) detail = 'The system proxy connection failed. Check that your proxy is running and allows the sign-in service.';
  else if (/ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED|DNS/.test(code)) detail = 'The sign-in server address could not be resolved. Check your DNS and system proxy.';
  else if (/CERT|SSL|TLS|VERIFY_LEAF|SELF_SIGNED/.test(code)) detail = 'The secure connection could not be verified. Check your system clock, certificates and proxy.';
  else if (/TIMEDOUT|TIMED_OUT|TIMEOUT/.test(code)) detail = 'The sign-in request timed out. Check your connection and system proxy, then start sign-in again.';
  else if (/RESET|CLOSED|SOCKET/.test(code)) detail = 'The connection was interrupted. Check your connection and system proxy, then start sign-in again.';
  else if (/REFUSED/.test(code)) detail = 'The connection was refused. Check your connection and system proxy.';
  else if (/UNREACH|DISCONNECTED/.test(code)) detail = 'The sign-in service is unreachable. Check your network connection and system proxy.';
  else if (code === 'ABORT_ERR') detail = 'The sign-in request was cancelled. Start sign-in again.';
  else if (code === 'AUTH_BRIDGE_UNAVAILABLE') detail = 'The desktop sign-in network service is unavailable. Restart StashBase and try again.';
  return Object.assign(new Error(`${detail} (${code})`), { code });
}
