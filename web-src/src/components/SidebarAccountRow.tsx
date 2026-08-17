import { useEffect, useState } from 'react';
import { electronBridge } from '../electronBridge';
import { BugIcon, DiscordIcon, ExternalLinkIcon, SettingsIcon, UserIcon } from '../icons';
import { api, errorMessage, type HostedAccountState } from '../api';
import { ACCOUNT_CHANGED_EVENT, notifyAccountChanged } from '../accountEvents';
import { signInWithStashBase } from '../accountOAuth';
import { DISCORD_INVITE_URL, openExternalUrl } from '../lib/externalLink';
import { openSettings } from './SettingsModal';
import { hostedQuotaRemainingPercent, hostedQuotaResetLabel } from '../lib/hostedQuota';
import { useDesktopUpdate } from '../hooks/useDesktopUpdate';
import { Button } from './ui/button';
import {
  Menu as AccountMenu,
  MenuItem,
  MenuPopup,
  MenuPortal,
  MenuPositioner,
  MenuSeparator,
  MenuTrigger,
} from './ui/menu';

/**
 * Bottom sidebar chrome: identity on the left and persistent utilities on the
 * right. Anonymous is a complete local-workspace state; the account menu adds
 * sign-in and hosted-usage details without gating files or Exact search.
 */
