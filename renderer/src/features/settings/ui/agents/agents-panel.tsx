/** Each Agent owns its connection controls; Default groups account and credits. */
import { Button } from '@/components/ui/button';
import type { AgentRuntimePort } from '@/features/settings/application/ports';
import { accountLabel } from '@/features/settings/domain/account';
import type { AgentRuntime } from '@/features/settings/domain/agent-catalog';
import type { AgentRuntimeAction } from '@/features/settings/domain/agent-runtime-status';
import { useAccountView } from '@/features/settings/hooks/account-context';
import type { AccountViewModel } from '@/features/settings/hooks/use-account';
import { useAgentRuntimes } from '@/features/settings/hooks/use-agent-runtimes';
import {
  SettingsGroup,
  SettingsList,
  SettingsMessage,
  SettingsPane,
  SettingsRow,
} from '@/features/settings/ui/rows';
import { FailureNotice } from '@/shared/ui/failure-notice';

import { AllowanceRow } from './allowance-row';
import { RuntimeRow } from './runtime-row';

export interface AgentRuntimesPanelProps {
  agentRuntimeApi: AgentRuntimePort;
}

function AccountRow({ account }: { account: AccountViewModel }) {
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
            : 'Sign in for free Agent credits.'
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
            Retry account
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
              {account.signInPending ? 'Waiting for browser…' : 'Sign in'}
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
      {account.failure && <FailureNotice className="mt-1" failure={account.failure} />}
    </SettingsRow>
  );
}

export function AgentRuntimesPanel({ agentRuntimeApi }: AgentRuntimesPanelProps) {
  const account = useAccountView();
  const runtimes = useAgentRuntimes(agentRuntimeApi);

  const onAction = (action: AgentRuntimeAction, runtime: AgentRuntime) => {
    if (action.kind === 'login') runtimes.login(runtime.id);
    else if (action.kind === 'update') runtimes.update(runtime.id);
    else if (action.kind === 'install' || action.kind === 'retry') runtimes.install(runtime.id);
    else account.signIn();
  };

  const { allowance, catalog } = runtimes;

  return (
    <SettingsPane lede="Manage your Agent connections." title="Agents">
      <SettingsGroup title="Default">
        <SettingsList as="ul">
          <AccountRow account={account} />
          {account.account?.signedIn && (
            <SettingsRow
              as="li"
              detail="Choose more Default Agent credits or manage your subscription with the same account on the website."
              title="Subscription"
              trail={
                <Button onClick={account.openBilling} size="compact" variant="tertiary">
                  Plans and billing
                </Button>
              }
            />
          )}
          {account.account?.signedIn && (allowance.allowance || allowance.failed) && (
            <>
              {allowance.allowance ? (
                <AllowanceRow allowance={allowance.allowance} />
              ) : (
                <SettingsMessage
                  as="li"
                  message="Could not load your credit balance."
                  onRetry={runtimes.refreshAllowance}
                />
              )}
            </>
          )}
          {catalog.runtimes
            .filter((runtime) => runtime.id === 'stashbase')
            .map((runtime) => (
              <RuntimeRow
                key={runtime.id}
                runtime={runtime}
                busy={runtimes.busy(runtime.id) || account.busy}
                failure={runtimes.failure(runtime.id)}
                onAction={onAction}
                hideAccountAction
              />
            ))}
        </SettingsList>
      </SettingsGroup>

      <SettingsGroup title="Your agents">
        <SettingsList as="ul">
          {catalog.loading && <SettingsMessage as="li" message="Checking agents…" />}
          {catalog.failed && (
            <SettingsMessage
              as="li"
              message="Could not load agents."
              onRetry={runtimes.refreshCatalog}
            />
          )}
          {catalog.runtimes
            .filter((runtime) => runtime.id !== 'stashbase')
            .map((runtime) => (
              <RuntimeRow
                busy={runtimes.busy(runtime.id)}
                failure={runtimes.failure(runtime.id)}
                key={runtime.id}
                onAction={onAction}
                runtime={runtime}
              />
            ))}
        </SettingsList>
      </SettingsGroup>
    </SettingsPane>
  );
}
