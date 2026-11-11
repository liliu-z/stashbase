import { useMemo } from 'react';

import type { AgentSessionRuntime } from '@/features/agent/application/session-runtime';
import { contextItemKey, type AgentContextItem } from '@/features/agent/domain/context';
import type { AgentQueuedPrompt } from '@/features/agent/domain/session';

/** The draft's uploaded Files for the shared composer's preview tiles, and
 *  the reconciliation of the tiles the reader kept back into session context.
 *  A File already held by the draft or a queued message is re-bound, not
 *  uploaded again. */
export function useComposerUploads(
  session: AgentSessionRuntime,
  context: readonly AgentContextItem[],
  queuedPrompts: readonly AgentQueuedPrompt[],
) {
  const uploads = useMemo(
    () =>
      context.flatMap((item) =>
        item.kind === 'transient' ? (session.fileForTransient(item.path) ?? []) : [],
      ),
    [context, session],
  );
  const knownUpload = (file: File): AgentContextItem | undefined => {
    for (const item of [...context, ...queuedPrompts.flatMap((prompt) => prompt.context)]) {
      if (item.kind === 'transient' && session.fileForTransient(item.path) === file) return item;
    }
    return undefined;
  };
  const syncUploads = (next: File[]) => {
    for (const item of context) {
      if (item.kind !== 'transient') continue;
      const file = session.fileForTransient(item.path);
      if (file && !next.includes(file)) session.removeContext(contextItemKey(item));
    }
    const fresh: File[] = [];
    for (const file of next) {
      if (uploads.includes(file)) continue;
      const known = knownUpload(file);
      if (known) session.addContext(known);
      else fresh.push(file);
    }
    if (fresh.length > 0) void session.attachFiles(fresh);
  };
  return { syncUploads, uploads };
}
