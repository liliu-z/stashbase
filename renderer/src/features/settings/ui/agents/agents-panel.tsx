/** Native runtime setup belongs here; account access has its own page. */
import { Button } from '@/components/ui/button';
import type { AgentRuntimePort } from '@/features/settings/application/ports';
import type { AgentRuntime } from '@/features/settings/domain/agent-catalog';
import type { AgentRuntimeAction } from '@/features/settings/domain/agent-runtime-status';
import { useAccountView } from '@/features/settings/hooks/account-context';
import { useAgentRuntimes } from '@/features/settings/hooks/use-agent-runtimes';
import {
  SettingsGroup,
  SettingsList,
  SettingsMessage,
  SettingsPane,
  SettingsRow,
} from '@/features/settings/ui/rows';

import { RuntimeRow } from './runtime-row';

export function AgentRuntimesPanel({
  agentRuntimeApi,
  onOpenAccount,
}: {
  agentRuntimeApi: AgentRuntimePort;
  onOpenAccount(): void;
}) {
  const account = useAccountView();
  const runtimes = useAgentRuntimes(agentRuntimeApi);

  const onAction = (action: AgentRuntimeAction, runtime: AgentRuntime) => {
    if (action.kind === 'login') runtimes.login(runtime.id);
    else if (action.kind === 'update') runtimes.update(runtime.id);
    else runtimes.install(runtime.id);
  };
  const onStop = (runtime: AgentRuntime) => runtimes.stop(runtime.id);
  const onOpenSignIn = (url: string) => void account.openExternal(url);

  const { catalog } = runtimes;

  return (
    <SettingsPane title="Agents">
      <SettingsGroup title="StashBase Agent">
        <SettingsList as="ul">
          {catalog.runtimes
            .filter((runtime) => runtime.id === 'stashbase')
            .map((runtime) => (
              // Account access is managed on its own page.
              <RuntimeRow
                key={runtime.id}
                runtime={runtime}
                busy={runtimes.busy(runtime.id)}
                failure={runtimes.failure(runtime.id)}
                onAction={onAction}
                onOpenSignIn={onOpenSignIn}
                onStop={onStop}
              />
            ))}
          <SettingsRow
            as="li"
            title="StashBase account"
            detail="Manage sign-in methods, credits and subscription."
            trail={
              <Button size="compact" variant="tertiary" onClick={onOpenAccount}>
                Open account
              </Button>
            }
          />
        </SettingsList>
      </SettingsGroup>

      <SettingsGroup title="Your agents">
        <SettingsList as="ul">
          {catalog.loading && <SettingsMessage as="li" message="Checking agents…" />}
          {catalog.failed && (
            <SettingsMessage
              as="li"
              message={catalog.failure?.message ?? 'Could not load agents.'}
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
                onOpenSignIn={onOpenSignIn}
                onStop={onStop}
                runtime={runtime}
              />
            ))}
        </SettingsList>
      </SettingsGroup>
    </SettingsPane>
  );
}
