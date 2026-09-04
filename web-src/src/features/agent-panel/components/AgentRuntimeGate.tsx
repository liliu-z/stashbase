import type { ReactNode } from 'react';
import { Button } from '@/common/components/ui/button';
import { Progress, ProgressIndicator, ProgressTrack } from '@/common/components/ui/progress';
import { SectionHeading } from '@/common/components/ui/section';
import { runtimeFailurePresentation } from '@/features/agent-panel/lib/runtimeFailurePresentation';
import type { Agent } from '@/common/api/api';
import { cn } from '@/common/lib/utils';

/**
 * The card every runtime gate wears. All four gates below — pre-discovery,
 * preparing, failed, not installed — are the SAME card with different copy
 * and a different action row, which is why this is a component and not the
 * five class strings it replaced: five names meant five places to edit when
 * the shape moved, and nothing tying them together but a prefix.
 *
 * One text rhythm with the app's dialogs (ManagedModalShell): body-size
 * medium title, body-size muted copy at mt-2. Card surface is bg-card —
 * chat is canvas, its cards float on the card role.
 */
function RuntimeCard({ role, live, title, copy, actions, children }: {
  role: 'status' | 'alert';
  /** Announce the card as it changes. Only preparation needs it: its copy
   *  updates in place while the install runs. */
  live?: 'polite';
  title: ReactNode;
  copy: ReactNode;
  /** Buttons for the trailing action row, most primary last. */
  actions?: ReactNode;
  /** Extra body between the copy and the action row (the progress bar). */
  children?: ReactNode;
}) {
  return (
    <div className="grid min-h-45 flex-1 place-items-center px-3 py-6" role={role} aria-live={live}>
      <div className="w-measure-sm rounded-xl border border-border bg-card p-4 text-foreground">
        {/* Level 2, stated: a pane-level state card is the top of the chat
          * pane's own outline (the pane has no h1 of its own), the same
          * depth the empty-chat greeting and the whole-pane fatal card
          * take. Transcript-inline cards sit one step down at h3. */}
        <SectionHeading level={2} className="font-medium">{title}</SectionHeading>
        <p className="mt-2 mb-3 text-base leading-normal text-muted-foreground">{copy}</p>
        {children}
        {actions && <div className="mt-3 flex justify-end gap-2">{actions}</div>}
      </div>
    </div>
  );
}

function AgentRuntimeSetup({
  runtime,
  fallbackName,
  onInstall,
  onRefresh,
}: {
  runtime: Agent | undefined;
  fallbackName: string;
  onInstall: () => void;
  onRefresh: () => void;
}) {
  const name = runtime?.label ?? fallbackName;
  return (
    /* First-run install keeps ONE primary path: no manual-command escape
     * hatch and no PATH/implementation caveats here — that recovery detail
     * lives on the failure card, where an install has actually gone
     * wrong. */
    <RuntimeCard
      role="status"
      title={<>{name} is not installed</>}
      copy="StashBase can set up the official runtime for you."
      actions={<>
        <Button variant="outline" size="sm" onClick={onRefresh}>Check again</Button>
        <Button size="sm" onClick={onInstall}>Install and continue</Button>
      </>}
    />
  );
}

function AgentRuntimeProgress({ runtime, fallbackName }: { runtime: Agent; fallbackName: string }) {
  const status = runtime.bootstrap;
  const name = runtime.label || fallbackName;
  const progress = typeof status?.progress === 'number' ? Math.max(0, Math.min(1, status.progress)) : null;
  return (
    <RuntimeCard role="status" live="polite" title={<>Preparing {name}</>} copy={status?.message ?? `Installing ${name}…`}>
      {/* The Progress primitive, not a styled div pair: Root carries
        * role="progressbar" with aria-valuenow/min/max (or an explicit
        * indeterminate state when the installer reports no fraction), so
        * the install reports a number rather than a coloured rectangle
        * only sighted users can read. */}
      <Progress
        className="block"
        aria-label={`Preparing ${name}`}
        value={progress == null ? null : Math.round(progress * 100)}
      >
        <ProgressTrack className="h-1.5 w-full">
          <ProgressIndicator
            className={cn('bg-accent', progress == null && 'w-1/3 animate-pulse')}
          />
        </ProgressTrack>
      </Progress>
      <p className="mt-2 mb-0 text-xs text-muted-foreground">You can keep browsing while this finishes.</p>
    </RuntimeCard>
  );
}

