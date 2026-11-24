/**
 * The Default Agent subscription: the plan catalog, the account's confirmed
 * rights, and the two Stripe pages the browser opens from here.
 *
 * Checkout opens in the system browser with the desktop account already
 * attached, so the reader never signs in to the website to pay. Returning from
 * the browser proves nothing: the panel waits for the hosted API to confirm
 * rights, and after a bounded wait it keeps the purchase buttons hidden until
 * the reader refreshes or stops waiting, so a slow webhook never invites a
 * second payment.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { checkoutFailure } from '@/features/settings/application/failure-messages';
import type { AccountPort, AgentRuntimePort } from '@/features/settings/application/ports';
import {
  accountRequest,
  billingPlansQuery,
  billingStatusQuery,
  settingsQueryKeys,
} from '@/features/settings/application/queries';
import type { HostedAccount } from '@/features/settings/domain/account';
import {
  billingPaid,
  type BillingPlan,
  type BillingChange,
  type BillingStatus,
} from '@/features/settings/domain/billing';
import {
  ReferralRequestError,
  type ReferralCheckoutInput,
} from '@/features/settings/domain/referrals';
import { broadcastAccountChange } from '@/features/settings/hooks/account-signals';
import { anyBusy, useSettingsCommand } from '@/features/settings/hooks/use-settings-command';
import type { FailureView } from '@/shared/domain/feature-error';
import { useWindowFocus } from '@/shared/runtime/use-window-focus';

const CONFIRM_POLL_MS = 5_000;
const CONFIRM_WINDOW_MS = 120_000;

type BillingConfirmation = 'waiting' | 'slow';

/** The Stripe page being requested: the portal, or Checkout for one plan's
 *  price, so only the button the reader pressed shows the wait. */
type BillingOpening =
  | { readonly page: 'portal' }
  | { readonly page: 'checkout'; readonly priceId: string };

export interface BillingViewModel {
  readonly plans: readonly BillingPlan[];
  readonly plansFailed: boolean;
  /** Null until the first read lands, or while it cannot. */
  readonly status: BillingStatus | null;
  readonly statusFailed: boolean;
  /** Checkout is open in the browser and rights are not confirmed yet;
   *  `slow` once the bounded wait has passed. */
  readonly confirming: BillingConfirmation | null;
  /** A Stripe page is being requested. */
  readonly busy: boolean;
  readonly opening: BillingOpening | null;
  readonly browserPage: 'checkout' | 'portal' | null;
  readonly failure: FailureView | null;
  subscribe(input: ReferralCheckoutInput): void;
  manage(): void;
  change(input: BillingChange): void;
  refresh(): void;
  /** Stops the local wait; it does not cancel anything in the browser. */
  stopWaiting(): void;
}

