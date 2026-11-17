import os from 'node:os';
import path from 'node:path';
import { readAppConfigStrict, writeAppConfigStrict } from '../app-config.ts';
import { createSpeechModel } from './model.ts';
import { createSpeechService } from './service.ts';

const root = path.join(os.homedir(), '.stashbase', 'speech');
export const speechModel = createSpeechModel({
  root: path.join(root, 'models'),
  paused: () => readAppConfigStrict().voiceTypingDownloadPaused === true,
  setPaused(value) {
    const config = readAppConfigStrict();
    config.voiceTypingDownloadPaused = value;
    writeAppConfigStrict(config);
  },
});
export const speechService = createSpeechService({ root: path.join(root, 'recordings'), modelPath: speechModel.path });

export async function startSpeechPreparation(): Promise<void> {
  await speechService.initialize();
  // Controlled source journeys must not start a 731 MB network transfer or
  // use an installed model from the developer's home.
  if (process.env.STASHBASE_ISOLATED_AGENTS !== '1') await speechModel.start();
}

export async function closeSpeech(): Promise<void> {
  await Promise.allSettled([speechModel.close(), speechService.close()]);
}
