import type { Meta, StoryObj } from '@storybook/react-vite';

import { MarkdownReviewBar } from './review-bar';

import './document.css';

const meta = {
  component: MarkdownReviewBar,
  title: 'Documents/Markdown Review Bar',
  parameters: { fluidCanvas: { width: '40rem', minHeight: '8rem' } },
  args: {
    onUndoAll: () => undefined,
    onKeepAll: () => undefined,
    pending: 4,
  },
  decorators: [
    (Story) => (
      <div className="relative min-h-24 bg-surface-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MarkdownReviewBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const LastChange: Story = { args: { pending: 1 } };
