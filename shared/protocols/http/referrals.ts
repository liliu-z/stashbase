import { z } from 'zod';

// Public StashBase API referral and credits-v1 wire shapes.
const id = z.string().uuid();
const instant = z.string().datetime({ precision: 3 });
const count = z.number().int().nonnegative().safe();
const positiveInt = z.number().int().min(1).max(2147483647);
const plan = z.enum(['plus', 'pro']);
const price = z.string().max(128).regex(/^price_[A-Za-z0-9]+$/);
const code = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{13}$/);
const revision = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => value.length < 19 || value <= '9223372036854775807');
export const creditAmount = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{9}$/);
const creditUnit = z.literal('credits-v1');

const windows = {
  hintDays: positiveInt,
  claimDays: positiveInt,
  paymentDays: positiveInt,
  confirmationDays: positiveInt,
  grantDays: positiveInt,
};
const terms = z.strictObject({
  campaignVersionId: id,
  creditUnit,
  inviterCredits: creditAmount,
  inviteeCredits: creditAmount,
  qualifyingPlans: z.tuple([z.literal('plus'), z.literal('pro')]),
  enrollmentOpensAt: instant,
  enrollmentClosesAt: instant,
  ...windows,
});
const unavailable = z.enum([
  'code_unavailable',
  'campaign_unavailable',
  'capacity_reached',
]);
const resolveQuery = z.strictObject({ code: z.string().min(1).max(64) });
export const referralPreviewSchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(true), code, terms }),
  z.strictObject({ available: z.literal(false), reason: unavailable }),
]);
const referralState = z.enum([
  'awaiting_payment',
  'confirming',
  'rewarded',
  'expired',
  'ineligible',
  'waived',
]);
const publicReason = z.enum([
  'payment_deadline_elapsed',
  'payment_ineligible',
  'payment_discounted',
  'payment_refunded',
  'policy_ineligible',
]);
const trial = z.strictObject({ expectedChargeAt: instant });
const referralProgress = z.strictObject({
  referralId: id,
  state: referralState,
  reason: publicReason.nullable(),
  reviewHeld: z.boolean(),
  boundAt: instant,
  paymentDeadlineAt: instant,
  trial: trial.nullable(),
  paidAt: instant.nullable(),
  confirmationDueAt: instant.nullable(),
  rewardedAt: instant.nullable(),
  ownGrantId: id.nullable(),
  terms,
});
export const cloudReferralMeSchema = z.strictObject({
  accountSubject: id,
  referralRevision: revision,
  creditUnit,
  invitation: z.strictObject({ code, shareUrl: z.string().url().max(4096), terms }).nullable(),
  claimEligibility: z.enum([
    'eligible',
    'bound',
    'account_too_old',
    'billing_history',
    'checkout_in_progress',
    'account_unavailable',
    'verification_pending',
  ]),
  binding: referralProgress.nullable(),
  checkoutOffers: z
    .array(
      z.strictObject({
        plan,
        priceId: price,
        amountMinor: positiveInt,
        currency: z.literal('usd'),
      }),
    )
    .optional(),
  activity: z
    .array(
      z.strictObject({
        id,
        kind: z.enum(['issuance', 'refund', 'dispute', 'operator_cap']),
        at: instant,
        beforeCredits: creditAmount.optional(),
        afterCredits: creditAmount.optional(),
        reason: z.enum(['payment_refunded', 'payment_disputed', 'payment_restored', 'operator_correction']).optional(),
      }),
    )
    .max(20)
    .optional(),
  summary: z.strictObject({
    registered: count,
    confirming: count,
    rewarded: count,
    bonusAvailableCredits: creditAmount,
    nextBonusExpiryAt: instant.nullable(),
  }),
});
const mutation = {
  requestId: id,
  expectedAccountSubject: id,
};
export const cloudReferralClaimInputSchema = z.strictObject({
  ...mutation,
  code: resolveQuery.shape.code,
  campaignVersionId: id,
  expectedReferralRevision: revision,
});
export const cloudReferralClaimSchema = z.strictObject({
  accountSubject: id,
  referralRevision: revision,
  binding: referralProgress,
});
const cursor = z.string().min(1).max(2048);
const pageFields = {
  limit: z
    .string()
    .regex(/^(?:[1-9][0-9]?|100)$/)
    .optional(),
  cursor: cursor.optional(),
};
const pageQuery = z.strictObject(pageFields);
const page = { nextCursor: cursor.nullable() };
const userPage = { ...page, accountSubject: id, creditUnit };
export const cloudReferralHistorySchema = z.strictObject({
  ...userPage,
  items: z.array(
    referralProgress.extend({ friendLabel: z.string().min(1).max(64) }),
  ),
});

