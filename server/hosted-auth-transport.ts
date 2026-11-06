import http from 'node:http';
import {
  AUTH_PATHS, AUTH_REQUEST_LIMIT, AUTH_RESPONSE_LIMIT, AUTH_TIMEOUT_MS,
  AUTH_BASE_URL, USAGE_RELAY_PATH, USAGE_REQUEST_LIMIT, authMethod, authNetworkError,
  ALLOWANCE_RELAY_PATH, ALLOWANCE_API_URL, GALLERY_DOWNLOAD_RELAY_PATH, GALLERY_DOWNLOAD_API_URL,
} from '../shared/hosted-auth-network.ts';

type NativeBridge = { port?: string | undefined; token?: string | undefined; required: boolean };

/** Desktop builds send through the native relay; standalone Node development
 * has none and keeps direct fetch. A required relay never falls back. */
function relayAvailable(bridge: NativeBridge): boolean {
  if (!bridge.port && !bridge.token && !bridge.required) return false;
  const port = Number(bridge.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !bridge.token) throw { code: 'AUTH_BRIDGE_UNAVAILABLE' };
  return true;
}

/** Node HTTP keeps the loopback hop outside any ambient proxy. */
function relay(bridge: NativeBridge, path: string, body: string, signal: AbortSignal): Promise<Response> {
  const port = Number(bridge.port);
  return new Promise<Response>((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        'x-stashbase-auth-network-token': bridge.token },
      signal,
    }, response => {
      const parts: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        // The JSON envelope may escape every character in the upstream body.
        if (size > AUTH_RESPONSE_LIMIT * 6 + 1024) { request.destroy(); reject({ code: 'AUTH_RESPONSE_TOO_LARGE' }); }
        else parts.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200 && response.statusCode !== 502) throw { code: 'AUTH_BRIDGE_UNAVAILABLE' };
          const reply = JSON.parse(Buffer.concat(parts).toString('utf8'));
          if (response.statusCode === 502) throw { code: reply.errorCode };
          if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 || typeof reply.body !== 'string') throw { code: 'AUTH_BRIDGE_UNAVAILABLE' };
          const headers = new Headers();
          for (const [field, header] of [['contentType', 'content-type'], ['requestId', 'x-request-id']] as const) {
            if (reply[field] === undefined) continue;
            if (typeof reply[field] !== 'string' || reply[field].length > 256) throw { code: 'AUTH_BRIDGE_UNAVAILABLE' };
            headers.set(header, reply[field]);
          }
          resolve(new Response([204, 205, 304].includes(reply.status) ? null : reply.body, {
            status: reply.status, headers,
          }));
        } catch (error) { reject(error); }
      });
    });
    const timeout = setTimeout(() => request.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })), AUTH_TIMEOUT_MS + 1000);
    request.once('close', () => clearTimeout(timeout));
    request.once('error', reject);
    request.end(body);
  });
}

/** Desktop auth uses Chromium via a private loopback relay so it follows the
 * system proxy, including PAC. */
export function createHostedAuthRequest(bridge: NativeBridge) {
  return async function hostedAuthRequest(path: string, options: {
    body?: Record<string, unknown>; accessToken?: string; signal: AbortSignal;
  }): Promise<Response> {
    if (!AUTH_PATHS.has(path)) throw new Error('Unsupported authentication operation');
    try {
      if (!relayAvailable(bridge)) {
        return await fetch(`${AUTH_BASE_URL}${path}`, {
          method: authMethod(path),
          headers: { 'content-type': 'application/json',
            ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}) },
          ...(authMethod(path) === 'POST' && options.body ? { body: JSON.stringify(options.body) } : {}),
          signal: options.signal, redirect: 'error', credentials: 'omit',
        });
      }
      const body = JSON.stringify({ path, body: options.body ? JSON.stringify(options.body) : undefined, accessToken: options.accessToken });
      if (Buffer.byteLength(body) > AUTH_REQUEST_LIMIT) throw { code: 'AUTH_REQUEST_TOO_LARGE' };
      return await relay(bridge, '/', body, options.signal);
    } catch (error) {
      const detail = authNetworkError(options.signal.aborted ? options.signal.reason : error);
      const stage = path === '/electron/token' ? 'exchange the sign-in code' : path === '/token' ? 'refresh the sign-in session' : path === '/get-session' ? 'read the signed-in profile' : path === '/sign-out' ? 'sign out' : path === '/email/send' ? 'send an email code' : path === '/desktop/email/verify' ? 'verify the email code' : 'manage sign-in methods';
      throw Object.assign(new Error(`Could not ${stage} with ${new URL(AUTH_BASE_URL).hostname}. ${detail.message}`, { cause: detail }), { code: detail.code });
    }
  };
}

