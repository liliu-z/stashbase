/** The Agent area: the active chat, or the project's scheduled tasks in its
 *  place. The chat stays mounted underneath, hidden, so its scroll position,
 *  draft and focus are where the reader left them when it comes back. */
import { useStore } from 'zustand';

import { cn } from '@/lib/utils';

import { ScheduledTasksView } from './scheduled/scheduled-tasks-view';
import ManagedAgentWorkspace from './workspace';
import type { AgentWorkspaceProps } from './workspace-lazy';

export default function AgentWorkspaceSurface(props: AgentWorkspaceProps) {
  const surface = useStore(props.runtime.store, (state) => state.surface);
  const scope = useStore(
    props.runtime.store,
    (state) => state.tabs.find((tab) => tab.id === state.activeId)?.scope ?? null,
  );
  const showTasks = surface === 'scheduled-tasks' && props.scheduledTasks && scope;
  return (
    <>
      <div className={cn(showTasks ? 'hidden' : 'contents')}>
        <ManagedAgentWorkspace {...props} />
      </div>
      {showTasks && props.scheduledTasks && scope && (
        <ScheduledTasksView
          catalog={props.catalog}
          header={props.header !== false}
          onOpenAgentSettings={props.onOpenAgentSettings}
          port={props.scheduledTasks}
          runtime={props.runtime}
          scope={scope}
        />
      )}
    </>
  );
}