export function SidebarAccountRow() {
  const [account, setAccount] = useState<HostedAccountState | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const { state: updateState, runPrimaryAction } = useDesktopUpdate();

  function refresh(refreshUsage = false) {
    api.getAccount(refreshUsage).then(setAccount).catch(() => { /* local server startup race */ });
  }

  useEffect(() => {
    refresh(false);
    const onChanged = () => refresh(false);
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, onChanged);
  }, []);

  const email = account?.signedIn ? account.email ?? '' : '';
  const label = email || 'Anonymous';
  const monogram = email ? email.slice(0, 2).toUpperCase() : '';
  const quota = account?.quota;
  const remainingPercent = quota ? hostedQuotaRemainingPercent(quota) : null;
  const showUpdate = updateState?.autoCheckEnabled === true
    && typeof updateState.availableVersion === 'string';
  const updateLabel = updateState?.phase === 'ready'
    ? 'Install update'
    : updateState?.phase === 'downloading'
      ? `Downloading${updateState.percent === undefined ? '…' : ` ${updateState.percent}%`}`
      : updateState?.phase === 'installing'
        ? 'Installing…'
        : updateState?.phase === 'error'
          ? 'Retry update'
          : 'Update';

  function signOut() {
    void api.signOutAccount()
      .then(() => {
        notifyAccountChanged();
        refresh(false);
      })
      .catch(() => { /* Settings remains the recovery surface */ });
  }

  function signIn() {
    setSigningIn(true);
    setSignInError(null);
    void signInWithStashBase('google')
      .then(setAccount)
      .catch((error: unknown) => setSignInError(errorMessage(error)))
      .finally(() => setSigningIn(false));
  }

  return (
    <div className="flex flex-none items-center gap-1 border-t border-border px-1.5 pt-2 pb-2.5">
      <AccountMenu onOpenChange={(open) => { if (open) refresh(true); }}>
        <MenuTrigger
          className="group/account flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-base text-muted-foreground hover:text-foreground"
          title="Account"
          aria-label={`Account: ${label}`}
        >
          <span className="relative inline-flex size-4 flex-none items-center justify-center">
            <span className="absolute inset-[-3px] rounded-full bg-muted" aria-hidden="true" />
            {monogram
              ? <span className="relative text-2xs font-semibold text-foreground">{monogram}</span>
              : <UserIcon className="relative size-3.5" />}
          </span>
          <span className={`min-w-0 truncate transition-colors ${email ? 'text-muted-foreground' : 'text-placeholder group-hover/account:text-muted-foreground'}`}>
            {label}
          </span>
        </MenuTrigger>
        <MenuPortal>
          <MenuPositioner side="top" align="start" sideOffset={6} collisionPadding={8}>
            <MenuPopup className="w-72 max-w-[calc(100vw-24px)] p-0" aria-label="StashBase account">
              {account?.signedIn ? (
                <>
                  <div className="flex items-center gap-2.5 px-4 py-3">
                    <span className="flex size-8 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">{monogram}</span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{email.split('@')[0]}</div>
                      <div className="truncate text-xs text-muted-foreground">{email}</div>
                    </div>
                  </div>
                  <MenuSeparator className="m-0" />
                  <div className="px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold">Remaining usage</span>
                      {remainingPercent !== null && <span className="text-sm text-muted-foreground">{remainingPercent}%</span>}
                    </div>
                    {quota ? (
                      <>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-accent" style={{ width: `${remainingPercent}%` }} />
                        </div>
                        <div className="mt-2 flex justify-between gap-3 text-xs text-muted-foreground">
                          <span>{quota.remainingTokens.toLocaleString()} tokens</span>
                          <span>{hostedQuotaResetLabel(quota)}</span>
                        </div>
                      </>
                    ) : (
                      <div className="mt-2 text-xs text-muted-foreground">Usage is temporarily unavailable.</div>
                    )}
                  </div>
                  <MenuSeparator className="m-0" />
                  <div className="p-1">
                    <MenuItem label="Learn more" onClick={() => openExternalUrl('https://stashbase.ai')}>
                      <span className="flex items-center gap-2"><ExternalLinkIcon className="size-4" />Learn more</span>
                    </MenuItem>
                    <MenuItem label="Sign out" onClick={signOut}>Sign out</MenuItem>
                  </div>
                </>
              ) : (
                <div className="p-1">
                  <MenuItem
                    className="items-start py-2"
                    label="Sign in to StashBase — Free monthly AI Index usage"
                    disabled={signingIn}
                    onClick={signIn}
                  >
                    <span className="flex min-w-0 items-start gap-2">
                      <ExternalLinkIcon className="mt-0.5 size-4 flex-none" />
                      <span className="grid min-w-0 gap-0.5">
                        <span>{signingIn ? 'Waiting for browser…' : 'Sign in to StashBase'}</span>
                        <span className="text-xs leading-snug text-muted-foreground">Free monthly AI Index usage</span>
                      </span>
                    </span>
                  </MenuItem>
                  {signInError && <div className="px-2 py-1.5 text-xs text-destructive">{signInError}</div>}
                </div>
              )}
            </MenuPopup>
          </MenuPositioner>
        </MenuPortal>
      </AccountMenu>

      {showUpdate ? (
        <Button
          variant="secondary"
          size="xs"
          disabled={updateState?.phase === 'downloading' || updateState?.phase === 'installing'}
          aria-label={`${updateLabel} to StashBase ${updateState?.availableVersion}`}
          title={`StashBase ${updateState?.availableVersion} is available`}
          className="max-w-28 flex-none"
          onClick={() => { void runPrimaryAction(); }}
        >
          <span className="truncate">{updateLabel}</span>
        </Button>
      ) : (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Join the StashBase Discord"
            title="Join the StashBase Discord"
            className="flex-none text-muted-foreground"
            onClick={() => { openExternalUrl(DISCORD_INVITE_URL); }}
          >
            <DiscordIcon className="size-4" />
          </Button>
          {/* Report Bug — opens the desktop app's local review window, the same
            * deliberate entry as Help → Report a Bug…. The flow lives in the
            * Electron main process, so the browser dev shell keeps the dimmed
            * placeholder. */}
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!electronBridge()?.reportBug}
            aria-label={electronBridge()?.reportBug ? 'Report a bug' : 'Report a bug (desktop app only)'}
            title={electronBridge()?.reportBug ? 'Report a bug' : 'Report a bug (desktop app only)'}
            className="flex-none text-muted-foreground"
            onClick={() => { void electronBridge()?.reportBug?.(); }}
          >
            <BugIcon className="size-4" />
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Settings"
        title="Settings"
        className="flex-none text-muted-foreground"
        onClick={() => { openSettings(); }}
      >
        <SettingsIcon className="size-4" />
      </Button>
    </div>
  );
}
