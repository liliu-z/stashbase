import { useQuery } from '@tanstack/react-query';

import type { AgentRuntimePort } from '@/features/settings/application/ports';
import { agentAllowanceQuery } from '@/features/settings/application/queries';
import { ReferralRequestError } from '@/features/settings/domain/referrals';
import { useAccountPort, useAccountView } from '@/features/settings/hooks/account-context';
import { useBilling } from '@/features/settings/hooks/use-billing';
import { useReferrals } from '@/features/settings/hooks/use-referrals';
import { AllowanceRow } from '@/features/settings/ui/agents/allowance-row';
import { SubscriptionRows } from '@/features/settings/ui/agents/subscription-rows';
import {
  SettingsGroup,
  SettingsList,
  SettingsMessage,
  SettingsPane,
} from '@/features/settings/ui/rows';
import { useWindowFocus } from '@/shared/runtime/use-window-focus';

import { AccountMethods } from './account-methods';
import { AccountRow } from './account-row';
import { ReferralRows } from './referral-rows';

export function AccountPanel({ agentRuntimeApi }: { agentRuntimeApi: AgentRuntimePort }) {
  const account = useAccountView();
  const generation = account.account?.generation;
  return (
    <SettingsPane title="Account">
      <SettingsGroup>
        <SettingsList as="ul">
          <AccountRow account={account} />
        </SettingsList>
      </SettingsGroup>
      {account.account?.signedIn && (
        <SignedInAccount
          agentRuntimeApi={agentRuntimeApi}
          generation={generation ?? ''}
          key={generation ?? account.account.email}
        />
      )}
    </SettingsPane>
  );
}

function SignedInAccount({
  agentRuntimeApi,
  generation,
}: {
  agentRuntimeApi: AgentRuntimePort;
  generation: string;
}) {
  const account = useAccountView();
  const port = useAccountPort();
  const referrals = useReferrals(port.referrals, generation);
  const billing = useBilling(
    agentRuntimeApi,
    account.openExternal,
    true,
    port,
    generation,
    (error) => {
      const reason = error;
      if (
        reason instanceof ReferralRequestError &&
        reason.status < 500 &&
        !['rate_limited', 'referral_operation_in_progress'].includes(reason.code)
      ) {
        referrals.resetChoice();
      }
    },
  );
  const allowance = useQuery(agentAllowanceQuery(agentRuntimeApi, generation || undefined));
  useWindowFocus(allowance.refetch, true);
  return (
    <>
      <AccountMethods />
      <SettingsGroup title="Credits and subscription">
        <SettingsList as="ul">
          {allowance.isError ? (
            <SettingsMessage
              as="li"
              message="Could not load your credit balance."
              onRetry={() => void allowance.refetch()}
            />
          ) : allowance.data ? (
            <AllowanceRow allowance={allowance.data} />
          ) : (
            <SettingsMessage as="li" message="Checking credits…" />
          )}
          <SubscriptionRows billing={billing} referrals={referrals} />
        </SettingsList>
      </SettingsGroup>
      <ReferralRows referrals={referrals} />
    </>
  );
}
