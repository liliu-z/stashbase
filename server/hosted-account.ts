import { telemetry } from './telemetry.ts';
import { errorDiagnostic } from './error-diagnostics.ts';
import packageJson from '../package.json' with { type: 'json' };
import crypto from 'node:crypto';
import type { HostedAccountState, HostedAgentAllowance, HostedBillingPlan, HostedBillingRedirect, HostedBillingStatus, HostedOAuthProvider, HostedOAuthPurpose, HostedOAuthStart, HostedOAuthStatus } from '../shared/account.ts';

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
  getHostedAccountSession,
  markAccountOfferSeen,
  pendingAccountOffers,
  setHostedAccountSession,
  type HostedAccountSession,
} from './app-config.ts';
import { normalizeHostedDisplayName, parseGoogleAvatarUrl } from './hosted-account-profile.ts';

export const STASHBASE_API_URL = 'https://api.stashbase.ai';
const SUPABASE_URL = 'https://vqtfigkoihpuziaimluf.supabase.co';
// Supabase publishable keys are intentionally safe to ship in clients. The
// project secret key remains server-only and must never enter this repository.
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_D-S7Ry-IWC9pTdDx6DHHHw_-mmaTp3b';
const CLIENT_VERSION = packageJson.version;

interface SupabaseUser {
  id?: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  identities?: Array<{ provider?: string; identity_data?: Record<string, unknown> }>;
}
interface SupabaseTokenResponse {
  code?: string;
  error_code?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  user?: SupabaseUser;
  error?: string;
  error_description?: string;
  msg?: string;
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
let tokenRefresh: { sessionKey: string; promise: Promise<string> } | null = null;
let profileHydration: { sessionKey: string; attemptedAt: number; promise: Promise<void> } | null = null;
const PROFILE_HYDRATION_RETRY_MS = 5 * 60 * 1000;
const PROFILE_TIMEOUT_MS = 3_000;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TIMEOUT_MS = 5_000;
const AVATAR_MAX_REDIRECTS = 2;
const AVATAR_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
let avatarCache: { key: string; contentType: string; bytes: Uint8Array } | null = null;

// Supabase's structured session errors, not message text or any generic 4xx:
// https://supabase.com/docs/guides/auth/debugging/error-codes
const INVALID_SESSION_CODES = new Set([
  'refresh_token_not_found', 'refresh_token_already_used', 'session_not_found',
  'session_expired', 'user_not_found', 'user_banned',
]);
class HostedAuthError extends Error {
  constructor(message: string, readonly invalidSession: boolean) { super(message); }
}

function messageOf(value: ErrorPayload | null, fallback: string): string {
  return value?.message ?? value?.error_description ?? value?.msg ?? value?.error ?? fallback;
}

async function jsonBody<T>(response: Response): Promise<T | null> {
  try { return await response.json() as T; } catch { return null; }
}

export function normalizedGoogleProfile(user: SupabaseUser | undefined): Pick<HostedAccountSession, 'displayName' | 'avatarUrl'> {
  const metadata = user?.user_metadata;
  const identity = user?.identities?.find((candidate) => candidate.provider === 'google')?.identity_data;
  const displayName = [metadata?.full_name, metadata?.name, identity?.full_name, identity?.name]
    .map(normalizeHostedDisplayName).find((value) => value !== undefined);
  const avatarUrl = [metadata?.avatar_url, metadata?.picture, identity?.avatar_url, identity?.picture]
    .map(parseGoogleAvatarUrl).find((value) => value !== undefined)?.toString();
  return {
    ...(displayName ? { displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

function sessionFrom(value: SupabaseTokenResponse, fallback?: HostedAccountSession): HostedAccountSession {
  const accessToken = value.access_token;
  const refreshToken = value.refresh_token ?? fallback?.refreshToken;
  const userId = value.user?.id ?? fallback?.userId;
  const email = value.user?.email ?? fallback?.email;
  const expiresAt = value.expires_at ?? (value.expires_in ? Math.floor(Date.now() / 1000) + value.expires_in : fallback?.expiresAt);
  if (!accessToken || !refreshToken || !userId || !email || !expiresAt) {
    throw new Error('Supabase returned an incomplete login session.');
  }
  const profile = normalizedGoogleProfile(value.user);
  return {
    accessToken, refreshToken, userId, email, expiresAt,
    ...(profile.displayName ? { displayName: profile.displayName } : fallback?.displayName ? { displayName: fallback.displayName } : {}),
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : fallback?.avatarUrl ? { avatarUrl: fallback.avatarUrl } : {}),
  };
}

async function supabaseAuth(path: string, body: Record<string, unknown>, accessToken?: string): Promise<SupabaseTokenResponse> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await jsonBody<SupabaseTokenResponse>(response);
  if (!response.ok) throw new HostedAuthError(
    messageOf(payload ?? null, `Supabase authentication failed (HTTP ${response.status}).`),
    response.status >= 400 && response.status < 500 && response.status !== 429
      && INVALID_SESSION_CODES.has(payload?.error_code ?? payload?.code ?? ''),
  );
  return payload ?? {};
}

async function supabaseUser(accessToken: string): Promise<SupabaseUser> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    const payload = await jsonBody<SupabaseUser & ErrorPayload>(response);
    if (!response.ok) throw new Error(messageOf(payload, `Supabase profile lookup failed (HTTP ${response.status}).`));
    return payload ?? {};
  } finally {
    clearTimeout(timeout);
  }
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
  const flowId = base64Url(crypto.randomBytes(24));
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const callback = new URL('/api/account/oauth/callback', origin);
  callback.searchParams.set('flow', flowId);

  pendingOAuthFlows.set(flowId, {
    provider,
    purpose,
    verifier,
    ...(windowId?.trim() ? { windowId: windowId.trim().slice(0, 128) } : {}),
    createdAt: Date.now(),
    state: 'pending',
  });

  const authorize = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  authorize.searchParams.set('provider', provider);
  authorize.searchParams.set('redirect_to', callback.toString());
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 's256');
  telemetry.capture({ event: 'account_login_started' });
  return { flowId, provider, purpose, url: authorize.toString() };
}

