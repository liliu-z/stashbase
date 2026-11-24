/**
 * The sign-in banner the window strip carries while signed out. It is shown
 * until the reader signs in or declines it, and the host remembers that across
 * launches until the next sign-out, which brings it back. The sidebar's
 * account row stays the account's only home; the banner only points at it.
 */
import { useAccountView } from '@/features/settings/hooks/account-context';
import type { WorkspaceNotice } from '@/shared/domain/workspace-notice';

export function useAccountOffers(): readonly WorkspaceNotice[] {
  const account = useAccountView();
  const person = account.account;
  if (!person || person.signedIn || !person.offers.includes('sign-in')) return [];
  // The wait is the same banner in the same place, so the strip does not jump
  // from centred to a row while the browser is out. Like every browser wait it
  // offers the sign-in page, in case the browser never appeared, and stopping
  // is its way out.
  if (account.signInPending) {
    const page = account.signInUrl;
    return [
      {
        action: page
          ? { label: 'Open sign-in page', onAct: () => void account.openExternal(page) }
          : null,
        dismissLabel: 'Stop waiting',
        message: 'Finish signing in to StashBase in your browser.',
        offer: 'wait',
        onDismiss: account.canStopWaiting ? account.stopWaiting : null,
        tone: 'capability',
      },
    ];
  }
  return [
    {
      action: { label: 'Sign in', onAct: account.signIn },
      dismissLabel: 'Not now',
      // What signing in gives, not a commitment to the StashBase Agent nor the
      // allowance's terms, which Settings → Account shows.
      message: 'Sign in for free agent credits every month.',
      offer: 'invitation',
      onDismiss: () => account.markOfferSeen('sign-in'),
      tone: 'capability',
    },
  ];
}
