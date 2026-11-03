import { Button } from '@/components/ui/button';
import { agentLabel } from '@/features/agent/domain/agent-catalog';
import type { AgentId } from '@/features/agent/domain/session';
import { FailureLine } from '@/shared/ui/failure-notice';

/** Both history entries keep installation prerequisites separate from reads
 * that can recover by retrying. Other agents and cached chats stay visible. */
export function HistoryRecovery({
  installationRequired,
  failure,
  onOpenAgentSettings,
  onCheckInstallation,
  onRetry,
}: {
  installationRequired: readonly AgentId[];
  failure: string | null;
  onOpenAgentSettings(): void;
  onCheckInstallation(): void;
  onRetry(): void;
}) {
  return (
    <div className="space-y-2 text-caption">
      {installationRequired.length > 0 && (
        <div>
          <p>Install {installationRequired.map(agentLabel).join(', ')} to access saved chats.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={onOpenAgentSettings} size="compact" variant="tertiary">
              Open Agents settings
            </Button>
            <Button onClick={onCheckInstallation} size="compact" variant="ghost">
              Check again
            </Button>
          </div>
        </div>
      )}
      {failure && (
        <div>
          <FailureLine tone="input">{failure}</FailureLine>
          <Button className="mt-2" onClick={onRetry} size="compact" variant="tertiary">
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
