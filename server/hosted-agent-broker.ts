/**
 * Loopback-only OpenAI-compatible model broker for the bundled Agent.
 *
 * OpenCode receives only a random process-local credential. The StashBase
 * account token is added here immediately before the request leaves the
 * machine, so neither the renderer nor OpenCode's config/history stores can
 * persist it. The hosted service remains the owner of Gemini routing,
 * token accounting, and allowance enforcement.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  hostedAccessToken,
  stashbaseClientVersion,
  STASHBASE_API_URL,
} from './hosted-account.ts';
import { logger } from './log.ts';

const log = logger('hosted-agent-broker');
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const AGENT_GATEWAY_PATH = '/v1/agent/chat/completions';
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_EMPTY_PREFIX_BYTES = 64 * 1024;

/** Hold only empty SSE framing before committing the downstream response.
 * Once any output (especially tool arguments) arrives, replay is forbidden.
 * Unknown extensions/errors pass through unchanged rather than being retried. */
async function modelStream(upstream: Response, signal: AbortSignal): Promise<Readable | null> {
  if (!upstream.body) return null;
  if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
    return Readable.fromWeb(upstream.body);
  }
  const reader = upstream.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let pending = '';
  let bytes = 0;
  let handedOff = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    signal.removeEventListener('abort', cancel);
    return cleanupPromise ??= reader.cancel().catch(() => {}).then(() => reader.releaseLock());
  };
  const emptyFrame = (frame: string): boolean => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n').trim();
    if (!data || data === '[DONE]') return true;
    try {
      const payload = JSON.parse(data);
      if (!payload || payload.error || !Array.isArray(payload.choices)) return false;
      return payload.choices.every((choice: { delta?: Record<string, unknown>; finish_reason?: string | null }) => {
        if (!choice || ![undefined, null, 'stop', 'unknown'].includes(choice.finish_reason)) return false;
        if (!choice.delta || typeof choice.delta !== 'object') return false;
        return Object.entries(choice.delta).every(([key, value]) =>
          key === 'role' || (key === 'content' && (value == null || (typeof value === 'string' && !value.trim()))));
      });
    } catch { return false; }
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (!next.done) {
        chunks.push(next.value);
        bytes += next.value.byteLength;
      }
      pending += decoder.decode(next.value, { stream: !next.done });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() ?? '';
      if (next.done && pending) frames.push(pending);
      if (frames.some(frame => !emptyFrame(frame))) {
        handedOff = true;
        const stream = Readable.from((async function* () {
          try {
            yield* chunks;
            while (!next.done) {
              signal.throwIfAborted();
              const chunk = await reader.read();
              if (chunk.done) break;
              yield chunk.value;
            }
          } finally {
            await cleanup();
          }
        })());
        // Also release a prefix whose consumer is cancelled before iteration.
        stream.once('close', () => { void cleanup(); });
        return stream;
      }
      if (bytes > MAX_EMPTY_PREFIX_BYTES) {
        throw Object.assign(new Error('The Agent model returned too much data without a reply.'), { status: 422 });
      }
      if (next.done) return null;
    }
  } finally {
    if (!handedOff) {
      await cleanup();
    }
  }
}

interface GatewayError {
  code?: string;
  message?: string;
  error?: { code?: string; message?: string };
}

export interface HostedAgentBrokerDependencies {
  accessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  upstreamUrl: string;
  clientVersion(): string;
}

function writeJson(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Agent model request is too large.'), { status: 413 });
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  const parsed = JSON.parse(body.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('Agent model request must be a JSON object.'), { status: 400 });
  }
  return body;
}

export class HostedAgentBroker {
  private server: http.Server | null = null;
  private startPromise: Promise<void> | null = null;
  private port = 0;
  private readonly channels = new Map<string, {
    agentSessionId: string;
    turnId: string | null;
    turnAbort: AbortController;
    profile: string;
  }>();
  private readonly channelBySession = new Map<string, string>();

