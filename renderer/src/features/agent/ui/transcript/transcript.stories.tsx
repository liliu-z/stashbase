import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AgentTranscriptBlock } from '@/features/agent/domain/session';

import { AgentTranscript } from './transcript';

const blocks: AgentTranscriptBlock[] = [
  { id: 'prompt', kind: 'user', text: 'Compare the sources and revise the introduction.' },
  ...Array.from({ length: 9 }, (_, index): AgentTranscriptBlock => ({
    id: `progress-${index}`,
    kind: 'assistant',
    text: `Source ${index + 1} is checked. I am comparing its evidence with the draft.`,
  })),
  {
    id: 'read',
    kind: 'tool',
    name: 'Read',
    input: { file_path: '/project/introduction.md' },
    status: 'done',
  },
  {
    id: 'search',
    kind: 'tool',
    name: 'Search',
    input: { pattern: 'opening', path: '/project' },
    status: 'done',
  },
  {
    id: 'answer',
    kind: 'assistant',
    turnOutcome: 'completed',
    text: 'The introduction now opens with the main claim and cites the two strongest sources.\n\nThe draft is ready for your review.',
  },
  {
    id: 'files',
    kind: 'turn-changes',
    turnId: 'turn',
    files: [{ path: '/project/introduction.md', change: 'edited', additions: 8, deletions: 3 }],
  },
];

const meta = {
  component: AgentTranscript,
  args: {
    activeTurn: false,
    blocks,
    onOpenExternal: () => {},
    onPermission: () => false,
    onRetry: () => false,
  },
  decorators: [
    (Story) => (
      <div className="flex w-full flex-col gap-3">
        <Story />
      </div>
    ),
  ],
  parameters: { controls: { disable: true }, fluidCanvas: { width: '48rem', minHeight: '25rem' } },
  title: 'Agent/Turn process',
} satisfies Meta<typeof AgentTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Completed: Story = {};
export const Running: Story = { args: { activeTurn: true } };
export const Compact: Story = {
  parameters: { fluidCanvas: { width: '22rem', minHeight: '25rem' } },
};
