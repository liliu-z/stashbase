import { useAppActions, useWorkspace } from '@/store/contexts/AppContext';
import { nameSetSize } from '@/store/state/state';

interface SemanticIndexingNoticeModel {
  awaiting: boolean;
  count: number;
  estimatedBytes?: number;
  failureMessage?: string;
  onStart: () => void;
  onDefer: () => void;
}

const NOTICE_STATES = ['awaiting-decision', 'paused', 'partial-paused'];

/** The Similarity Search workload the Files panel and the search popup both announce,
 *  or `null` when there is nothing to say. One rule, so the two surfaces
 *  cannot disagree about when the notice is due. */
export function useSemanticIndexingNotice(): SemanticIndexingNoticeModel | null {
  const state = useWorkspace();
  const { actions } = useAppActions();
  const workload = state.semanticIndexing;
  if (!workload || !NOTICE_STATES.includes(workload.state)) return null;
  return {
    awaiting: workload.state === 'awaiting-decision',
    count: workload.sourceCount ?? nameSetSize(state.pendingSemanticNames),
    estimatedBytes: workload.estimatedBytes,
    failureMessage: state.indexWarning?.message,
    onStart: () => { void actions.decideSemanticIndexing('start'); },
    onDefer: () => { void actions.decideSemanticIndexing('defer'); },
  };
}