function AgentRuntimeFailure({
  runtime,
  fallbackName,
  onRetry,
  onLogin,
  onOpenAccount,
  onCheck,
  onCopyInstall,
  onOpenMcpSetup,
}: {
  runtime: Agent;
  fallbackName: string;
  onRetry: () => void;
  onLogin: () => void;
  onOpenAccount: () => void;
  onCheck: () => void;
  onCopyInstall: () => void;
  onOpenMcpSetup: () => void;
}) {
  const name = runtime.label || fallbackName;
  const presentation = runtimeFailurePresentation(runtime.bootstrap, name);
  const manualAction = presentation.manualAction === 'copy-install-command'
    ? onCopyInstall
    : presentation.manualAction === 'open-mcp-settings'
      ? onOpenMcpSetup
      : null;
  const primaryAction = presentation.primaryAction === 'start-codex-login'
    ? onLogin
    : presentation.primaryAction === 'open-account-settings'
      ? onOpenAccount
      : onRetry;
  return (
    <RuntimeCard
      role="alert"
      title={presentation.title}
      copy={presentation.message}
      actions={<>
        {manualAction && presentation.manualLabel && (
          <Button variant="outline" size="sm" onClick={manualAction}>
            {presentation.manualLabel}
          </Button>
        )}
        {/* An MCP failure is downstream of a runtime that already
          * answered, so re-probing it proves nothing. Every earlier stage
          * can be settled by re-checking the local CLI. */}
        {runtime.bootstrap?.failure?.stage !== 'mcp' && (
          <Button variant="outline" size="sm" onClick={onCheck}>
            Check again
          </Button>
        )}
        <Button size="sm" onClick={primaryAction}>
          {presentation.retryLabel}
        </Button>
      </>}
    />
  );
}

function AgentRuntimeChecking({ name, onRefresh }: { name: string; onRefresh: () => void }) {
  return (
    <RuntimeCard
      role="status"
      title={<>Checking {name}</>}
      copy="Checking whether its local CLI is installed."
      actions={<Button variant="outline" size="sm" onClick={onRefresh}>Refresh status</Button>}
    />
  );
}

/** Runtime-readiness gates, most fundamental first: discovery has not
 *  answered yet, preparation is running, preparation failed, CLI missing.
 *  Renders `null` once the runtime is usable, so the caller's chat UI owns
 *  the pane. Pulled out of AgentView verbatim — pure presentation over the
 *  runtime descriptor plus a handful of retry/install callbacks, with no
 *  socket or session state of its own. */
export function AgentRuntimeGate({
  runtime,
  fallbackName,
  bootstrapActive,
  bootstrapFailed,
  runtimeUnavailable,
  onRefresh,
  onCheck,
  onInstall,
  onLogin,
  onOpenAccount,
  onCopyInstall,
  onOpenMcpSetup,
}: {
  runtime: Agent | undefined;
  fallbackName: string;
  bootstrapActive: boolean;
  bootstrapFailed: boolean;
  runtimeUnavailable: boolean;
  /** Re-read the catalog. Only the pre-discovery card uses it: there is no
   *  runtime yet to prepare. */
  onRefresh: () => void;
  /** Re-run preparation's read-only probe — install state and, for Codex,
   *  sign-in — so a fix made outside StashBase is picked up. */
  onCheck: () => void;
  onInstall: () => void;
  onLogin: () => void;
  onOpenAccount: () => void;
  onCopyInstall: () => void;
  onOpenMcpSetup: () => void;
}) {
  let card: ReactNode;
  if (!runtime) {
    card = <AgentRuntimeChecking name={fallbackName} onRefresh={onRefresh} />;
  } else if (bootstrapActive) {
    card = <AgentRuntimeProgress runtime={runtime} fallbackName={fallbackName} />;
  } else if (bootstrapFailed) {
    card = (
      <AgentRuntimeFailure
        runtime={runtime}
        fallbackName={fallbackName}
        onRetry={onInstall}
        onLogin={onLogin}
        onOpenAccount={onOpenAccount}
        onCheck={onCheck}
        onCopyInstall={onCopyInstall}
        onOpenMcpSetup={onOpenMcpSetup}
      />
    );
  } else if (runtimeUnavailable) {
    card = (
      <AgentRuntimeSetup
        runtime={runtime}
        fallbackName={fallbackName}
        onInstall={onInstall}
        onRefresh={onCheck}
      />
    );
  } else {
    return null;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {card}
    </div>
  );
}
