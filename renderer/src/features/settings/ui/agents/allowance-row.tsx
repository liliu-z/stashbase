import type { AgentAllowance } from '@/features/settings/domain/agent-catalog';
import { ProgressBar, SettingsRow } from '@/features/settings/ui/rows';
import { clamp } from '@/shared/utils/clamp';

export function AllowanceRow({ allowance }: { allowance: AgentAllowance }) {
  const percent = clamp(Math.round(allowance.remainingPercent), 0, 100);
  const reset = allowance.windowEndsAt
    ? new Date(allowance.windowEndsAt).toLocaleString([], {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  return (
    <SettingsRow
      as="li"
      detail={`${percent}% remaining${reset ? ` · Refills ${reset}` : ' · Resets every 7 days from first use'}`}
      title="Agent credits"
    >
      <ProgressBar value={percent} />
    </SettingsRow>
  );
}