  constructor(private readonly dependencies: HostedAgentBrokerDependencies = {
    accessToken: hostedAccessToken,
    fetch: globalThis.fetch,
    upstreamUrl: `${STASHBASE_API_URL}${AGENT_GATEWAY_PATH}`,
    clientVersion: stashbaseClientVersion,
  }) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handle(request, response).catch((error: unknown) => {
          // A streamed response may fail only after its headers reached
          // OpenCode (most commonly because the user interrupted the turn).
          // At that point an error body is no longer legal; close the local
          // leg and let OpenCode settle the interrupted request.
          if (response.headersSent || response.destroyed) {
            if (!response.destroyed) response.destroy();
            return;
          }
          const status = typeof (error as { status?: unknown })?.status === 'number'
            ? (error as { status: number }).status
            : 500;
          writeJson(response, status, {
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: 'stashbase_broker_error',
              code: status === 401 ? 'authentication_required' : 'broker_error',
            },
          });
        });
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Could not bind the hosted Agent broker.'));
          return;
        }
        this.server = server;
        this.port = address.port;
        log.info(`listening on 127.0.0.1:${this.port}`);
        resolve();
      });
    }).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  runtime(agentSessionId = 'history'): { apiKey: string; baseUrl: string; model: string } | null {
    if (!this.server) return null;
    let apiKey = this.channelBySession.get(agentSessionId);
    if (!apiKey) {
      apiKey = crypto.randomBytes(32).toString('base64url');
      this.channelBySession.set(agentSessionId, apiKey);
      this.channels.set(apiKey, {
        agentSessionId,
        turnId: null,
        turnAbort: new AbortController(),
        profile: 'stashbase-agent-default',
      });
    }
    return {
      apiKey,
      baseUrl: `http://127.0.0.1:${this.port}/v1`,
      model: 'stashbase-agent-default',
    };
  }

  beginTurn(agentSessionId: string, turnId: string, profile = 'stashbase-agent-default'): void {
    const apiKey = this.channelBySession.get(agentSessionId);
    const channel = apiKey ? this.channels.get(apiKey) : undefined;
    if (!channel) throw new Error('The hosted Agent broker channel is unavailable.');
    if (!UUID_PATTERN.test(turnId)) {
      throw new Error('The hosted Agent turn id must be a valid UUID.');
    }
    channel.turnAbort.abort();
    channel.turnAbort = new AbortController();
    channel.turnId = turnId;
    channel.profile = profile;
  }

  endTurn(agentSessionId: string): void {
    const apiKey = this.channelBySession.get(agentSessionId);
    const channel = apiKey ? this.channels.get(apiKey) : undefined;
    if (channel) {
      channel.turnId = null;
      channel.turnAbort.abort();
    }
  }

  releaseChannel(agentSessionId: string): void {
    const apiKey = this.channelBySession.get(agentSessionId);
    if (!apiKey) return;
    this.endTurn(agentSessionId);
    this.channelBySession.delete(agentSessionId);
    this.channels.delete(apiKey);
  }

  async close(): Promise<void> {
    // Shutdown can race the first Agent request while the loopback listener
    // is binding. Wait for that bounded operation so a late `listen`
    // callback cannot leave a broker alive after application shutdown.
    if (this.startPromise) await this.startPromise.catch(() => {});
    const server = this.server;
    this.server = null;
    this.port = 0;
    for (const channel of this.channels.values()) channel.turnAbort.abort();
    this.channels.clear();
    this.channelBySession.clear();
    if (!server) return;
    server.closeIdleConnections();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::1') {
      writeJson(response, 403, { error: { message: 'Loopback access only.', code: 'forbidden' } });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      writeJson(response, 404, { error: { message: 'Not found.', code: 'not_found' } });
      return;
    }
    const authorization = request.headers.authorization;
    const apiKey = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
    const channel = apiKey ? this.channels.get(apiKey) : undefined;
    if (!channel) {
      writeJson(response, 401, { error: { message: 'Invalid broker credential.', code: 'invalid_api_key' } });
      return;
    }
    if (!channel.turnId) {
      writeJson(response, 409, { error: { message: 'The Agent model call is not bound to an active turn.', code: 'agent_turn_required' } });
      return;
    }
    const turnId = channel.turnId;
    const profile = channel.profile;

    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, channel.turnAbort.signal]);
    const retire = () => response.destroy();
    signal.addEventListener('abort', retire, { once: true });
    request.once('aborted', () => abort.abort());
    response.once('close', () => {
      if (!response.writableEnded) abort.abort();
    });
    try {
      const body = await readBody(request);
      signal.throwIfAborted();
      let idempotencyKey = crypto.randomUUID();

      const call = async (forceRefresh: boolean) => {
        signal.throwIfAborted();
        const token = await this.dependencies.accessToken({ forceRefresh });
        signal.throwIfAborted();
        return this.dependencies.fetch(this.dependencies.upstreamUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: request.headers.accept ?? 'text/event-stream, application/json',
            'idempotency-key': idempotencyKey,
            'x-stashbase-agent-turn-id': turnId,
            'x-stashbase-agent-profile': profile,
            'x-stashbase-client-version': this.dependencies.clientVersion(),
          },
          body,
          signal,
        });
      };

      const authenticatedCall = async () => {
        let upstream = await call(false);
        if (upstream.status === 401) {
          await upstream.body?.cancel();
          upstream = await call(true);
        }
        return upstream;
      };
      let upstream = await authenticatedCall();
      let stream: Readable | null = null;
      if (upstream.ok) {
        stream = await modelStream(upstream, signal);
        if (!stream) {
          // A fresh model attempt has its own accounting identity, but keeps
          // this turn and the exact context (including completed tool results).
          log.warn('empty model response; retrying the current model call once');
          idempotencyKey = crypto.randomUUID();
          upstream = await authenticatedCall();
          if (upstream.ok) stream = await modelStream(upstream, signal);
        }
      }
      if (!upstream.ok) {
        const payload = await upstream.json().catch(() => null) as GatewayError | null;
        const nested = payload?.error;
        const upstreamMessage = nested?.message ?? payload?.message ?? `The Agent gateway failed (HTTP ${upstream.status}).`;
        const upstreamCode = nested?.code ?? payload?.code;
        const allowanceMessage = upstreamCode === 'agent_turn_budget_exhausted'
          ? `This Agent turn reached its spending limit. ${upstreamMessage}`
          : `Free Agent credits are exhausted. ${upstreamMessage}`;
        writeJson(response, upstream.status, {
          error: {
            message: upstream.status === 402
              ? allowanceMessage
              : upstreamMessage,
            type: 'stashbase_hosted_error',
            code: upstreamCode ?? (upstream.status === 402 ? 'agent_allowance_exhausted' : 'hosted_error'),
          },
        });
        return;
      }

      if (!stream) {
        // 422 prevents the native runtime from adding an unbounded retry loop
        // after our bounded recovery. Do not resend the whole user turn.
        writeJson(response, 422, { error: {
          message: 'The Agent model returned an empty response twice. The task may be incomplete; completed file changes have been kept.',
          type: 'stashbase_hosted_error', code: 'agent_empty_response',
        } });
        return;
      }
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      await pipeline(stream, response, { signal });
    } finally {
      signal.removeEventListener('abort', retire);
    }
  }
}

const broker = new HostedAgentBroker();

export const startHostedAgentBroker = (): Promise<void> => broker.start();
export const stopHostedAgentBroker = (): Promise<void> => broker.close();
export const hostedAgentRuntime = (agentSessionId?: string) => broker.runtime(agentSessionId);
export const beginHostedAgentTurn = (agentSessionId: string, turnId: string, profile?: string) =>
  broker.beginTurn(agentSessionId, turnId, profile);
export const endHostedAgentTurn = (agentSessionId: string) => broker.endTurn(agentSessionId);
export const releaseHostedAgentChannel = (agentSessionId: string) => broker.releaseChannel(agentSessionId);
