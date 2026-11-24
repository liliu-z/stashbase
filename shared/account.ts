/**
 * The signed-in StashBase account used by the hosted Agent runtime.
 *
 * An account is optional throughout the product — the project works
 * anonymously — so every consumer has to be able to render 'no account'
 * without treating it as an error.
 */

import type { CreditBreakdown } from './protocols/http/referrals.ts';

/** Public Agent allowance intentionally exposes only the user-facing monthly
 * percentage and token detail. Picodollar accounting stays server-side. */
export interface HostedAgentAllowance {
  profile: string;
  remainingPercent: number;
  reservedPercent?: number;
  creditBreakdown?: CreditBreakdown;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  windowStartedAt: string | null;
  windowEndsAt: string | null;
}

/** One purchasable tier from the hosted Stripe catalog. Amounts are minor
 * currency units, as Stripe reports them. */
export interface HostedBillingPlan {
  priceId: string;
  planKey: string;
  name: string;
  amount: number;
  currency: string;
  interval: 'month' | 'year';
  monthlyGrantPicodollars?: number | null;
  available: boolean;
}

/** The hosted API's subscription rights for the signed-in account. A paid
 * plan is in effect only while `paidThrough` is in the future. */
export interface HostedBillingStatus {
  plan: HostedBillingPlan | null;
  status: string;
  subscriptionStatus?: string;
  scheduledChange?: { priceId: string; effectiveAt: string } | null;
  changePending?: boolean;
  changeError?: string | null;
  paidThrough: string | null;
  cancelAtPeriodEnd: boolean;
  canManage: boolean;
}

export type HostedBillingChange = { action: 'downgrade'; priceId: string } | { action: 'keep' | 'cancel' | 'resume' };

/** A Stripe-hosted page (Checkout or Customer Portal) for the browser. */
export interface HostedBillingRedirect {
  url: string;
}

/** Banners about the account. Each is shown until the reader takes it up or
 * declines it; signing out shows the sign-in banner again. */
export type HostedAccountOffer = 'sign-in';

export interface HostedAccountState {
  generation?: string;
  signedIn: boolean;
  /** Offers this installation has not shown to completion yet. */
  offers: HostedAccountOffer[];
  email?: string;
  displayName?: string;
  /** Same-origin renderer endpoint; the provider URL remains Node-only. */
  avatarUrl?: string;
}

export type HostedOAuthProvider = 'google';
export type HostedOAuthPurpose = 'account';

export interface HostedOAuthStart {
  flowId: string;
  provider: HostedOAuthProvider;
  purpose: HostedOAuthPurpose;
  url: string;
}

export interface HostedOAuthStatus {
  state: 'pending' | 'complete' | 'error';
  error?: string;
  appReturned?: boolean;
}
