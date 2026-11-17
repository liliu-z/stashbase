/** Native inference lives only in this disposable embedded-Node child. */
import os from 'node:os';
import { TranscribeModel, setLogHandler } from 'transcribe-cpp';
import { createBufferedRecognition } from './stream.ts';

setLogHandler(() => {}); // Native diagnostics must never print recognized text.
let model: TranscribeModel | undefined;
let recognition: ReturnType<typeof createBufferedRecognition> | undefined;
let loadedPath = '';
let backend = '';
let queue = Promise.resolve();

type Command = { id: number; kind: 'load'; path: string; cpu: boolean }
  | { id: number; kind: 'begin' }
  | { id: number; kind: 'reset' }
  | { id: number; kind: 'finish'; startSample?: number; endSample?: number }
  | { id: number; kind: 'feed'; pcm: Uint8Array };

function reset() {
  recognition?.dispose();
  recognition = undefined;
}

async function run(command: Command): Promise<unknown> {
  if (command.kind === 'load') {
    const selected = !command.cpu && process.platform === 'darwin' && process.arch === 'arm64' ? 'metal' : 'cpu';
    if (!model || loadedPath !== command.path || backend !== selected) {
      reset();
      model?.dispose();
      model = undefined;
      model = await TranscribeModel.load(command.path, { backend: selected });
      loadedPath = command.path;
      backend = selected;
    }
    return { backend: model.backend };
  }
  if (command.kind === 'reset') { reset(); return null; }
  if (!model) throw new Error('Model is not loaded');
  if (command.kind === 'begin') {
    reset();
    const loaded = model;
    recognition = createBufferedRecognition(() => loaded.createSession({
      nThreads: Math.min(4, Math.max(1, os.availableParallelism() - 1)),
    }));
    return null;
  }
  if (!recognition) throw new Error('No recording is active');
  if (command.kind === 'feed') {
    const bytes = Buffer.from(command.pcm);
    if (!bytes.length || bytes.length > 32000 || bytes.length % 2) throw new Error('Invalid PCM');
    const pcm = new Float32Array(bytes.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2) / 32768;
    await recognition.feed(pcm);
    return null;
  }
  const text = await recognition.finish(command);
  reset();
  return { text };
}

process.on('message', (message: Command) => {
  queue = queue.then(async () => {
    try {
      const result = await run(message);
      process.send?.({ id: message.id, ok: true, result });
    } catch {
      // The owning host classifies this and retains the uncommitted audio.
      process.send?.({ id: message.id, ok: false });
    }
  });
});
process.on('disconnect', () => process.exit(0));
