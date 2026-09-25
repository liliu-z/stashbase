import type { ReactNode } from 'react';

import { SURFACE_FAILED } from '@/features/agent/application/failure-messages';
import type { AgentCatalogPort, AgentPersonaPort } from '@/features/agent/application/ports';
import type { AgentWorkspaceRuntime } from '@/features/agent/application/workspace-runtime';
import type { AgentScope } from '@/features/agent/domain/session';
import type { AgentRevisionReview } from '@/features/agent/ui/transcript/revision-card';
import type { SourceReference } from '@/shared/domain/source-reference';
import { lazySurface } from '@/shared/runtime/lazy-surface';
import { SurfaceBoundary } from '@/shared/runtime/surface-boundary';

export interface AgentWorkspaceProps {
  catalog: AgentCatalogPort;
  accountSignedIn?: boolean;
  /** Whether the pane draws its own name row with the conversation's actions
   *  (default true). False while the Chat has the whole card: the titlebar
   *  names the chat then, and the Chats panel beside it manages the history
   *  and New chat. */
  header?: boolean | undefined;
  /** The persona this scope's Chats run under. */
  persona: AgentPersonaPort;
  onOpenExternal(href: string): void;
  onOpenAgentSettings(): void;
  /** Explicit account choice; a caller signal waits for completion without
   *  carrying account tokens or authorizing a send after cancellation. */
  onSignIn(signal?: AbortSignal): void | Promise<boolean>;
  /** Opens a file the Agent changed or cited beside the chat; the user chose
   *  it. A cited phrase is the passage to locate, null for the whole file. */
  onOpenSource?: ((source: SourceReference, phrase: string | null) => void) | undefined;
  /** Restarts preparation for a bound source whose prepared text failed. */
  onReprocess?: ((source: SourceReference) => void) | undefined;
  /** The review open on a document an agent proposed a revision to, by
   *  folder-relative path. The documents feature owns that count, and the
   *  composition layer is where the two features meet. */
  revisionFor?: ((path: string, proposalId: string) => AgentRevisionReview | null) | undefined;
  runtime: AgentWorkspaceRuntime;
}

export interface AgentChatsProps {
  catalog: AgentCatalogPort;
  onOpenAgentSettings(): void;
  runtime: AgentWorkspaceRuntime;
  scope: AgentScope;
  workspaceName: string;
}

/** Both Agent surfaces load behind the same boundary, so a chunk that fails
 *  offers a retry instead of taking the shell down with it. One factory, so
 *  the panel and the sidebar's chats cannot drift into two recoveries; the
 *  wording is the feature's, and only the placement is this file's. */
const agentBoundary = (retry: () => void, children: ReactNode) => (
  <SurfaceBoundary
    placement="pane"
    recovery={{ actions: [{ label: 'Retry', perform: retry }], message: SURFACE_FAILED }}
    surface="Agent"
  >
    {children}
  </SurfaceBoundary>
);

export const AgentWorkspace = lazySurface<AgentWorkspaceProps>(() => import('./workspace'), {
  boundary: agentBoundary,
  fallback: <div className="h-full bg-surface-2" />,
});

export const AgentChats = lazySurface<AgentChatsProps>(() => import('./chats/chats'), {
  boundary: agentBoundary,
  fallback: <p className="px-4 py-2 text-caption text-muted-foreground">Loading chats…</p>,
});
