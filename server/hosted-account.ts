import { telemetry } from './telemetry.ts';
import { errorDiagnostic } from './error-diagnostics.ts';
import packageJson from '../package.json' with { type: 'json' };
import crypto from 'node:crypto';
import type { HostedBillingChange, HostedAccountState, HostedAgentAllowance, HostedBillingPlan, HostedBillingRedirect, HostedBillingStatus, HostedOAuthProvider, HostedOAuthPurpose, HostedOAuthStart, HostedOAuthStatus } from '../shared/account.ts';

export type {
  HostedAccountState,
  HostedAgentAllowance,
  HostedBillingPlan,
  HostedBillingRedirect,
  HostedBillingStatus,
  HostedOAuthProvider,
  HostedOAuthPurpose,
  HostedOAuthStart,
  HostedOAuthStatus,
} from '../shared/account.ts';
import {
  forgetAccountOfferSeen,
  getHostedAccountSession,
  markAccountOfferSeen,
  pendingAccountOffers,
  setHostedAccountSession,
  type HostedAccountSession,
} from './app-config.ts';
import { normalizeHostedDisplayName, parseGoogleAvatarUrl } from './hosted-account-profile.ts';
import { hostedAuthRequest, hostedAllowanceRequest } from './hosted-auth-transport.ts';
import { AUTH_BASE_URL } from '../shared/hosted-auth-network.ts';

export const STASHBASE_API_URL = 'https://api.stashbase.ai';
const CLIENT_VERSION = packageJson.version;

interface AuthUser {
  id?: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  image?: string;
}
interface AuthSessionResponse {
  session: { id: string; expiresAt: string };
  user: AuthUser;
}

interface ErrorPayload {
  code?: string;
  message?: string;
  error?: string;
  error_description?: string;
  msg?: string;
}

interface PendingOAuthFlow {
  provider: HostedOAuthProvider;
  purpose: HostedOAuthPurpose;
  verifier: string;
  windowId?: string;
  createdAt: number;
  state: 'pending' | 'exchanging' | 'exchanged' | 'complete' | 'error';
  error?: string;
  returnRequestedAt?: number;
  appReturnedAt?: number;
}

const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const pendingOAuthFlows = new Map<string, PendingOAuthFlow>();
let emailFlow: { id: string; email: string; expires: number } | null = null;
let tokenRefresh: { sessionKey: string; promise: Promise<string> } | null = null;
let profileHydration: { sessionKey: string; attemptedAt: number; promise: Promise<void> } | null = null;
const PROFILE_HYDRATION_RETRY_MS = 5 * 60 * 1000;
const PROFILE_TIMEOUT_MS = 3_000;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TIMEOUT_MS = 5_000;
const AVATAR_MAX_REDIRECTS = 2;
const AVATAR_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
let avatarCache: { key: string; contentType: string; bytes: Uint8Array } | null = null;

class HostedAuthError extends Error {
  constructor(message: string, readonly invalidSession: boolean) { super(message); }
}

export function isHostedSignInRequired(error: unknown): boolean {
  return error instanceof HostedAuthError && error.invalidSession;
}

function requireHostedAccountSession(): HostedAccountSession {
  const session = getHostedAccountSession();
  if (!session) throw new HostedAuthError('Sign in to StashBase to use the Default Agent and its free credits.', true);
  return session;
}

function messageOf(value: ErrorPayload | null, fallback: string): string {
  const messages: Record<string, string> = { otp_rate_limited: 'Wait a minute before requesting another code. You can request up to five codes per hour.', otp_invalid: 'The code is incorrect or expired. Request a new code.', otp_delivery_failed: 'The email could not be sent. Please try again later.', google_already_linked: 'Google is already connected.', auth_service_unavailable: 'The sign-in service is unavailable. Please try again later.' };
  return ((value?.code && messages[value.code]) || value?.message) ?? value?.error_description ?? value?.msg ?? value?.error ?? fallback;
}

