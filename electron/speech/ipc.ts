import type { IpcMain } from 'electron';
import {
  SPEECH_CAPTURE_CAPABILITY, SPEECH_CAPTURE_CHANNEL, speechCaptureRequestSchema,
} from '../../shared/protocols/electron/speech.ts';
import { authorizeSender, type SenderAuthorization } from '../project/dialog.ts';
export { SPEECH_CAPTURE_CAPABILITY };

export function registerSpeechCapture(dependencies: SenderAuthorization & {
  ipcMain: Pick<IpcMain, 'handle'>;
  authorize(window: NonNullable<ReturnType<typeof authorizeSender>>, active: boolean): boolean;
}): void {
  dependencies.ipcMain.handle(SPEECH_CAPTURE_CHANNEL, (event, payload) => {
    const window = authorizeSender(event, dependencies, SPEECH_CAPTURE_CAPABILITY);
    const parsed = speechCaptureRequestSchema.safeParse(payload);
    return { ok: Boolean(window && parsed.success && dependencies.authorize(window, parsed.data.active)) };
  });
}
