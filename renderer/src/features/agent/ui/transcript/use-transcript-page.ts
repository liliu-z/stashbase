import { useEffect, useState } from 'react';

import type { AgentTranscriptBlock } from '@/features/agent/domain/session';

const PAGE_SIZE = 200;

/** Keep pending decisions reachable, and retain a page explicitly opened by a
 * notification after its one-shot focus target has been consumed. */
export function useTranscriptPage(blocks: AgentTranscriptBlock[], focusBlockId?: string) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const pendingIndex = blocks.findIndex(
    (block) => block.kind === 'tool' && block.status === 'awaiting' && block.permissionId,
  );
  const focusIndex = focusBlockId ? blocks.findIndex((block) => block.id === focusBlockId) : -1;
  useEffect(() => {
    if (focusIndex >= 0) setVisibleCount((count) => Math.max(count, blocks.length - focusIndex));
  }, [focusIndex, blocks.length]);
  let hiddenCount = Math.min(
    Math.max(0, blocks.length - visibleCount),
    pendingIndex < 0 ? blocks.length : pendingIndex,
    focusIndex < 0 ? blocks.length : focusIndex,
  );
  // A page boundary must not strand the beginning of a long turn behind a
  // second disclosure: expanding that turn reveals its complete process.
  let turnStart = hiddenCount;
  while (turnStart > 0) {
    const block = blocks[turnStart];
    if (block?.kind === 'user' && !block.followUp) break;
    turnStart -= 1;
  }
  if (blocks[turnStart]?.kind === 'user') hiddenCount = turnStart;
  return {
    hiddenCount,
    showEarlier: () =>
      setVisibleCount((count) => Math.max(count, blocks.length - hiddenCount) + PAGE_SIZE),
  };
}
