import { useQuery } from '@tanstack/react-query';
import { useReducedMotion } from 'framer-motion';
import { Mic, Square } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import type { VoiceTypingRuntime } from '@/features/agent/application/voice-typing';
import { voiceModelQueryKey } from '@/shared/domain/voice-typing';

export function VoiceTypingMic({ voice }: { voice: VoiceTypingRuntime }) {
  const model = useQuery({
    queryKey: voiceModelQueryKey,
    queryFn: ({ signal }) => voice.ports.speech.model(signal),
    retry: false,
    refetchInterval: (query) => (query.state.data?.phase === 'ready' ? false : 5000),
  });
  const ready = model.data?.phase === 'ready';
  return (
    <Tooltip
      content={
        ready
          ? 'Dictate in English'
          : 'Voice typing is not ready. See Settings → General → Voice typing.'
      }
      side="top"
    >
      <span className="inline-flex">
        <Button
          aria-label="Dictate in English"
          disabled={!ready}
          onClick={() => void voice.start()}
          size="icon-compact"
          variant="ghost"
        >
          <Mic />
        </Button>
      </span>
    </Tooltip>
  );
}

export function VoiceTypingControls({ voice }: { voice: VoiceTypingRuntime }) {
  const state = useStore(voice.store);
  const reducedMotion = useReducedMotion();
  const stopButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    stopButton.current?.focus();
  }, []);
  const elapsed = `${Math.floor(state.seconds / 60)}:${String(Math.floor(state.seconds % 60)).padStart(2, '0')}`;
  const recording = state.phase === 'recording' || state.phase === 'starting';
  const label =
    state.phase === 'starting'
      ? 'Starting microphone…'
      : state.phase === 'recording'
        ? 'Recording'
        : state.phase === 'processing'
          ? 'Transcribing…'
          : 'Recording needs attention';
  const bars = Array.from({ length: 40 }, (_, index) => {
    const level = reducedMotion
      ? (state.levels.at(-1) ?? 0)
      : (state.levels[index - (40 - state.levels.length)] ?? 0);
    const height = Math.max(2, Math.min(28, level * 28));
    return `M${index * 4 + 2},${16 - height / 2}v${height}`;
  }).join(' ');
  return (
    <div className="flex flex-wrap items-center gap-3 px-1 py-1">
      <span aria-live="polite" role="status" className="text-caption text-muted-foreground">
        {label}
      </span>
      {state.phase === 'recording' && (
        <span
          role="timer"
          aria-label="Recording duration"
          aria-live="off"
          className="text-caption text-muted-foreground tabular-nums"
        >
          {elapsed}
        </span>
      )}
      {state.phase === 'recording' && (
        <svg aria-hidden viewBox="0 0 160 32" className="h-8 min-w-12 flex-1 text-muted-foreground">
          <path d={bars} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
        {recording ? (
          <Button
            ref={stopButton}
            aria-label="Stop recording"
            size="icon-compact"
            variant="primary"
            onClick={() => void voice.stop()}
          >
            <Square fill="currentColor" />
          </Button>
        ) : state.phase === 'processing' ? (
          <Button size="compact" variant="tertiary" onClick={() => void voice.cancel()}>
            Cancel
          </Button>
        ) : (
          <>
            <Button size="compact" variant="tertiary" onClick={() => void voice.retry()}>
              Retry transcription
            </Button>
            {state.completedText && (
              <Button size="compact" variant="tertiary" onClick={() => void voice.keepCompleted()}>
                Keep completed text
              </Button>
            )}
            <Button size="compact" variant="tertiary" onClick={() => void voice.cancel()}>
              Discard recording
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
