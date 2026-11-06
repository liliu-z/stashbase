import crypto from 'node:crypto';
import http from 'node:http';
import {
  AUTH_PATHS, AUTH_REQUEST_LIMIT, AUTH_RESPONSE_LIMIT, AUTH_TIMEOUT_MS,
  AUTH_BASE_URL, USAGE_RELAY_PATH, USAGE_REQUEST_LIMIT, authMethod, authNetworkError, usageBatchUrl,
  ALLOWANCE_RELAY_PATH, ALLOWANCE_API_URL, GALLERY_DOWNLOAD_RELAY_PATH, GALLERY_DOWNLOAD_API_URL,
} from '../../shared/hosted-auth-network.ts';
import destination from '../../server/telemetry-destination.json' with { type: 'json' };

/** A bounded, process-private relay to Chromium's system-proxy-aware session.
 * It carries hosted Auth, credit reads and usage batches to fixed destinations.
 * No renderer IPC, arbitrary destination, redirects, cookies or session storage. */
export async function createAuthNetworkBridge(options: { fetch: typeof fetch; usageUrl?: string | undefined }) {
  const token = crypto.randomBytes(32).toString('hex');
  const usageUrl = 'usageUrl' in options ? options.usageUrl : usageBatchUrl(destination);
  const pending = new Set<AbortController>();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const supplied = request.headers['x-stashbase-auth-network-token'];
    if (request.headers.origin || typeof supplied !== 'string' || !/^[0-9a-f]{64}$/.test(supplied)
      || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      response.writeHead(403).end();
      return;
    }
    const usage = request.url === USAGE_RELAY_PATH;
    const allowance = request.url === ALLOWANCE_RELAY_PATH;
    const gallery = request.url === GALLERY_DOWNLOAD_RELAY_PATH;
    if (request.method !== 'POST' || (request.url !== '/' && !usage && !allowance && !gallery) || (usage && !usageUrl)) {
      response.writeHead(404).end(); return;
    }
    if (pending.size >= 8) { response.writeHead(503).end(); return; }
    const controller = new AbortController();
    pending.add(controller);
    const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), AUTH_TIMEOUT_MS);
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', disconnect);
    const abort = () => { if (!response.writableEnded) response.destroy(); };
    // Also bound incomplete request bodies, before an upstream fetch exists.
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const limit = usage ? USAGE_REQUEST_LIMIT : AUTH_REQUEST_LIMIT;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > limit) { response.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let input;
      try { input = JSON.parse(raw); }
      catch { response.writeHead(400).end(); return; }
      let target: { url: string; init: RequestInit };
      if (gallery) {
        if (!input || typeof input.templateId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(input.templateId)
          || typeof input.operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.operationId)
          || Object.keys(input).some(key => key !== 'templateId' && key !== 'operationId')) {
          response.writeHead(400).end(); return;
        }
        target = { url: GALLERY_DOWNLOAD_API_URL, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw } };
      } else if (usage) {
        if (!input || typeof input !== 'object' || !Array.isArray(input.batch)) { response.writeHead(400).end(); return; }
        target = { url: usageUrl!, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw } };
      } else if (allowance) {
        if (!input || typeof input.accessToken !== 'string' || !input.accessToken || input.accessToken.length > 16_384
          || typeof input.clientVersion !== 'string' || !/^[\w.+-]{1,64}$/.test(input.clientVersion)
          || Object.keys(input).some(key => key !== 'accessToken' && key !== 'clientVersion')) {
          response.writeHead(400).end(); return;
        }
        target = { url: ALLOWANCE_API_URL, init: { method: 'GET', headers: {
          authorization: `Bearer ${input.accessToken}`,
          'x-stashbase-client-version': input.clientVersion,
          'cache-control': 'no-store',
        } } };
      } else {
        if (!input || !AUTH_PATHS.has(input.path)
          || (input.body !== undefined && typeof input.body !== 'string')
          || (input.accessToken !== undefined && (typeof input.accessToken !== 'string' || input.accessToken.length > 16_384))) {
          response.writeHead(400).end(); return;
        }
        target = { url: `${AUTH_BASE_URL}${input.path}`, init: {
          method: authMethod(input.path),
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {}),
          },
          ...(authMethod(input.path) === 'POST' ? { body: input.body } : {}),
        } };
      }
      controller.signal.removeEventListener('abort', abort);
      const upstream = await options.fetch(target.url, {
        ...target.init, credentials: 'omit', redirect: 'error', signal: controller.signal,
      });
      const reader = upstream.body?.getReader();
      const parts: Uint8Array[] = [];
      let length = 0;
      try {
        while (reader) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.length;
          if (length > AUTH_RESPONSE_LIMIT) throw Object.assign(new Error('Response too large'), { code: 'AUTH_RESPONSE_TOO_LARGE' });
          parts.push(next.value);
        }
      } finally { await reader?.cancel().catch(() => {}); }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        status: upstream.status, body: Buffer.concat(parts).toString('utf8'),
        contentType: upstream.headers.get('content-type')?.slice(0, 256),
        requestId: upstream.headers.get('x-request-id')?.slice(0, 256),
      }));
    } catch (error) {
      if (!response.destroyed) {
        const failure = authNetworkError(controller.signal.aborted ? controller.signal.reason : error);
        response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ errorCode: failure.code }));
      }
    } finally {
      clearTimeout(timeout);
      response.removeListener('close', disconnect);
      controller.signal.removeEventListener('abort', abort);
      pending.delete(controller);
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.requestTimeout = AUTH_TIMEOUT_MS;
  server.headersTimeout = AUTH_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing authentication relay address');
  return {
    port: address.port, token, usageUrl,
    cancelPending() { for (const controller of pending) controller.abort(); },
    close() {
      for (const controller of pending) controller.abort();
      server.closeAllConnections();
      server.close();
    },
  };
}
