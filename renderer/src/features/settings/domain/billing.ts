/**
 * StashBase Agent subscriptions as the Agents panel reasons about them.
 *
 * Stripe owns prices, promotion codes, and payment; the hosted API owns the
 * rights from a confirmed payment or native trial. A browser return is never evidence of payment, so a
 * plan is in effect only while the API reports confirmed access through a future
 * date.
 */

export interface BillingPlan {
  readonly priceId: string;
  readonly name: string;
  readonly planKey?: string;
  readonly monthlyGrantPicodollars?: number | null;
  /** Minor currency units, as Stripe reports them. */
  readonly amount: number;
  readonly currency: string;
  readonly interval: 'month' | 'year';
  readonly available: boolean;
}

export interface BillingStatus {
  readonly planName: string | null;
  readonly planKey?: string | null;
  readonly scheduledChange?: { priceId: string; effectiveAt: string } | null;
  readonly changePending?: boolean;
  readonly changeError?: string | null;
  readonly status: string;
  readonly paidThrough: string | null;
  readonly cancelAtPeriodEnd: boolean;
  /** A Stripe customer exists, so the Customer Portal can open. */
  readonly canManage: boolean;
}

/** Rights the API has confirmed and that have not lapsed. */
export function billingPaid(status: BillingStatus, now = Date.now()): boolean {
  return (
    status.paidThrough !== null &&
    Date.parse(status.paidThrough) > now &&
    (status.status === 'active' || status.status === 'past_due' || status.status === 'trialing')
  );
}

/** A subscription exists in Stripe, paid or not; new Checkout is not offered. */
export function billingSubscribed(status: BillingStatus): boolean {
  return status.canManage && status.status !== 'free';
}

export function billingPrice(plan: BillingPlan): string {
  const amount = new Intl.NumberFormat(undefined, {
    currency: plan.currency,
    style: 'currency',
  }).format(plan.amount / 100);
  return `${amount} a ${plan.interval}`;
}

export type BillingChange =
  | { action: 'downgrade'; priceId: string }
  | { action: 'keep' | 'cancel' | 'resume' };
