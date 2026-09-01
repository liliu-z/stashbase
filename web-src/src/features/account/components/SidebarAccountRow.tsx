import { electronBridge } from '@/common/lib/electronBridge';
import { BugIcon, DiscordIcon, ExternalLinkIcon, SettingsIcon, UserIcon } from '@/common/components/icons';
import { AccountAvatar, accountDisplayLabel } from '@/common/components/AccountIdentity';
import { useHostedAccount } from '@/features/account/hooks/useHostedAccount';
import { DISCORD_INVITE_URL, openExternalUrl } from '@/common/lib/externalLink';
import { openSettings } from '@/common/lib/settingsTrigger';
import { hostedQuotaRemainingPercent, hostedQuotaResetLabel } from '@/common/lib/hostedQuota';
import { DesktopUpdateBanner } from '@/common/components/DesktopUpdateBanner';
import { Button } from '@/common/components/ui/button';
import { Progress, ProgressIndicator, ProgressTrack } from '@/common/components/ui/progress';
import {
  Menu as AccountMenu,
  MenuItem,
  MenuPopup,
  MenuPortal,
  MenuPositioner,
  MenuSeparator,
  MenuTrigger,
} from '@/common/components/ui/menu';
import { cn } from '@/common/lib/utils';

/**
 * Bottom sidebar chrome: identity on the left and persistent utilities on the
 * right. Signed out is a complete local-workspace state; the account menu adds
 * sign-in and hosted-usage details without gating files or Exact search.
 */
export function SidebarAccountRow() {
  const { account, signingIn, signInError, refresh, signIn, signOut } = useHostedAccount();

  const email = account?.signedIn ? account.email ?? '' : '';
  const label = account?.signedIn ? accountDisplayLabel(account) : 'Sign in';
  const accessibleLabel = account?.signedIn && email && label !== email ? `${label} (${email})` : label;
  const quota = account?.quota;
  const remainingPercent = quota ? hostedQuotaRemainingPercent(quota) : null;

  return (
    <>
      {/* Rendered from this module so the update announcement ships in the
       * account-row lazy chunk — a second sidebar lazy import alone pushed
       * the initial-JS budget over. The banner floats above this row. */}
      <DesktopUpdateBanner />
      <div className="flex flex-none items-center gap-1 border-t border-border px-1.5 pt-2 pb-2.5">
        <AccountMenu onOpenChange={(open) => { if (open) refresh(true); }}>
          <MenuTrigger
            className="group/account flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-base text-muted-foreground hover:text-foreground"
            title="Account"
            aria-label={`Account: ${accessibleLabel}`}
          >
            {account?.signedIn
              ? <AccountAvatar account={account} className="size-4" initialsClassName="text-2xs" />
              : (
                // Preserve the long-standing signed-out affordance. Hosted
                // identity owns the new avatar/initial fallback only after
                // sign-in, so an account feature does not restyle local mode.
                <span className="relative inline-flex size-4 flex-none items-center justify-center">
                  <span className="absolute inset-[-3px] rounded-full bg-muted" aria-hidden="true" />
                  <UserIcon className="relative size-3.5" />
                </span>
              )}
            <span className={cn('min-w-0 truncate transition-tint', email ? 'text-muted-foreground' : 'text-placeholder group-hover/account:text-muted-foreground')}>
              {label}
            </span>
          </MenuTrigger>
          <MenuPortal>
            <MenuPositioner side="top" align="start" sideOffset={6} collisionPadding={8}>
              <MenuPopup className="w-72 max-w-overlay-fit p-0" aria-label="StashBase account">
                {account?.signedIn ? (
                  <>
                    {/* Static blocks inside a role="menu" popup take
                      * role="presentation" (the MenuSectionLabel idiom):
                      * a menu's own children may only be items, groups,
                      * separators, or presentation, and these rows are
                      * read-only identity/usage detail, not items. */}
                    <div role="presentation" className="flex items-center gap-2.5 px-4 py-3">
                      <AccountAvatar account={account} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{label}</div>
                        {label !== email && <div className="truncate text-xs text-muted-foreground">{email}</div>}
                      </div>
                    </div>
                    <MenuSeparator className="m-0" />
                    <div role="presentation" className="px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold">Remaining usage</span>
                        {remainingPercent !== null && <span className="text-sm text-muted-foreground">{remainingPercent}%</span>}
                      </div>
                      {quota ? (
                        <>
                          {/* The primitive, not an inline-width div: Root
                            * carries role="progressbar" with
                            * aria-valuenow/max, so the menu reports the
                            * remaining allowance as a number rather than a
                            * coloured rectangle only sighted users can
                            * read. The track takes the popup's full width
                            * instead of the primitive's inline step. */}
                          <Progress
                            className="mt-2 block"
                            aria-label="Remaining usage"
                            value={remainingPercent ?? 0}
                          >
                            <ProgressTrack className="w-full">
                              <ProgressIndicator className="bg-accent" />
                            </ProgressTrack>
                          </Progress>
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
                    <div role="presentation" className="p-1">
                      <MenuItem label="Learn more" onClick={() => openExternalUrl('https://stashbase.ai')}>
                        <span className="flex items-center gap-2"><ExternalLinkIcon className="size-4" />Learn more</span>
                      </MenuItem>
                      <MenuItem label="Sign out" onClick={signOut}>Sign out</MenuItem>
                    </div>
                  </>
                ) : (
                  <div role="presentation" className="p-1">
                    <MenuItem
                      className="items-start py-2"
                      label="Sign in to StashBase — Built-in Agent and optional hosted Similarity Search"
                      disabled={signingIn}
                      onClick={signIn}
                    >
                      <span className="flex min-w-0 items-start gap-2">
                        <ExternalLinkIcon className="mt-0.5 size-4 flex-none" />
                        <span className="grid min-w-0 gap-0.5">
                          <span>{signingIn ? 'Waiting for browser…' : 'Sign in to StashBase'}</span>
                          <span className="text-xs leading-snug text-muted-foreground">Built-in Agent and optional hosted Similarity Search</span>
                        </span>
                      </span>
                    </MenuItem>
                    {/* role="alert", so a failed sign-in is announced when
                      * it appears instead of sitting silently under the
                      * menu item that still has focus. */}
                    {signInError && <div role="alert" className="px-2 py-1.5 text-xs text-destructive">{signInError}</div>}
                  </div>
                )}
              </MenuPopup>
            </MenuPositioner>
          </MenuPortal>
        </AccountMenu>

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
    </>
  );
}