async function jsonBody<T>(response: Response): Promise<T | null> {
  try { return await response.json() as T; } catch { return null; }
}

export function normalizedGoogleProfile(user: AuthUser | undefined): Pick<HostedAccountSession, 'displayName' | 'avatarUrl'> {
  const displayName = normalizeHostedDisplayName(user?.name);
  const avatarUrl = parseGoogleAvatarUrl(user?.image)?.toString();
  return { ...(displayName ? { displayName } : {}), ...(avatarUrl ? { avatarUrl } : {}) };
}

async function authRequest<T>(path: string, sessionToken?: string, body?: Record<string, unknown>, signal = AbortSignal.timeout(10_000)): Promise<T | null> {
  const response = await hostedAuthRequest(path, { body, accessToken: sessionToken, signal });
  const diagnostic = {
    http_status: response.status,
    content_type: response.headers.get('content-type') ?? undefined,
    request_id: response.headers.get('x-request-id') ?? undefined,
  };
  let payload: (T & ErrorPayload) | null;
  try { payload = await response.json() as (T & ErrorPayload) | null; } catch (error) {
    // JSON parser messages can contain upstream response bytes, including
    // credentials. Keep the failure type without retaining that body excerpt.
    const cause = error instanceof SyntaxError ? new SyntaxError('Invalid JSON in authentication response.') : error;
    throw Object.assign(new Error('The authentication service returned an unreadable response.', {
      cause: signal.aborted ? signal.reason : cause,
    }), diagnostic);
  }
  if (!response.ok) throw Object.assign(new HostedAuthError(
    messageOf(payload, `Account authentication failed (HTTP ${response.status}).`),
    response.status === 401,
  ), diagnostic);
  return payload;
}

async function readSession(sessionToken: string, signal: AbortSignal): Promise<AuthSessionResponse> {
  const value = await authRequest<AuthSessionResponse>('/get-session', sessionToken, undefined, signal);
  if (value === null) throw new HostedAuthError('Your session expired. Sign in again.', true);
  if (!value.session?.id || !value.user?.id || !value.user.email || value.user.emailVerified !== true
    || !(Date.parse(value.session.expiresAt) > Date.now())) throw new Error('The authentication service returned an incomplete session.');
  return value;
}

async function sessionFrom(sessionToken: string, fallback?: HostedAccountSession): Promise<HostedAccountSession> {
  const signal = AbortSignal.timeout(10_000);
  const value = await readSession(sessionToken, signal);
  if (fallback) {
    const current = requireHostedAccountSession();
    if (value.user.id !== fallback.userId || current.accessToken !== fallback.accessToken || current.sessionToken !== fallback.sessionToken) throw new Error('The hosted account changed while its token was refreshing.');
  }
  const result = await authRequest<{ token: string }>('/token', sessionToken, undefined, signal);
  // The API verifies signatures. Here we check the token's lifetime and binding
  // before caching it; decoding alone is never used to authorize an operation.
  let claims;
  try { claims = JSON.parse(Buffer.from(result?.token.split('.')[1] ?? '', 'base64url').toString()); } catch { /* rejected below */ }
  if (!result?.token || claims?.sub !== value.user.id || claims?.session_id !== value.session.id
    || !Number.isFinite(claims?.exp) || claims.exp <= Date.now() / 1000) throw new Error('The authentication service returned an invalid API token.');
  return {
    accessToken: result.token, sessionToken, expiresAt: claims.exp,
    userId: value.user.id!, email: value.user.email!,
    ...normalizedGoogleProfile(value.user),
  };
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function pruneOAuthFlows(now = Date.now()): void {
  for (const [flowId, flow] of pendingOAuthFlows) {
    if (now - flow.createdAt > OAUTH_FLOW_TTL_MS) pendingOAuthFlows.delete(flowId);
  }
}

function assertLoopbackCallbackOrigin(callbackOrigin: string): URL {
  const parsed = new URL(callbackOrigin);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('OAuth callback must use the local StashBase server.');
  }
  return parsed;
}