export function useBilling(
  port: AgentRuntimePort,
  openExternal: (href: string) => Promise<boolean> | void,
  signedIn: boolean,
  accountPort?: Pick<AccountPort, 'load'>,
  generation?: string,
  onCheckoutChanged?: (error?: unknown) => void,
): BillingViewModel {
  const queryClient = useQueryClient();
  const [confirmingSince, setConfirmingSince] = useState<number | null>(null);
  const [slow, setSlow] = useState(false);
  const [browserPage, setBrowserPage] = useState<'checkout' | 'portal' | null>(null);
  const [flow, setFlow] = useState<'checkout' | 'portal' | null>(null);
  // Asking again aborts the Checkout already in flight, so the price the
  // latest request named is the one still open.
  const [checkoutPrice, setCheckoutPrice] = useState<string | null>(null);
  const waiting = confirmingSince !== null && !slow;

  const plans = useQuery({ ...billingPlansQuery(port), enabled: signedIn });
  const status = useQuery({
    ...billingStatusQuery(port, generation),
    enabled: signedIn,
    refetchInterval: (query) =>
      waiting || query.state.data?.changePending ? CONFIRM_POLL_MS : false,
  });
  const { refetch: refetchStatus } = status;
  const refreshStatus = useCallback(() => {
    // A command can discover expiry before this hook renders signed out.
    // Manual refetch bypasses the query's enabled flag, so read the owner here.
    if (queryClient.getQueryData<HostedAccount>(settingsQueryKeys.account)?.signedIn === false)
      return;
    void refetchStatus();
  }, [queryClient, refetchStatus]);
  // Returning from Checkout or the Portal focuses the window again.
  const resumeConfirmation = useCallback(() => {
    if (confirmingSince !== null) {
      setSlow(false);
      setConfirmingSince(Date.now());
    }
    refreshStatus();
  }, [confirmingSince, refreshStatus]);
  useWindowFocus(resumeConfirmation, signedIn);

  useEffect(() => {
    if (confirmingSince === null || slow) return;
    const timer = setTimeout(
      () => setSlow(true),
      Math.max(0, confirmingSince + CONFIRM_WINDOW_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [confirmingSince, slow]);

  useEffect(() => {
    if (confirmingSince === null || !status.data) return;
    if (flow === 'checkout') {
      if (!billingPaid(status.data)) return;
      setConfirmingSince(null);
      setFlow(null);
      setSlow(false);
    }
    void queryClient.invalidateQueries({ queryKey: settingsQueryKeys.agentAllowance });
    void queryClient.invalidateQueries({ queryKey: settingsQueryKeys.agentCatalog });
  }, [confirmingSince, flow, queryClient, status.data]);

  const openPage = async (url: string, kind: 'checkout' | 'portal', signal: AbortSignal) => {
    if (accountPort && generation) {
      const current = await accountPort.load(signal);
      signal.throwIfAborted();
      if (current.generation !== generation || !current.signedIn) {
        void queryClient.invalidateQueries({ queryKey: settingsQueryKeys.account, exact: true });
        throw new ReferralRequestError('referral_account_changed', 409);
      }
    }
    if ((await openExternal(url)) === false) throw new Error('The browser did not open.');
    signal.throwIfAborted();
    setFlow((current) => (current === 'checkout' ? current : kind));
    setSlow(false);
    setConfirmingSince(Date.now());
  };

  const checkout = useSettingsCommand(
    'billingCheckout',
    (input: ReferralCheckoutInput, signal) =>
      accountRequest(queryClient, signal, () => port.startCheckout(input, signal)),
    {
      readFailure: checkoutFailure,
      onStart: ({ priceId }) => {
        setBrowserPage('checkout');
        setCheckoutPrice(priceId);
      },
      onDone: (url, _input, signal) => openPage(url, 'checkout', signal),
      // A refusal such as an existing subscription changes what the panel
      // should offer, so the rights are read again.
      onFailed: (_input, error) => {
        void plans.refetch();
        refreshStatus();
        onCheckoutChanged?.(error);
      },
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: settingsQueryKeys.referrals });
        broadcastAccountChange('referrals');
      },
    },
  );
  const portal = useSettingsCommand(
    'billingPortal',
    (_input: void, signal) =>
      accountRequest(queryClient, signal, () => port.openBillingPortal(signal, generation)),
    {
      onStart: () => setBrowserPage('portal'),
      onDone: (url, _input, signal) => openPage(url, 'portal', signal),
    },
  );

  const change = useSettingsCommand(
    'billingChange',
    (input: BillingChange, signal) =>
      accountRequest(queryClient, signal, () => port.changeBilling(input, signal, generation)),
    { onSettled: refreshStatus },
  );

  return {
    busy: anyBusy(checkout, portal, change) || Boolean(status.data?.changePending),
    opening:
      checkout.busy && checkoutPrice !== null
        ? { page: 'checkout', priceId: checkoutPrice }
        : portal.busy
          ? { page: 'portal' }
          : null,
    browserPage,
    confirming: flow !== 'checkout' || confirmingSince === null ? null : slow ? 'slow' : 'waiting',
    // Each page names what did not open; a refusal such as an existing
    // subscription is already answered by the status read it triggers.
    failure:
      change.failure ??
      (browserPage === 'checkout' && checkout.failure
        ? checkout.failure
        : browserPage === 'portal' && portal.failure
          ? {
              message:
                'Could not open subscription management. Check your connection and default browser, then try again.',
              tone: portal.failure.tone,
            }
          : null),
    change: (input) => change.run(input),
    manage: () => portal.run(),
    plans: plans.data ?? [],
    plansFailed: plans.isError,
    refresh: () => {
      if (confirmingSince !== null) {
        setSlow(false);
        setConfirmingSince(Date.now());
      }
      void plans.refetch();
      refreshStatus();
    },
    status: status.data ?? null,
    statusFailed: status.isError,
    stopWaiting: () => {
      setFlow(null);
      setConfirmingSince(null);
      setSlow(false);
    },
    subscribe: (input) => checkout.run(input),
  };
}
