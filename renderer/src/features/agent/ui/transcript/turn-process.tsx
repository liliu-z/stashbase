import { ChevronRight } from 'lucide-react';
import {
  Fragment,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { settledFileChanges } from '@/features/agent/domain/file-change';
import { focusRing } from '@/lib/focus-ring';
import { cn } from '@/lib/utils';

import { visibleActivitySteps } from './activity';
import type { TranscriptGroup } from './transcript-order';

// Presentation choices live only as long as their conversation runtime. They
// survive switching chats without entering native history or durable settings.
const choices = new WeakMap<object, Map<string, boolean>>();

function processMessage(group: TranscriptGroup, finalId?: string) {
  if (group.kind === 'assistant') return group.id !== finalId;
  if (group.kind === 'notice') return true;
  if (group.kind !== 'activity') return false;
  const steps = visibleActivitySteps(group.steps);
  const tools = steps.filter((step) => step.kind === 'tool');
  return (
    steps.length > 0 &&
    settledFileChanges(tools).length === 0 &&
    !tools.some((tool) => tool.status === 'denied' || tool.status === 'cancelled')
  );
}

export function TurnProcess({
  id,
  groups,
  finalId,
  completed,
  scope,
  canFold,
  onToggle,
  focusBlockId,
  renderGroup,
}: {
  id: string;
  groups: TranscriptGroup[];
  finalId?: string | undefined;
  completed: boolean;
  scope: object;
  canFold?: (() => boolean) | undefined;
  onToggle?: (() => void) | undefined;
  focusBlockId?: string | undefined;
  renderGroup(group: TranscriptGroup): ReactNode;
}) {
  const preferences = useMemo(() => {
    let value = choices.get(scope);
    if (!value) {
      value = new Map();
      choices.set(scope, value);
    }
    return value;
  }, [scope]);
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  const open = preferences.get(id);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const parts = useMemo(
    () =>
      groups
        .filter(
          (group) => group.kind !== 'activity' || visibleActivitySteps(group.steps).length > 0,
        )
        .map((group) => ({
          id: group.id,
          process: processMessage(group, finalId),
          group,
        })),
    [groups, finalId],
  );
  const count = parts.filter((part) => part.process).length;
  const eligible = completed && count > 8;
  // A settled turn mounts folded directly. A running turn keeps its content
  // until the layout check can preserve the reader's focus and scroll state.
  const [arrivedCompleted] = useState(eligible);
  const focused = Boolean(
    focusBlockId &&
    parts.some(
      ({ process, group }) =>
        process &&
        (group.id === focusBlockId ||
          (group.kind === 'activity' && group.steps.some((step) => step.id === focusBlockId))),
    ),
  );
  useLayoutEffect(() => {
    if (!eligible || (!focused && open !== undefined)) return;
    const next =
      focused ||
      canFold?.() === false ||
      Boolean(root.current?.contains(root.current.ownerDocument.activeElement));
    preferences.set(id, next);
    refresh();
  }, [canFold, eligible, focused, id, open, preferences]);
  const expanded = !eligible || focused || (open ?? (!arrivedCompleted || canFold?.() === false));
  const firstProcess = parts.findIndex((part) => part.process);
  return (
    <div className="flex min-w-0 flex-col gap-3" ref={root}>
      {parts.map((part, index) => {
        const shown = !part.process || expanded;
        return (
          <Fragment key={part.id}>
            {eligible && index === firstProcess && (
              <button
                aria-controls={parts
                  .flatMap((entry, i) => (entry.process ? [`${panelId}-${i}`] : []))
                  .join(' ')}
                aria-expanded={expanded}
                className={cn(
                  'flex w-full items-center gap-1.5 border-b border-border py-2 text-left text-ui-13 text-muted-foreground outline-none hover:text-foreground',
                  focusRing(),
                )}
                onClick={() => {
                  onToggle?.();
                  preferences.set(id, !expanded);
                  refresh();
                }}
              >
                <ChevronRight
                  aria-hidden
                  className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
                />
                {expanded ? 'Hide' : 'Show'} {count} process messages
              </button>
            )}
            {/* Whole-turn visibility changes directly. An outer measured collapse
              clips message actions and competes with nested activity motion. Keep
              each group's shell stable so permission decisions retain focus. */}
            <div
              className={cn('min-w-0', shown ? 'flex flex-col gap-3' : 'hidden')}
              hidden={!shown}
              id={`${panelId}-${index}`}
            >
              {shown && renderGroup(part.group)}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
