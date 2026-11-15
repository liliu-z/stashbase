import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { VoiceModelState } from '@/shared/domain/voice-typing';

import { GeneralPanel } from './general-panel';

function VoiceSettingsPreview({ phase = 'downloading' }: { phase?: VoiceModelState['phase'] }) {
  let state: VoiceModelState = {
    phase,
    downloadedBytes: phase === 'ready' ? 731357568 : 292543027,
    totalBytes: 731357568,
    error:
      phase === 'failed'
        ? 'The voice model could not be downloaded. Check your connection and retry in Settings.'
        : null,
  };
  return (
    <GeneralPanel
      softwareUpdate={null}
      voiceModelApi={{
        load: async () => state,
        command: async (action) =>
          (state = { ...state, phase: action === 'stop' ? 'paused' : 'downloading' }),
      }}
    />
  );
}

const meta = {
  title: 'Settings/Voice typing',
  component: VoiceSettingsPreview,
  decorators: [
    (Story) => (
      <QueryClientProvider client={new QueryClient()}>
        <Story />
      </QueryClientProvider>
    ),
  ],
  parameters: { fluidCanvas: { width: '40rem', minHeight: '20rem' } },
} satisfies Meta<typeof VoiceSettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Downloading: Story = {};
export const Paused: Story = { args: { phase: 'paused' } };
export const Verifying: Story = { args: { phase: 'verifying' } };
export const Ready: Story = { args: { phase: 'ready' } };
export const Failed: Story = { args: { phase: 'failed' } };
export const Waiting: Story = { args: { phase: 'missing' } };
export const Unsupported: Story = { args: { phase: 'unsupported' } };
