/**
 * The StashBase account: who is signed in, and the two commands that change
 * it.
 *
 * A browser sign-in is tracked by its flow id and polled until the server
 * reports the flow finished. Either way the account changes, everything that
 * depends on it is re-read: the bundled Agent's readiness, credits, and
 * subscription.
 *
 * The sign-in dialog stays open through its own browser wait and shows it,
 * with the page again for a browser that did not open. A send waiting on the
 * account is held for as long as that dialog is open, whatever happens inside
 * it, and is let go only when the reader leaves it; the browser wait itself
 * carries on in the window until it finishes or is stopped.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { settingsFailure } from '@/features/settings/application/failure-messages';
import type { AccountPort } from '@/features/settings/application/ports';
import { accountQuery, settingsQueryKeys } from '@/features/settings/application/queries';
import type { AccountOffer, HostedAccount } from '@/features/settings/domain/account';
import {
  anyBusy,
  firstCommandFailure,
  useSettingsCommand,
} from '@/features/settings/hooks/use-settings-command';
import type { FailureView } from '@/shared/domain/feature-error';

const SIGN_IN_POLL_MS = 1_500;

/** The keys a changed account invalidates, in the order a reader would notice
 *  them. The account itself is written from the command's answer. */
const DEPENDENT_KEYS = [
  settingsQueryKeys.agentCatalog,
  settingsQueryKeys.agentAllowance,
  settingsQueryKeys.billingStatus,
] as const;

export interface AccountViewModel {
  /** Null until the first read lands, or while it cannot. */
  readonly account: HostedAccount | null;
  /** Any account command is open, including the browser round trip. */
  readonly busy: boolean;
  readonly failure: FailureView | null;
  readonly loading: boolean;
  readonly loadFailed: boolean;
  retryAccount(): void;
  /** Hands a page to the system browser, as sign-in does. */
  openExternal(href: string): Promise<boolean> | void;
  /** The browser round trip is open: started, and not yet reported finished. */
  readonly signInPending: boolean;
  /** The page the open browser flow started on, for a browser that did not
   *  open by itself. Null when no flow is open. */
  readonly signInUrl: string | null;
  /** A browser flow is open and its local wait can be stopped. */
  readonly canStopWaiting: boolean;
  /** Stops local polling; it does not revoke authorization in the browser. */
  stopWaiting(): void;
  /** Opens the sign-in dialog, which shows the browser wait while one is
   *  open. */
  signIn(): void;
  readonly accessOpen: boolean;
  /** The reader left the dialog. A send waiting on it is let go; a browser
   *  wait carries on in the window. */
  closeAccess(): void;
  /** Starts the flow and hands its page to the browser, keeping the dialog
   *  open on the wait. */
  signInWithGoogle(): void;
  emailSignedIn(next: HostedAccount): void;
  /** Opens the sign-in dialog and waits for it: true once signed in, false
   *  once the reader leaves it. Aborting the caller never revokes browser
   *  authorization. */
  signInAndWait(signal: AbortSignal): Promise<boolean>;
  signOut(): void;
  /** Records an account banner as taken up or declined. */
  markOfferSeen(offer: AccountOffer): void;
  /** Development: shows every account banner again. */
  resetOffers(): void;
}