function retireOAuthFlows(message: string): void {
  emailFlow = null;
  for (const [id, flow] of pendingOAuthFlows) {
    if (flow.state !== 'complete' && flow.state !== 'error') failHostedOAuth(id, message);
  }
}

export function beginHostedOAuth(
  provider: HostedOAuthProvider,
  callbackOrigin: string,
  windowId?: string,
  purpose: HostedOAuthPurpose = 'account',
): HostedOAuthStart {
  pruneOAuthFlows();
  const origin = assertLoopbackCallbackOrigin(callbackOrigin);
  retireOAuthFlows('A newer sign-in request was started. Continue in the latest browser tab.');
  const flowId = crypto.randomBytes(32).toString('hex');
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const callback = new URL('/api/account/oauth/callback', origin);
  callback.hostname = '127.0.0.1';

  pendingOAuthFlows.set(flowId, {
    provider,
    purpose,
    verifier,
    ...(windowId?.trim() ? { windowId: windowId.trim().slice(0, 128) } : {}),
    createdAt: Date.now(),
    state: 'pending',
  });

  const authorize = new URL(`${AUTH_BASE_URL}/desktop/start`);
  authorize.searchParams.set('state', flowId);
  authorize.searchParams.set('challenge', challenge);
  authorize.searchParams.set('callback', callback.toString());
  telemetry.capture({ event: 'account_login_started' });
  return { flowId, provider, purpose, url: authorize.toString() };
}

export async function exchangeHostedOAuthCode(flowId: string, authCode: string): Promise<HostedAccountSession> {
  pruneOAuthFlows();
  const flow = pendingOAuthFlows.get(flowId);
  if (!flow || flow.state !== 'pending') throw new Error(flow?.error ?? 'This sign-in request expired. Start again from StashBase.');
  if (!authCode.trim()) throw new Error('The sign-in service did not return an authorization code.');
  flow.state = 'exchanging';
  try {
    const payload = await authRequest<{ token: string }>('/electron/token', undefined, {
      token: authCode, state: flowId,
      code_verifier: flow.verifier,
    });
    pruneOAuthFlows();
    if (pendingOAuthFlows.get(flowId) !== flow || flow.state !== 'exchanging') {
      throw new Error(flow.error ?? 'This sign-in request expired. Start again from StashBase.');
    }
    if (!payload?.token) throw new Error('The sign-in service returned no session.');
    const session = await sessionFrom(payload.token);
    pruneOAuthFlows();
    if (pendingOAuthFlows.get(flowId) !== flow || flow.state !== 'exchanging') {
      throw new Error(flow.error ?? 'This sign-in request expired. Start again from StashBase.');
    }
    setHostedAccountSession(session);
    telemetry.identityChanged();
    // A completed sign-in answers the sign-in banner for good.
    markAccountOfferSeen('sign-in');
    flow.state = 'exchanged';
    return session;
  } catch (error: unknown) {
    failHostedOAuth(flowId, error);
    throw error;
  }
}

/** Email proofs stay in the host; only profile state crosses to the renderer. */
export async function sendHostedEmail(email: string): Promise<{ flowId: string }> {
  if (getHostedAccountSession()) throw new Error('Sign out before signing in to another account.');
  retireOAuthFlows('A newer sign-in request was started.');
  const flow = { id: crypto.randomBytes(32).toString('hex'), email: email.trim().toLowerCase(), expires: Date.now() + 300_000 };
  emailFlow = flow;
  try {
    await authRequest('/email/send', undefined, { email: flow.email });
    if (emailFlow !== flow) throw new Error('This sign-in request was cancelled.');
    return { flowId: flow.id };
  } catch (error) { if (emailFlow === flow) emailFlow = null; throw error; }
}

export function cancelHostedEmail(flowId: string): void {
  if (emailFlow?.id === flowId) emailFlow = null;
}

