import { randomUUID } from 'node:crypto';
import {
  cloudReferralCheckoutInputSchema,
  cloudReferralClaimInputSchema,
  cloudReferralClaimSchema,
  cloudReferralGrantsSchema,
  cloudReferralHistorySchema,
  cloudReferralMeSchema,
  referralAccountSchema,
  referralGrantsSchema,
  referralHistorySchema,
  referralPreviewSchema,
  type ReferralCheckoutInput,
  type ReferralPreview,
} from '../shared/protocols/http/referrals.ts';
import { z } from 'zod';
import { getHostedAccountSession } from './app-config.ts';
import { assertHostedGeneration, createHostedCheckout, HostedApiError, hostedAccountRequest } from './hosted-account.ts';

type Claim = z.infer<typeof cloudReferralClaimInputSchema>;
type Page = { limit?: string; cursor?: string };
type Draft = {
  code: string;
  preview: ReferralPreview | null;
  attempt?: Claim;
};
type AccountOperations = {
  generation: string;
  draft: Draft | null;
  busy: boolean;
  checkout: { fingerprint: string; requestId: string } | null;
  checkoutStarted: boolean;
};

let operations: AccountOperations | undefined;

function scoped(generation: string): AccountOperations {
  assertHostedGeneration(generation);
  if (operations?.generation !== generation) {
    operations = { generation, draft: null, busy: false, checkout: null, checkoutStarted: false };
  }
  return operations;
}

function checkSubject(subject: string, generation: string): void {
  assertHostedGeneration(generation);
  if (subject !== getHostedAccountSession()?.userId.toLowerCase()) {
    throw new HostedApiError(409, 'referral_account_changed');
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HostedApiError(502, 'invalid_response');
  return result.data;
}

async function readMe(generation: string) {
  const result = parse(cloudReferralMeSchema, await hostedAccountRequest('/v1/referrals/me', { method: 'GET' }, { generation }));
  checkSubject(result.accountSubject, generation);
  return result;
}

export async function referralAccount(generation: string) {
  const state = scoped(generation);
  const me = await readMe(generation);
  const { accountSubject: _, ...publicMe } = me;
  return parse(referralAccountSchema, {
    ...publicMe,
    draft: me.binding || !state.draft ? null : {
      code: state.draft.code, preview: state.draft.preview, claiming: state.busy,
    },
    checkoutStarted: state.checkoutStarted,
  });
}

function idle(state: AccountOperations): void {
  if (state.busy) throw new HostedApiError(409, 'referral_operation_in_progress');
}

export async function previewReferral(generation: string, code: string) {
  const state = scoped(generation);
  idle(state);
  // Establish readiness before the lookup, including when the lookup fails.
  const existing = state.draft;
  const draft: Draft = {
    code, preview: null,
    ...(existing?.code === code && existing.attempt ? { attempt: existing.attempt } : {}),
  };
  state.draft = draft;
  const preview = parse(referralPreviewSchema, await hostedAccountRequest('/v1/referrals/resolve', {
    method: 'GET', query: new URLSearchParams({ code }),
  }, { generation }));
  assertHostedGeneration(generation);
  if (state.draft !== draft) throw new HostedApiError(409, 'referral_preview_changed');
  if (draft.attempt && (!preview.available || preview.terms.campaignVersionId !== draft.attempt.campaignVersionId)) {
    delete draft.attempt;
  }
  draft.preview = preview;
  return preview;
}

export function skipReferral(generation: string): void {
  const state = scoped(generation);
  idle(state);
  state.draft = null;
}

export async function acceptReferral(generation: string, campaignVersionId: string, referralRevision: string, code: string) {
  const state = scoped(generation);
  idle(state);
  const draft = state.draft;
  if (!draft?.preview?.available || (draft.preview.terms.campaignVersionId !== campaignVersionId || draft.preview.code !== code)) {
    throw new HostedApiError(409, 'referral_preview_changed');
  }
  state.busy = true;
  try {
    if (!draft.attempt) {
      const me = await readMe(generation);
      if (me.referralRevision !== referralRevision) throw new HostedApiError(409, 'referral_revision_changed');
      draft.attempt = {
        requestId: randomUUID(), expectedAccountSubject: me.accountSubject, campaignVersionId,
        expectedReferralRevision: referralRevision, code: draft.preview.code,
      };
    }
    if (draft.attempt.expectedReferralRevision !== referralRevision) {
      throw new HostedApiError(409, 'referral_revision_changed');
    }
    const result = parse(cloudReferralClaimSchema, await hostedAccountRequest('/v1/referrals/claim', {
      method: 'POST', body: draft.attempt,
    }, { generation }));
    checkSubject(result.accountSubject, generation);
    state.draft = null;
  } catch (error) {
    if (error instanceof HostedApiError && ['referral_terms_changed', 'referral_revision_changed', 'referral_code_unavailable',
      'referral_campaign_unavailable', 'referral_already_bound', 'idempotency_conflict'].includes(error.code)) {
      draft.preview = null;
      delete draft.attempt;
    }
    throw error;
  } finally {
    state.busy = false;
  }
}

function pageQuery(page: Page): URLSearchParams {
  const query = new URLSearchParams();
  if (page.limit) query.set('limit', page.limit);
  if (page.cursor) query.set('cursor', page.cursor);
  return query;
}

export async function referralHistory(generation: string, page: Page) {
  const { accountSubject, ...result } = parse(cloudReferralHistorySchema, await hostedAccountRequest('/v1/referrals/history', {
    method: 'GET', query: pageQuery(page),
  }, { generation }));
  checkSubject(accountSubject, generation);
  return parse(referralHistorySchema, result);
}

export async function referralGrants(generation: string, page: Page) {
  const { accountSubject, ...result } = parse(cloudReferralGrantsSchema, await hostedAccountRequest('/v1/credits/grants', {
    method: 'GET', query: pageQuery(page),
  }, { generation }));
  checkSubject(accountSubject, generation);
  return parse(referralGrantsSchema, result);
}

export async function startReferralCheckout(input: ReferralCheckoutInput) {
  const { generation, priceId, referralRevision, benefit } = input;
  const state = scoped(generation);
  idle(state);
  state.busy = true;
  try {
    const me = await readMe(generation);
    if (state.draft && !me.binding) throw new HostedApiError(409, 'referral_decision_required');
    if (me.referralRevision !== referralRevision) throw new HostedApiError(409, 'referral_revision_changed');
    const fingerprint = JSON.stringify([priceId, referralRevision, benefit]);
    if (state.checkout?.fingerprint !== fingerprint) {
      state.checkout = { fingerprint, requestId: randomUUID() };
    }
    const body = cloudReferralCheckoutInputSchema.parse({
      priceId,
      referral: {
        requestId: state.checkout.requestId,
        expectedAccountSubject: me.accountSubject,
        expectedReferralRevision: referralRevision,
        benefit,
        ...(benefit === 'discount' ? { confirmImmediatePayment: input.confirmImmediatePayment } : {}),
      },
    });
    state.checkoutStarted = true;
    return await createHostedCheckout(body, generation);
  } catch (error) {
    if (error instanceof HostedApiError && ['billing_checkout_closed', 'referral_price_changed', 'referral_revision_changed',
      'referral_benefit_unavailable', 'idempotency_conflict'].includes(error.code)) {
      state.checkout = null;
    }
    throw error;
  } finally {
    state.busy = false;
  }
}
