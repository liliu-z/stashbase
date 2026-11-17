import { vi } from 'vite-plus/test';

import type {
  SpeechPort,
  SpeechRecording,
  VoiceTypingPorts,
} from '@/features/agent/application/speech-port';
import type { SpeechCapturePort } from '@/shared/domain/voice-typing';

export function speechFixture(text = 'A dictated idea.') {
  let input: Parameters<SpeechCapturePort['open']>[0] | undefined;
  let tail: Int16Array | null = null;
  let recording: SpeechRecording = {
    id: crypto.randomUUID(),
    phase: 'recording',
    nextSequence: 0,
    text: '',
    error: null,
  };
  const stop = vi.fn(async () => {
    if (tail) {
      const pcm = tail;
      tail = null;
      input?.onAudio(pcm);
    }
  });
  const speech: SpeechPort = {
    model: vi.fn(async () => ({
      phase: 'ready' as const,
      downloadedBytes: 731357568,
      totalBytes: 731357568,
      error: null,
    })),
    start: vi.fn(async (id) => {
      recording = { ...recording, id };
      return { ...recording };
    }),
    audio: vi.fn(async (_id, sequence) => {
      recording.nextSequence = sequence + 1;
      return { ...recording };
    }),
    finish: vi.fn(async () => {
      recording = { ...recording, phase: 'ready' as const, text };
      return { ...recording };
    }),
    status: vi.fn(async () => ({ ...recording })),
    retry: vi.fn(async () => {
      recording.phase = 'recording';
      return { ...recording };
    }),
    cancel: vi.fn(async () => {}),
  };
  const ports: VoiceTypingPorts = {
    speech,
    capture: {
      open: vi.fn(async (options) => {
        input = options;
        return { stop };
      }),
    },
  };
  return {
    ports,
    speech,
    stop,
    emit(pcm = new Int16Array(16000).fill(100)) {
      input?.onAudio(pcm);
    },
    level(value: number) {
      input?.onLevel(value);
    },
    end(message: string) {
      input?.onEnded(message);
    },
    tail(pcm: Int16Array) {
      tail = pcm;
    },
  };
}
