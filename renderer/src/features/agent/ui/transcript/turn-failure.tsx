/** A turn the Agent could not finish, with the one recovery that applies.
 *  A transient failure offers a plain retry. A runtime too old for its model
 *  is repaired here rather than in Settings: the update runs in place, the
 *  chat reconnects on the newer runtime, and the same request is sent again;
 *  a plain retry appears only once that update ran, since before it the
 *  retry would fail the same way. A hosted model whose configuration changed
 *  is handled the same way, without an update: the chat reconnects to read
 *  the models again, and nothing is sent until the reader has reviewed the
 *  model and chooses to retry. A refused sign-in asks for one only until the
 *  agent is signed in again; the card stays in the transcript, so it then
 *  says so instead of asking for a sign-in that already happened.
 *
 *  The card is paper like the others in the transcript; the failure's red is
 *  the mark beside the heading, never a fill. While a recovery runs, its
 *  button keeps its name and the line above says what is being waited for. */
import { CircleX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  agentTurnFailureIsRetryable,
  type AgentTranscriptBlock,
} from '@/features/agent/domain/session';
import type { AgentModelRefreshView } from '@/features/agent/hooks/use-agent-model-refresh';
import type { AgentRuntimeUpdateView } from '@/features/agent/hooks/use-agent-runtime-update';
import { RuntimeUpdateNotes } from '@/features/agent/ui/runtime-update-notes';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';

export function TurnFailure({
  block,
  modelRefresh,
  onSignIn,
  onUpdateApp,
  onRetry,
  runtimeUpdate,
  signedIn = false,
}: {
  block: Extract<AgentTranscriptBlock, { kind: 'error' }>;
  modelRefresh?: AgentModelRefreshView | undefined;
  onSignIn?: (() => void) | undefined;
  onUpdateApp?: (() => void) | undefined;
  onRetry(errorBlockId: string): boolean;
  runtimeUpdate?: AgentRuntimeUpdateView | undefined;
  /** The agent that refused sign-in has been signed in again since. */
  signedIn?: boolean | undefined;
}) {
  const shape = useShape();
  const refusedSignIn = block.failure === 'auth-expired';
  const needsSignIn = refusedSignIn && !signedIn;
  const appOutdated = block.failure === 'app-outdated';
  const outdated = block.failure === 'runtime-outdated';
  const updated = outdated && runtimeUpdate?.completedBlockId === block.id;
  const modelChanged = block.failure === 'model-changed';
  const refreshed = modelChanged && modelRefresh?.refreshedBlockId === block.id;
  const retryable =
    block.retryablePrompt !== undefined &&
    agentTurnFailureIsRetryable(block.failure) &&
    (!outdated || updated) &&
    (!modelChanged || refreshed);
  return (
    <section className={cn('border border-border/50 p-3', shape.panel)}>
      <div className="flex items-start gap-2">
        <CircleX
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 text-destructive"
          strokeWidth={1.75}
        />
        <h3 className="text-caption font-medium text-foreground">
          {needsSignIn
            ? 'Sign in to continue'
            : appOutdated
              ? 'Update StashBase to continue'
              : 'The agent could not finish'}
        </h3>
      </div>
      <p className="mt-1 text-caption text-muted-foreground">{block.text}</p>
      <p className="mt-1 text-caption text-muted-foreground">
        {refusedSignIn
          ? signedIn
            ? 'You are signed in again. Send again to continue. Your chat and draft are kept.'
            : 'Sign in to this agent in Settings, then send again. Your chat and draft are kept.'
          : appOutdated
            ? 'Install the StashBase update in Settings, then send again. Your chat and draft are kept.'
            : modelChanged
              ? refreshed
                ? 'The models are refreshed. Check the model below, then send again. Your chat, draft, and queued messages are kept.'
                : modelRefresh?.busy
                  ? 'Refreshing the models. Your chat, draft, and queued messages are kept.'
                  : 'Refresh the models, check your choice, then send again. Your chat, draft, and queued messages are kept.'
              : outdated && !updated
                ? runtimeUpdate
                  ? runtimeUpdate.signIn
                    ? `Sign in to finish preparing ${runtimeUpdate.label}. Your chat and draft are kept.`
                    : runtimeUpdate.busy
                      ? `Updating ${runtimeUpdate.label}. The same request is sent again once it is done.`
                      : `Update ${runtimeUpdate.label} here and the same request is sent again. Partial output and completed file changes are kept.`
                  : 'This installation cannot be updated here. Update it externally or remove the executable override, then reconnect. Your chat is kept.'
                : 'Partial output and completed file changes are kept. Retrying may repeat work.'}
      </p>
      {appOutdated && onUpdateApp && (
        <Button className="mt-2" onClick={onUpdateApp} size="compact" variant="tertiary">
          Update StashBase
        </Button>
      )}
      {needsSignIn && onSignIn && (
        <Button className="mt-2" onClick={onSignIn} size="compact" variant="tertiary">
          Sign in
        </Button>
      )}
      {outdated && !updated && runtimeUpdate && (
        <>
          {!runtimeUpdate.signIn && (
            <Button
              className="mt-2"
              disabled={runtimeUpdate.busy}
              loading={runtimeUpdate.busy}
              onClick={() => runtimeUpdate.update(block.id)}
              size="compact"
              variant="tertiary"
            >
              {`Update ${runtimeUpdate.label}`}
            </Button>
          )}
          <RuntimeUpdateNotes progressClassName="mt-1" runtimeUpdate={runtimeUpdate} />
        </>
      )}
      {modelChanged && !refreshed && modelRefresh && (
        <>
          <Button
            className="mt-2"
            disabled={modelRefresh.busy}
            loading={modelRefresh.busy}
            onClick={() => modelRefresh.refresh(block.id)}
            size="compact"
            variant="tertiary"
          >
            Refresh models
          </Button>
          {modelRefresh.failure && (
            <p
              className="mt-1 text-caption wrap-anywhere whitespace-pre-wrap text-muted-foreground"
              role="alert"
            >
              {modelRefresh.failure}
            </p>
          )}
        </>
      )}
      {retryable && (
        <Button
          className="mt-2"
          onClick={() => onRetry(block.id)}
          size="compact"
          variant="tertiary"
        >
          Retry
        </Button>
      )}
    </section>
  );
}
