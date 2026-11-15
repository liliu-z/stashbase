import { useEffect, useLayoutEffect, useRef } from 'react';

import type {
  AgentContextPort,
  AgentPreferencesPort,
  AgentSessionPort,
} from '@/features/agent/application/ports';
import type { AgentFilesChanged } from '@/features/agent/application/session-runtime';
import type { AgentUsageEvent } from '@/features/agent/application/session/usage';
import type { VoiceTypingPorts } from '@/features/agent/application/speech-port';
import {
  createAgentWorkspaceRuntime,
  type AgentWorkspaceRuntime,
} from '@/features/agent/application/workspace-runtime';
import { useRetainedRuntime } from '@/shared/runtime/use-retained-runtime';

export interface AgentWorkspaceRuntimeOptions {
  voice?: VoiceTypingPorts;
  recordUsage?: ((event: AgentUsageEvent) => void) | undefined;
  context: AgentContextPort;
  createId(): string;
  folderPath: string | null;
  /** Files an Agent's settled write changed; the latest handler is called. */
  onFilesChanged?: (change: AgentFilesChanged) => void;
  session: AgentSessionPort;
  preferences?: AgentPreferencesPort;
  subscribeFolderRemoved(handler: (folderPath: string) => void): () => void;
}

/** Owns the Agent workspace for one renderer window. Blank drafts stay local;
 * the catalog readiness gate allows the first turn to start transport. */
export function useAgentWorkspaceRuntime({
  context,
  createId,
  folderPath,
  onFilesChanged,
  recordUsage,
  session,
  preferences,
  subscribeFolderRemoved,
  voice,
}: AgentWorkspaceRuntimeOptions): AgentWorkspaceRuntime {
  const filesChangedHandler = useRef(onFilesChanged);
  filesChangedHandler.current = onFilesChanged;
  const runtime = useRetainedRuntime(
    () =>
      createAgentWorkspaceRuntime({
        autostart: false,
        context,
        createId,
        folderPath,
        onFilesChanged: (change) => filesChangedHandler.current?.(change),
        port: session,
        preferences,
        recordUsage,
        ...(voice ? { voice } : {}),
      }),
    (agent) => agent.dispose(),
  );

  useEffect(() => {
    // Read on entry so a Welcome window inherits choices made elsewhere while
    // it was open, without reusing a preference request started on Welcome.
    if (folderPath) void runtime.loadPreferences();
  }, [folderPath, runtime]);
  useLayoutEffect(() => runtime.setWindowFolder(folderPath), [folderPath, runtime]);
  useEffect(
    () => subscribeFolderRemoved((path) => runtime.retireFolder(path)),
    [runtime, subscribeFolderRemoved],
  );

  return runtime;
}
