/** The composer's model-and-thinking control: one trigger naming the model
 *  the next turn runs on and how hard it thinks, over a panel that holds the
 *  thinking level as a slider and keeps the model list one step deeper, in a
 *  menu of its own. The level is the thing a reader changes turn to turn; the
 *  model is chosen once. It sits beside Send, where the reader looks last
 *  before sending. */
import { Popover } from '@base-ui/react/popover';
import { Brain, ChevronRight, RotateCcw } from 'lucide-react';
import { useId, useRef, useState, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownTrigger } from '@/components/ui/dropdown';
import { Elevated } from '@/components/ui/elevated';
import { Tooltip } from '@/components/ui/tooltip';
import type { Agent } from '@/features/agent/domain/agent-catalog';
import { modelChoice, type ModelChoice } from '@/features/agent/domain/model-choice';
import type { AgentSessionState } from '@/features/agent/domain/session';
import type { AgentRuntimeUpdateView } from '@/features/agent/hooks/use-agent-runtime-update';
import { focusRing } from '@/lib/focus-ring';
import { useShape } from '@/lib/shape-context';
import { useSize } from '@/lib/size-context';
import { cn } from '@/lib/utils';

import { ComposerMenuTrigger } from './menu-trigger';
import { NARROWEST_LABEL } from './narrow';
import { ModelMenu, modelDisplayName, type ThinkingState } from './thinking-models';
import { effortLabel, rankedLevels, ThinkingSlider } from './thinking-slider';

export interface AgentThinkingControlProps {
  activeAgent: Agent;
  state: ThinkingState &
    Pick<AgentSessionState, 'transcript'> & {
      /** Whether a turn is streaming; model and level are fixed for its run. */
      activeTurn: boolean;
    };
  onEffortChange(effort: string | null): void;
  onModelChange(model: string | null): void;
  /** Called when the trigger is pressed, so the catalog can be re-read. */
  onRequestCatalog(): void;
  runtimeUpdate?: AgentRuntimeUpdateView | undefined;
}

/** The panel: the model leads, centred at the top with Reset at the corner,
 *  and opens one step deeper to a menu of its own; the level it thinks at
 *  reads under it, quieter, live while the slider below moves. A locked model
 *  says why in visible text: a disabled control cannot show a tooltip. */
