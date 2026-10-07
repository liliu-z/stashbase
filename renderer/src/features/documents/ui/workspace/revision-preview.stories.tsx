import type { Meta, StoryObj } from '@storybook/react-vite';

import { RevisionPreview } from './revision-preview';

const meta = {
  component: RevisionPreview,
  title: 'Documents/Revision Preview',
  parameters: { fluidCanvas: { width: '32rem', minHeight: '24rem' } },
  args: { onStart: () => undefined, refusal: null },
} satisfies Meta<typeof RevisionPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Refused: Story = {
  args: {
    refusal: 'The earlier text matches the document already, so there is nothing to review.',
  },
};
