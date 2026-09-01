import crypto from 'node:crypto';
import http from 'node:http';
import { getHostedAccountSession } from './app-config.ts';
import {
  cachedHostedQuota,
  hostedAccessToken,
  isHostedQuotaExhausted,
  rememberHostedQuota,
  stashbaseClientVersion,
  STASHBASE_API_URL,
  type HostedQuota,
} from './hosted-account.ts';
import { logger } from './log.ts';

const log = logger('hosted-embedding-broker');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

interface HostedEmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
  usage: { inputTokens: number };
  quota: HostedQuota;
}

interface ProviderError {
  code?: string;
  message?: string;
}

function writeJson(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('embedding request is too large'), { status: 413 });
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required');
  return parsed as Record<string, unknown>;
}

class HostedEmbeddingBroker {
  private server: http.Server | null = null;
  private startPromise: Promise<void> | null = null;
  private port = 0;
  private readonly secret = crypto.randomBytes(32).toString('base64url');

  async start(): Promise<void> {
    if (this.server) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handle(request, response).catch((error: unknown) => {
          const status = typeof (error as { status?: unknown })?.status === 'number'
            ? (error as { status: number }).status
            : 500;
          writeJson(response, status, {
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: 'stashbase_broker_error',
              code: 'broker_error',
            },
          });
        });
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Could not bind the hosted embedding broker.'));
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

  runtime(): { provider: 'stashbase'; apiKey: string; model: string; dimension: number; baseUrl: string } | null {
    if (!this.server || !getHostedAccountSession()) return null;
    return {
      provider: 'stashbase',
      apiKey: this.secret,
      model: 'text-embedding-3-small',
      dimension: 1536,
      baseUrl: `http://127.0.0.1:${this.port}/v1`,
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) return;
    server.closeIdleConnections();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::1') {
      writeJson(response, 403, { error: { message: 'loopback access only', code: 'forbidden' } });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/embeddings') {
      writeJson(response, 404, { error: { message: 'not found', code: 'not_found' } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.secret}`) {
      writeJson(response, 401, { error: { message: 'invalid broker credential', code: 'invalid_api_key' } });
      return;
    }
    if (isHostedQuotaExhausted()) {
      writeJson(response, 402, {
        error: {
          message: 'Hosted Similarity Search allowance is exhausted. Exact Search remains available.',
          type: 'stashbase_hosted_error',
          code: 'quota_exhausted',
        },
      });
      return;
    }
    const body = await readJson(request);
    const rawInput = body.input;
    const inputs = typeof rawInput === 'string' ? [rawInput] : rawInput;
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.some((item) => typeof item !== 'string' || !item)) {
      writeJson(response, 400, { error: { message: 'input must contain text', code: 'invalid_request' } });
      return;
    }
    const purpose = request.headers['x-stashbase-purpose'] === 'query' ? 'query' : 'index';
    const call = async (forceRefresh: boolean) => {
      const token = await hostedAccessToken({ forceRefresh });
      return fetch(`${STASHBASE_API_URL}/v1/embeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
          'x-stashbase-client-version': stashbaseClientVersion(),
        },
        body: JSON.stringify({ profile: 'stashbase-embedding-v1', purpose, inputs }),
      });
    };
    let upstream = await call(false);
    if (upstream.status === 401) upstream = await call(true);
    const payload = await upstream.json().catch(() => null) as HostedEmbeddingResponse | ProviderError | null;
    if (!upstream.ok) {
      const error = payload as ProviderError | null;
      if (upstream.status === 402) {
        const current = cachedHostedQuota();
        rememberHostedQuota(current ? {
          ...current,
          usedTokens: Math.max(current.usedTokens, current.grantedTokens),
          remainingTokens: 0,
        } : {
          plan: 'unknown',
          grantedTokens: 0,
          usedTokens: 0,
          reservedTokens: 0,
          remainingTokens: 0,
          periodStartedAt: null,
          periodEndsAt: null,
        });
      }
      writeJson(response, upstream.status, {
        error: {
          message: error?.message ?? `Hosted embedding request failed (HTTP ${upstream.status}).`,
          type: 'stashbase_hosted_error',
          code: error?.code ?? 'hosted_error',
        },
      });
      return;
    }
    const result = payload as HostedEmbeddingResponse;
    rememberHostedQuota(result.quota);
    writeJson(response, 200, {
      object: 'list',
      data: result.data.map((item) => ({ object: 'embedding', index: item.index, embedding: item.embedding })),
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: result.usage.inputTokens, total_tokens: result.usage.inputTokens },
    });
  }
}

const broker = new HostedEmbeddingBroker();

export const startHostedEmbeddingBroker = (): Promise<void> => broker.start();
export const stopHostedEmbeddingBroker = (): Promise<void> => broker.close();
export const hostedEmbeddingRuntime = () => broker.runtime();