export async function verifyHostedEmail(flowId: string, otp: string): Promise<HostedAccountState> {
  const flow = emailFlow;
  if (!flow || flow.id !== flowId || flow.expires <= Date.now()) throw new Error('This code expired. Request a new code.');
  const response = await authRequest<{ token: string }>('/desktop/email/verify', undefined, { email: flow.email, otp });
  if (!response?.token) throw new Error('The authentication service returned no session.');
  try {
    const session = await sessionFrom(response.token);
    if (emailFlow !== flow || getHostedAccountSession()) throw new Error('This sign-in request was cancelled.');
    setHostedAccountSession(session);
    emailFlow = null;
    telemetry.identityChanged();
    markAccountOfferSeen('sign-in');
    return hostedAccountState();
  } catch (error) {
    await authRequest('/sign-out', response.token, {}).catch(() => undefined);
    throw error;
  }
}

export async function hostedSignInMethods(): Promise<{ email: string; google: boolean }> {
  return accountOperation('/account/methods', {});
}

export async function accountOperation<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const session = getHostedAccountSession();
  if (!session?.sessionToken) throw new Error('Sign in again to manage your account.');
  const result = await authRequest<T>(path, session.sessionToken, body);
  if (getHostedAccountSession()?.sessionToken !== session.sessionToken) throw new Error('Your account changed. Try again.');
  if (!result) throw new Error('The authentication service returned no response.');
  return result;
}

export function finishHostedOAuth(flowId: string): void {
  const flow = pendingOAuthFlows.get(flowId);
  if (flow?.state === 'exchanged') {
    flow.state = 'complete';
    telemetry.capture({ event: 'account_login_result', outcome: 'success' });
    telemetry.capture({ event: 'agent_setup_result', runtime: 'stashbase', stage: 'login', outcome: 'success' });
  }
}

/** Give a callback that arrived without a usable OAuth flow its own bounded
 * status ticket. The fixed deep link still carries no data, while the browser
 * can prove a successful app return before closing. */
export function createFailedHostedOAuthFlow(message: string): string {
  pruneOAuthFlows();
  const flowId = base64Url(crypto.randomBytes(24));
  pendingOAuthFlows.set(flowId, {
    provider: 'google',
    purpose: 'account',
    verifier: base64Url(crypto.randomBytes(48)),
    createdAt: Date.now(),
    state: 'error',
    error: message,
  });
  return flowId;
}

export function noteHostedOAuthReturnIntent(flowId: string, now = Date.now()): boolean {
  pruneOAuthFlows(now);
  const flow = pendingOAuthFlows.get(flowId);
  if (!flow || (flow.state !== 'complete' && flow.state !== 'error')) return false;
  flow.returnRequestedAt = now;
  return true;
}

/** Electron calls this only after accepting the exact data-free deep link.
 * Callback pages poll their own flow state and close only after this proof,
 * never merely because the browser lost focus. */
export function noteHostedOAuthAppReturn(now = Date.now()): {
  acknowledged: boolean;
  windowId?: string;
} {
  pruneOAuthFlows(now);
  const candidates = [...pendingOAuthFlows.values()]
    .filter((flow) => (
      (flow.state === 'complete' || flow.state === 'error')
      && !flow.appReturnedAt
    ))
    .sort((left, right) => (
      (right.returnRequestedAt ?? right.createdAt) - (left.returnRequestedAt ?? left.createdAt)
    ));
  const flow = candidates.find((candidate) => candidate.returnRequestedAt) ?? candidates[0];
  if (!flow) return { acknowledged: false };
  flow.appReturnedAt = now;
  return {
    acknowledged: true,
    ...(flow.windowId ? { windowId: flow.windowId } : {}),
  };
}

export function failHostedOAuth(flowId: string, error: unknown): void {
  const flow = pendingOAuthFlows.get(flowId);
  if (!flow || flow.state === 'complete') return;
  if (flow.state !== 'error') {
    telemetry.capture({ event: 'account_login_result', outcome: 'failed' });
    telemetry.capture({ event: 'agent_setup_result', runtime: 'stashbase', stage: 'login', outcome: 'failed',
      diagnostic: errorDiagnostic(error) });
  }
  flow.state = 'error';
  flow.error = error instanceof Error ? error.message : String(error);
}

