/**
 * Loopback-only OpenAI-compatible model broker for the bundled Agent.
 *
 * OpenCode receives only a random process-local credential. The StashBase
 * account token is added here immediately before the request leaves the
 * machine, so neither the renderer nor OpenCode's config/history stores can
 * persist it. The hosted service remains the owner of model routing,
 * token accounting, and allowance enforcement.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  hostedAccessToken,
  stashbaseClientVersion,
  STASHBASE_API_URL,
} from './hosted-account.ts';
import { DEFAULT_HOSTED_AGENT_PROFILE } from './hosted-agent-models.ts';
import { logger } from './log.ts';
import { HostedAgentRequestDiagnostic } from './hosted-agent-diagnostics.ts';
import { modelStream, INTERRUPTED_MODEL_RESPONSE } from './hosted-agent-stream.ts';

const log = logger('hosted-agent-broker');
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const AGENT_GATEWAY_PATH = '/v1/agent/chat/completions';
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** The hosted model profile one turn runs on. `version` is the configuration
 * the reader was shown; without it the service runs the profile as it is now. */
export interface HostedAgentTurnModel {
  profile: string;
  version?: number;
}

/** Hosted refusals that a fresh model list resolves, and nothing else does.
 * Both leave as 422 so the native runtime's provider retry cannot repeat a
 * request the service will refuse again, and with one message each that the
 * turn-failure classifier recognizes. */
const MODEL_REFUSALS: Record<string, string> = {
  agent_model_configuration_changed:
    'The selected model configuration has changed. Refresh the models, then review and send again.',
  agent_model_unavailable:
    'The selected model is no longer available. Refresh the models and choose another one.',
};

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

function writeJson(response: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the socket alive long enough to return a useful upload refusal.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      throw Object.assign(new Error('This request exceeds the upload size limit. Start a new chat with fewer or smaller attachments.'), { status: 422 });
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  const parsed = JSON.parse(body.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('Agent model request must be a JSON object.'), { status: 400 });
  }
  // The bundled SDK emits OpenAI file parts. The current Gemini-compatible
  // gateway accepts inline PDFs through image_url instead (verified against
  // the hosted provider). Preserve the original bytes; no URL fetch or upload.
  // Other parts, tools, and provider options pass through untouched.
  const payload = parsed as { messages?: Array<{ role?: string; content?: unknown }> };
  let changed = false;
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
      message.content = message.content.map((part: unknown) => {
        if (!part || typeof part !== 'object') return part;
        const input = part as { type?: string; file?: { file_data?: unknown } };
        const data = input.file?.file_data;
        if (input.type !== 'file' || typeof data !== 'string' || !data.startsWith('data:application/pdf;base64,')) return part;
        changed = true;
        return { type: 'image_url', image_url: { url: data } };
      });
    }
  }
  if (changed) return Buffer.from(JSON.stringify(parsed));
  return body;
}

/** The validated provider request, including history and tool results. */
function hasMedia(body: Buffer): boolean {
  const payload = JSON.parse(body.toString('utf8')) as { messages?: Array<{ content?: unknown }> };
  return Array.isArray(payload.messages) && payload.messages.some(message =>
    Array.isArray(message?.content) && message.content.some((part: unknown) => {
      if (!part || typeof part !== 'object') return false;
      const type = (part as { type?: unknown }).type;
      return type === 'image_url' || type === 'file';
    }));
}

/** The text of a streamed completion, read whole. A stream error or an empty
 * answer fails with the caller's own error. */
function completionText(stream: string): string {
  let text = '';
  let done = false;
  let finish: string | undefined;
  for (const line of stream.split(/\r?\n/)) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data) continue;
    if (data === '[DONE]') { done = true; continue; }
    const chunk = JSON.parse(data) as { error?: { message?: string }; choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string | null }> };
    if (chunk.error) throw new Error(chunk.error.message ?? 'The agent model failed.');
    if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === 'string') text += content;
  }
  if (!text.trim()) throw new Error('The agent model returned an empty response.');
  if (!done || finish !== 'stop') throw new Error(finish === 'length'
    ? 'The model reached its output limit before finishing. Ask for a shorter passage and try again.'
    : 'The model response did not finish completely. Try again before using it as finished work.');
  return text;
}

