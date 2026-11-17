import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type Call = { kind: 'load'; path: string; cpu: boolean }
  | { kind: 'begin' | 'reset' }
  | { kind: 'finish'; startSample?: number; endSample?: number }
  | { kind: 'feed'; pcm: Uint8Array };

export interface SpeechEngine {
  load(modelPath: string, cpu: boolean): Promise<void>;
  begin(): Promise<void>;
  feed(pcm: Uint8Array): Promise<void>;
  finish(range?: { startSample?: number; endSample?: number }): Promise<string>;
  close(): Promise<void>;
}

/** One worker, no renderer-selected executable or library. Timeout, crash,
 * cancellation and shutdown all retire its pending calls before replacement. */
export function createSpeechEngine(): SpeechEngine {
  let child: ChildProcess | undefined;
  let sequence = 0;
  let generation = 0;
  let retiring = Promise.resolve();
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  function fail() {
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Local speech recognition stopped. Retry transcription.'));
    }
    waiting.clear();
  }

  function stopChild(owned: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { owned.kill('SIGKILL'); }, 1500);
      timer.unref();
      owned.once('close', () => { clearTimeout(timer); resolve(); });
      if (owned.exitCode !== null || owned.signalCode !== null) { clearTimeout(timer); resolve(); }
      else owned.kill();
    });
  }

  function retireChild(owned: ChildProcess) {
    if (child !== owned) return;
    child = undefined;
    generation++;
    fail();
    retiring = Promise.all([retiring, stopChild(owned)]).then(() => {});
  }

  async function ensureChild(version: number): Promise<ChildProcess> {
    await retiring;
    if (version !== generation) throw new Error('Local speech recognition was cancelled.');
    if (child) return child;
    const built = import.meta.url.endsWith('.mjs');
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (/^(TRANSCRIBE|GGML|KOFFI)_/u.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete environment[key];
    }
    const owned = spawn(process.execPath, [
      ...(built ? [] : ['--import', 'tsx']),
      fileURLToPath(new URL(built ? './speech-worker.mjs' : './worker.ts', import.meta.url)),
    ], {
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: environment, windowsHide: true,
    });
    child = owned;
    owned.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const reply = message as { id?: unknown; ok?: unknown; result?: unknown };
      if (typeof reply.id !== 'number') return;
      const pending = waiting.get(reply.id);
      if (!pending) return;
      waiting.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.ok === true) pending.resolve(reply.result);
      else pending.reject(new Error('Local speech recognition failed. Retry transcription.'));
    });
    const retire = () => retireChild(owned);
    owned.once('error', retire);
    owned.once('exit', retire);
    return owned;
  }

  async function call(command: Call): Promise<unknown> {
    const process = await ensureChild(generation);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        retireChild(process);
      }, 120_000);
      timer.unref();
      waiting.set(id, { resolve, reject, timer });
      process.send({ ...command, id }, (error) => {
        if (error) retireChild(process);
      });
    });
  }

  return {
    async load(path, cpu) { await call({ kind: 'load', path, cpu }); },
    async begin() { await call({ kind: 'begin' }); },
    async feed(pcm) { await call({ kind: 'feed', pcm }); },
    async finish(range = {}) {
      const result = await call({ kind: 'finish', ...range });
      if (!result || typeof result !== 'object' || !('text' in result)
        || typeof result.text !== 'string' || result.text.length > 262144)
        throw new Error('Local speech recognition returned an invalid result.');
      return result.text;
    },
    async close() {
      const owned = child;
      if (owned) retireChild(owned);
      else { generation++; fail(); }
      await retiring;
    },
  };
}
