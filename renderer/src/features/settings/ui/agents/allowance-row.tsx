import {
  creditHoldDetail,
  formatCredits,
  reservedCreditsDetail,
} from '@/features/settings/domain/agent-allowance';
import type { AgentAllowance } from '@/features/settings/domain/agent-catalog';
import { accountDate } from '@/features/settings/domain/referrals';
import { ProgressBar, SettingsRow } from '@/features/settings/ui/rows';
import { clamp } from '@/shared/utils/clamp';

export function AllowanceRow({ allowance }: { allowance: AgentAllowance }) {
  const { creditBreakdown } = allowance;
  if (creditBreakdown) {
    const { base, bonus, agentAvailableCredits } = creditBreakdown;
    return (
      <SettingsRow
        as="li"
        title="Credits"
        detail={`${formatCredits(agentAvailableCredits)} Agent credits available`}
      >
        <dl className="grid gap-1 text-caption text-muted-foreground">
          <div className="flex flex-wrap gap-x-2">
            <dt>Base</dt>
            <dd>
              {formatCredits(base.availableCredits)} available ·{' '}
              {base.windowEndsAt
                ? `Refills ${accountDate(base.windowEndsAt)}`
                : 'Refills one month after first use'}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt>Bonus</dt>
            <dd>
              {formatCredits(bonus.availableCredits)} available
              {bonus.nextExpiry &&
                ` · ${formatCredits(bonus.nextExpiry.availableCredits)} expires ${accountDate(bonus.nextExpiry.at)}`}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt>In use</dt>
            <dd>{creditHoldDetail(creditBreakdown)}</dd>
          </div>
        </dl>
      </SettingsRow>
    );
  }
  const percent = clamp(Math.round(allowance.remainingPercent), 0, 100);
  const reset = allowance.windowEndsAt
    ? new Date(allowance.windowEndsAt).toLocaleString([], {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  const reserved = reservedCreditsDetail(allowance);

  return (
    <SettingsRow
      as="li"
      detail={`${percent}% available${reserved ? ` · ${reserved}` : ''} · Refills ${reset ?? 'one month after first use'}`}
      title="Credits"
    >
      <ProgressBar value={percent} />
    </SettingsRow>
  );
}
