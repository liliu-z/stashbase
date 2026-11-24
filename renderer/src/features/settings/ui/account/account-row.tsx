import { Button } from '@/components/ui/button';
import { accountLabel } from '@/features/settings/domain/account';
import type { AccountViewModel } from '@/features/settings/hooks/use-account';
import { SettingsRow } from '@/features/settings/ui/rows';
import { FailureNotice } from '@/shared/ui/failure-notice';
import { SignInPageLink } from '@/shared/ui/sign-in-page-link';

/** The account the StashBase Agent runs on. A browser sign-in that waits keeps
 *  Sign in's name on its spinner and says what it waits for in the detail
 *  line, with the page again and Stop waiting, as every browser wait does. */
export function AccountRow({ account }: { account: AccountViewModel }) {
  const signedIn = account.account?.signedIn ?? false;
  return (
    <SettingsRow
      as="li"
      detail={
        account.account === null
          ? account.loading
            ? 'Checking…'
            : 'Account unavailable.'
          : signedIn
            ? [account.account.displayName, account.account.email]
                .filter((part): part is string => part !== null)
                .join(' · ') || accountLabel(account.account)
            : account.signInPending
              ? 'Finish signing in to StashBase in your browser.'
              : 'Sign in for free agent credits every month.'
      }
      title="Account"
      trail={
        account.loadFailed ? (
          <Button
            disabled={account.loading || account.busy}
            onClick={account.retryAccount}
            size="compact"
            variant="tertiary"
          >
            Retry
          </Button>
        ) : signedIn ? (
          <Button
            disabled={account.busy}
            onClick={() => account.signOut()}
            size="compact"
            variant="ghost"
          >
            Sign out
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              disabled={account.busy || account.account === null}
              loading={account.signInPending}
              onClick={() => account.signIn()}
              size="compact"
              variant="tertiary"
            >
              Sign in
            </Button>
            {account.canStopWaiting && (
              <Button onClick={account.stopWaiting} size="compact" variant="ghost">
                Stop waiting
              </Button>
            )}
          </div>
        )
      }
    >
      {!signedIn && account.signInUrl && (
        <SignInPageLink
          className="mt-1"
          url={account.signInUrl}
          onOpen={(url) => void account.openExternal(url)}
        />
      )}
      {account.failure && <FailureNotice className="mt-1" failure={account.failure} />}
    </SettingsRow>
  );
}