export function hostedOAuthStatus(flowId: string): HostedOAuthStatus {
  pruneOAuthFlows();
  const flow = pendingOAuthFlows.get(flowId);
  if (!flow) return { state: 'error', error: 'This sign-in request expired. Start again.' };
  if (flow.state === 'complete') return {
    state: 'complete',
    ...(flow.appReturnedAt ? { appReturned: true } : {}),
  };
  if (flow.state === 'error') return {
    state: 'error',
    error: flow.error ?? 'Sign-in failed.',
    ...(flow.appReturnedAt ? { appReturned: true } : {}),
  };
  return { state: 'pending' };
}

export async function hostedAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
  const session = requireHostedAccountSession();
  if (!options.forceRefresh && session.expiresAt > Math.floor(Date.now() / 1000) + 60) return session.accessToken;
  const sessionKey = `${session.userId}\0${session.sessionToken}\0${session.accessToken}`;
  if (tokenRefresh?.sessionKey === sessionKey) return tokenRefresh.promise;

  const promise = (async () => {
    try {
      const refreshed = await sessionFrom(session.sessionToken, session);
      const current = requireHostedAccountSession();
      if (`${current.userId}\0${current.sessionToken}\0${current.accessToken}` !== sessionKey) {
        throw new Error('The hosted account changed while its token was refreshing.');
      }
      setHostedAccountSession(refreshed);
      return refreshed.accessToken;
    } catch (error) {
      const current = getHostedAccountSession();
      if (error instanceof HostedAuthError && error.invalidSession
        && current && `${current.userId}\0${current.sessionToken}\0${current.accessToken}` === sessionKey) {
        setHostedAccountSession(undefined);
        telemetry.identityChanged();
      }
      throw error;
    }
  })();
  tokenRefresh = { sessionKey, promise };
  try {
    return await promise;
  } finally {
    if (tokenRefresh?.promise === promise) tokenRefresh = null;
  }
}

export async function signOutHostedAccount(): Promise<void> {
  const session = getHostedAccountSession();
  const record = telemetry.scoped();
  setHostedAccountSession(undefined);
  telemetry.identityChanged();
  if (session) record({ event: 'account_signed_out' });
  retireOAuthFlows('You signed out. Start a new sign-in from StashBase.');
  avatarCache = null;
  profileHydration = null;
  if (!session) return;
  // Signed out, the reader is back where the sign-in banner first found them,
  // so it shows again; a Not now from then on holds until the next sign-out.
  // A sign-out with no session is not one, and leaves a Not now standing.
  try { forgetAccountOfferSeen('sign-in'); } catch { /* the sign-out stands without the banner */ }
  try { await authRequest('/sign-out', session.sessionToken, {}); } catch { /* local sign-out still succeeds */ }
}

async function hydrateHostedProfile(session: HostedAccountSession): Promise<void> {
  if (session.displayName && session.avatarUrl) return;
  const sessionKey = `${session.userId}\0${session.accessToken}`;
  const now = Date.now();
  if (profileHydration?.sessionKey === sessionKey) {
    if (now - profileHydration.attemptedAt < PROFILE_HYDRATION_RETRY_MS) return profileHydration.promise;
  }
  const promise = (async () => {
    const { user } = await readSession(session.sessionToken, AbortSignal.timeout(PROFILE_TIMEOUT_MS));
    if (user.id !== session.userId) return;
    const profile = normalizedGoogleProfile(user);
    if (!profile.displayName && !profile.avatarUrl) return;
    const current = getHostedAccountSession();
    if (!current || current.userId !== session.userId || current.accessToken !== session.accessToken) return;
    setHostedAccountSession({
      ...current,
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
    });
  })();
  profileHydration = { sessionKey, attemptedAt: now, promise };
  return promise;
}

