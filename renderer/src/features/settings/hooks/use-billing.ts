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

import type { AgentRuntimePort } from '@/features/settings/application/ports';
import {
  billingPlansQuery,
  billingStatusQuery,
  settingsQueryKeys,
} from '@/features/settings/application/queries';
import {
  billingPaid,
  type BillingPlan,
  type BillingStatus,
} from '@/features/settings/domain/billing';
import { anyBusy, useSettingsCommand } from '@/features/settings/hooks/use-settings-command';
import type { FailureView } from '@/shared/domain/feature-error';
import { useWindowFocus } from '@/shared/runtime/use-window-focus';

const CONFIRM_POLL_MS = 5_000;
const CONFIRM_WINDOW_MS = 120_000;

type BillingConfirmation = 'waiting' | 'slow';

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
  readonly opening: 'checkout' | 'portal' | null;
  readonly browserPage: 'checkout' | 'portal' | null;
  readonly failure: FailureView | null;
  subscribe(priceId: string): void;
  manage(): void;
  refresh(): void;
  /** Stops the local wait; it does not cancel anything in the browser. */
  stopWaiting(): void;
}

export function useBilling(
  port: AgentRuntimePort,
  openExternal: (href: string) => Promise<boolean> | void,
  signedIn: boolean,
): BillingViewModel {
  const queryClient = useQueryClient();
  const [confirmingSince, setConfirmingSince] = useState<number | null>(null);
  const [slow, setSlow] = useState(false);
  const [browserPage, setBrowserPage] = useState<'checkout' | 'portal' | null>(null);
  const [flow, setFlow] = useState<'checkout' | 'portal' | null>(null);
  const waiting = confirmingSince !== null && !slow;

  const plans = useQuery({ ...billingPlansQuery(port), enabled: signedIn });
  const status = useQuery({
    ...billingStatusQuery(port),
    enabled: signedIn,
    refetchInterval: waiting ? CONFIRM_POLL_MS : false,
  });
  const { refetch: refetchStatus } = status;
  const refreshStatus = useCallback(() => void refetchStatus(), [refetchStatus]);
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

  const openPage = async (url: string, kind: 'checkout' | 'portal') => {
    if ((await openExternal(url)) === false) throw new Error('The browser did not open.');
    setFlow((current) => (current === 'checkout' ? current : kind));
    setSlow(false);
    setConfirmingSince(Date.now());
  };

  const checkout = useSettingsCommand(
    'billingCheckout',
    (priceId: string, signal) => port.startCheckout(priceId, signal),
    {
      onStart: () => setBrowserPage('checkout'),
      onDone: (url) => openPage(url, 'checkout'),
      // A refusal such as an existing subscription changes what the panel
      // should offer, so the rights are read again.
      onFailed: refreshStatus,
    },
  );
  const portal = useSettingsCommand(
    'billingPortal',
    (_input: void, signal) => port.openBillingPortal(signal),
    { onStart: () => setBrowserPage('portal'), onDone: (url) => openPage(url, 'portal') },
  );

  return {
    busy: anyBusy(checkout, portal),
    opening: checkout.busy ? 'checkout' : portal.busy ? 'portal' : null,
    browserPage,
    confirming: flow !== 'checkout' || confirmingSince === null ? null : slow ? 'slow' : 'waiting',
    // Each page names what did not open; a refusal such as an existing
    // subscription is already answered by the status read it triggers.
    failure:
      browserPage === 'checkout' && checkout.failure
        ? { message: 'Could not open the payment page. Try again.', tone: checkout.failure.tone }
        : browserPage === 'portal' && portal.failure
          ? {
              message:
                'Could not open subscription management. Check your connection and default browser, then try again.',
              tone: portal.failure.tone,
            }
          : null,
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
    subscribe: (priceId) => checkout.run(priceId),
  };
}