export class HostedAgentBroker {
  private readonly permissionReviews = new Set<AbortController>();
  private server: http.Server | null = null;
  private startPromise: Promise<void> | null = null;
  private port = 0;
  private readonly channels = new Map<string, {
    agentSessionId: string;
    turnId: string | null;
    turnAbort: AbortController;
    model: HostedAgentTurnModel;
    diagnostic?: HostedAgentRequestDiagnostic;
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
          reject(new Error('Could not bind the hosted agent broker.'));
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
        model: { profile: DEFAULT_HOSTED_AGENT_PROFILE },
      });
    }
    return {
      apiKey,
      baseUrl: `http://127.0.0.1:${this.port}/v1`,
      model: DEFAULT_HOSTED_AGENT_PROFILE,
    };
  }

  /** Every model call until `endTurn` — tool continuations included — runs
   * on the model given here; a different choice waits for the next turn. */
  beginTurn(
    agentSessionId: string,
    turnId: string,
    model: HostedAgentTurnModel = { profile: DEFAULT_HOSTED_AGENT_PROFILE },
  ): void {
    const apiKey = this.channelBySession.get(agentSessionId);
    const channel = apiKey ? this.channels.get(apiKey) : undefined;
    if (!channel) throw new Error('The hosted agent broker channel is unavailable.');
    if (!UUID_PATTERN.test(turnId)) {
      throw new Error('The hosted agent turn id must be a valid UUID.');
    }
    channel.turnAbort.abort();
    channel.turnAbort = new AbortController();
    channel.turnId = turnId;
    delete channel.diagnostic;
    channel.model = { ...model };
  }

  /**
   * One model call on the main Agent's own profile, inside the session's
   * running turn and accounted under it (the Auto permission review). The
   * caller's signal gates dispatch and the approval decision, not an already
   * dispatched read-only classification. Drain that response under a bounded
   * lifetime so manual fallback does not turn successful work into unknown fees.
   * Returns the generated classification text.
   */
  async complete(
    agentSessionId: string,
    model: HostedAgentTurnModel,
    messages: ReadonlyArray<{ role: 'system' | 'user'; content: string }>,
    signal?: AbortSignal,
  ): Promise<string> {
    const apiKey = this.channelBySession.get(agentSessionId);
    const channel = apiKey ? this.channels.get(apiKey) : undefined;
    if (!channel?.turnId) throw new Error('The permission review is not bound to an active turn.');
    const turnId = channel.turnId;
    const admissionSignal = signal ? AbortSignal.any([signal, channel.turnAbort.signal]) : channel.turnAbort.signal;
    const lifetime = new AbortController();
    let callSignal: AbortSignal | undefined;
    const body = JSON.stringify({ model: model.profile, messages, stream: true, max_tokens: 256 });
    const idempotencyKey = crypto.randomUUID();
    let attempt = 0;
    const call = async (forceRefresh: boolean) => {
      const diagnostic = new HostedAgentRequestDiagnostic(idempotencyKey, ++attempt, { profile: model.profile, turnId });
      try {
        admissionSignal.throwIfAborted();
        lifetime.signal.throwIfAborted();
        const token = await this.dependencies.accessToken({ forceRefresh });
        admissionSignal.throwIfAborted();
        lifetime.signal.throwIfAborted();
        if (!callSignal) {
          callSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
          this.permissionReviews.add(lifetime);
        }
        return diagnostic.response(await this.dependencies.fetch(this.dependencies.upstreamUrl, {
          method: 'POST',
          headers: this.gatewayHeaders(token, {
            accept: 'text/event-stream', idempotencyKey, model, turnId,
          }),
          body,
          signal: callSignal,
        }));
      } catch (error) { if (!admissionSignal.aborted) diagnostic.fail(error); throw error; }
    };
    try {
      let upstream = await call(false);
      if (upstream.status === 401) {
        await upstream.body?.cancel();
        upstream = await call(true);
      }
      if (!upstream.ok) {
        const payload = await upstream.json().catch(() => null) as GatewayError | null;
        const code = payload?.error?.code ?? payload?.code;
        throw new Error((code && MODEL_REFUSALS[code])
          ?? payload?.error?.message ?? payload?.message ?? `The agent gateway failed (HTTP ${upstream.status}).`);
      }
      return completionText(await upstream.text());
    } finally {
      this.permissionReviews.delete(lifetime);
    }
  }

  private gatewayHeaders(
    token: string,
    call: { accept: string; idempotencyKey: string; model: HostedAgentTurnModel; turnId: string },
  ): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: call.accept,
      'idempotency-key': call.idempotencyKey,
      'x-stashbase-agent-turn-id': call.turnId,
      'x-stashbase-agent-profile': call.model.profile,
      ...(call.model.version === undefined ? {} : { 'x-stashbase-agent-profile-version': String(call.model.version) }),
      'x-stashbase-client-version': this.dependencies.clientVersion(),
    };
  }

  diagnostic(agentSessionId: string) {
    const key = this.channelBySession.get(agentSessionId);
    return key ? this.channels.get(key)?.diagnostic?.snapshot() : undefined;
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
    for (const review of this.permissionReviews) review.abort();
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
      writeJson(response, 409, { error: { message: 'The agent model call is not bound to an active turn.', code: 'agent_turn_required' } });
      return;
    }
    const turnId = channel.turnId;
    const model = channel.model;

    let diagnostic: HostedAgentRequestDiagnostic | undefined;
    let attempt = 0;
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
        diagnostic = new HostedAgentRequestDiagnostic(idempotencyKey, ++attempt, { profile: model.profile, turnId });
        channel.diagnostic = diagnostic;
        const token = await this.dependencies.accessToken({ forceRefresh });
        signal.throwIfAborted();
        const upstream = await this.dependencies.fetch(this.dependencies.upstreamUrl, {
          method: 'POST',
          headers: this.gatewayHeaders(token, {
            accept: request.headers.accept ?? 'text/event-stream, application/json',
            idempotencyKey, model, turnId,
          }),
          body,
          signal,
        });
        return diagnostic.response(upstream);
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
      let stream: Readable | 'empty' | 'interrupted' = 'empty';
      let interrupted = false;
      if (upstream.ok) {
        stream = await modelStream(upstream, signal);
        interrupted = stream === 'interrupted';
        if (typeof stream === 'string') {
          // A fresh model attempt has its own accounting identity, but keeps
          // this turn and the exact context (including completed tool results).
          log.warn(`${stream} model response; retrying the current model call once`);
          idempotencyKey = crypto.randomUUID();
          upstream = await authenticatedCall();
          if (upstream.ok) stream = await modelStream(upstream, signal);
          interrupted ||= stream === 'interrupted';
        }
      }
      if (!upstream.ok) {
        const payload = await upstream.json().catch(() => null) as GatewayError | null;
        const nested = payload?.error;
        const upstreamMessage = nested?.message ?? payload?.message ?? `The agent gateway failed (HTTP ${upstream.status}).`;
        const upstreamCode = nested?.code ?? payload?.code;
        diagnostic?.fail({ message: upstreamMessage, code: upstreamCode, status: upstream.status });
        // Native overflow compaction replaces image/PDF parts with filenames,
        // including files the model has never seen. Fail before that replay,
        // preserving the saved prompt and pausing the queue for user recovery.
        if (upstream.status === 413 && hasMedia(body)) {
          writeJson(response, 422, { error: {
            message: 'The model could not process this request with its attachments. Start a new chat with the files and a shorter prompt. This turn has stopped; its saved history is unchanged.',
            type: 'stashbase_hosted_error', code: 'agent_attachment_recovery_required',
          } });
          return;
        }
        const modelRefusal = upstreamCode ? MODEL_REFUSALS[upstreamCode] : undefined;
        if (modelRefusal) {
          writeJson(response, 422, { error: { message: modelRefusal, type: 'stashbase_hosted_error', code: upstreamCode } });
          return;
        }
        const allowanceMessage = upstreamCode === 'agent_allowance_reserved'
          ? 'Remaining agent credits cannot cover this request while some credits are reserved for active requests or fees awaiting confirmation. Check agent credits in Settings; wait for reservations to clear or try a shorter conversation.'
          : upstreamCode === 'agent_turn_budget_exhausted'
          ? 'This agent turn has insufficient spending budget for another model call.'
          : upstreamCode === 'agent_allowance_exhausted' || !upstreamCode
            ? 'Remaining agent credits cannot cover this request. Try a shorter conversation or wait for credits to refill.'
            : upstreamMessage;
        const retryAfter = upstream.status === 429 || upstream.status === 503
          ? upstream.headers.get('retry-after') : null;
        writeJson(response, upstream.status, {
          error: {
            message: upstream.status === 402
              ? allowanceMessage
              : upstreamMessage,
            type: 'stashbase_hosted_error',
            code: upstreamCode ?? (upstream.status === 402 ? 'agent_allowance_exhausted' : 'hosted_error'),
          },
        }, retryAfter ? { 'retry-after': retryAfter } : undefined);
        return;
      }

      if (typeof stream === 'string') {
        // 422 prevents the native runtime from adding another retry loop
        // after our bounded recovery. Do not resend the whole user turn.
        writeJson(response, 422, { error: interrupted ? INTERRUPTED_MODEL_RESPONSE : {
          message: 'The agent model returned an empty response twice. The task may be incomplete; completed file changes have been kept.',
          type: 'stashbase_hosted_error', code: 'agent_empty_response',
        } });
        return;
      }
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      await pipeline(stream, response, { signal });
    } catch (error) {
      // Keep the original socket/decoder cause before the native SDK reduces it
      // to an unknown finish. The request owns this trace across turn changes.
      if (!signal.aborted) diagnostic?.fail(error);
      throw error;
    } finally {
      signal.removeEventListener('abort', retire);
    }
  }
}

const broker = new HostedAgentBroker();

export const startHostedAgentBroker = (): Promise<void> => broker.start();
export const stopHostedAgentBroker = (): Promise<void> => broker.close();
export const hostedAgentRuntime = (agentSessionId?: string) => broker.runtime(agentSessionId);
export const beginHostedAgentTurn = (agentSessionId: string, turnId: string, model?: HostedAgentTurnModel) =>
  broker.beginTurn(agentSessionId, turnId, model);
export const completeHostedAgentModel = (...args: Parameters<HostedAgentBroker['complete']>) => broker.complete(...args);
export const hostedAgentDiagnostic = (agentSessionId: string) => broker.diagnostic(agentSessionId);
export const endHostedAgentTurn = (agentSessionId: string) => broker.endTurn(agentSessionId);
export const releaseHostedAgentChannel = (agentSessionId: string) => broker.releaseChannel(agentSessionId);