function assertAvatarUrl(value: string): URL {
  const url = parseGoogleAvatarUrl(value);
  if (!url) throw new Error('Account avatar URL is not allowed.');
  return url;
}

/** Fetch the signed-in account's provider avatar without exposing a general
 * URL proxy. Redirects stay on the exact allowlisted HTTPS host; bodies are
 * type-, time-, and size-bounded before entering the renderer boundary. */
export async function hostedAccountAvatar(): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  const session = getHostedAccountSession();
  if (!session?.avatarUrl) return null;
  const key = `${session.userId}\0${session.avatarUrl}`;
  if (avatarCache?.key === key) return { contentType: avatarCache.contentType, bytes: avatarCache.bytes };
  let url = assertAvatarUrl(session.avatarUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVATAR_TIMEOUT_MS);
  try {
    let response: Response | null = null;
    for (let redirects = 0; redirects <= AVATAR_MAX_REDIRECTS; redirects++) {
      response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'image/avif,image/webp,image/png,image/jpeg' },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects === AVATAR_MAX_REDIRECTS) throw new Error('Account avatar redirected too many times.');
      const location = response.headers.get('location');
      if (!location) throw new Error('Account avatar redirect was incomplete.');
      url = assertAvatarUrl(new URL(location, url).toString());
    }
    if (!response?.ok) throw new Error(`Account avatar failed (HTTP ${response?.status ?? 0}).`);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!AVATAR_CONTENT_TYPES.has(contentType)) throw new Error('Account avatar returned an unsupported content type.');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > AVATAR_MAX_BYTES) throw new Error('Account avatar is too large.');
    if (!response.body) throw new Error('Account avatar returned no content.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > AVATAR_MAX_BYTES) {
        await reader.cancel();
        throw new Error('Account avatar is too large.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    avatarCache = { key, contentType, bytes };
    return { contentType, bytes };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchHostedAgentAllowance(
  options: { forceRefreshToken?: boolean; signal?: AbortSignal } = {},
): Promise<HostedAgentAllowance> {
  // One budget covers headers, body and the existing one-time auth refresh.
  // A provider that sends headers and stalls must not leave credits pending.
  const signal = options.signal ?? AbortSignal.timeout(20_000);
  signal.throwIfAborted();
  // Refresh is shared with other callers. Stop this reader at its deadline
  // without cancelling their refresh or dispatching this reader's late request.
  const token = await new Promise<string>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    void hostedAccessToken({ forceRefresh: options.forceRefreshToken }).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
  const response = await hostedAllowanceRequest({ accessToken: token, clientVersion: CLIENT_VERSION, signal });
  const payload = await jsonBody<HostedAgentAllowance & ErrorPayload>(response);
  // jsonBody intentionally hides unreadable upstream bodies; cancellation is
  // not an unreadable success and must reach the route's recovery path.
  signal.throwIfAborted();
  if (response.status === 401 && !options.forceRefreshToken) {
    return fetchHostedAgentAllowance({ forceRefreshToken: true, signal });
  }
  if (!response.ok) throw Object.assign(new Error(messageOf(payload, `The agent credits service failed (HTTP ${response.status}).`)), {
    http_status: response.status,
    code: payload?.code,
    request_id: response.headers.get('x-request-id') ?? undefined,
    content_type: response.headers.get('content-type') ?? undefined,
  });
  return payload as HostedAgentAllowance;
}

// Billing pages are Stripe-hosted. Anything else in a billing answer is
// refused before it can reach the system browser.
const STRIPE_BILLING_HOSTS = new Set(['checkout.stripe.com', 'billing.stripe.com']);

function stripeBillingUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new Error('Billing returned an unexpected page.'); }
  if (url.protocol !== 'https:' || !STRIPE_BILLING_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error('Billing returned an unexpected page.');
  }
  return url.href;
}

/** One signed-in billing call. The desktop token stays in this process: the
 * renderer receives plans, status, or a Stripe page URL, never a credential. */
