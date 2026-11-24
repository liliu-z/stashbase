import { useId } from 'react';

import type { BillingPlan } from '@/features/settings/domain/billing';
import { accountDate } from '@/features/settings/domain/referrals';
import type { ReferralViewModel } from '@/features/settings/hooks/use-referrals';

export function CheckoutBenefits({
  plan,
  referrals,
}: {
  plan: BillingPlan;
  referrals: ReferralViewModel;
}) {
  const name = useId();
  const binding = referrals.data?.binding;
  const amount = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: plan.currency,
  }).format(plan.amount / 100);
  return (
    <fieldset className="mt-1 grid min-w-0 gap-2 text-caption">
      <legend className="mb-1 text-foreground">Choose a benefit for {plan.name} Checkout</legend>
      <label className="flex items-start gap-2">
        <input
          checked={referrals.benefit === 'referral'}
          name={name}
          onChange={() => referrals.choose('referral')}
          type="radio"
        />
        <span>
          Keep invitation rewards. This Checkout won’t accept promotion codes.
          {binding && (
            <span className="block text-muted-foreground">
              Qualifying payment by {accountDate(binding.paymentDeadlineAt)}.
            </span>
          )}
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          checked={referrals.benefit === 'discount'}
          name={name}
          onChange={() => referrals.choose('discount')}
          type="radio"
        />
        <span>
          Use a discount code in Checkout. A redeemed discount replaces both invitation rewards.
        </span>
      </label>
      {referrals.showImmediate && (
        <label className="flex items-start gap-2">
          <input
            checked={referrals.immediate}
            onChange={(event) => referrals.setImmediate(event.target.checked)}
            type="checkbox"
          />
          <span>
            I agree to pay {amount} immediately before any discount. This Checkout starts paid
            access without a trial.
          </span>
        </label>
      )}
    </fieldset>
  );
}
