import type express from 'express';
import type { z } from 'zod';
import {
  referralAcceptInputSchema,
  referralCheckoutInputSchema,
  referralPageInputSchema,
  referralPreviewInputSchema,
  referralScopeSchema,
} from '../../shared/protocols/http/referrals.ts';
import { HostedApiError, isHostedSignInRequired } from '../hosted-account.ts';
import {
  acceptReferral,
  previewReferral,
  referralAccount,
  referralGrants,
  referralHistory,
  skipReferral,
  startReferralCheckout,
} from '../referral-account.ts';

const publicCodes = new Set([
  'agent_account_unavailable', 'auth_required', 'billing_checkout_closed', 'client_upgrade_required',
  'idempotency_conflict', 'invalid_request', 'invalid_response', 'rate_limited', 'referral_account_changed',
  'referral_already_bound', 'referral_benefit_unavailable', 'referral_campaign_capacity_reached',
  'referral_campaign_unavailable', 'referral_checkout_in_progress', 'referral_code_unavailable',
  'referral_cursor_invalid', 'referral_decision_required', 'referral_not_new_account',
  'referral_operation_in_progress', 'referral_preview_changed', 'referral_price_changed',
  'referral_revision_changed', 'referral_self_invite', 'referral_terms_changed', 'service_unavailable',
  'upstream_unavailable',
]);

export function hostedAccountFailure(res: express.Response, error: unknown): void {
  const failure = error instanceof HostedApiError && publicCodes.has(error.code) ? error
    : isHostedSignInRequired(error) ? new HostedApiError(401, 'auth_required')
      : new HostedApiError(502, 'service_unavailable');
  if (failure.retryAfterSeconds) res.setHeader('retry-after', failure.retryAfterSeconds);
  res.status(failure.status).json({
    code: failure.code,
    error: failure.message,
    ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
  });
}

function validated<S extends z.ZodTypeAny>(
  schema: S,
  source: 'query' | 'body',
  operation: (input: z.output<S>) => unknown | Promise<unknown>,
): express.RequestHandler {
  return async (req, res) => {
    res.setHeader('cache-control', 'private, no-store');
    const input = schema.safeParse(req[source]);
    if (!input.success) return hostedAccountFailure(res, new HostedApiError(400, 'invalid_request'));
    try {
      const result = await operation(input.data);
      if (result === undefined) res.status(204).end();
      else res.json(result);
    } catch (error) {
      hostedAccountFailure(res, error);
    }
  };
}

export function mountReferralRoutes(app: express.Express): void {
  app.get('/api/account/referrals/me', validated(referralScopeSchema, 'query', ({ generation }) => referralAccount(generation)));
  app.post('/api/account/referrals/preview', validated(referralPreviewInputSchema, 'body', ({ generation, code }) => previewReferral(generation, code)));
  app.post('/api/account/referrals/claim', validated(referralAcceptInputSchema, 'body', ({ generation, campaignVersionId, referralRevision, code }) =>
    acceptReferral(generation, campaignVersionId, referralRevision, code)));
  app.post('/api/account/referrals/skip', validated(referralScopeSchema, 'body', ({ generation }) => skipReferral(generation)));
  app.get('/api/account/referrals/history', validated(referralPageInputSchema, 'query', ({ generation, ...page }) => referralHistory(generation, page)));
  app.get('/api/account/referrals/grants', validated(referralPageInputSchema, 'query', ({ generation, ...page }) => referralGrants(generation, page)));
  app.post('/api/account/billing/checkout', validated(referralCheckoutInputSchema, 'body', startReferralCheckout));
}
