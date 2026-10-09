/** A turn the Agent could not finish, with the one recovery that applies.
 *  A transient failure offers a plain retry. A runtime too old for its model
 *  is repaired here rather than in Settings: the update runs in place, the
 *  conversation reconnects on the newer runtime, and the same request is sent
 *  again; a plain retry appears only once that update ran, since before it
 *  the retry would fail the same way. */
import { Button } from '@/components/ui/button';
import {
  agentTurnFailureIsRetryable,
  type AgentTranscriptBlock,
} from '@/features/agent/domain/session';
import type { AgentRuntimeUpdateView } from '@/features/agent/hooks/use-agent-runtime-update';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';

export function TurnFailure({
  block,
  onRetry,
  runtimeUpdate,
}: {
  block: Extract<AgentTranscriptBlock, { kind: 'error' }>;
  onRetry(errorBlockId: string): boolean;
  runtimeUpdate?: AgentRuntimeUpdateView | undefined;
}) {
  const shape = useShape();
  const outdated = block.failure === 'runtime-outdated';
  const updated = outdated && runtimeUpdate?.completedBlockId === block.id;
  const retryable =
    block.retryablePrompt !== undefined &&
    agentTurnFailureIsRetryable(block.failure) &&
    (!outdated || updated);
  return (
    <section className={cn('border border-destructive/30 bg-destructive-light p-3', shape.panel)}>
      <h3 className="text-caption font-medium text-foreground">The Agent could not finish</h3>
      <p className="mt-1 text-caption text-muted-foreground">{block.text}</p>
      <p className="mt-1 text-caption text-muted-foreground">
        {outdated && !updated
          ? runtimeUpdate
            ? `Update ${runtimeUpdate.label} here and the same request is sent again. Partial output and completed file changes are kept.`
            : 'This installation cannot be updated here. Update it externally or remove the executable override, then reconnect. Your conversation is kept.'
          : 'Partial output and completed file changes are kept. Retrying may repeat work.'}
      </p>
      {outdated && !updated && runtimeUpdate && (
        <>
          <Button
            className="mt-2"
            disabled={runtimeUpdate.busy}
            loading={runtimeUpdate.busy}
            onClick={() => runtimeUpdate.update(block.id)}
            size="compact"
            variant="tertiary"
          >
            {runtimeUpdate.busy
              ? `Updating ${runtimeUpdate.label}…`
              : `Update ${runtimeUpdate.label}`}
          </Button>
          {runtimeUpdate.failure && (
            <p
              className="mt-1 text-caption wrap-anywhere whitespace-pre-wrap text-muted-foreground"
              role="alert"
            >
              {runtimeUpdate.failure}
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
          Try again
        </Button>
      )}
    </section>
  );
}
