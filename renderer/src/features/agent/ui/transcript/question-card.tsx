/** An Agent's clarifying questions as a card the reader answers in place:
 *  each question with the options the Agent offered, one ticked for a single
 *  choice or several for a multi-select, and a line for an answer of the
 *  reader's own. The answers go back on the same reply an approval travels
 *  on, keyed by question text, which is how the runtime hands them to the
 *  tool. Skip sends no answer and the Agent is told so. */
import { Check, MessageCircleQuestionMark } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  agentQuestionReplies,
  type AgentQuestion,
  type AgentQuestionAnswers,
  type AgentQuestionChoice,
  type AgentQuestionOption,
} from '@/features/agent/domain/question';
import { FOCUS_RING_TINT, focusRing } from '@/lib/focus-ring';
import { useShape } from '@/lib/shape-context';
import { cn } from '@/lib/utils';

import { AgentDecisionCard, AgentDecisionStatus } from './decision-card';
import type { AgentToolBlock } from './tool-presentation';

const OTHER: AgentQuestionOption = { description: '', label: 'Other' };
const UNANSWERED: AgentQuestionChoice = { labels: [], other: null };

function ChoiceRow({
  checked,
  multiSelect,
  name,
  onToggle,
  option,
}: {
  checked: boolean;
  multiSelect: boolean;
  name: string;
  onToggle(): void;
  option: AgentQuestionOption;
}) {
  const shape = useShape();
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2 px-2 py-1.5 transition-colors duration-fast hover:bg-hover has-[:focus-visible]:ring-1',
        shape.item,
        FOCUS_RING_TINT,
      )}
    >
      <input
        checked={checked}
        className="sr-only"
        name={name}
        onChange={onToggle}
        type={multiSelect ? 'checkbox' : 'radio'}
      />
      <span
        aria-hidden
        className={cn(
          'mt-[3px] flex size-3.5 shrink-0 items-center justify-center border transition-colors duration-fast',
          multiSelect ? shape.glyph : shape.circle,
          checked ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground',
        )}
      >
        {checked &&
          (multiSelect ? (
            <Check className="size-2.5" strokeWidth={3} />
          ) : (
            <span className={cn('size-1.5 bg-background', shape.circle)} />
          ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui-13 leading-5 text-foreground">{option.label}</span>
        {option.description && (
          <span className="block text-ui-12 leading-4 text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
    </label>
  );
}

function QuestionField({
  choice,
  headingId,
  onChange,
  onSubmit,
  question,
  single,
}: {
  choice: AgentQuestionChoice;
  /** The card heading's id when it is this question's text, so the group
   *  takes its name from there rather than repeating it. */
  headingId: string | undefined;
  onChange(choice: AgentQuestionChoice): void;
  onSubmit(): void;
  question: AgentQuestion;
  single: boolean;
}) {
  const shape = useShape();
  const name = useId();
  const otherRef = useRef<HTMLInputElement>(null);
  const otherOpen = choice.other !== null;
  // Taking the Other line is choosing to type, so the caret goes there.
  useEffect(() => {
    if (otherOpen) otherRef.current?.focus();
  }, [otherOpen]);
  const toggle = (label: string) => {
    if (!question.multiSelect) {
      onChange({ labels: [label], other: null });
      return;
    }
    const labels = choice.labels.includes(label)
      ? choice.labels.filter((chosen) => chosen !== label)
      : [...choice.labels, label];
    onChange({ ...choice, labels });
  };
  const toggleOther = () => {
    if (!question.multiSelect) {
      onChange({ labels: [], other: choice.other ?? '' });
      return;
    }
    onChange({ ...choice, other: otherOpen ? null : '' });
  };
  return (
    <fieldset aria-labelledby={headingId} className="min-w-0">
      {(!single || question.header) && (
        <legend className="mb-1.5 flex flex-wrap items-baseline gap-x-2 px-2">
          {question.header && (
            <span className="text-ui-11 font-medium tracking-wide text-muted-foreground uppercase">
              {question.header}
            </span>
          )}
          {!single && (
            <span className="text-ui-13 font-medium text-foreground">{question.question}</span>
          )}
        </legend>
      )}
      <div className="flex flex-col gap-0.5">
        {question.options.map((option) => (
          <ChoiceRow
            checked={choice.labels.includes(option.label)}
            key={option.label}
            multiSelect={question.multiSelect}
            name={name}
            onToggle={() => toggle(option.label)}
            option={option}
          />
        ))}
        <ChoiceRow
          checked={otherOpen}
          multiSelect={question.multiSelect}
          name={name}
          onToggle={toggleOther}
          option={OTHER}
        />
        {otherOpen && (
          <input
            aria-label="Your answer"
            className={cn(
              'mx-2 mt-0.5 border border-border bg-background px-2 py-1 text-ui-13 text-foreground outline-none placeholder:text-muted-foreground',
              shape.input,
              focusRing(),
            )}
            onChange={(event) => onChange({ ...choice, other: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              onSubmit();
            }}
            placeholder="Type your answer"
            ref={otherRef}
            type="text"
            value={choice.other ?? ''}
          />
        )}
      </div>
    </fieldset>
  );
}

export function AgentQuestionCard({
  onReply,
  questions,
  tool,
}: {
  onReply(
    toolUseId: string,
    permissionId: string,
    allow: boolean,
    decision?: { answers: AgentQuestionAnswers },
  ): boolean;
  questions: AgentQuestion[];
  tool: AgentToolBlock;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [choices, setChoices] = useState<AgentQuestionChoice[]>(() =>
    questions.map(() => UNANSWERED),
  );
  const permissionId = tool.permissionId;
  const answers = agentQuestionReplies(questions, choices);
  const single = questions.length === 1;
  const heading = single ? (questions[0]?.question ?? '') : 'A few questions before continuing';
  const decide = (allow: boolean) => {
    if (!permissionId) return;
    const sent = allow
      ? answers !== null && onReply(tool.id, permissionId, true, { answers })
      : onReply(tool.id, permissionId, false);
    if (sent) requestAnimationFrame(() => headingRef.current?.focus());
  };
  return (
    <AgentDecisionCard
      heading={heading}
      headingId={single ? headingId : undefined}
      headingRef={headingRef}
      icon={MessageCircleQuestionMark}
    >
      <div className="mt-3 flex flex-col gap-4">
        {questions.map((question, index) => (
          <QuestionField
            choice={choices[index] ?? UNANSWERED}
            headingId={single ? headingId : undefined}
            key={question.question}
            onChange={(choice) =>
              setChoices((current) => current.map((held, at) => (at === index ? choice : held)))
            }
            onSubmit={() => decide(true)}
            question={question}
            single={single}
          />
        ))}
      </div>
      {permissionId ? (
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={() => decide(false)} size="compact" variant="tertiary">
            Skip
          </Button>
          <Button
            disabled={answers === null}
            leadingIcon={Check}
            onClick={() => decide(true)}
            size="compact"
          >
            Answer
          </Button>
        </div>
      ) : (
        <AgentDecisionStatus status={tool.status} />
      )}
    </AgentDecisionCard>
  );
}

/** The questions a settled call asked and what the reader answered, behind
 *  the call's row in the activity group. */
export function AgentQuestionSummary({
  answers,
  questions,
}: {
  answers: AgentQuestionAnswers | null;
  questions: AgentQuestion[];
}) {
  return (
    <dl className="space-y-1.5">
      {questions.map((question) => (
        <div key={question.question}>
          <dt className="text-foreground">{question.question}</dt>
          <dd className="text-muted-foreground">
            {answers?.[question.question] ?? 'Not answered'}
          </dd>
        </div>
      ))}
    </dl>
  );
}
