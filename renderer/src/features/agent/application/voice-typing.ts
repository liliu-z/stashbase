/** Dictation belongs to a conversation, never to the mounted composer. */
import { createStore } from 'zustand/vanilla';

import { isFeatureError } from '@/shared/domain/feature-error';
import type { SpeechCapture } from '@/shared/domain/voice-typing';

import type { SpeechRecording, VoiceTypingPorts } from './speech-port';

export interface VoiceTypingState {
  phase: 'idle' | 'starting' | 'recording' | 'processing' | 'failed';
  error: string | null;
  seconds: number;
  levels: readonly number[];
  completedText: string;
  insertion: { before: string; after: string } | null;
}
export const IDLE_VOICE_STATE: VoiceTypingState = {
  phase: 'idle',
  error: null,
  seconds: 0,
  levels: [],
  completedText: '',
  insertion: null,
};
interface Operation {
  id: string;
  requests: AbortController;
  captureAbort: AbortController;
  capture: SpeechCapture | null;
  captureStopped: Promise<void>;
  queue: Int16Array[];
  bytes: number;
  sequence: number;
  sending: Promise<void> | null;
  finishing: Promise<void> | null;
  settled: Promise<void>;
  settle(): void;
  stopped: boolean;
  applied: boolean;
  poll: ReturnType<typeof setTimeout> | undefined;
  warning: string | null;
  epoch: number;
}

const errorMessage = (error: unknown) => {
  if (isFeatureError(error) && error.cause instanceof Error) return error.cause.message;
  if (error instanceof Error && error.name === 'NotAllowedError')
    return 'Microphone permission was denied. Allow StashBase in your system privacy settings and try again.';
  if (error instanceof Error && error.name === 'NotFoundError')
    return 'No microphone was found. Connect one and try again.';
  if (error instanceof Error && error.name === 'NotReadableError')
    return 'The microphone is unavailable or in use by another application.';
  return 'Voice typing could not finish. Retry transcription or discard this recording. Your existing draft was kept.';
};
const signal = (operation: Operation) =>
  AbortSignal.any([operation.requests.signal, AbortSignal.timeout(15_000)]);