function ThinkingPanel({
  choice,
  modelLocked,
  modelName,
  models,
  onEffortChange,
  onModelChange,
  panel,
  runtimeUpdate,
  state,
}: {
  choice: ModelChoice;
  modelLocked: boolean;
  modelName: string;
  models: boolean;
  onEffortChange(effort: string | null): void;
  onModelChange(model: string | null): void;
  /** The panel's own box, which the model menu clears rather than covering
   *  the name it opened from. */
  panel: RefObject<HTMLDivElement | null>;
  runtimeUpdate?: AgentRuntimeUpdateView | undefined;
  state: ThinkingState;
}) {
  const sizeClasses = useSize();
  const shape = useShape();
  // Where the thumb is while it moves, so the name above follows it.
  const [moving, setMoving] = useState<number | null>(null);
  const { ranked, unranked } = rankedLevels(choice.efforts);
  const chosen = choice.effort === null ? -1 : ranked.indexOf(choice.effort);
  const position = moving ?? chosen;
  const declared = choice.model?.defaultEffort;
  const hasDeclaredDefault = declared !== undefined && choice.efforts.includes(declared);
  const atDefault = choice.effort === null || (hasDeclaredDefault && choice.effort === declared);
  const levels = choice.efforts.length > 0;
  const shownLevel = (position >= 0 ? ranked[position] : choice.effort) ?? null;
  const modelText = cn('px-1.5 py-0.5 font-medium text-foreground', sizeClasses.text);
  const lockReason = useId();
  return (
    <div className="flex flex-col gap-2 px-3 pt-2.5 pb-3">
      {/* Reset's width mirrored on the left, so the model centres on the panel. */}
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_1.75rem] items-start">
        <span aria-hidden="true" />
        <div className="flex min-w-0 flex-col items-center gap-0.5">
          {models ? (
            <DropdownMenu disabled={modelLocked}>
              <DropdownTrigger
                render={
                  <button
                    aria-describedby={modelLocked ? lockReason : undefined}
                    aria-label={`Model: ${modelName}`}
                    className={cn(
                      'flex max-w-full cursor-pointer items-center gap-0.5 outline-none',
                      modelText,
                      shape.chip,
                      'transition-colors duration-fast hover:bg-hover data-[popup-open]:bg-hover',
                      'disabled:pointer-events-none disabled:opacity-50',
                      focusRing(),
                    )}
                    disabled={modelLocked}
                    type="button"
                  />
                }
              >
                <span className="min-w-0 truncate">{modelName}</span>
                <ChevronRight
                  aria-hidden="true"
                  className="shrink-0 text-muted-foreground"
                  size={12}
                  strokeWidth={1.75}
                />
              </DropdownTrigger>
              <ModelMenu
                anchor={panel}
                choice={choice}
                onModelChange={onModelChange}
                runtimeUpdate={runtimeUpdate}
                state={state}
              />
            </DropdownMenu>
          ) : (
            <span className={cn('truncate', modelText)}>{modelName}</span>
          )}
          <span className={cn('truncate text-muted-foreground', sizeClasses.caption)}>
            {levels
              ? shownLevel === null
                ? 'Default'
                : effortLabel(shownLevel)
              : 'Thinking is set by the runtime'}
          </span>
          {models && modelLocked && (
            <Popover.Description
              className={cn('text-center text-muted-foreground', sizeClasses.caption)}
              id={lockReason}
            >
              Kept for this chat · Start a new chat to switch
            </Popover.Description>
          )}
        </div>
        {levels ? (
          <Tooltip content="Reset to default" side="top">
            <Button
              aria-label="Reset thinking to the model's default"
              disabled={atDefault}
              onClick={() => onEffortChange(null)}
              size="icon-compact"
              variant="ghost"
            >
              <RotateCcw aria-hidden="true" />
            </Button>
          </Tooltip>
        ) : (
          <span aria-hidden="true" />
        )}
      </div>
      {ranked.length > 0 && (
        <ThinkingSlider
          effort={choice.effort}
          onEffortChange={onEffortChange}
          onMove={setMoving}
          position={position}
          ranked={ranked}
        />
      )}
      {unranked.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1">
          {unranked.map((effort) => (
            <Button
              aria-pressed={choice.effort === effort}
              key={effort}
              onClick={() => onEffortChange(effort)}
              size="compact"
              variant={choice.effort === effort ? 'secondary' : 'ghost'}
            >
              {effortLabel(effort)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Renders nothing for a runtime that advertises neither a model nor a level
 *  choice, so the caller places it without asking. Default's main model is
 *  fixed, so it offers its optional tools instead. A runtime with models but
 *  no level opens straight on the model list. */
export function AgentThinkingControl({
  activeAgent,
  onEffortChange,
  onModelChange,
  onRequestCatalog,
  runtimeUpdate,
  state,
}: AgentThinkingControlProps) {
  const { effort, models } = activeAgent.abilities;
  const disabled = state.activeTurn;
  // Catalog notices and startup errors can appear before any conversation content.
  const modelLocked =
    activeAgent.id === 'claude' &&
    state.transcript.some((block) => block.kind !== 'notice' && block.kind !== 'error');
  const choice = modelChoice(state);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const shape = useShape();
  const name = modelDisplayName(choice.model, state.models);
  const effortName = choice.effort === null ? null : effortLabel(choice.effort);
  const reading = effortName === null ? name : `${name}, ${effortName}`;
  const label = `Model and thinking: ${reading}`;

  if (!effort && !models) return null;

  const trigger = (
    <ComposerMenuTrigger
      className="max-w-56"
      disabled={disabled}
      icon={Brain}
      label={label}
      onClick={onRequestCatalog}
      popover={effort}
    >
      {/* The model's name leads and the level follows it; both stay until
          the narrowest step (narrow.ts), and a long name truncates first. */}
      <span className="flex min-w-0 items-center gap-1 overflow-hidden">
        <span className={cn('min-w-0 truncate', NARROWEST_LABEL)}>{name}</span>
        {effortName !== null && (
          <span className={cn('shrink-0 text-muted-foreground', NARROWEST_LABEL)}>
            {effortName}
          </span>
        )}
      </span>
    </ComposerMenuTrigger>
  );

  if (!effort) {
    return (
      <DropdownMenu disabled={disabled}>
        {trigger}
        <ModelMenu
          choice={choice}
          onModelChange={onModelChange}
          runtimeUpdate={runtimeUpdate}
          state={state}
        />
      </DropdownMenu>
    );
  }

  return (
    <Popover.Root onOpenChange={setOpen} open={open && !disabled}>
      {trigger}
      <Popover.Portal>
        <Popover.Positioner align="end" className="z-50 outline-none" side="top" sideOffset={6}>
          <Popover.Popup
            aria-label="Model and thinking"
            ref={panel}
            // A larger radius than the menus': a panel of a few controls
            // rather than a list, the way the composer card it rises from
            // rounds its own corners.
            className={cn(
              'flex w-64 max-w-[calc(100vw-1rem)] flex-col p-1 outline-none',
              shape.card,
            )}
            render={<Elevated offset={2} shadowLevel={3} />}
          >
            <ThinkingPanel
              choice={choice}
              modelLocked={modelLocked}
              modelName={name}
              models={models}
              onEffortChange={onEffortChange}
              onModelChange={(model) => {
                onModelChange(model);
                setOpen(false);
              }}
              panel={panel}
              runtimeUpdate={runtimeUpdate}
              state={state}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
