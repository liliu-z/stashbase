import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { InputMessage, type InputMessageEditorContext } from '@/components/ui/input-message';
import type { SpeechRecording, VoiceTypingPorts } from '@/features/agent/application/speech-port';
import {
  createVoiceTyping,
  type VoiceTypingState,
} from '@/features/agent/application/voice-typing';

import { VoiceTypingControls, VoiceTypingMic } from './voice-typing-controls';

const editorSlot = (context: InputMessageEditorContext) => (
  <div role="textbox" aria-label={context.ariaLabel} aria-readonly={context.disabled}>
    {context.value}
  </div>
);

function VoicePreview({
  phase = 'recording',
  modelReady = true,
}: {
  phase?: VoiceTypingState['phase'];
  modelReady?: boolean;
}) {
  const voice = useMemo(() => {
    const recording: SpeechRecording = {
      id: 'story',
      phase: 'recording',
      nextSequence: 0,
      text: '',
      error: null,
    };
    const ports: VoiceTypingPorts = {
      capture: { open: async () => ({ stop: async () => {} }) },
      speech: {
        model: async () => ({
          phase: modelReady ? 'ready' : 'downloading',
          downloadedBytes: 731357568,
          totalBytes: 731357568,
          error: null,
        }),
        start: async () => recording,
        audio: async () => recording,
        status: async () => recording,
        finish: async () => ({ ...recording, phase: 'ready', text: 'A new idea.' }),
        retry: async () => recording,
        cancel: async () => {},
      },
    };
    return createVoiceTyping({
      ports,
      conversation: 'story',
      folder: '/Research',
      signal: new AbortController().signal,
      getDraft: () => 'Keep this typed idea.',
      append() {},
      lock() {},
    });
  }, [modelReady]);
  useEffect(() => {
    if (phase === 'idle') return;
    void voice.start().then(() =>
      voice.store.setState({
        phase,
        seconds: 83,
        levels: Array.from({ length: 40 }, (_, index) => Math.abs(Math.sin(index * 1.3)) * 0.8),
        completedText: phase === 'failed' ? 'Words from the completed part.' : '',
      }),
    );
    return () => {
      void voice.cancel();
    };
  }, [phase, voice]);
  return (
    <div className="w-full max-w-2xl bg-surface-3 p-4 shadow-surface-3">
      <InputMessage
        editor={editorSlot}
        value="Keep this typed idea."
        onValueChange={() => {}}
        readOnly={phase !== 'idle'}
        actionSlot={phase === 'idle' ? undefined : <VoiceTypingControls voice={voice} />}
        rightSlot={<VoiceTypingMic voice={voice} />}
      />
    </div>
  );
}

const meta = {
  title: 'Features/Agent/Voice typing',
  component: VoicePreview,
  decorators: [
    (Story) => (
      <QueryClientProvider client={new QueryClient()}>
        <Story />
      </QueryClientProvider>
    ),
  ],
} satisfies Meta<typeof VoicePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Recording: Story = {};
export const Starting: Story = { args: { phase: 'starting' } };
export const Processing: Story = { args: { phase: 'processing' } };
export const Recovery: Story = { args: { phase: 'failed' } };
export const Ready: Story = { args: { phase: 'idle' } };
export const ModelNotReady: Story = { args: { phase: 'idle', modelReady: false } };