export function useAccount(
  port: AccountPort,
  openExternal: (href: string) => Promise<boolean> | void,
): AccountViewModel {
  const queryClient = useQueryClient();
  const account = useQuery(accountQuery(port));
  const [signInFlow, setSignInFlow] = useState<string | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<FailureView | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const command = useRef<'sign-in' | 'sign-out' | null>(null);
  const waiters = useRef(new Set<(success: boolean) => void>());
  const finishWaiters = useCallback((success: boolean) => {
    for (const finish of waiters.current) finish(success);
    waiters.current.clear();
  }, []);
  useEffect(() => () => finishWaiters(false), [finishWaiters]);

  const flow = useQuery({
    enabled: signInFlow !== null,
    queryFn: ({ signal }) => port.signInStatus(signInFlow ?? '', signal),
    queryKey: [...settingsQueryKeys.account, 'sign-in', signInFlow] as const,
    refetchInterval: (query) => (query.state.data?.state === 'pending' ? SIGN_IN_POLL_MS : false),
    retry: false,
  });

  const invalidateDependents = useCallback(() => {
    for (const queryKey of DEPENDENT_KEYS) void queryClient.invalidateQueries({ queryKey });
  }, [queryClient]);

  // A flow that fails leaves the dialog, when it is open, saying why and
  // offering the choices again, so a send waiting on it keeps waiting.
  useEffect(() => {
    if (signInFlow && flow.isError) {
      command.current = null;
      setSignInFlow(null);
      setSignInError(settingsFailure(flow.error));
      return;
    }
    if (!signInFlow || !flow.data || flow.data.state === 'pending') return;
    command.current = null;
    setSignInFlow(null);
    if (flow.data.state === 'error') {
      setSignInError({ message: flow.data.error, tone: 'input' });
      return;
    }
    setAccessOpen(false);
    void queryClient.invalidateQueries({ queryKey: settingsQueryKeys.account });
    invalidateDependents();
    finishWaiters(true);
  }, [
    finishWaiters,
    flow.data,
    flow.error,
    flow.isError,
    invalidateDependents,
    queryClient,
    signInFlow,
  ]);

  const stopWaiting = () => {
    if (!signInFlow) return;
    void queryClient.cancelQueries({
      queryKey: [...settingsQueryKeys.account, 'sign-in', signInFlow],
      exact: true,
    });
    setSignInFlow(null);
    setSignInError(null);
    command.current = null;
  };

  const startSignIn = useSettingsCommand(
    'startSignIn',
    async (_input: void, signal) => {
      const started = await port.startSignIn(signal);
      signal.throwIfAborted();
      return started;
    },
    {
      onStart: () => setSignInError(null),
      onFailed: () => {
        command.current = null;
      },
      onDone: (started) => {
        // The page is kept whatever the browser answers: a browser that did
        // not open leaves the reader the link, not a wait with no way on.
        setSignInUrl(started.url);
        setSignInFlow(started.flowId);
        void Promise.resolve(openExternal(started.url)).catch(() => false);
      },
    },
  );
  const signOut = useSettingsCommand('signOut', (_input: void, signal) => port.signOut(signal), {
    onStart: () => queryClient.cancelQueries({ queryKey: settingsQueryKeys.account, exact: true }),
    onSettled: () => {
      command.current = null;
    },
    onDone: (next) => {
      queryClient.setQueryData(settingsQueryKeys.account, next);
      invalidateDependents();
    },
  });

  const writeAccount = (next: HostedAccount) => {
    queryClient.setQueryData(settingsQueryKeys.account, next);
  };
  const markOfferSeen = useSettingsCommand<AccountOffer, HostedAccount>(
    'markOfferSeen',
    (offer: AccountOffer, signal) => port.markOfferSeen(offer, signal),
    {
      // The banner leaves at once; the answer confirms it.
      onStart: (offer) => {
        const current = queryClient.getQueryData<HostedAccount>(settingsQueryKeys.account);
        if (current)
          writeAccount({ ...current, offers: current.offers.filter((o) => o !== offer) });
      },
      onDone: writeAccount,
    },
  );
  const resetOffers = useSettingsCommand(
    'resetOffers',
    (_input: void, signal) => port.resetOffers(signal),
    { onDone: writeAccount },
  );

  const signInWithGoogle = () => {
    if (command.current || !account.data) return;
    command.current = 'sign-in';
    startSignIn.run();
  };

  // While a browser wait is open this reopens the dialog on it, so every
  // entry that offers sign-in leads to the one place the wait is shown.
  const signIn = () => {
    if (command.current === 'sign-out' || !account.data) return;
    setAccessOpen(true);
  };

  // One pending flag spans the whole browser round trip: the start call and
  // the poll that follows it are a single wait as far as the reader is
  // concerned, and a button must not flicker back between them.
  const signInPending = startSignIn.busy || signInFlow !== null;

  return {
    account: account.data ?? null,
    busy: signInPending || anyBusy(signOut),
    failure:
      (account.isError ? settingsFailure(account.error) : null) ??
      signInError ??
      firstCommandFailure(startSignIn, signOut),
    loading: account.isFetching,
    loadFailed: account.isError,
    openExternal,
    retryAccount: () => {
      void account.refetch({ cancelRefetch: false });
    },
    signIn,
    accessOpen,
    closeAccess: () => {
      setAccessOpen(false);
      void queryClient.invalidateQueries({ queryKey: settingsQueryKeys.account });
      finishWaiters(false);
    },
    signInWithGoogle,
    emailSignedIn: (next) => {
      setAccessOpen(false);
      // A recovery read may still describe the expired account. Retire it
      // before publishing the new sign-in, even if its transport answers late.
      void queryClient.cancelQueries({ queryKey: settingsQueryKeys.account, exact: true });
      writeAccount(next);
      invalidateDependents();
      finishWaiters(true);
    },
    signInAndWait: (signal) => {
      if (signal.aborted || !account.data || command.current === 'sign-out')
        return Promise.resolve(false);
      // Signed in elsewhere already, such as in another window or by a
      // browser wait the reader left running.
      if (account.data.signedIn) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const finish = (success: boolean) => {
          signal.removeEventListener('abort', abort);
          waiters.current.delete(finish);
          resolve(success);
        };
        const abort = () => finish(false);
        waiters.current.add(finish);
        signal.addEventListener('abort', abort, { once: true });
        signIn();
      });
    },
    signInPending,
    signInUrl: signInFlow !== null ? signInUrl : null,
    canStopWaiting: signInFlow !== null,
    stopWaiting,
    markOfferSeen: (offer) => markOfferSeen.run(offer),
    resetOffers: () => resetOffers.run(),
    signOut: () => {
      if (command.current) return;
      command.current = 'sign-out';
      signOut.run();
    },
  };
}