/** Usage delivery through the same proxy-aware relay. The relay chooses the
 * fixed ingestion URL; `url` is used only by standalone Node development. */
export function createHostedUsageFetch(bridge: NativeBridge): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (!relayAvailable(bridge)) return fetch(url, init);
    const body = typeof init?.body === 'string' ? init.body : '';
    if (Buffer.byteLength(body) > USAGE_REQUEST_LIMIT) throw { code: 'USAGE_REQUEST_TOO_LARGE' };
    return relay(bridge, String(url) === GALLERY_DOWNLOAD_API_URL ? GALLERY_DOWNLOAD_RELAY_PATH : USAGE_RELAY_PATH, body, init?.signal ?? AbortSignal.timeout(AUTH_TIMEOUT_MS + 1000));
  }) as typeof fetch;
}

/** Credits must follow the same system proxy as the sign-in that granted them.
 * The native hop accepts only a token/version for one fixed, read-only endpoint. */
export function createHostedAllowanceRequest(bridge: NativeBridge) {
  return async (options: { accessToken: string; clientVersion: string; signal: AbortSignal }): Promise<Response> => {
    try {
      if (!relayAvailable(bridge)) return await fetch(ALLOWANCE_API_URL, {
        signal: options.signal,
        headers: { authorization: `Bearer ${options.accessToken}`, 'x-stashbase-client-version': options.clientVersion },
        redirect: 'error', credentials: 'omit',
      });
      const body = JSON.stringify({ accessToken: options.accessToken, clientVersion: options.clientVersion });
      if (Buffer.byteLength(body) > AUTH_REQUEST_LIMIT) throw { code: 'AUTH_REQUEST_TOO_LARGE' };
      return await relay(bridge, ALLOWANCE_RELAY_PATH, body, options.signal);
    } catch (error) {
      // Keep original Node network causes in standalone development; native
      // errors have already crossed a boundary that admits only safe codes.
      if (options.signal.aborted) throw options.signal.reason;
      if (!bridge.required && !bridge.port && !bridge.token) throw error;
      const detail = authNetworkError(options.signal.aborted ? options.signal.reason : error);
      throw Object.assign(new Error(`Could not refresh Agent credits. Check your connection and system proxy. (${detail.code})`, { cause: detail }), { code: detail.code });
    }
  };
}

const nativeBridge: NativeBridge = {
  port: process.env.STASHBASE_AUTH_NETWORK_PORT,
  token: process.env.STASHBASE_AUTH_NETWORK_TOKEN,
  required: process.env.STASHBASE_PACKAGED === '1' || Boolean(process.env.STASHBASE_SERVER_INSTANCE_ID),
};
export const hostedAuthRequest = createHostedAuthRequest(nativeBridge);
export const hostedUsageFetch = createHostedUsageFetch(nativeBridge);
export const hostedAllowanceRequest = createHostedAllowanceRequest(nativeBridge);
// Do not pass the process-private capability to Agent or tool subprocesses.
delete process.env.STASHBASE_AUTH_NETWORK_PORT;
delete process.env.STASHBASE_AUTH_NETWORK_TOKEN;
