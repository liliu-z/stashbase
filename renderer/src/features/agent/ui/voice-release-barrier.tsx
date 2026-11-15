import { useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { AgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import type { WindowReleaseReason } from '@/shared/domain/window-release';

/** Existing chat drafts have no disk journal. Native close cannot silently
 * destroy a recording or an unsent dictated draft. Use the ordinary barrier. */
export function VoiceReleaseBarrier({
  runtime,
  subscribe,
  visible = true,
}: {
  runtime: AgentWorkspaceRuntime;
  subscribe(
    handler: (reason: WindowReleaseReason) => Promise<boolean>,
    options?: { interactive: boolean },
  ): () => void;
  visible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const decision = useRef<((allowed: boolean) => void) | null>(null);
  useEffect(() => {
    if (!visible) for (const session of runtime.voiceSessions()) void session.voice?.stop();
  }, [runtime, visible]);
  useEffect(() => {
    const stop = subscribe(
      async (reason) => {
        const sessions = runtime.voiceSessions();
        if (
          !sessions.some(
            (session) => session.voice?.hasRecording() || session.voice?.hasUnsentDraft(),
          )
        )
          return true;
        for (const session of sessions) void session.voice?.stop();
        // The updater disables windows before gathering save acknowledgements.
        // Refuse immediately so it re-enables them; an interactive dialog in
        // that disabled window could never be answered.
        if (reason === 'update') {
          for (const session of sessions)
            if (session.voice?.hasRecording() || session.voice?.hasUnsentDraft())
              session.voice.store.setState({
                error:
                  'Your voice work was kept. Send or clear the dictated draft, then retry installing the update.',
              });
          return false;
        }
        if (decision.current) return false;
        setOpen(true);
        return new Promise<boolean>((resolve) => {
          decision.current = resolve;
        });
      },
      { interactive: true },
    );
    return () => {
      stop();
      decision.current?.(false);
      decision.current = null;
    };
  }, [runtime, subscribe]);
  const settle = (allowed: boolean) => {
    const pending = decision.current;
    decision.current = null;
    setOpen(false);
    if (allowed)
      void Promise.all(runtime.voiceSessions().map((session) => session.voice?.cancel())).then(() =>
        pending?.(true),
      );
    else pending?.(false);
  };
  return (
    <ConfirmDialog
      open={open}
      title="Discard voice work and close?"
      description="Closing discards active recordings and unsent dictated text. Keep working to review, copy, or send your draft first."
      confirmLabel="Discard and close"
      cancelLabel="Keep working"
      destructive
      onCancel={() => settle(false)}
      onConfirm={() => settle(true)}
    />
  );
}