async function hostedBillingRequest<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  options: { forceRefreshToken?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const signal = options.signal ?? AbortSignal.timeout(20_000);
  const token = await hostedAccessToken({ forceRefresh: options.forceRefreshToken });
  signal.throwIfAborted();
  const response = await fetch(`${STASHBASE_API_URL}${path}`, {
    method: init.method,
    signal,
    headers: {
      authorization: `Bearer ${token}`,
      'x-stashbase-client-version': CLIENT_VERSION,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const payload = await jsonBody<T & ErrorPayload>(response);
  if (response.status === 401 && !options.forceRefreshToken) {
    return hostedBillingRequest(path, init, { forceRefreshToken: true, signal });
  }
  if (!response.ok) throw new Error(messageOf(payload, `Billing is temporarily unavailable (HTTP ${response.status}).`));
  return payload as T;
}

export async function fetchHostedBillingPlans(): Promise<HostedBillingPlan[]> {
  const response = await fetch(`${STASHBASE_API_URL}/v1/billing/plans`, {
    signal: AbortSignal.timeout(20_000),
    headers: { 'x-stashbase-client-version': CLIENT_VERSION },
  });
  const payload = await jsonBody<{ plans?: HostedBillingPlan[] } & ErrorPayload>(response);
  if (!response.ok || !Array.isArray(payload?.plans)) {
    throw new Error(messageOf(payload, `Billing is temporarily unavailable (HTTP ${response.status}).`));
  }
  return payload.plans;
}

export async function fetchHostedBillingStatus(): Promise<HostedBillingStatus> {
  const record = telemetry.scoped();
  const status = await hostedBillingRequest<HostedBillingStatus>('/v1/billing/status', { method: 'GET' });
  const key = status.plan?.planKey;
  record({ event: 'subscription_observed',
    plan: key === 'plus' || key === 'pro' ? key : status.plan ? 'other' : 'free',
    paid: Boolean(status.paidThrough && Date.parse(status.paidThrough) > Date.now()
      && ['active', 'past_due'].includes(status.status)),
    cancel_at_period_end: status.cancelAtPeriodEnd === true });
  return status;
}

export async function createHostedCheckout(priceId: string): Promise<HostedBillingRedirect> {
  const record = telemetry.scoped();
  try {
    const answer = await hostedBillingRequest<{ url?: unknown }>('/v1/billing/checkout', { method: 'POST', body: { priceId } });
    const url = stripeBillingUrl(answer.url);
    record({ event: 'billing_checkout_result', outcome: 'success' });
    return { url };
  } catch (error) {
    record({ event: 'billing_checkout_result', outcome: 'failed' });
    throw error;
  }
}

export async function changeHostedBilling(input: HostedBillingChange): Promise<{ changed: boolean }> {
  return hostedBillingRequest('/v1/billing/change', { method: 'POST', body: input });
}

export async function createHostedBillingPortal(): Promise<HostedBillingRedirect> {
  const record = telemetry.scoped();
  try {
    const answer = await hostedBillingRequest<{ url?: unknown }>('/v1/billing/portal', { method: 'POST' });
    const url = stripeBillingUrl(answer.url);
    record({ event: 'billing_portal_result', outcome: 'success' });
    return { url };
  } catch (error) {
    record({ event: 'billing_portal_result', outcome: 'failed' });
    throw error;
  }
}

export async function hostedAccountState(_refresh = false): Promise<HostedAccountState> {
  let session = getHostedAccountSession();
  const offers = pendingAccountOffers();
  if (!session) return { signedIn: false, offers };
  void hydrateHostedProfile(session).catch(() => { /* display-only profile data never gates account or local workflows */ });
  session = getHostedAccountSession() ?? session;
  return {
    signedIn: true,
    offers,
    email: session.email,
    ...(session.displayName ? { displayName: session.displayName } : {}),
    ...(session.avatarUrl ? { avatarUrl: '/api/account/avatar' } : {}),
  };
}

export function stashbaseClientVersion(): string {
  return CLIENT_VERSION;
}
