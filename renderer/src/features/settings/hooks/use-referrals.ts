/** Keeps the signed-in invitation draft and paginated records in sync with the
 * Node account owner. Checkout review is a transient selection for one offer. */
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { settingsFailure } from '@/features/settings/application/failure-messages';
import { accountRequest, settingsQueryKeys } from '@/features/settings/application/queries';
import type { ReferralPort } from '@/features/settings/application/referral-port';
import type { BillingPlan } from '@/features/settings/domain/billing';
import type {
  ReferralAccount,
  ReferralCheckoutBenefit,
  ReferralCheckoutInput,
  ReferralGrants,
  ReferralHistory,
  ReferralPreview,
} from '@/features/settings/domain/referrals';
import {
  broadcastAccountChange,
  useAccountSignals,
} from '@/features/settings/hooks/account-signals';
import {
  anyBusy,
  firstCommandFailure,
  useSettingsCommand,
} from '@/features/settings/hooks/use-settings-command';
import type { FailureView } from '@/shared/domain/feature-error';
import { useWindowFocus } from '@/shared/runtime/use-window-focus';
import { writeToClipboard } from '@/shared/ui/clipboard';

interface ReferralPageView<Item> {
  readonly items: readonly Item[];
  readonly busy: boolean;
  readonly failed: boolean;
  readonly empty: boolean;
  readonly hasMore: boolean;
  retry(): void;
  more(): void;
}

export interface ReferralViewModel {
  readonly data: ReferralAccount | undefined;
  readonly code: string;
  readonly preview: ReferralPreview | null | undefined;
  readonly busy: boolean;
  readonly copied: 'code' | 'link' | null;
  readonly decisionNeeded: boolean;
  readonly billingReady: boolean;
  readonly benefit: ReferralCheckoutBenefit | null;
  readonly immediate: boolean;
  readonly showImmediate: boolean;
  readonly failed: boolean;
  readonly failure: FailureView | null;
  readonly history: ReferralPageView<ReferralHistory['items'][number]>;
  readonly grants: ReferralPageView<ReferralGrants['items'][number]>;
  readonly hasOffer: boolean;
  readonly reviewedPriceId: string | null;
  checkout(plan: BillingPlan): ReferralCheckoutInput | null;
  plans(catalog: readonly BillingPlan[]): readonly BillingPlan[];
  refresh(): void;
  setCode(value: string): void;
  inspect(): void;
  accept(): void;
  skip(): void;
  copy(kind: 'code' | 'link'): void;
  reviewPlan(priceId: string): void;
  choose(value: ReferralCheckoutBenefit): void;
  setImmediate(value: boolean): void;
  resetChoice(): void;
}

function pageView<Item>(query: {
  data: { pages: { items: readonly Item[] }[] } | undefined;
  isFetching: boolean;
  isError: boolean;
  hasNextPage: boolean;
  refetch(): Promise<unknown>;
  fetchNextPage(): Promise<unknown>;
}): ReferralPageView<Item> {
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return {
    items,
    busy: query.isFetching,
    failed: query.isError,
    empty: Boolean(query.data && !query.isError && items.length === 0),
    hasMore: query.hasNextPage && !query.isError,
    retry: () => void query.refetch(),
    more: () => void query.fetchNextPage(),
  };
}

