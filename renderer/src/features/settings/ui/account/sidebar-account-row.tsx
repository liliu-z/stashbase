/**
 * The sidebar's account row, at the foot of the window's left column.
 *
 * Signed out it is one button that opens the sign-in dialog, where the
 * reader chooses email or Google; what the account is worth (the bundled
 * Agent's free credits) is stated in Settings → Account rather than inside
 * this row. It is the same dialog the Agents section opens, through the same
 * account, so the two entries can never disagree. While a browser sign-in
 * waits, the row keeps its name and turns its glyph into a spinner, and
 * opens the dialog on that wait. Signed in, the row leads with the same
 * person glyph as every other sidebar row, and its menu opens on the
 * initials disc, then the credits, Plans and billing (the plan in
 * Settings → Account), Sign-in methods, Settings, and sign-out.
 */
import { useQuery } from '@tanstack/react-query';
import {
  CreditCard,
  Gauge,
  KeyRound,
  LoaderCircle,
  LogOut,
  Settings as SettingsIcon,
  UserRound,
} from 'lucide-react';

import {
  DropdownContent,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from '@/components/ui/dropdown';
import { MenuItem } from '@/components/ui/menu-item';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar-menu';
import type { AgentRuntimePort } from '@/features/settings/application/ports';
import { agentAllowanceQuery } from '@/features/settings/application/queries';
import { accountLabel } from '@/features/settings/domain/account';
import {
  creditHoldDetail,
  formatCredits,
  reservedCreditsDetail,
} from '@/features/settings/domain/agent-allowance';
import { useAccountView } from '@/features/settings/hooks/account-context';
import { ProgressBar } from '@/features/settings/ui/rows';
import type { IconComponentProps } from '@/lib/icon-context';
import { useSize } from '@/lib/size-context';
import { cn } from '@/lib/utils';
import { useWindowFocus } from '@/shared/runtime/use-window-focus';
import { FailureNotice } from '@/shared/ui/failure-notice';
import { clamp } from '@/shared/utils/clamp';

import { AccountAvatar } from './account-avatar';

export interface SidebarAccountRowProps {
  agentRuntimeApi: AgentRuntimePort;
  /** Opens Settings — the menu is its sidebar home, not a standing row. */
  onOpenSettings(): void;
  /** Opens the subscription, which lives with the credits in Settings → Account. */
  onOpenAccount(): void;
}

/** The menu hangs off the account row and is read as the bottom of the left
 *  column, so its rows keep the sidebar's own geometry rather than the compact
 *  step's tighter menu spacing: the 8px inset and 8px glyph gap that
 *  sidebar-menu-button writes, around the same 14px glyph. Without it a menu
 *  row's label sat 6px left of the sidebar label directly beneath it. */
const SIDEBAR_ROW = 'gap-2 px-2';

/** The row's glyph while a browser sign-in waits: ongoing work is a spinner,
 *  never a dot, and the label keeps the action's name. */
function SignInWaiting({ className, ...props }: IconComponentProps) {
  return <LoaderCircle {...props} className={cn(className, 'motion-safe:animate-spin')} />;
}

export function SidebarAccountRow({
  agentRuntimeApi,
  onOpenAccount,
  onOpenSettings,
}: SidebarAccountRowProps) {
  const account = useAccountView();
  // The menu inherits the sidebar's compact step through the portal, so its
  // glyphs are the column's own 14px. Only the icon size comes from the step:
  // the inset and the glyph gap are the sidebar's, not the step's — see
  // SIDEBAR_ROW below.
  const sizeClasses = useSize();
  const person = account.account;
  const signedIn = person?.signedIn ?? false;
  const credits = useQuery({
    ...agentAllowanceQuery(agentRuntimeApi, person?.generation),
    enabled: signedIn,
  });

  useWindowFocus(credits.refetch, signedIn);

  if (!person || !signedIn) {
    return (
      <>
        {/* No account, no menu — Settings keeps a standing row so the
         *  complete local workspace stays reachable signed out. */}
        <SidebarMenuItem>
          <SidebarMenuButton icon={SettingsIcon} label="Settings" onClick={onOpenSettings} />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            // A browser wait leaves the row live: it opens the dialog on
            // that wait, which has the page again and Stop waiting.
            disabled={account.loading || (!person && !account.loadFailed)}
            icon={account.signInPending ? SignInWaiting : UserRound}
            // The row is the action and nothing else, the length of Gallery
            // and Settings above it. It used to carry the reason inline in a
            // second tone, which made the one row in the column that reads as
            // a sentence; the offer belongs where it is acted on, so Settings
            // → Account states it. The label is the row's name, so it needs no
            // hover hint repeating it; the failure under a Retry says what
            // failed.
            label={account.loadFailed ? 'Retry' : 'Sign in'}
            onClick={account.loadFailed ? account.retryAccount : account.signIn}
          />
          {account.failure && <FailureNotice className="px-2 pb-1" failure={account.failure} />}
        </SidebarMenuItem>
      </>
    );
  }

  const label = accountLabel(person);
  const breakdown = credits.isError ? undefined : credits.data?.creditBreakdown;
  const percent =
    breakdown || credits.isError || credits.data === undefined
      ? null
      : clamp(Math.round(credits.data.remainingPercent), 0, 100);
  const reserved = percent !== null && credits.data ? reservedCreditsDetail(credits.data) : null;
  return (
    <SidebarMenuItem>
      <DropdownMenu
        disabled={account.busy}
        onOpenChange={(open) => {
          if (open) void credits.refetch();
        }}
      >
        <DropdownTrigger
          render={
            <SidebarMenuButton
              aria-label={`Account: ${label}`}
              label={label}
              // The same glyph as the signed-out row: the name beside it says
              // who, so the row needs no initials disc of its own, and it keeps
              // the column's glyph-and-label rhythm. The menu's header keeps
              // the disc, where it heads the account's details.
              icon={UserRound}
            />
          }
        />
        <DropdownContent align="start" className="w-72" side="top">
          <DropdownLabel className="flex items-center gap-2.5 text-foreground">
            <AccountAvatar account={person} size={32} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{label}</span>
              {person.email && person.email !== label && (
                <span className="block truncate text-muted-foreground">{person.email}</span>
              )}
            </span>
          </DropdownLabel>
          <DropdownSeparator />
          <DropdownLabel>
            <span
              className={cn(
                'flex items-center justify-between gap-3 text-foreground',
                sizeClasses.text,
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                <Gauge
                  aria-hidden="true"
                  className="text-muted-foreground"
                  size={sizeClasses.icon}
                  strokeWidth={1.5}
                />
                Agent credits
              </span>
              <span className="text-muted-foreground">
                {breakdown
                  ? formatCredits(breakdown.agentAvailableCredits)
                  : percent !== null
                    ? `${percent}%`
                    : credits.isError
                      ? 'Unavailable'
                      : '…'}
              </span>
            </span>
            {percent !== null && <ProgressBar className="mt-1.5" value={percent} />}
            {breakdown && (
              <span className="mt-1.5 block text-muted-foreground">
                {formatCredits(breakdown.base.availableCredits)} base ·{' '}
                {formatCredits(breakdown.bonus.availableCredits)} bonus
                <br />
                {creditHoldDetail(breakdown)}
              </span>
            )}
            {reserved && (
              <span
                className="mt-1.5 block text-muted-foreground"
                title="Reserved for active requests or fees awaiting confirmation. These credits are excluded from the available balance."
              >
                {reserved}
              </span>
            )}
          </DropdownLabel>
          <MenuItem
            className={SIDEBAR_ROW}
            icon={CreditCard}
            label="Plans and billing"
            onSelect={onOpenAccount}
          />
          <DropdownSeparator />
          <MenuItem
            className={SIDEBAR_ROW}
            icon={KeyRound}
            label="Sign-in methods"
            onSelect={onOpenAccount}
          />
          <MenuItem
            className={SIDEBAR_ROW}
            icon={SettingsIcon}
            label="Settings"
            onSelect={onOpenSettings}
          />
          <MenuItem
            className={SIDEBAR_ROW}
            icon={LogOut}
            label="Sign out"
            onSelect={() => account.signOut()}
          />
        </DropdownContent>
      </DropdownMenu>
      {account.failure && <FailureNotice className="px-2 pb-1" failure={account.failure} />}
    </SidebarMenuItem>
  );
}
