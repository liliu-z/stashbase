import type { SpeechCapturePort } from '@/shared/domain/voice-typing';

import workletUrl from './speech-worklet?worker&url';

export function createSpeechCapture(authority: {
  authorize(active: boolean): Promise<boolean>;
}): SpeechCapturePort {
  return {
    async open({ signal, onAudio, onLevel, onEnded }) {
      signal.throwIfAborted();
      if (!(await authority.authorize(true)))
        throw new Error('This window cannot access the microphone.');
      let media: MediaStream | undefined;
      let context: AudioContext | undefined;
      let node: AudioWorkletNode | undefined;
      let stopped: Promise<void> | undefined;
      let stopping = false;
      let confirmStopped: (() => void) | undefined;
      const release = async () => {
        media?.getTracks().forEach((track) => track.stop());
        node?.disconnect();
        node?.port.close();
        await context?.close().catch(() => {});
        await authority.authorize(false).catch(() => {});
        signal.removeEventListener('abort', abort);
      };
      const stop = (): Promise<void> =>
        (stopped ??= (async () => {
          stopping = true;
          media?.getTracks().forEach((track) => track.stop());
          try {
            if (node) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        'The microphone could not finish its last audio. Completed text was kept.',
                      ),
                    ),
                  1500,
                );
                confirmStopped = () => {
                  clearTimeout(timer);
                  resolve();
                };
                node?.port.postMessage({ kind: 'stop' }, { transfer: [] });
              });
            }
          } finally {
            await release();
          }
        })());
      const abort = () => {
        void stop().catch(() => {});
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        const pending = navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        // Permission dialogs can outlive cancellation. A late stream is always
        // stopped, even after its caller has left the conversation.
        void pending.then(
          (stream) => {
            if (signal.aborted || stopping) stream.getTracks().forEach((track) => track.stop());
          },
          () => {},
        );
        media = await pending;
        signal.throwIfAborted();
        context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
        if (context.sampleRate !== 16000)
          throw new Error('This microphone cannot provide the audio rate voice typing needs.');
        await context.audioWorklet.addModule(workletUrl);
        signal.throwIfAborted();
        node = new AudioWorkletNode(context, 'stashbase-speech', {
          channelCount: 1,
          channelCountMode: 'explicit',
        });
        node.port.addEventListener('message', (event: MessageEvent<unknown>) => {
          const message = event.data as { kind?: string; pcm?: ArrayBuffer; value?: number };
          if (message.kind === 'stopped') confirmStopped?.();
          else if (
            message.kind === 'audio' &&
            message.pcm instanceof ArrayBuffer &&
            !signal.aborted
          )
            onAudio(new Int16Array(message.pcm));
          else if (message.kind === 'level' && typeof message.value === 'number' && !stopping)
            onLevel(message.value);
        });
        node.port.start();
        node.addEventListener('processorerror', () =>
          onEnded('The microphone stopped unexpectedly. Completed text was kept.'),
        );
        context.addEventListener('statechange', () => {
          if (!stopping && context?.state === 'suspended')
            onEnded('Recording stopped when audio was suspended. Completed text was kept.');
        });
        for (const track of media.getTracks())
          track.addEventListener('ended', () => {
            if (!stopping) onEnded('The microphone was disconnected. Completed text was kept.');
          });
        context.createMediaStreamSource(media).connect(node);
        node.connect(context.destination); // The processor emits only silence.
        await context.resume();
        signal.throwIfAborted();
        return { stop };
      } catch (error) {
        stopping = true;
        await release();
        throw error;
      }
    },
  };
}