export function useReferrals(port: ReferralPort, generation: string): ReferralViewModel {
  const client = useQueryClient();
  const key = [...settingsQueryKeys.referrals, generation] as const;
  const [enteredCode, setEnteredCode] = useState<string | null>(null);
  const [reviewedPriceId, setReviewedPriceId] = useState<string | null>(null);
  const [choice, setChoice] = useState<ReferralCheckoutBenefit | null>(null);
  const [immediate, setImmediate] = useState(false);
  const [confirmedOffer, setConfirmedOffer] = useState<string>();
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: [...settingsQueryKeys.referrals, generation] });
  }, [client, generation]);
  const changed = () => {
    refresh();
    broadcastAccountChange('referrals');
  };
  useWindowFocus(refresh, Boolean(generation));
  useAccountSignals((change) => {
    if (change === 'referrals') refresh();
  });
  const me = useQuery({
    enabled: Boolean(generation),
    queryKey: [...key, 'me'],
    queryFn: ({ signal }) => accountRequest(client, signal, () => port.load(generation, signal)),
    refetchInterval: (query) => (query.state.data?.draft?.claiming ? 1500 : false),
    retry: false,
  });
  const history = useInfiniteQuery({
    enabled: Boolean(generation),
    queryKey: [...key, 'history'],
    queryFn: ({ signal, pageParam }) =>
      accountRequest(client, signal, () => port.history(generation, pageParam, signal)),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
  });
  const grants = useInfiniteQuery({
    enabled: Boolean(generation),
    queryKey: [...key, 'grants'],
    queryFn: ({ signal, pageParam }) =>
      accountRequest(client, signal, () => port.grants(generation, pageParam, signal)),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
  });
  const inspect = useSettingsCommand(
    'previewReferral',
    (code: string, signal) =>
      accountRequest(client, signal, () => port.preview(generation, code, signal)),
    {
      onSettled: changed,
    },
  );
  const accept = useSettingsCommand(
    'acceptReferral',
    (input: { code: string; campaignVersionId: string; referralRevision: string }, signal) =>
      accountRequest(client, signal, () => port.accept({ generation, ...input }, signal)),
    {
      onDone: () => setEnteredCode(null),
      onSettled: changed,
    },
  );
  const skip = useSettingsCommand(
    'skipReferral',
    (_: void, signal) => accountRequest(client, signal, () => port.skip(generation, signal)),
    {
      onDone: () => setEnteredCode(null),
      onSettled: changed,
    },
  );
  const copy = useSettingsCommand(
    'copyReferral',
    (input: { kind: 'code' | 'link'; value: string }) => writeToClipboard(input.value),
    { onDone: (_, input) => setCopied(input.kind) },
  );

  const data = me.isError ? undefined : me.data;
  const code = enteredCode ?? data?.draft?.code ?? '';
  const preview = code.trim() === data?.draft?.code ? data?.draft?.preview : undefined;
  const busy = anyBusy(inspect, accept, skip) || Boolean(data?.draft?.claiming);
  const decisionNeeded = Boolean(!data?.binding && (code.trim() || data?.draft));
  const hasOffer = data?.checkoutOffers !== undefined;
  const revision = data?.referralRevision;
  const reviewedOffer = data?.checkoutOffers?.find((offer) => offer.priceId === reviewedPriceId);
  const offerVersion = reviewedOffer
    ? JSON.stringify([revision, reviewedOffer.priceId, reviewedOffer.amountMinor])
    : undefined;
  const benefit = offerVersion !== undefined && offerVersion === confirmedOffer ? choice : null;
  const showImmediate = benefit === 'discount';
  const billingReady = Boolean(data && !decisionNeeded && !busy && !data.binding?.reviewHeld);
  function plans(catalog: readonly BillingPlan[]): readonly BillingPlan[] {
    return (
      data?.checkoutOffers?.map((offer) => ({
        priceId: offer.priceId,
        amount: offer.amountMinor,
        currency: offer.currency,
        interval: 'month',
        available: true,
        planKey: offer.plan,
        name: offer.plan === 'plus' ? 'Plus' : 'Pro',
      })) ?? catalog
    );
  }

  function checkout(plan: BillingPlan): ReferralCheckoutInput | null {
    if (!data || !billingReady) return null;
    const fields = { generation, priceId: plan.priceId, referralRevision: data.referralRevision };
    if (!hasOffer) return { ...fields, benefit: 'standard' };
    if (!benefit || plan.priceId !== reviewedPriceId) return null;
    if (benefit === 'discount')
      return immediate ? { ...fields, benefit, confirmImmediatePayment: true } : null;
    return { ...fields, benefit };
  }

  return {
    data,
    code,
    preview,
    busy,
    copied,
    decisionNeeded,
    billingReady,
    checkout,
    benefit,
    showImmediate,
    immediate: showImmediate && immediate,
    failed: me.isError || !generation,
    failure:
      firstCommandFailure(inspect, accept, skip, copy) ??
      (me.isError ? settingsFailure(me.error) : null),
    history: pageView(history),
    grants: pageView(grants),
    refresh,
    plans,
    hasOffer,
    reviewedPriceId,
    setCode: (value: string) => {
      setEnteredCode(value);
      inspect.cancel();
      accept.cancel();
      skip.cancel();
    },
    inspect: () => inspect.run(code.trim()),
    accept: () => {
      if (preview?.available && revision !== undefined)
        accept.run({
          code: preview.code,
          campaignVersionId: preview.terms.campaignVersionId,
          referralRevision: revision,
        });
    },
    skip: () => {
      inspect.cancel();
      accept.cancel();
      skip.run();
    },
    copy: (kind: 'code' | 'link') => {
      if (!data?.invitation) return;
      setCopied(null);
      copy.run({ kind, value: kind === 'code' ? data.invitation.code : data.invitation.shareUrl });
    },
    reviewPlan: (priceId: string) => {
      setReviewedPriceId(priceId);
      setChoice(null);
      setImmediate(false);
    },
    choose: (value: ReferralCheckoutBenefit) => {
      setChoice(value);
      setImmediate(false);
      setConfirmedOffer(offerVersion);
    },
    setImmediate,
    resetChoice: () => {
      setChoice(null);
      setImmediate(false);
    },
  };
}
