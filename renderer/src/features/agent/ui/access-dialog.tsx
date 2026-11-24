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
 *  and Close stay live the whole time: they retire the retained send. Stop
 *  waiting ends only the browser wait, and the send stays for the next answer.
 *
 *  Connecting a native runtime can take minutes: a download, an installer,
 *  and the provider's sign-in in the browser. While it runs, the panel says
 *  which step the service is on and how long the wait has lasted, so a slow
 *  step never reads as a stuck one.
 *
 *  The StashBase Agent's answer is the account's own sign-in dialog, which this
 *  panel hands over to rather than sitting beneath; it shows again only with
 *  the reason the sign-in did not finish. */
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  agentLabel,
  DEFAULT_AGENT_ID,
  type AgentPreparation,
} from '@/features/agent/domain/agent-catalog';
import type { AgentId } from '@/features/agent/domain/session';
import { durationLabel } from '@/features/agent/domain/time';
import { FailureLine } from '@/shared/ui/failure-notice';
import { SignInPageLink } from '@/shared/ui/sign-in-page-link';

/** What the gate says for the Agent it stands in front of. Sign in is the
 *  verb whenever a sign-in is all that is missing: the bundled Agent's
 *  account, or a native runtime whose own sign-in lapsed. Connect is kept for
 *  a native runtime that may need installing first, because one word then
 *  covers both steps. */
function gateCopy(
  agent: AgentId,
  needsSignIn: boolean,
): {
  action: string;
  description: string;
  title: string;
  /** What the wait reads as before the service names its step. Null for
   *  the bundled Agent, whose sign-in happens in the account's own dialog
   *  with this one out of the way. */
  waiting: string | null;
} {
  const label = agentLabel(agent);
  if (agent === DEFAULT_AGENT_ID)
    return {
      action: 'Sign in',
      description: 'The StashBase Agent runs on free agent credits.',
      title: 'Sign in to use the StashBase Agent',
      waiting: null,
    };
  if (needsSignIn)
    return {
      action: 'Sign in',
      description: `${label} needs you to sign in. StashBase opens its sign-in in your browser.`,
      title: `Sign in to use ${label}`,
      waiting: `Checking ${label} sign-in…`,
    };
  return {
    action: `Connect ${label}`,
    description: `${label} is not connected yet. StashBase sets it up and opens its sign-in if it needs one.`,
    title: `Connect ${label}`,
    waiting: `Connecting ${label}…`,
  };
}

/** How long the wait has lasted, counted from the reader's answer. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="shrink-0 text-muted-foreground tabular-nums">
      {durationLabel(now - since)}
    </span>
  );
}

/** The step a native runtime's preparation is on, in the service's words.
 *  The sign-in step waits on the reader's browser, so it alone offers the
 *  page again and a way to stop waiting. */
function PreparationStatus({
  fallback,
  preparation,
  startedAt,
  onOpenSignIn,
  onStopWaiting,
}: {
  fallback: string;
  preparation: AgentPreparation | null;
  startedAt: number | null;
  onOpenSignIn(url: string): void;
  onStopWaiting: (() => void) | undefined;
}) {
  const signInUrl = preparation?.signInUrl;
  return (
    <div className="mt-1 flex flex-col items-start gap-1 text-caption">
      <div className="flex w-full items-baseline gap-3">
        <p className="min-w-0 flex-1 wrap-anywhere text-foreground" role="status">
          {preparation?.note ?? fallback}
        </p>
        {startedAt !== null && <Elapsed since={startedAt} />}
      </div>
      {signInUrl && <SignInPageLink url={signInUrl} onOpen={onOpenSignIn} />}
      <p className="text-muted-foreground">Your message sends as soon as this is ready.</p>
      {preparation?.step === 'sign-in' && onStopWaiting && (
        <Button onClick={onStopWaiting} size="compact" variant="ghost">
          Stop waiting
        </Button>
      )}
    </div>
  );
}

export function AgentAccessDialog({
  open,
  agent,
  needsSignIn = false,
  working,
  startedAt = null,
  preparation = null,
  failure,
  onConfirm,
  onCancel,
  onOpenSignIn,
  onStopWaiting,
}: {
  open: boolean;
  /** The Agent this send is waiting on: the one the chat is already set to. */
  agent: AgentId;
  /** A sign-in is all this Agent is missing. */
  needsSignIn?: boolean;
  working: boolean;
  /** When the reader answered, while the answer is still running. */
  startedAt?: number | null;
  /** The step the service reports for a native runtime. */
  preparation?: AgentPreparation | null;
  failure: string | null;
  onConfirm(): void;
  onCancel(): void;
  /** Opens the provider's sign-in page in the reader's browser. */
  onOpenSignIn(url: string): void;
  /** Ends the browser wait and keeps the send. */
  onStopWaiting?: () => void;
}) {
  const copy = gateCopy(agent, needsSignIn);
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
        {working && copy.waiting !== null && (
          <PreparationStatus
            fallback={copy.waiting}
            preparation={preparation}
            startedAt={startedAt}
            onOpenSignIn={onOpenSignIn}
            onStopWaiting={onStopWaiting}
          />
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
          {/* After a failure the answer is a recovery: outlined, and named
              Retry like every other. */}
          <Button loading={working} onClick={onConfirm} variant={failure ? 'tertiary' : 'primary'}>
            {failure ? 'Retry' : copy.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
