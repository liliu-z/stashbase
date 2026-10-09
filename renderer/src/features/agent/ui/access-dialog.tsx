/** The first-send access gate: one question, the action that answers it, and
 *  the way out.
 *
 *  The question is about the Agent this chat is already on, so the panel
 *  offers that one action rather than a menu of runtimes. Bringing your own
 *  Codex or Claude stays a choice in the composer's picker and a setup
 *  step in Settings, which owns runtimes; a gate that listed them too turned
 *  one decision into three and made every one of them look equally likely.
 *
 *  It is not `ConfirmDialog`, which holds its panel open while the action
 *  runs. This action waits on a browser that may never come back, so Not now
 *  and Close stay live the whole time: they retire the retained send. */
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { agentLabel, DEFAULT_AGENT_ID } from '@/features/agent/domain/agent-catalog';
import type { AgentId } from '@/features/agent/domain/session';
import { FailureLine } from '@/shared/ui/failure-notice';

/** What the gate says for the Agent it stands in front of. The bundled Agent
 *  waits on the account and nothing else; a native runtime may need both an
 *  installation and its provider's own sign-in, which is why one word covers
 *  them. */
function gateCopy(agent: AgentId): {
  action: string;
  description: string;
  title: string;
  waiting: string;
} {
  const label = agentLabel(agent);
  if (agent === DEFAULT_AGENT_ID)
    return {
      action: 'Sign in',
      description: 'Default agent runs on free Agent credits.',
      title: 'Sign in to use Default Agent',
      waiting: 'Waiting for your browser. Your message sends as soon as this is ready.',
    };
  return {
    action: `Connect ${label}`,
    description: `${label} is not connected yet. StashBase sets it up and opens its sign-in if it needs one.`,
    title: `Connect ${label}`,
    waiting: `Connecting ${label}. Your message sends as soon as this is ready.`,
  };
}

export function AgentAccessDialog({
  open,
  agent,
  working,
  failure,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** The Agent this send is waiting on: the one the chat is already set to. */
  agent: AgentId;
  working: boolean;
  failure: string | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  const copy = gateCopy(agent);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        initialFocus="panel"
        width={failure ? 'wide' : 'narrow'}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {working && (
          <p className="mt-1 text-caption text-muted-foreground" role="status">
            {copy.waiting}
          </p>
        )}
        {failure && (
          <FailureLine className="mt-1 wrap-anywhere whitespace-pre-wrap" tone="capability">
            {failure}
          </FailureLine>
        )}
        <DialogFooter>
          <Button onClick={onCancel} variant="tertiary">
            Not now
          </Button>
          <Button loading={working} onClick={onConfirm}>
            {copy.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