const balanceFields = {
  consumedCredits: creditAmount,
  reservedCredits: creditAmount,
  provisionalCredits: creditAmount,
  availableCredits: creditAmount,
};
const grant = z.strictObject({
  grantId: id,
  referralId: id,
  campaignVersionId: id,
  recipientRole: z.enum(['inviter', 'invitee']),
  scope: z.literal('agent'),
  source: z.literal('referral_reward'),
  issuedAt: instant,
  expiresAt: instant,
  originalCredits: creditAmount,
  entitlementCredits: creditAmount,
  ...balanceFields,
  availability: z.enum(['available', 'held', 'expired', 'depleted', 'revoked']),
  lastAdjustment: z
    .strictObject({
      at: instant,
      reason: z.enum([
        'payment_refunded',
        'payment_disputed',
        'payment_restored',
        'operator_correction',
      ]),
    })
    .nullable(),
});
export const cloudReferralGrantsSchema = z.strictObject({
  ...userPage,
  items: z.array(grant),
});
export const creditBreakdownSchema = z.strictObject({
  creditUnit,
  asOf: instant,
  base: z.strictObject({
    windowStartedAt: instant.nullable(),
    windowEndsAt: instant.nullable(),
    grantedCredits: creditAmount,
    ...balanceFields,
  }),
  bonus: z.strictObject({
    entitlementCredits: creditAmount,
    ...balanceFields,
    nextExpiry: z
      .strictObject({ at: instant, availableCredits: creditAmount })
      .nullable(),
  }),
  agentAvailableCredits: creditAmount,
});

// The loopback API uses a host-only session generation and never exposes the
// cloud subject or accepts a client-supplied idempotency identity.
export const accountGenerationSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const generation = { generation: accountGenerationSchema };
export const referralScopeSchema = z.strictObject(generation);
export const referralPageInputSchema = pageQuery.extend(generation);
export const referralPreviewInputSchema = z.strictObject({
  ...generation,
  code: z.string().trim().min(1).max(64),
});
export const referralAcceptInputSchema = z.strictObject({
  ...generation,
  campaignVersionId: id,
  referralRevision: revision,
  code,
});
export const referralAccountSchema = cloudReferralMeSchema.omit({ accountSubject: true }).extend({
  draft: z.strictObject({
    code: resolveQuery.shape.code,
    preview: referralPreviewSchema.nullable(),
    claiming: z.boolean(),
  }).nullable(),
  checkoutStarted: z.boolean(),
});
export const referralHistorySchema = cloudReferralHistorySchema.omit({ accountSubject: true });
export const referralGrantsSchema = cloudReferralGrantsSchema.omit({ accountSubject: true });

export const referralCheckoutBenefitSchema = z.enum(['standard', 'referral', 'discount']);
const checkout = { ...generation, priceId: price, referralRevision: revision };
export const referralCheckoutInputSchema = z.discriminatedUnion('benefit', [
  z.strictObject({ ...checkout, benefit: z.literal('standard') }),
  z.strictObject({ ...checkout, benefit: z.literal('referral') }),
  z.strictObject({ ...checkout, benefit: z.literal('discount'), confirmImmediatePayment: z.literal(true) }),
]);
export const cloudReferralCheckoutInputSchema = z.strictObject({
  priceId: price,
  referral: z.discriminatedUnion('benefit', [
    z.strictObject({ ...mutation, expectedReferralRevision: revision, benefit: z.literal('standard') }),
    z.strictObject({ ...mutation, expectedReferralRevision: revision, benefit: z.literal('referral') }),
    z.strictObject({ ...mutation, expectedReferralRevision: revision, benefit: z.literal('discount'), confirmImmediatePayment: z.literal(true) }),
  ]),
});
export const referralFailureSchema = z.strictObject({
  code: z.string().regex(/^[a-z_0-9]{1,64}$/),
  error: z.string().min(1).max(200),
  retryAfterSeconds: z.number().int().positive().safe().optional(),
});

export type CreditBreakdown = z.infer<typeof creditBreakdownSchema>;
export type ReferralAccount = z.infer<typeof referralAccountSchema>;
export type ReferralCheckoutBenefit = z.infer<typeof referralCheckoutBenefitSchema>;
export type ReferralCheckoutInput = z.infer<typeof referralCheckoutInputSchema>;
export type ReferralHistory = z.infer<typeof referralHistorySchema>;
export type ReferralGrants = z.infer<typeof referralGrantsSchema>;
export type ReferralPreview = z.infer<typeof referralPreviewSchema>;
export type ReferralTerms = z.infer<typeof terms>;
export type ReferralProgress = z.infer<typeof referralProgress>;
export type CloudReferralCheckoutInput = z.infer<typeof cloudReferralCheckoutInputSchema>;