export function createVoiceTyping(options: {
  ports: VoiceTypingPorts;
  conversation: string;
  folder: string;
  signal: AbortSignal;
  getDraft(): string;
  append(draft: string): void;
  lock(locked: boolean): void;
}) {
  const { speech, capture } = options.ports;
  const store = createStore<VoiceTypingState>(() => ({ ...IDLE_VOICE_STATE }));
  let active: Operation | null = null;
  let unsent = false;
  let unsentBaseline: string | null = null;
  let cleanupId: string | null = null;
  const current = (operation: Operation) => active === operation && !options.signal.aborted;

  async function cleanup(id: string) {
    cleanupId = id;
    await speech.cancel(id, AbortSignal.timeout(5000));
    if (cleanupId === id) cleanupId = null;
  }
  function fail(operation: Operation, message: string, text = '') {
    if (!current(operation) || operation.applied) return;
    const firstFailure = store.getState().phase !== 'failed';
    operation.stopped = true;
    clearTimeout(operation.poll);
    operation.captureStopped = operation.capture?.stop().catch(() => {}) ?? Promise.resolve();
    operation.capture = null;
    store.setState({
      phase: 'failed',
      error: message,
      completedText: text || store.getState().completedText,
    });
    operation.settle();
    // A failed upload may race the worker's failure response. Recover its
    // committed words even when that response was not the failing request.
    const epoch = operation.epoch;
    if (firstFailure && !text)
      void speech
        .status(operation.id, signal(operation))
        .then((result) => {
          if (
            current(operation) &&
            operation.epoch === epoch &&
            store.getState().phase === 'failed' &&
            (result.phase === 'failed' || result.phase === 'ready')
          )
            store.setState({ completedText: result.text, error: result.error ?? message });
        })
        .catch(() => {});
  }
  async function apply(operation: Operation, text: string) {
    if (!current(operation) || operation.applied) return;
    operation.applied = true;
    clearTimeout(operation.poll);
    const before = options.getDraft();
    const suffix = text.trim();
    const after = suffix ? before + (before && !/\s$/u.test(before) ? ' ' : '') + suffix : before;
    if (suffix) {
      if (!unsent) unsentBaseline = before;
      store.setState({ insertion: { before, after } });
      options.append(after);
      unsent = true;
    }
    options.lock(false);
    store.setState({
      phase: 'idle',
      completedText: '',
      levels: [],
      error: operation.warning ?? (suffix ? null : 'No speech detected.'),
    });
    active = null;
    operation.settle();
    await cleanup(operation.id).catch(() => {});
  }

  async function observe(operation: Operation, result: SpeechRecording) {
    if (!current(operation)) return;
    if (result.phase === 'ready') await apply(operation, result.text);
    else if (result.phase === 'failed')
      fail(operation, result.error ?? errorMessage(null), result.text);
    else if (result.phase === 'cancelled')
      fail(operation, 'The voice recording was cancelled. Your existing draft was kept.');
  }
  function poll(operation: Operation) {
    if (!current(operation) || operation.applied || store.getState().phase === 'failed') return;
    clearTimeout(operation.poll);
    operation.poll = setTimeout(() => {
      if (!current(operation)) return;
      const epoch = operation.epoch;
      void speech
        .status(operation.id, signal(operation))
        .then(async (result) => {
          if (operation.epoch !== epoch) return;
          await observe(operation, result);
          poll(operation);
        })
        .catch((error: unknown) => {
          if (operation.epoch === epoch) fail(operation, errorMessage(error));
        });
    }, 750);
  }
  function drain(operation: Operation): Promise<void> {
    if (operation.sending) return operation.sending;
    operation.sending = (async () => {
      while (current(operation) && operation.queue.length) {
        const pcm = operation.queue[0];
        if (!pcm) return;
        let result: SpeechRecording;
        try {
          result = await speech.audio(operation.id, operation.sequence, pcm, signal(operation));
        } catch (error) {
          if (!current(operation) || operation.requests.signal.aborted) throw error;
          // The sequence and exact PCM are unchanged: a lost acknowledgement
          // can be retried once without submitting the audio twice.
          result = await speech.audio(operation.id, operation.sequence, pcm, signal(operation));
        }
        if (!current(operation)) return;
        if (result.nextSequence !== operation.sequence + 1)
          throw new Error('Audio was not acknowledged');
        operation.sequence++;
        operation.queue.shift();
        operation.bytes -= pcm.byteLength;
        if (result.phase === 'failed') {
          await observe(operation, result);
          return;
        }
      }
    })().finally(() => {
      operation.sending = null;
    });
    return operation.sending;
  }

  async function finish(operation: Operation, mode: 'stop' | 'retry' = 'stop') {
    if (!current(operation)) return;
    if (operation.finishing) return operation.finishing;
    operation.stopped = true;
    store.setState({ phase: 'processing', error: null });
    operation.finishing = (async () => {
      try {
        if (mode === 'retry') {
          await operation.captureStopped;
          await speech.retry(operation.id, signal(operation));
        } else {
          await operation.capture?.stop();
          operation.capture = null;
        }
        await submitFinish(operation);
      } catch (error) {
        fail(operation, errorMessage(error));
      }
    })().finally(() => {
      operation.finishing = null;
    });
    return operation.finishing;
  }

  async function submitFinish(operation: Operation) {
    await drain(operation);
    if (!current(operation) || store.getState().phase === 'failed') return;
    await observe(
      operation,
      await speech.finish(operation.id, operation.sequence, signal(operation)),
    );
    if (current(operation)) poll(operation);
  }

  const runtime = {
    store,
    ports: options.ports,
    draftChanged() {
      if (!options.getDraft() || options.getDraft() === unsentBaseline) {
        unsent = false;
        unsentBaseline = null;
      }
    },
    hasUnsentDraft: () => unsent && options.getDraft().length > 0,
    hasRecording: () => active !== null,
    async start() {
      if (active || options.signal.aborted) return;
      if (cleanupId) {
        try {
          await cleanup(cleanupId);
        } catch (error) {
          store.setState({ error: errorMessage(error) });
          return;
        }
      }
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const operation: Operation = {
        id: crypto.randomUUID(),
        requests: new AbortController(),
        captureAbort: new AbortController(),
        capture: null,
        captureStopped: Promise.resolve(),
        queue: [],
        bytes: 0,
        sequence: 0,
        sending: null,
        finishing: null,
        settled,
        settle,
        stopped: false,
        applied: false,
        poll: undefined,
        warning: null,
        epoch: 0,
      };
      active = operation;
      options.lock(true);
      store.setState({ phase: 'starting', error: null, seconds: 0, levels: [], completedText: '' });
      try {
        await speech.start(operation.id, options.conversation, options.folder, signal(operation));
        if (!current(operation)) return;
        poll(operation);
        const input = await capture.open({
          signal: operation.captureAbort.signal,
          onAudio(pcm) {
            if (!current(operation)) return;
            if (operation.bytes + pcm.byteLength > 4 * 1024 * 1024) {
              operation.warning =
                'Recording stopped because audio could not be delivered quickly enough. Some audio may be missing.';
              void finish(operation);
              return;
            }
            operation.queue.push(pcm);
            operation.bytes += pcm.byteLength;
            store.setState((state) => ({ seconds: state.seconds + pcm.length / 16000 }));
            if (store.getState().phase !== 'failed')
              void drain(operation).catch((error: unknown) => fail(operation, errorMessage(error)));
          },
          onLevel(level) {
            if (current(operation) && !operation.stopped)
              store.setState((state) => ({ levels: [...state.levels.slice(-39), level] }));
          },
          onEnded(message) {
            if (!current(operation) || operation.stopped) return;
            operation.warning = message;
            void finish(operation);
          },
        });
        if (!current(operation) || operation.stopped) {
          operation.captureStopped = input.stop();
          await operation.captureStopped;
          return;
        }
        operation.capture = input;
        store.setState({ phase: 'recording' });
      } catch (error) {
        if (!current(operation)) return;
        await runtime.cancel();
        if (!options.signal.aborted) store.setState({ error: errorMessage(error) });
      }
    },
    async stop(): Promise<void> {
      const operation = active;
      if (!operation) return;
      if (store.getState().phase === 'starting') {
        await runtime.cancel();
        return;
      }
      if (store.getState().phase === 'failed') return;
      await finish(operation);
      await operation.settled;
    },
    async retry() {
      const operation = active;
      if (!operation || store.getState().phase !== 'failed') return;
      operation.epoch++;
      operation.settled = new Promise<void>((resolve) => {
        operation.settle = resolve;
      });
      await finish(operation, 'retry');
    },
    async keepCompleted() {
      const operation = active;
      if (operation && store.getState().phase === 'failed') {
        operation.warning = 'Only the completed part of the recording was added.';
        await apply(operation, store.getState().completedText);
      }
    },
    async cancel() {
      const operation = active;
      if (!operation) return;
      active = null;
      operation.requests.abort();
      operation.captureAbort.abort();
      clearTimeout(operation.poll);
      await operation.capture?.stop().catch(() => {});
      operation.queue = [];
      operation.bytes = 0;
      operation.settle();
      options.lock(false);
      if (!options.signal.aborted)
        store.setState({ phase: 'idle', error: null, completedText: '', levels: [] });
      await cleanup(operation.id).catch(() => {});
    },
  };
  options.signal.addEventListener(
    'abort',
    () => {
      void runtime.cancel();
    },
    { once: true },
  );
  return runtime;
}
export type VoiceTypingRuntime = ReturnType<typeof createVoiceTyping>;
