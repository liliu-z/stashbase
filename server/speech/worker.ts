/** Native inference lives only in this disposable embedded-Node child. */
import os from 'node:os';
import { TranscribeModel, setLogHandler, type Session } from 'transcribe-cpp';
import { SPEECH_TRANSCRIBE_OPTIONS, SPEECH_SEGMENT_MAX_SAMPLES } from './model-manifest.ts';

setLogHandler(() => {}); // Native diagnostics must never print recognized text.
let model: TranscribeModel | undefined;
let session: Session | undefined;
let chunks: Float32Array[] = [];
let sampleCount = 0;
let loadedPath = '';
let backend = '';
let queue = Promise.resolve();

type Command = { id: number; kind: 'load'; path: string; cpu: boolean }
  | { id: number; kind: 'begin' | 'finish' | 'reset' }
  | { id: number; kind: 'feed'; pcm: Uint8Array };

function reset() {
  chunks = [];
  sampleCount = 0;
  session?.dispose();
  session = undefined;
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
    session = model.createSession({ nThreads: Math.min(4, Math.max(1, os.availableParallelism() - 1)) });
    return null;
  }
  if (!session) throw new Error('No recording is active');
  if (command.kind === 'feed') {
    const bytes = Buffer.from(command.pcm);
    if (!bytes.length || bytes.length > 32000 || bytes.length % 2) throw new Error('Invalid PCM');
    const pcm = new Float32Array(bytes.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2) / 32768;
    // The host cuts at forty seconds; allow at most one final frame of
    // overhang. Neither a long recording nor a bad parent can grow this queue.
    if (sampleCount + pcm.length > SPEECH_SEGMENT_MAX_SAMPLES + 16000) throw new Error('Speech batch is too large');
    chunks.push(pcm);
    sampleCount += pcm.length;
    return null;
  }
  const pcm = new Float32Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
  // Live text is not shown. Full-attention inference once per bounded batch
  // avoids repeatedly encoding the same overlapping streaming context.
  const result = await session.run(pcm, SPEECH_TRANSCRIBE_OPTIONS);
  if (result.aborted || result.truncated) throw new Error('Recognition stopped before completion');
  const text = result.text.trim();
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
