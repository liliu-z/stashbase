import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSpeechModel } from '../../server/speech/model.ts';

/** The checked-in public-domain fixture is mono 16 kHz PCM16. */
export function speechFixturePcm(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid speech fixture.');
  let audio;
  let validFormat = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (offset + 8 + size > wav.length) throw new Error('Truncated speech fixture.');
    const name = wav.toString('ascii', offset, offset + 4);
    if (name === 'fmt ' && size >= 16) validFormat = wav.readUInt16LE(offset + 8) === 1 && wav.readUInt16LE(offset + 10) === 1 && wav.readUInt32LE(offset + 12) === 16000 && wav.readUInt16LE(offset + 22) === 16;
    if (name === 'data') audio = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  if (!validFormat || !audio || audio.length % 2) throw new Error('Speech fixture must be mono 16 kHz PCM16.');
  return audio;
}

export async function speechModelFile(root, args) {
  const modelAt = args.indexOf('--model');
  const explicit = modelAt < 0 ? '' : args[modelAt + 1];
  if (explicit) return path.resolve(explicit);
  if (!args.includes('--download')) throw new Error('Pass --model <pinned GGUF> or --download for explicit model preparation.');
  const model = createSpeechModel({ root: path.join(root, 'profiling.nosync', 'speech-model'), paused: () => false, setPaused() {} });
  try {
    await model.start();
    const deadline = Date.now() + 15 * 60_000;
    while (!['ready', 'failed', 'unsupported'].includes(model.status().phase)) {
      if (Date.now() > deadline) throw new Error('Speech model preparation timed out.');
      await delay(250);
    }
    if (!model.path()) throw new Error(model.status().error ?? 'The speech model is not ready.');
    return model.path();
  } finally { await model.close(); }
}

