import { SPEECH_CAPTURE_CHANNEL, speechCaptureResponseSchema } from '../../shared/protocols/electron/speech.ts';
export function createSpeechCapturePreload(ipc: { invoke(channel: string, payload: unknown): Promise<unknown> }) {
  return Object.freeze({
    async authorize(active: boolean): Promise<boolean> {
      const result = speechCaptureResponseSchema.safeParse(await ipc.invoke(SPEECH_CAPTURE_CHANNEL, { active }));
      return result.success && result.data.ok;
    },
  });
}
