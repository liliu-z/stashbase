import { hostedBillingChangeRequestSchema } from '../../shared/protocols/http/agent-runtime.ts';
import express from 'express';
import { emailProofSchema, emailSendSchema, emailVerifySchema, emailCancelSchema, accountLinkActionSchema } from '../../shared/protocols/http/embedder.ts';
import { getHostedAccountSession, markAccountOfferSeen, resetAccountOffers } from '../app-config.ts';
import {
  assertHostedGeneration,
  beginHostedOAuth,
  sendHostedEmail, verifyHostedEmail, cancelHostedEmail, hostedSignInMethods, accountOperation,
  createFailedHostedOAuthFlow,
  createHostedBillingPortal,
  changeHostedBilling,
  exchangeHostedOAuthCode,
  failHostedOAuth,
  finishHostedOAuth,
  fetchHostedAgentAllowance,
  fetchHostedBillingPlans,
  fetchHostedBillingStatus,
  hostedAccountState,
  hostedAccountAvatar,
  isHostedSignInRequired,
  hostedOAuthStatus,
  noteHostedOAuthAppReturn,
  noteHostedOAuthReturnIntent,
  signOutHostedAccount,
  type HostedOAuthProvider,
  type HostedOAuthPurpose,
} from '../hosted-account.ts';
import { errorMessage, logger } from '../log.ts';
import { oauthResultPage } from '../oauth-result-page.ts';
import { processPrivateTokenMatches } from '../process-private-token.ts';
import { currentWindowId } from '../folder.ts';
import { stopAgentRuntime } from '../agent-contract.ts';
import { stopOpenCodeRuntime } from '../opencode-runtime.ts';
import { hostedAccountFailure, mountReferralRoutes } from './referrals.ts';
import { referralScopeSchema } from '../../shared/protocols/http/referrals.ts';
import { HostedApiError } from '../hosted-account.ts';

const log = logger('routes/account');
const OAUTH_PROVIDERS = new Set<HostedOAuthProvider>(['google']);
const OAUTH_PURPOSES = new Set<HostedOAuthPurpose>(['account']);
const OAUTH_RETURN_TOKEN_HEADER = 'x-stashbase-oauth-return-token';

interface AccountRouteOptions {
  appReturnToken: string;
}

function oauthProvider(value: unknown): HostedOAuthProvider | null {
  return typeof value === 'string' && OAUTH_PROVIDERS.has(value as HostedOAuthProvider)
    ? value as HostedOAuthProvider
    : null;
}

function oauthPurpose(value: unknown): HostedOAuthPurpose | null {
  return typeof value === 'string' && OAUTH_PURPOSES.has(value as HostedOAuthPurpose)
    ? value as HostedOAuthPurpose
    : null;
}

function callbackOrigin(req: express.Request): string {
  return new URL(`http://${req.get('host') ?? ''}`).origin;
}

function hostedServiceFailure(res: express.Response, error: unknown): void {
  if (error instanceof HostedApiError) return hostedAccountFailure(res, error);
  res.locals.diagnosticError = error;
  res.status(isHostedSignInRequired(error) ? 401 : 502).json({ error: errorMessage(error) });
}

function checkAccountGeneration(req: express.Request): void {
  if (req.query.generation === undefined) return;
  const input = referralScopeSchema.safeParse(req.query);
  if (!input.success) throw new HostedApiError(400, 'invalid_request');
  assertHostedGeneration(input.data.generation);
}