export function hostedOAuthPurpose(flowId: string): HostedOAuthPurpose | null {
  pruneOAuthFlows();
  return pendingOAuthFlows.get(flowId)?.purpose ?? null;
}

export async function exchangeHostedOAuthCode(flowId: string, authCode: string): Promise<HostedAccountSession> {
  pruneOAuthFlows();
  const flow = pendingOAuthFlows.get(flowId);
  if (!flow || flow.state !== 'pending') throw new Error(flow?.error ?? 'This sign-in request expired. Start again from StashBase.');
  if (!authCode.trim()) throw new Error('Supabase did not return an authorization code.');
  flow.state = 'exchanging';
  try {
    const payload = await supabaseAuth('/token?grant_type=pkce', {
      auth_code: authCode,
      code_verifier: flow.verifier,
    });
    pruneOAuthFlows();
    if (pendingOAuthFlows.get(flowId) !== flow || flow.state !== 'exchanging') {
      throw new Error(flow.error ?? 'This sign-in request expired. Start again from StashBase.');
    }
    const session = sessionFrom(payload);
    setHostedAccountSession(session);
    telemetry.identityChanged();
    // A completed sign-in answers the sign-in banner for good.
    markAccountOfferSeen('sign-in');
    flow.state = 'exchanged';
    return session;
  } catch (error: unknown) {
    failHostedOAuth(flowId, error instanceof Error ? error.message : String(error));
    throw error;
  }
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

export function failHostedOAuth(flowId: string, message: string): void {
  const flow = pendingOAuthFlows.get(flowId);
  if (!flow || flow.state === 'complete') return;
  if (flow.state !== 'error') {
    telemetry.capture({ event: 'account_login_result', outcome: 'failed' });
    telemetry.capture({ event: 'agent_setup_result', runtime: 'stashbase', stage: 'login', outcome: 'failed',
      diagnostic: errorDiagnostic(message) });
  }
  flow.state = 'error';
  flow.error = message;
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
  const session = getHostedAccountSession();
  if (!session) throw new Error('Sign in to StashBase to use the Default Agent and its free credits.');
  if (!options.forceRefresh && session.expiresAt > Math.floor(Date.now() / 1000) + 60) return session.accessToken;
  const sessionKey = `${session.userId}\0${session.refreshToken}\0${session.accessToken}`;
  if (tokenRefresh?.sessionKey === sessionKey) return tokenRefresh.promise;

  const promise = (async () => {
    try {
      const payload = await supabaseAuth('/token?grant_type=refresh_token', { refresh_token: session.refreshToken });
      const current = getHostedAccountSession();
      if (!current || `${current.userId}\0${current.refreshToken}\0${current.accessToken}` !== sessionKey) {
        throw new Error('The hosted account changed while its token was refreshing.');
      }
      const refreshed = sessionFrom(payload, session);
      setHostedAccountSession(refreshed);
      return refreshed.accessToken;
    } catch (error) {
      const current = getHostedAccountSession();
      if (error instanceof HostedAuthError && error.invalidSession
        && current && `${current.userId}\0${current.refreshToken}\0${current.accessToken}` === sessionKey) {
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
  try { await supabaseAuth('/logout?scope=local', {}, session.accessToken); } catch { /* local sign-out still succeeds */ }
}

async function hydrateHostedProfile(session: HostedAccountSession): Promise<void> {
  if (session.displayName && session.avatarUrl) return;
  const sessionKey = `${session.userId}\0${session.accessToken}`;
  const now = Date.now();
  if (profileHydration?.sessionKey === sessionKey) {
    if (now - profileHydration.attemptedAt < PROFILE_HYDRATION_RETRY_MS) return profileHydration.promise;
  }
  const promise = (async () => {
    const user = await supabaseUser(session.accessToken);
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
  options: { forceRefreshToken?: boolean } = {},
): Promise<HostedAgentAllowance> {
  const token = await hostedAccessToken({ forceRefresh: options.forceRefreshToken });
  const response = await fetch(`${STASHBASE_API_URL}/v1/agent/usage`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-stashbase-client-version': CLIENT_VERSION,
    },
  });
  const payload = await jsonBody<HostedAgentAllowance & ErrorPayload>(response);
  if (response.status === 401 && !options.forceRefreshToken) {
    return fetchHostedAgentAllowance({ forceRefreshToken: true });
  }
  if (!response.ok) throw new Error(messageOf(payload, `The Agent credits service failed (HTTP ${response.status}).`));
  return payload as HostedAgentAllowance;
}

// Billing pages are Stripe-hosted. Anything else in a billing answer is
// refused before it can reach the system browser.
const STRIPE_BILLING_HOSTS = new Set(['checkout.stripe.com', 'billing.stripe.com']);

export function stripeBillingUrl(value: unknown): string {
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
