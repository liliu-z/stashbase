/** One recording across windows. Audio is acknowledged only after publication
 * to private spool files, and kept until its inference segment commits. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SpeechJob } from '../../shared/protocols/http/speech.ts';
import { createSpeechEngine, type SpeechEngine } from './worker-client.ts';
import { SPEECH_SEGMENT_MAX_SAMPLES, SPEECH_LEFT_CONTEXT_SAMPLES, SPEECH_RIGHT_CONTEXT_SAMPLES } from './model-manifest.ts';

const MAX_PENDING_BYTES = 512 * 1024 * 1024;
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status, code: 'SPEECH_UNAVAILABLE' });
interface Recording {
  id: string;
  window: string;
  folder: string;
  conversation: string;
  phase: SpeechJob['phase'];
  nextSequence: number;
  cursor: number;
  segmentStart: number;
  segmentSamples: number;
  segmentSkipSamples: number;
  pendingBytes: number;
  nativeStarted: boolean;
  cpu: boolean;
  stopRequested: boolean;
  error: string | null;
  forcedError: string | null;
  text: string[];
  receipts: Map<number, string>;
  mutation: Promise<void>;
  pumping: Promise<void> | null;
  retirement: Promise<void> | null;
  retrying: Promise<SpeechJob> | null;
}

export function createSpeechService(options: {
  root: string;
  modelPath(): string | null;
  engine?: SpeechEngine;
  cpu?: boolean;
  pendingLimit?: number;
}) {
  const engine = options.engine ?? createSpeechEngine();
  const cpu = options.cpu ?? !(process.platform === 'darwin' && process.arch === 'arm64');
  let recording: Recording | undefined;
  let initialized: Promise<void> | undefined;
  let retiring = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const cancelled = new Map<string, string>();
  const directory = (job: Recording) => path.join(options.root, job.id);
  const audioFile = (job: Recording, sequence: number) => path.join(directory(job), `${sequence}.pcm`);
  const current = (job: Recording) => recording === job && job.phase !== 'cancelled' && !closed;
  const snapshot = (job: Recording): SpeechJob => ({
    id: job.id, phase: job.phase, nextSequence: job.nextSequence, error: job.error,
    text: job.phase === 'ready' || job.phase === 'failed' ? job.text.join(' ').trim() : '',
  });
  const owned = (window: string, id: string) => {
    if (!recording || recording.window !== window || recording.id !== id)
      throw failure('That voice recording is no longer available in this window.', 404);
    return recording;
  };
  const initialize = () => initialized ??= (async () => {
    await fs.mkdir(options.root, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(options.root)) {
      if (/^[0-9a-f-]{36}$/u.test(entry)) await fs.rm(path.join(options.root, entry), { recursive: true, force: true });
    }
  })();

  async function commitSegment(job: Recording, final: boolean) {
    const from = job.segmentStart;
    const end = job.cursor;
    let retainedStart = end;
    let retainedSamples = 0;
    if (!final) {
      // Retain left acoustic context plus the uncommitted right tail. Replay
      // these exact spool frames after rollover or a worker/CPU retry.
      while (retainedStart > from && retainedSamples < SPEECH_LEFT_CONTEXT_SAMPLES + SPEECH_RIGHT_CONTEXT_SAMPLES) {
        retainedStart--;
        retainedSamples += (await fs.stat(audioFile(job, retainedStart))).size / 2;
      }
    }
    const ownedEnd = final ? undefined : job.segmentSamples - SPEECH_RIGHT_CONTEXT_SAMPLES;
    const text = job.nativeStarted ? await engine.finish({ startSample: job.segmentSkipSamples, ...(ownedEnd === undefined ? {} : { endSample: ownedEnd }) }) : '';
    if (!current(job)) return;
    if (text.trim()) job.text.push(text.trim());
    job.nativeStarted = false;
    job.segmentSamples = 0;
    job.segmentStart = retainedStart;
    job.segmentSkipSamples = final ? 0 : retainedSamples - SPEECH_RIGHT_CONTEXT_SAMPLES;
    job.cursor = retainedStart;
    for (let sequence = from; sequence < retainedStart; sequence++) {
      const file = audioFile(job, sequence);
      job.pendingBytes -= (await fs.stat(file)).size;
      await fs.rm(file);
    }
  }

  function pump(job: Recording) {
    if (!current(job) || job.pumping || job.phase === 'failed' || job.phase === 'ready') return;
    job.pumping = (async () => {
      try {
        const model = options.modelPath();
        if (!model) throw failure('Voice typing is not ready. Check Settings → General → Voice typing.', 412);
        await engine.load(model, job.cpu);
        while (current(job) && job.cursor < job.nextSequence) {
          const bytes = await fs.readFile(audioFile(job, job.cursor));
          if (!current(job)) return;
          if (!job.nativeStarted) {
            await engine.begin();
            job.nativeStarted = true;
          }
          await engine.feed(bytes);
          if (!current(job)) return;
          job.segmentSamples += bytes.length / 2;
          job.cursor++;
          // Prefer a pause after thirty seconds. A forty-second ceiling keeps
          // native retained audio bounded even with uninterrupted speech.
          let energy = 0;
          const from = Math.max(0, bytes.length - 12800);
          for (let i = from; i < bytes.length; i += 2) energy += (bytes.readInt16LE(i) / 32768) ** 2;
          const quiet = energy / Math.max(1, (bytes.length - from) / 2) < 0.000064;
          if (job.segmentSamples >= SPEECH_SEGMENT_MAX_SAMPLES || (job.segmentSamples >= 480000 && quiet)) await commitSegment(job, job.stopRequested && job.cursor === job.nextSequence);
        }
        if (current(job) && job.stopRequested && job.cursor === job.nextSequence) {
          await commitSegment(job, true);
          if (current(job)) {
            job.phase = job.forcedError ? 'failed' : 'ready';
            job.error = job.forcedError;
          }
        }
      } catch {
        if (!current(job)) return;
        if (!job.cpu) {
          // No text or audio from this segment was committed. Replay exactly
          // those retained frames on CPU; previously committed segments stay.
          await engine.close();
          job.cpu = true;
          job.cursor = job.segmentStart;
          job.segmentSamples = 0;
          job.nativeStarted = false;
        } else {
          job.phase = 'failed';
          job.error = 'Local speech recognition stopped. Retry transcription or keep the completed text. Your existing draft was kept.';
        }
      } finally {
        job.pumping = null;
        if (current(job) && job.phase !== 'failed' && job.phase !== 'ready'
          && (job.cursor < job.nextSequence || job.stopRequested)) pump(job);
      }
    })();
  }

  function cancel(job: Recording, keepWarm = false): Promise<void> {
    if (job.retirement) return job.retirement;
    const warm = keepWarm && job.phase === 'ready' && !job.pumping;
    job.phase = 'cancelled';
    // Every acknowledgement/cancel shares this retirement. In particular,
    // Windows must never receive overlapping removals of the same directory.
    const completion = (async () => {
      if (!warm) await engine.close();
      await job.pumping;
      await job.mutation.catch(() => {});
      await fs.rm(directory(job), { recursive: true, force: true });
      if (recording === job) {
        recording = undefined;
        if (warm && !closed) {
          clearTimeout(idle);
          idle = setTimeout(() => { if (!recording) retiring = engine.close(); }, 60_000);
          idle.unref();
        }
      }
    })();
    job.retirement = completion;
    // A transient filesystem failure can be retried by the next cleanup call.
    void completion.catch(() => { if (job.retirement === completion) job.retirement = null; });
    return completion;
  }

  return {
    initialize,
    async start(window: string, folder: string, conversation: string, id: string = randomUUID()): Promise<SpeechJob> {
      await initialize();
      await retiring;
      if (closed) throw failure('Voice typing is shutting down.');
      if (cancelled.get(id) === window) throw failure('That recording was cancelled.');
      if (recording?.id === id && recording.window === window && recording.folder === folder && recording.conversation === conversation) return snapshot(recording);
      if (recording) throw failure('Voice typing is already in use. Finish the current recording first.');
      if (!options.modelPath()) throw failure('Voice typing is not ready. Check Settings → General → Voice typing.', 412);
      clearTimeout(idle);
      const job: Recording = {
        id, window, folder, conversation, phase: 'recording', nextSequence: 0,
        cursor: 0, segmentStart: 0, segmentSamples: 0, segmentSkipSamples: 0, pendingBytes: 0, nativeStarted: false,
        stopRequested: false, cpu, error: null, forcedError: null,
        text: [], receipts: new Map(), mutation: Promise.resolve(), pumping: null, retirement: null, retrying: null,
      };
      recording = job;
      job.mutation = fs.mkdir(directory(job), { mode: 0o700 });
      try { await job.mutation; }
      catch (error) { if (recording === job) recording = undefined; throw error; }
      if (!current(job)) throw failure('That recording was cancelled.');
      pump(job);
      return snapshot(job);
    },
    status(window: string, id: string) { return snapshot(owned(window, id)); },
    async push(window: string, id: string, sequence: number, pcm: string): Promise<SpeechJob> {
      const job = owned(window, id);
      const bytes = Buffer.from(pcm, 'base64');
      if (!bytes.length || bytes.length > 32000 || bytes.length % 2 || bytes.toString('base64') !== pcm)
        throw failure('The recording returned invalid audio.', 400);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const mutation = job.mutation.catch(() => {}).then(async () => {
        if (!current(job)) throw failure('That recording has ended.');
        if (sequence < job.nextSequence) {
          if (job.receipts.get(sequence) === hash) return;
          throw failure('That audio sequence cannot be replayed.');
        }
        if (sequence !== job.nextSequence) throw failure('The recording is missing an audio sequence.');
        if (job.phase !== 'recording' || job.stopRequested) throw failure('That recording has stopped.');
        if (job.pendingBytes + bytes.length > (options.pendingLimit ?? MAX_PENDING_BYTES)) {
          job.forcedError = 'Recording stopped because speech recognition could not keep up. Completed text was kept; the recording is incomplete.';
        } else if (sequence % 32 === 0) {
          const space = await fs.statfs(options.root);
          if (space.bavail * space.bsize < DISK_RESERVE_BYTES)
            job.forcedError = 'Recording stopped because disk space is low. Completed text was kept; the recording is incomplete.';
        }
        if (job.forcedError) {
          job.stopRequested = true;
          job.phase = 'processing';
          pump(job);
          throw failure(job.forcedError, 507);
        }
        const destination = audioFile(job, sequence);
        try {
          await fs.writeFile(`${destination}.partial`, bytes, { mode: 0o600 });
          await fs.rename(`${destination}.partial`, destination);
        } catch (error) {
          await fs.rm(`${destination}.partial`, { force: true }).catch(() => {});
          throw error;
        }
        if (!current(job)) return;
        job.pendingBytes += bytes.length;
        job.receipts.set(sequence, hash);
        if (job.receipts.size > 64) job.receipts.delete(job.receipts.keys().next().value!);
        job.nextSequence++;
        pump(job);
      });
      job.mutation = mutation;
      await mutation;
      return snapshot(job);
    },
    async finish(window: string, id: string, sequence: number): Promise<SpeechJob> {
      const job = owned(window, id);
      await job.mutation.catch(() => {});
      if (job.nextSequence !== sequence) throw failure('Some recorded audio has not arrived. Retry transcription.');
      if (job.phase === 'recording') {
        job.phase = 'processing';
        job.stopRequested = true;
        pump(job);
      }
      return snapshot(job);
    },
    async retry(window: string, id: string): Promise<SpeechJob> {
      const job = owned(window, id);
      if (job.retrying) return job.retrying;
      if (job.phase !== 'failed') return snapshot(job);
      job.retrying = (async () => {
        await job.pumping;
        if (!current(job) || job.phase !== 'failed') throw failure('That recording was cancelled.', 404);
        await engine.close();
        // Cancellation/window retirement wins over an in-flight retry. Sharing
        // this flight also prevents a second retry from closing its replacement.
        if (!current(job) || job.phase !== 'failed') throw failure('That recording was cancelled.', 404);
        job.cursor = job.segmentStart;
        job.segmentSamples = 0;
        job.nativeStarted = false;
        job.cpu = true;
        job.error = null;
        job.forcedError = null;
        job.mutation = Promise.resolve();
        job.stopRequested = false;
        job.phase = 'recording';
        pump(job);
        return snapshot(job);
      })().finally(() => { job.retrying = null; });
      return job.retrying;
    },
    async cancel(window: string, id: string) {
      if (!recording || recording.id !== id) {
        cancelled.set(id, window);
        if (cancelled.size > 512) cancelled.delete(cancelled.keys().next().value!);
        return;
      }
      const job = owned(window, id);
      cancelled.set(id, window);
      if (cancelled.size > 512) cancelled.delete(cancelled.keys().next().value!);
      // Successful delivery keeps the model warm; there is no active native
      // session after finalization. Cancellation of work kills its process.
      retiring = cancel(job, true);
      await retiring;
    },
    async releaseWindow(window: string) {
      if (recording?.window === window) { retiring = cancel(recording); await retiring; }
    },
    async close() {
      closed = true;
      clearTimeout(idle);
      if (recording) { retiring = cancel(recording); await retiring; }
      await engine.close();
    },
  };
}