export function mount(app: express.Express, { appReturnToken }: AccountRouteOptions): void {
  app.get('/api/account', async (req, res) => {
    const refresh = req.query.refresh === '1';
    res.json(await hostedAccountState(refresh));
  });

  app.post('/api/account/offers/:offer/seen', async (req, res) => {
    const offer = req.params.offer;
    if (offer !== 'sign-in') return res.status(400).json({ error: 'Unknown offer.' });
    try {
      markAccountOfferSeen(offer);
      res.json(await hostedAccountState());
    } catch (error: unknown) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  // Developer tools use this to see first-launch banners again.
  app.delete('/api/account/offers', async (_req, res) => {
    try {
      resetAccountOffers();
      res.json(await hostedAccountState());
    } catch (error: unknown) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/account/avatar', async (_req, res) => {
    try {
      const avatar = await hostedAccountAvatar();
      if (!avatar) return res.status(404).end();
      res.setHeader('content-type', avatar.contentType);
      res.setHeader('cache-control', 'private, no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.end(Buffer.from(avatar.bytes));
    } catch {
      // Avatar display is optional. Fail closed to the renderer fallback
      // without exposing provider URLs or upstream diagnostics.
      res.status(404).end();
    }
  });

  app.get('/api/account/agent-usage', async (req, res) => {
    try {
      checkAccountGeneration(req);
      if (!getHostedAccountSession()) return res.status(401).json({ error: 'Sign in first.' });
      res.json(await fetchHostedAgentAllowance());
    } catch (error: unknown) {
      hostedServiceFailure(res, error);
    }
  });

  app.get('/api/account/billing/plans', async (_req, res) => {
    try {
      res.json({ plans: await fetchHostedBillingPlans() });
    } catch (error: unknown) {
      hostedServiceFailure(res, error);
    }
  });

  app.get('/api/account/billing/status', async (req, res) => {
    try {
      checkAccountGeneration(req);
      if (!getHostedAccountSession()) return res.status(401).json({ error: 'Sign in first.' });
      res.json(await fetchHostedBillingStatus());
    } catch (error: unknown) {
      hostedServiceFailure(res, error);
    }
  });

  mountReferralRoutes(app);

  app.post('/api/account/billing/change', async (req, res) => {
    const input = hostedBillingChangeRequestSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Choose a valid subscription change.' });
    try {
      if (!getHostedAccountSession()) return res.status(401).json({ error: 'Sign in first.' });
      checkAccountGeneration(req);
      res.json(await changeHostedBilling(input.data));
    } catch (error: unknown) {
      hostedServiceFailure(res, error);
    }
  });

  app.post('/api/account/billing/portal', async (req, res) => {
    try {
      checkAccountGeneration(req);
      if (!getHostedAccountSession()) return res.status(401).json({ error: 'Sign in first.' });
      res.json(await createHostedBillingPortal());
    } catch (error: unknown) {
      hostedServiceFailure(res, error);
    }
  });

  app.post('/api/account/email/send', async (req, res) => {
    const input = emailSendSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Enter a valid email address.' });
    try { res.json(await sendHostedEmail(input.data.email)); }
    catch (error) { res.status(400).json({ error: errorMessage(error) }); }
  });
  app.post('/api/account/email/verify', async (req, res) => {
    const input = emailVerifySchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Enter the six-digit code.' });
    try { res.json(await verifyHostedEmail(input.data.flowId, input.data.otp)); }
    catch (error) { res.status(400).json({ error: errorMessage(error) }); }
  });
  app.post('/api/account/email/cancel', (req, res) => {
    const input = emailCancelSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid sign-in request.' });
    cancelHostedEmail(input.data.flowId); res.json({ success: true });
  });
  app.get('/api/account/methods', async (_req, res) => {
    try { res.json(await hostedSignInMethods()); }
    catch (error) { res.status(400).json({ error: errorMessage(error) }); }
  });
  app.post('/api/account/email-proof', async (req, res) => {
    const input = emailProofSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid email verification request.' });
    try { res.json(await accountOperation(`/account/email/${input.data.action}`, input.data)); }
    catch (error) { res.status(400).json({ error: errorMessage(error) }); }
  });
  app.post('/api/account/link', async (req, res) => {
    const input = accountLinkActionSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid account request.' });
    const paths = { send: '/account/otp/send', link: '/account/google/link', unlink: '/account/google/unlink', status: '/account/link/status' };
    try { res.json(await accountOperation(paths[input.data.action], input.data)); }
    catch (error) { res.status(400).json({ error: errorMessage(error) }); }
  });

  app.post('/api/account/oauth/start', (req, res) => {
    try {
      const provider = oauthProvider(req.body?.provider ?? 'google');
      if (!provider) return res.status(400).json({ error: 'Unsupported sign-in provider.' });
      const purpose = oauthPurpose(req.body?.purpose ?? 'account');
      if (!purpose) return res.status(400).json({ error: 'Unsupported sign-in purpose.' });
      res.json(beginHostedOAuth(provider, callbackOrigin(req), currentWindowId(), purpose));
    } catch (error: unknown) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/account/oauth/callback', async (req, res) => {
    const flowId = typeof req.query.state === 'string' ? req.query.state : '';
    const authCode = typeof req.query.code === 'string' ? req.query.code : '';
    const providerError = typeof req.query.error_description === 'string'
      ? req.query.error_description
      : typeof req.query.error === 'string' ? req.query.error : '';
    if (!flowId) {
      const message = 'The sign-in request is missing or expired. Return to StashBase and try again.';
      const failedFlowId = createFailedHostedOAuthFlow(message);
      return res.status(400).type('html').send(oauthResultPage({
        title: 'Sign-in failed',
        message,
        kind: 'error',
        returnStatusUrl: `/api/account/oauth/status?flow=${encodeURIComponent(failedFlowId)}`,
        returnIntentUrl: `/api/account/oauth/return-intent?flow=${encodeURIComponent(failedFlowId)}`,
      }));
    }
    if (providerError) {
      failHostedOAuth(flowId, providerError);
      return res.status(400).type('html').send(oauthResultPage({
        title: 'Sign-in failed', message: providerError, kind: 'error',
        returnStatusUrl: `/api/account/oauth/status?flow=${encodeURIComponent(flowId)}`,
        returnIntentUrl: `/api/account/oauth/return-intent?flow=${encodeURIComponent(flowId)}`,
      }));
    }
    try {
      await exchangeHostedOAuthCode(flowId, authCode);
      finishHostedOAuth(flowId);
      log.info('OAuth sign-in completed');
      res.type('html').send(oauthResultPage({
        title: 'Signed in to StashBase',
        message: 'Your account is ready.',
        autoReturn: true,
        returnStatusUrl: `/api/account/oauth/status?flow=${encodeURIComponent(flowId)}`,
        returnIntentUrl: `/api/account/oauth/return-intent?flow=${encodeURIComponent(flowId)}`,
      }));
    } catch (error: unknown) {
      const message = errorMessage(error);
      failHostedOAuth(flowId, error);
      res.status(400).type('html').send(oauthResultPage({
        title: 'Sign-in failed', message, kind: 'error',
        returnStatusUrl: `/api/account/oauth/status?flow=${encodeURIComponent(flowId)}`,
        returnIntentUrl: `/api/account/oauth/return-intent?flow=${encodeURIComponent(flowId)}`,
      }));
    }
  });

  app.get('/api/account/oauth/status', (req, res) => {
    const flowId = typeof req.query.flow === 'string' ? req.query.flow : '';
    if (!flowId) return res.status(400).json({ error: 'Missing sign-in flow.' });
    res.json(hostedOAuthStatus(flowId));
  });

  app.post('/api/account/oauth/return-intent', (req, res) => {
    const flowId = typeof req.query.flow === 'string' ? req.query.flow : '';
    if (!flowId || !noteHostedOAuthReturnIntent(flowId)) {
      return res.status(404).json({ error: 'Sign-in flow is unavailable.' });
    }
    res.json({ accepted: true });
  });

  app.post('/api/account/oauth/app-return', (req, res) => {
    if (!processPrivateTokenMatches(req.header(OAUTH_RETURN_TOKEN_HEADER), appReturnToken)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    res.json(noteHostedOAuthAppReturn());
  });

  app.delete('/api/account', async (_req, res) => {
    stopAgentRuntime('stashbase');
    const signingOut = signOutHostedAccount();
    await stopOpenCodeRuntime();
    await signingOut;
    // The tool catalog is per account; a later sign-in reads its own.
    res.json(await hostedAccountState());
  });
}
