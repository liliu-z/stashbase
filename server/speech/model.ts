/** One resumable, verified model installation. Reads never start a download;
 * launch and explicit Settings commands are the only demand owners. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SpeechModelStatus } from '../../shared/protocols/http/speech.ts';
import { SPEECH_MODEL, speechPlatformSupported } from './model-manifest.ts';

const RESERVE_BYTES = 256 * 1024 * 1024;
interface ModelOptions {
  root: string;
  paused(): boolean;
  setPaused(value: boolean): void;
  manifest?: { sizeBytes: number; sha256: string; url: string };
  fetch?: typeof fetch;
  supported?: boolean;
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function createSpeechModel(options: ModelOptions) {
  const manifest = options.manifest ?? SPEECH_MODEL;
  const destination = path.join(options.root, `${manifest.sha256}.gguf`);
  const partial = `${destination}.partial`;
  const request = options.fetch ?? fetch;
  const supported = options.supported ?? speechPlatformSupported();
  let status: SpeechModelStatus = {
    phase: supported ? 'missing' : 'unsupported', downloadedBytes: 0,
    totalBytes: manifest.sizeBytes,
    error: supported ? null : 'Voice typing is unavailable on this operating system or processor.',
  };
  let initialized: Promise<void> | undefined;
  let active: { controller: AbortController; completion: Promise<void> } | undefined;
  let closed = false;
  let commands = Promise.resolve();
  const snapshot = (): SpeechModelStatus => ({ ...status });

  const readSize = async (file: string) => {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) throw new Error('The voice model path is not a regular file.');
      return stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  };
  const initialize = () => initialized ??= (async () => {
    if (!supported) return;
    try {
      await fs.mkdir(options.root, { recursive: true, mode: 0o700 });
      if (await readSize(destination)) {
        status = { ...status, phase: 'verifying' };
        if (await readSize(destination) !== manifest.sizeBytes || await digest(destination) !== manifest.sha256) {
          await fs.rm(destination);
          throw new Error('The installed voice model failed verification. Retry preparation in Settings.');
        }
        status = { ...status, phase: 'ready', downloadedBytes: manifest.sizeBytes, error: null };
        return;
      }
      const size = await readSize(partial);
      if (size > manifest.sizeBytes) await fs.rm(partial);
      status = { ...status, phase: options.paused() ? 'paused' : 'missing', downloadedBytes: Math.min(size, manifest.sizeBytes) };
    } catch {
      status = { ...status, phase: 'failed', error: 'The voice model could not be checked. Retry preparation in Settings.' };
    }
  })();

  async function transfer(signal: AbortSignal): Promise<void> {
    let offset = await readSize(partial);
    const space = await fs.statfs(options.root);
    if (space.bavail * space.bsize < manifest.sizeBytes - offset + RESERVE_BYTES)
      throw new Error('Not enough free disk space for voice typing. Free some space and retry.');
    if (offset < manifest.sizeBytes) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error('Download stalled')), 30_000);
        timer.unref();
      };
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let file: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        signal.throwIfAborted();
        arm();
        const response = await request(manifest.url, {
          signal: controller.signal, redirect: 'follow',
          ...(offset ? { headers: { Range: `bytes=${offset}-` } } : {}),
        }).catch((cause: unknown) => { throw new Error('The voice model could not be downloaded. Check your connection and retry in Settings.', { cause }); });
        if (!response.ok || !response.body) throw new Error('The voice model download failed. Check your connection and retry.');
        if (response.status === 206) {
          const range = response.headers.get('content-range');
          if (range !== `bytes ${offset}-${manifest.sizeBytes - 1}/${manifest.sizeBytes}`)
            throw new Error('The voice model download returned an invalid range. Retry preparation.');
        } else if (response.status === 200) offset = 0;
        else throw new Error('The voice model download returned an unexpected response.');
        file = await fs.open(partial, offset ? 'a' : 'w', 0o600);
        reader = response.body.getReader();
        status = { ...status, phase: 'downloading', downloadedBytes: offset, error: null };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          signal.throwIfAborted();
          arm();
          if (offset + value.byteLength > manifest.sizeBytes) throw new Error('The voice model exceeds its expected size. Retry preparation.');
          await file.writeFile(value);
          offset += value.byteLength;
          status = { ...status, downloadedBytes: offset };
        }
        await file.sync();
      } finally {
        clearTimeout(timer);
        controller.abort();
        signal.removeEventListener('abort', abort);
        await reader?.cancel().catch(() => {});
        await file?.close();
      }
    }
    signal.throwIfAborted();
    status = { ...status, phase: 'verifying' };
    if (offset !== manifest.sizeBytes || await digest(partial) !== manifest.sha256) {
      await fs.rm(partial, { force: true });
      status = { ...status, downloadedBytes: 0 };
      throw new Error('The voice model failed verification. Retry preparation to download a fresh copy.');
    }
    signal.throwIfAborted();
    await fs.rename(partial, destination);
    status = { ...status, phase: 'ready', downloadedBytes: manifest.sizeBytes, error: null };
  }

  function startAttempt() {
    if (closed || active || !supported || status.phase === 'ready' || options.paused()) return;
    const flight = { controller: new AbortController(), completion: Promise.resolve() };
    active = flight;
    status = { ...status, phase: 'downloading', error: null };
    flight.completion = transfer(flight.controller.signal).catch((error: unknown) => {
      status = { ...status, phase: flight.controller.signal.aborted ? 'paused' : 'failed',
        error: flight.controller.signal.aborted ? null : error instanceof Error ? error.message : 'Voice model preparation failed. Retry in Settings.' };
    }).finally(() => { if (active === flight) active = undefined; });
  }

  return {
    initialize,
    status: snapshot,
    path: () => status.phase === 'ready' ? destination : null,
    async start() {
      await initialize();
      if (status.phase !== 'failed') startAttempt();
    },
    command(action: 'stop' | 'resume' | 'retry'): Promise<SpeechModelStatus> {
      const next = commands.catch(() => {}).then(async () => {
        await initialize();
        if (!supported || status.phase === 'ready') return;
        options.setPaused(action === 'stop');
        if (action === 'stop') {
          active?.controller.abort();
          await active?.completion;
          if (snapshot().phase !== 'ready') status = { ...status, phase: 'paused', error: null };
        } else startAttempt();
      });
      commands = next;
      return next.then(() => ({ ...status }));
    },
    async close() {
      closed = true;
      await initialized;
      active?.controller.abort();
      await active?.completion;
    },
  };
}
