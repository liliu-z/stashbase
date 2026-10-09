/**
 * The one place a refused HTTP call becomes a feature's own failure.
 *
 * Every adapter names the ladder it reports on, the sentences its kinds read
 * as, and the statuses only it can classify; everything else — the shared
 * status ladder, the server's own sentence, the schema check — happens here,
 * so no adapter invents its own idea of what a 404 means.
 */
import type { HttpClient, HttpRequest, HttpResponse } from '@/platform/http/client';
import type {
  FeatureError,
  FeatureErrorClass,
  TransportFailureKind,
} from '@/shared/domain/feature-error';

/** The `safeParse` surface every reviewed protocol schema exposes. Kept
 *  structural so the transport never depends on the validation project. */
export interface ResponseSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/** StashBase failure bodies all carry one sentence written for the reader. */
type FailureBodySchema = ResponseSchema<{ error: string }>;

/** One user-facing sentence per transport kind, overridable per call. */
type TransportMessages = Partial<Record<TransportFailureKind, string>>;

/** What the shared ladder made of a refusal, for adapters that add kinds. */
export interface TransportFailure {
  /** The kind the shared ladder would report for this status. */
  readonly kind: TransportFailureKind;
  readonly response: HttpResponse;
  /** The failure body's own sentence, when `failureSchema` accepted it. */
  readonly serverMessage: string | null;
}

export interface TransportOptions<Extra extends string = never> {
  /** The feature ladder a refusal is reported on. */
  readonly error: FeatureErrorClass<Extra>;
  /** First refusal on a non-2xx response; return null to fall through to the
   *  shared ladder. Adapters use it for the kinds only they can meet. */
  readonly failure?: ((failure: TransportFailure) => FeatureError<Extra> | null) | undefined;
  /** Reads the server's sentence out of a refusal body. It becomes the cause,
   *  and the message too when `serverMessage` is set. */
  readonly failureSchema?: FailureBodySchema | undefined;
  readonly messages?: TransportMessages | undefined;
  /** Surface the server's own sentence instead of the per-kind fallback. */
  readonly serverMessage?: boolean | undefined;
}

export interface TransportRequest<Extra extends string = never> extends TransportOptions<Extra> {
  readonly body?: unknown;
  readonly method?: HttpRequest['method'] | undefined;
  readonly path: string;
  readonly signal?: AbortSignal | undefined;
}

/** What one call names on top of its adapter's fixed ladder and sentences.
 *  `body` and `method` are absent for a plain GET rather than present and
 *  undefined, which is what `exactOptionalPropertyTypes` refuses. */
export interface TransportCall<Extra extends string = never> extends TransportOptions<Extra> {
  readonly body?: unknown;
  readonly method?: HttpRequest['method'] | undefined;
  readonly path: string;
  readonly signal: AbortSignal;
}

/** Builds one request's options, dropping the members the call did not name.
 *  Every adapter that shapes its requests through a local builder goes through
 *  here rather than restating the same conditional spread. */
export function requestOptions<Extra extends string = never>(
  call: TransportCall<Extra>,
): TransportRequest<Extra> {
  const { body, method, ...rest } = call;
  return {
    ...rest,
    ...(body === undefined ? {} : { body }),
    ...(method === undefined ? {} : { method }),
  };
}

const FALLBACK_MESSAGES: Record<TransportFailureKind, string> = {
  'invalid-response': 'StashBase returned an unexpected response.',
  'scope-lost': 'That folder is no longer available in this window.',
  unauthorized: 'This window can no longer perform that action.',
  unavailable: 'StashBase is unavailable.',
};

/** Maps a refused status onto the shared ladder: a lost folder grant
 *  (404/410/412), a withdrawn window grant (401/403), or an unreachable
 *  capability. Adapters that read a narrower ladder classify their own
 *  statuses through `failure` and let the rest land here. */
export function classifyResponse(response: HttpResponse): TransportFailureKind {
  if (response.status === 401 || response.status === 403) return 'unauthorized';
  if (response.status === 404 || response.status === 410 || response.status === 412) {
    return 'scope-lost';
  }
  return 'unavailable';
}

function messageFor(messages: TransportMessages | undefined, kind: TransportFailureKind): string {
  return messages?.[kind] ?? FALLBACK_MESSAGES[kind];
}

function serverSentence(schema: FailureBodySchema | undefined, body: unknown): string | null {
  if (!schema) return null;
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data.error : null;
}

/** Turns one refused response into the owning feature's error. */
export function transportError<Extra extends string = never>(
  response: HttpResponse,
  options: TransportOptions<Extra>,
): FeatureError<Extra> {
  const kind = classifyResponse(response);
  const serverMessage = serverSentence(options.failureSchema, response.body);
  const owned = options.failure?.({ kind, response, serverMessage });
  if (owned) return owned;
  const message =
    options.serverMessage === true && serverMessage !== null
      ? serverMessage
      : messageFor(options.messages, kind);
  return new options.error(
    kind,
    message,
    serverMessage === null ? undefined : { cause: new Error(serverMessage) },
  );
}

/** Reports an unreachable server on the owning feature's ladder. An abort the
 *  caller asked for stays the caller's own rejection. */
function unreachable<Extra extends string>(
  cause: unknown,
  options: TransportRequest<Extra>,
): unknown {
  if (options.signal?.aborted) return cause;
  return new options.error('unavailable', messageFor(options.messages, 'unavailable'), { cause });
}

/** Performs one call and classifies transport and refusal failure, leaving the
 *  success body to the caller. Use it when the success path needs more than a
 *  schema: response headers, or a body shape the adapter cross-checks. */
export async function send<Extra extends string = never>(
  client: HttpClient,
  options: TransportRequest<Extra>,
): Promise<HttpResponse> {
  const { body, method, path, signal } = options;
  let response: HttpResponse;
  try {
    response = await client.request({
      ...(body === undefined ? {} : { body }),
      ...(method === undefined ? {} : { method }),
      path,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    throw unreachable(cause, options);
  }
  if (response.status < 200 || response.status >= 300) throw transportError(response, options);
  return response;
}

/** The whole envelope: call, classify, validate. Every adapter that only needs
 *  a schema off a successful body goes through here. */
export async function request<T, Extra extends string = never>(
  client: HttpClient,
  options: TransportRequest<Extra> & { readonly schema: ResponseSchema<T> },
): Promise<T> {
  const response = await send(client, options);
  const parsed = options.schema.safeParse(response.body);
  if (!parsed.success) {
    const error = new options.error(
      'invalid-response',
      messageFor(options.messages, 'invalid-response'),
      undefined,
    );
    client.reportError?.(error, 'http-response');
    throw error;
  }
  return parsed.data;
}
