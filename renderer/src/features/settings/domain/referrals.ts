/** Invitation, reward history, and Checkout values used by the Account feature. */
import { FeatureError } from '@/shared/domain/feature-error';

export type ReferralCheckoutBenefit = 'standard' | 'referral' | 'discount';

export type ReferralCheckoutInput = {
  generation: string;
  priceId: string;
  referralRevision: string;
} & (
  | { benefit: 'standard' }
  | { benefit: 'referral' }
  | { benefit: 'discount'; confirmImmediatePayment: true }
);

export interface ReferralTerms {
  campaignVersionId: string;
  inviterCredits: string;
  inviteeCredits: string;
  enrollmentClosesAt: string;
  claimDays: number;
  paymentDays: number;
  confirmationDays: number;
  grantDays: number;
}

export type ReferralPreview =
  | { available: true; code: string; terms: ReferralTerms }
  | { available: false; reason: 'code_unavailable' | 'campaign_unavailable' | 'capacity_reached' };

export interface ReferralProgress {
  referralId: string;
  state: 'awaiting_payment' | 'confirming' | 'rewarded' | 'expired' | 'ineligible' | 'waived';
  reason:
    | 'payment_deadline_elapsed'
    | 'payment_ineligible'
    | 'payment_discounted'
    | 'payment_refunded'
    | 'policy_ineligible'
    | null;
  reviewHeld: boolean;
  paymentDeadlineAt: string;
  trial: { expectedChargeAt: string } | null;
  confirmationDueAt: string | null;
  terms: ReferralTerms;
}

export interface ReferralActivity {
  id: string;
  kind: 'issuance' | 'refund' | 'dispute' | 'operator_cap';
  at: string;
  beforeCredits?: string | undefined;
  afterCredits?: string | undefined;
  reason?:
    | 'payment_refunded'
    | 'payment_disputed'
    | 'payment_restored'
    | 'operator_correction'
    | undefined;
}

export interface ReferralAccount {
  activity?: readonly ReferralActivity[] | undefined;
  referralRevision: string;
  invitation: { code: string; shareUrl: string; terms: ReferralTerms } | null;
  claimEligibility:
    | 'eligible'
    | 'bound'
    | 'account_too_old'
    | 'billing_history'
    | 'checkout_in_progress'
    | 'account_unavailable'
    | 'verification_pending';
  binding: ReferralProgress | null;
  checkoutOffers?:
    | readonly { plan: 'plus' | 'pro'; priceId: string; amountMinor: number; currency: 'usd' }[]
    | undefined;
  summary: { registered: number; confirming: number; rewarded: number };
  draft: { code: string; preview: ReferralPreview | null; claiming: boolean } | null;
  checkoutStarted: boolean;
}

export interface ReferralHistory {
  items: readonly (ReferralProgress & { friendLabel: string })[];
  nextCursor: string | null;
}

export interface ReferralGrants {
  items: readonly {
    grantId: string;
    expiresAt: string;
    entitlementCredits: string;
    availableCredits: string;
    availability: 'available' | 'held' | 'expired' | 'depleted' | 'revoked';
    lastAdjustment: {
      at: string;
      reason: 'payment_refunded' | 'payment_disputed' | 'payment_restored' | 'operator_correction';
    } | null;
  }[];
  nextCursor: string | null;
}

export class ReferralRequestError extends FeatureError {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(
      'ReferralRequestError',
      status === 401 ? 'unauthorized' : 'unavailable',
      'The guarded account request was refused.',
    );
  }
}

const eligibility = {
  eligible: '',
  bound: '',
  account_too_old: 'This account is outside the signup window for new invitations.',
  billing_history: 'This account’s subscription history makes it ineligible for an invitation.',
  checkout_in_progress: 'Finish or close your earlier payment page before accepting an invitation.',
  account_unavailable: 'Invitations are unavailable for this account.',
  verification_pending: 'Verify your email address before you accept an invitation.',
} as const;

export function invitationEligibility(value: ReferralAccount['claimEligibility']): string {
  return eligibility[value] ?? '';
}

const progressLabels: Record<ReferralProgress['state'], string> = {
  awaiting_payment: 'Awaiting first payment',
  confirming: 'Payment confirming',
  rewarded: 'Reward issued',
  expired: 'Expired',
  ineligible: 'Ineligible',
  waived: 'Closed',
};

const progressReasons: Record<NonNullable<ReferralProgress['reason']>, string> = {
  payment_deadline_elapsed: 'The first-payment deadline passed.',
  payment_ineligible: 'The payment did not qualify.',
  payment_discounted: 'A discount was used for the first payment.',
  payment_refunded: 'The payment was refunded.',
  policy_ineligible: 'The invitation did not qualify.',
};

export function invitationProgress(item: ReferralProgress): string {
  const status = progressLabels[item.state];
  if (item.reviewHeld) return `${status} · Under review`;
  if (item.reason !== null) return `${status} · ${progressReasons[item.reason]}`;
  if (item.confirmationDueAt && item.state === 'confirming')
    return `${status} · Review after ${accountDate(item.confirmationDueAt)}`;
  if (item.state === 'awaiting_payment') {
    const deadline = `Qualifying payment by ${accountDate(item.paymentDeadlineAt)}`;
    const trial =
      item.trial && `Trial payment expected ${accountDate(item.trial.expectedChargeAt)}`;
    return [status, deadline, trial].filter(Boolean).join(' · ');
  }
  return status;
}

export function accountDate(value: string): string {
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

const activityLabels: Record<ReferralActivity['kind'], string> = {
  issuance: 'Reward issued',
  refund: 'Refund adjustment',
  dispute: 'Payment dispute adjustment',
  operator_cap: 'Reward adjusted',
};

export function referralActivityLabel(item: ReferralActivity): string {
  return item.kind !== 'issuance' && item.reason === 'payment_restored'
    ? 'Reward entitlement restored'
    : activityLabels[item.kind];
}
