import { useEffect } from 'react';
import { useStore } from 'zustand';

import { Button } from '@/components/ui/button';
import type { AgentSessionRuntime } from '@/features/agent/application/session-runtime';
import { agentSessionIsBusy } from '@/features/agent/domain/session';
import type { AgentRuntimeUpdateView } from '@/features/agent/hooks/use-agent-runtime-update';

import {
  AgentConnectionNotice,
  connectionNeedsRepair,
  connectionNotice,
} from './connection-notice';
import { RuntimeSignInRecovery } from './runtime-update-notes';

/** Recovery actions for an uncertain or failed turn stay above the composer. */
export function AgentWorkStatus({
  session,
  onOpenSettings,
  onUpdateApp,
  onRefresh,
  runtimeUpdate,
}: {
  session: AgentSessionRuntime;
  onOpenSettings(): void;
  onUpdateApp(): void;
  onRefresh(): void;
  runtimeUpdate?: AgentRuntimeUpdateView | undefined;
}) {
  const state = useStore(session.store);
  const authFailureId = state.transcript.findLast(
    (block) => block.kind === 'error' && block.failure === 'auth-expired',
  )?.id;
  const connectionNeedsSignIn =
    (state.connection.kind === 'failed' || state.connection.kind === 'closed') &&
    state.connection.failure === 'auth-expired';
  useEffect(() => {
    // The host invalidates readiness on a provider refusal. Read that answer
    // immediately so the next send goes through the existing sign-in gate.
    if (authFailureId || connectionNeedsSignIn) onRefresh();
  }, [authFailureId, connectionNeedsSignIn, onRefresh]);
  const notice = connectionNotice(state.connection);
  const interruption =
    state.connection.kind === 'closed' || state.connection.kind === 'failed'
      ? state.connection.message?.trim()
      : undefined;
  const failure = state.transcript.findLast((block) => block.kind === 'error');
  const needsRepair =
    failure?.kind === 'error' &&
    failure.failure &&
    !['network', 'rate-limit', 'model-changed', 'auth-expired', 'app-outdated'].includes(
      failure.failure,
    );
  const unknown = state.delivery === 'unknown';
  const repair = needsRepair && state.delivery === 'failed';
  return (
    <>
      {(unknown || repair) && (
        <div className="mx-auto flex w-full max-w-[46rem] flex-wrap items-center gap-2 px-5 pb-2 text-caption text-muted-foreground">
          {unknown && (
            <>
              <span role="status">Outcome unknown</span>
              <span>{interruption || 'The connection was interrupted.'}</span>
              <span>
                Review the chat before sending again; file changes may already have happened.
              </span>
              <Button size="compact" variant="tertiary" onClick={session.reconnect}>
                Reconnect and review
              </Button>
              {state.connection.kind === 'live' && !agentSessionIsBusy(state) && (
                <Button size="compact" variant="tertiary" onClick={session.confirmOutcome}>
                  Reviewed, continue
                </Button>
              )}
            </>
          )}
          {repair && (
            <Button size="compact" variant="tertiary" onClick={onOpenSettings}>
              Open agent settings
            </Button>
          )}
        </div>
      )}
      {notice && (!unknown || connectionNeedsRepair(state.connection)) && (
        <AgentConnectionNotice
          connection={state.connection}
          onReconnect={session.reconnect}
          onSignIn={onOpenSettings}
          onUpdateApp={onUpdateApp}
          runtimeUpdate={runtimeUpdate}
        />
      )}
      {runtimeUpdate && <RuntimeSignInRecovery runtimeUpdate={runtimeUpdate} />}
    </>
  );
}

/** Catalog and preference failures retain the operation that can reload them.
 *  A preference failure comes first: it blocks sending even with a catalog. */
export function AgentReadinessNotice({
  catalog,
  preferencesFailure,
  onReloadPreferences,
}: {
  catalog: { error: boolean; loading: boolean; refresh(): void };
  preferencesFailure: string | null;
  onReloadPreferences(): void;
}) {
  const message =
    preferencesFailure ??
    (catalog.error
      ? 'Agent runtime status is unavailable.'
      : catalog.loading
        ? 'Checking agents…'
        : null);
  if (!message) return null;
  const onRetry = preferencesFailure
    ? onReloadPreferences
    : catalog.error
      ? catalog.refresh
      : undefined;
  return (
    <div className="mx-auto flex w-full max-w-[46rem] items-center gap-2 px-4 pb-3 text-caption text-muted-foreground">
      <span>{message}</span>
      {onRetry && (
        <Button variant="tertiary" size="compact" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
