/**
 * Local Whisper model ownership.
 *
 * This module is the only place that knows model URLs, checksums, download
 * progress, and AppData paths. Callers select stable model ids and receive an
 * installed path; they never assemble Hugging Face URLs or inspect `.part`
 * files. Downloads are explicit, atomic, and SHA-256 verified.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appDataRoot } from './local-data.ts';
import type { TranscriptionModelId } from './app-config.ts';
import type { TranscriptionModelOperation } from '../shared/transcription.ts';
import { errorMessage, logger } from './log.ts';

const log = logger('transcription-models');
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;

export interface TranscriptionModelDefinition {
  id: TranscriptionModelId;
  label: string;
  sizeBytes: number;
  speed: string;
  accuracy: string;
  resourceUse: string;
  sha256: string;
  url: string;
}

export type ModelDownloadState = TranscriptionModelOperation;

export interface TranscriptionModelState extends TranscriptionModelDefinition {
  installed: boolean;
  download: ModelDownloadState;
}

export type LocalTranscriptionModelAvailability =
  | { status: 'ready'; path: string }
  | { status: 'verifying' }
  | { status: 'not-installed' }
  | { status: 'unavailable'; error: string };

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const TRANSCRIPTION_MODELS: readonly TranscriptionModelDefinition[] = [
  {
    id: 'tiny',
    label: 'Tiny',
    sizeBytes: 77_691_713,
    speed: 'Fastest',
    accuracy: 'Basic accuracy',
    resourceUse: 'Lowest CPU and memory use',
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    url: `${MODEL_BASE_URL}/ggml-tiny.bin`,
  },
  {
    id: 'base',
    label: 'Base',
    sizeBytes: 147_951_465,
    speed: 'Fast',
    accuracy: 'Balanced accuracy',
    resourceUse: 'Low CPU and memory use',
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    url: `${MODEL_BASE_URL}/ggml-base.bin`,
  },
  {
    id: 'small',
    label: 'Small',
    sizeBytes: 487_601_967,
    speed: 'Slowest',
    accuracy: 'Best accuracy of these models',
    resourceUse: 'Highest CPU and memory use',
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    url: `${MODEL_BASE_URL}/ggml-small.bin`,
  },
] as const;

interface ActiveDownload {
  state: ModelDownloadState;
  abort: AbortController;
  completion: Promise<void>;
  cancelRequested: boolean;
}

interface DownloadOptions {
  fetchImpl?: typeof fetch;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
}

interface ActiveVerification {
  state: Extract<ModelDownloadState, { status: 'verifying' }>;
  fileIdentity: string;
  abort: AbortController;
  completion: Promise<void>;
  cancelRequested: boolean;
}

export interface TranscriptionModelLifecycle {
  /** Reconcile newly available weights with incomplete library audio. */
  onAvailable?: (id: TranscriptionModelId) => void | Promise<void>;
  /** Release every job using the weights before deletion. */
  release?: (id: TranscriptionModelId) => void | Promise<void>;
}

interface ModelVerificationRecord {
  schemaVersion: 1;
  sha256: string;
  fileIdentity: string;
}

const downloads = new Map<TranscriptionModelId, ActiveDownload>();
const verifications = new Map<TranscriptionModelId, ActiveVerification>();
const verificationFailures = new Map<TranscriptionModelId, string>();
const removals = new Map<TranscriptionModelId, Promise<void>>();
let lifecycle: TranscriptionModelLifecycle = {};

export function configureTranscriptionModelLifecycle(next: TranscriptionModelLifecycle): void {
  lifecycle = { ...next };
}

export function transcriptionModelsDir(): string {
  return path.join(appDataRoot(), 'models', 'whisper');
}

export function transcriptionModelPath(id: TranscriptionModelId): string {
  requireModel(id);
  return path.join(transcriptionModelsDir(), `ggml-${id}.bin`);
}

function verificationPath(id: TranscriptionModelId): string {
  return `${transcriptionModelPath(id)}.sha256`;
}

export function isTranscriptionModelInstalled(id: TranscriptionModelId): boolean {
  const model = requireModel(id);
  if (removals.has(id)) return false;
  try {
    const target = transcriptionModelPath(id);
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size !== model.sizeBytes) return false;
    const marker = fs.readFileSync(verificationPath(id), 'utf8').trim();
    const record = parseVerificationRecord(marker);
    if (
      record?.sha256 === model.sha256
      && record.fileIdentity === modelFileIdentity(stat)
    ) return true;

    // Old releases wrote only the accepted digest. A changed file identity or
    // legacy marker must earn a new trusted record by hashing the model bytes;
    // size plus a detached checksum string is not proof of current contents.
    if (marker.toLowerCase() !== model.sha256 && record?.sha256 !== model.sha256) return false;
    startModelVerification(model, target, stat);
    return false;
  } catch {
    return false;
  }
}

export function installedTranscriptionModelPath(id: TranscriptionModelId): string | null {
  return isTranscriptionModelInstalled(id) ? transcriptionModelPath(id) : null;
}

export function localTranscriptionModelAvailability(id: TranscriptionModelId): LocalTranscriptionModelAvailability {
  const installed = installedTranscriptionModelPath(id);
  if (installed) return { status: 'ready', path: installed };
  if (verifications.has(id)) return { status: 'verifying' };
  const verificationFailure = verificationFailures.get(id);
  if (verificationFailure) return { status: 'unavailable', error: verificationFailure };
  if (removals.has(id)) return { status: 'unavailable', error: 'model is being removed' };
  return { status: 'not-installed' };
}

export function listTranscriptionModels(): TranscriptionModelState[] {
  return TRANSCRIPTION_MODELS.map((model) => ({
    ...model,
    installed: isTranscriptionModelInstalled(model.id),
    download: downloads.get(model.id)?.state
      ?? verifications.get(model.id)?.state
      ?? (verificationFailures.has(model.id)
        ? { status: 'failed', error: verificationFailures.get(model.id)! }
        : { status: 'idle' }),
  }));
}

export function startTranscriptionModelDownload(
  id: TranscriptionModelId,
  options: DownloadOptions = {},
): ModelDownloadState {
  const model = requireModel(id);
  if (removals.has(id)) throw new Error(`transcription model ${id} is being removed`);
  const verification = verifications.get(id);
  if (verification) return verification.state;
  const existing = downloads.get(id);
  if (existing?.state.status === 'downloading') return existing.state;
  if (isTranscriptionModelInstalled(id)) return { status: 'idle' };
  // The installed check may have started an asynchronous trust verification
  // for a legacy marker or changed file identity. Do not race that read with
  // a replacement download.
  const startedVerification = verifications.get(id);
  if (startedVerification) return startedVerification.state;

  const abort = new AbortController();
  const active: ActiveDownload = {
    state: { status: 'downloading', receivedBytes: 0, totalBytes: model.sizeBytes },
    abort,
    completion: Promise.resolve(),
    cancelRequested: false,
  };
  verificationFailures.delete(id);
  downloads.set(id, active);
  active.completion = downloadAndVerify(model, active, options)
    .then(() => {
      downloads.delete(id);
      notifyModelAvailable(id);
    })
    .catch((err: unknown) => {
      if (active.cancelRequested) {
        downloads.delete(id);
        return;
      }
      const message = errorMessage(err);
      active.state = { status: 'failed', error: message };
      log.warn(`model ${id} download failed: ${message}`);
    });
  return active.state;
}

export function removeTranscriptionModel(id: TranscriptionModelId): Promise<void> {
  requireModel(id);
  const current = removals.get(id);
  if (current) return current;

  let beginRemoval!: () => void;
  const gate = new Promise<void>((resolve) => { beginRemoval = resolve; });
  const removal = gate.then(async () => {
    try {
      const active = downloads.get(id);
      if (active) {
        active.cancelRequested = true;
        active.abort.abort(new Error('model download cancelled'));
        await active.completion.catch(() => undefined);
      }
      downloads.delete(id);
      const verification = verifications.get(id);
      if (verification) {
        verification.cancelRequested = true;
        verification.abort.abort(new Error('model verification cancelled'));
        await verification.completion.catch(() => undefined);
      }
      verifications.delete(id);
      verificationFailures.delete(id);
      await lifecycle.release?.(id);
      fs.rmSync(transcriptionModelPath(id), { force: true });
      fs.rmSync(verificationPath(id), { force: true });
      fs.rmSync(`${transcriptionModelPath(id)}.part`, { force: true });
    } finally {
      removals.delete(id);
    }
  });
  // Publish unavailability before cancellation or any caller-supplied hook can
  // observe the model. This closes the enqueue-between-cancel-and-delete gap.
  removals.set(id, removal);
  beginRemoval();
  return removal;
}

/** Server-lifecycle cleanup for every in-flight model stream and `.part` file. */
export async function cancelAllTranscriptionModelDownloads(): Promise<TranscriptionModelId[]> {
  const activeDownloads = [...downloads.entries()];
  const activeVerifications = [...verifications.entries()];
  for (const [, download] of activeDownloads) {
    download.cancelRequested = true;
    download.abort.abort(new Error('server shutdown'));
  }
  for (const [, verification] of activeVerifications) {
    verification.cancelRequested = true;
    verification.abort.abort(new Error('server shutdown'));
  }
  await Promise.allSettled([
    ...activeDownloads.map(([, download]) => download.completion),
    ...activeVerifications.map(([, verification]) => verification.completion),
  ]);
  for (const [id] of activeDownloads) {
    downloads.delete(id);
    fs.rmSync(`${transcriptionModelPath(id)}.part`, { force: true });
  }
  for (const [id] of activeVerifications) verifications.delete(id);
  return [...new Set([
    ...activeDownloads.map(([id]) => id),
    ...activeVerifications.map(([id]) => id),
  ])];
}

/** Startup-only crash recovery. Runtime downloads are represented in memory,
 * so an unowned `.part` file can only belong to a terminated server. */
export function cleanupStaleTranscriptionModelDownloads(): string[] {
  const removed: string[] = [];
  for (const model of TRANSCRIPTION_MODELS) {
    if (downloads.has(model.id) || verifications.has(model.id)) continue;
    const part = `${transcriptionModelPath(model.id)}.part`;
    if (!fs.existsSync(part)) continue;
    fs.rmSync(part, { force: true });
    removed.push(model.id);
  }
  return removed;
}

async function downloadAndVerify(
  model: TranscriptionModelDefinition,
  active: ActiveDownload,
  options: DownloadOptions,
): Promise<void> {
  const dir = transcriptionModelsDir();
  const target = transcriptionModelPath(model.id);
  const part = `${target}.part`;
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(part, { force: true });
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await withDownloadDeadline(
      Promise.resolve().then(() => fetchImpl(model.url, { signal: active.abort.signal, redirect: 'follow' })),
      active,
      positiveTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
      'model download connection timed out',
    );
    if (!response.ok || !response.body) {
      throw new Error(`model download returned HTTP ${response.status}`);
    }

    const totalHeader = Number(response.headers.get('content-length'));
    if (Number.isFinite(totalHeader) && totalHeader > 0 && totalHeader !== model.sizeBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`model content length mismatch: received ${totalHeader}, expected ${model.sizeBytes}`);
    }
    const hash = crypto.createHash('sha256');
    const handle = await fs.promises.open(part, 'wx', 0o600);
    let receivedBytes = 0;
    const reader = response.body.getReader();
    let streamDone = false;
    try {
      while (true) {
        const { done, value } = await withDownloadDeadline(
          reader.read(),
          active,
          positiveTimeout(options.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS),
          'model download stalled while receiving data',
        );
        if (done) {
          streamDone = true;
          break;
        }
        if (active.abort.signal.aborted) throw active.abort.signal.reason ?? new Error('download cancelled');
        const chunk = Buffer.from(value);
        if (receivedBytes + chunk.byteLength > model.sizeBytes) {
          throw new Error(`model download exceeded expected size ${model.sizeBytes}`);
        }
        await handle.write(chunk);
        hash.update(chunk);
        receivedBytes += chunk.byteLength;
        active.state = { status: 'downloading', receivedBytes, totalBytes: model.sizeBytes };
      }
      await handle.sync();
    } finally {
      await handle.close();
      if (!streamDone) await reader.cancel().catch(() => undefined);
    }

    const digest = hash.digest('hex');
    if (receivedBytes !== model.sizeBytes) {
      throw new Error(`model size mismatch: received ${receivedBytes} bytes, expected ${model.sizeBytes}`);
    }
    if (digest !== model.sha256) throw new Error('model checksum mismatch');

    // `rename` cannot replace an existing file on Windows. A previous
    // interrupted/invalid installation is not trusted and is replaced only
    // after the new download has passed both checks above.
    fs.rmSync(target, { force: true });
    fs.rmSync(verificationPath(model.id), { force: true });
    fs.renameSync(part, target);
    writeVerificationRecord(model.id, digest, fs.statSync(target));
    log.info(`model ${model.id} installed (${receivedBytes} bytes)`);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function withDownloadDeadline<T>(
  promise: Promise<T>,
  active: ActiveDownload,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(message);
      active.abort.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function requireModel(id: TranscriptionModelId): TranscriptionModelDefinition {
  const model = TRANSCRIPTION_MODELS.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`unsupported transcription model: ${id}`);
  return model;
}

function parseVerificationRecord(value: string): ModelVerificationRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<ModelVerificationRecord>;
    return parsed.schemaVersion === 1
      && typeof parsed.sha256 === 'string'
      && typeof parsed.fileIdentity === 'string'
      ? parsed as ModelVerificationRecord
      : null;
  } catch {
    return null;
  }
}

function modelFileIdentity(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function startModelVerification(
  model: TranscriptionModelDefinition,
  target: string,
  stat: fs.Stats,
): void {
  const fileIdentity = modelFileIdentity(stat);
  const current = verifications.get(model.id);
  if (current?.fileIdentity === fileIdentity) return;
  if (current) {
    current.cancelRequested = true;
    current.abort.abort(new Error('model file changed during verification'));
  }
  verificationFailures.delete(model.id);
  const abort = new AbortController();
  const active: ActiveVerification = {
    state: { status: 'verifying' },
    fileIdentity,
    abort,
    completion: Promise.resolve(),
    cancelRequested: false,
  };
  verifications.set(model.id, active);
  active.completion = verifyCurrentModel(model, target, active)
    .then(() => {
      if (verifications.get(model.id) !== active) return;
      verifications.delete(model.id);
      notifyModelAvailable(model.id);
    })
    .catch((err: unknown) => {
      if (verifications.get(model.id) !== active) return;
      verifications.delete(model.id);
      if (active.cancelRequested) return;
      const message = errorMessage(err);
      verificationFailures.set(model.id, message);
      log.warn(`model ${model.id} verification failed: ${message}`);
    });
}

async function verifyCurrentModel(
  model: TranscriptionModelDefinition,
  target: string,
  active: ActiveVerification,
): Promise<void> {
  const digest = await sha256File(target, active.abort.signal);
  if (active.abort.signal.aborted) throw active.abort.signal.reason ?? new Error('model verification cancelled');
  const after = await fs.promises.stat(target);
  if (active.fileIdentity !== modelFileIdentity(after)) {
    throw new Error('model file changed during verification');
  }
  if (digest !== model.sha256) {
    fs.rmSync(verificationPath(model.id), { force: true });
    throw new Error('model checksum mismatch');
  }
  writeVerificationRecord(model.id, model.sha256, after);
}

async function sha256File(file: string, signal: AbortSignal): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
  const abort = () => stream.destroy(signal.reason instanceof Error ? signal.reason : new Error('model verification cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    signal.removeEventListener('abort', abort);
  }
  return hash.digest('hex');
}

function notifyModelAvailable(id: TranscriptionModelId): void {
  void Promise.resolve(lifecycle.onAvailable?.(id)).catch((err: unknown) => {
    log.warn(`model ${id} post-install reconcile failed: ${errorMessage(err)}`);
  });
}

function writeVerificationRecord(id: TranscriptionModelId, sha256: string, stat: fs.Stats): void {
  const target = verificationPath(id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const record: ModelVerificationRecord = {
    schemaVersion: 1,
    sha256,
    fileIdentity: modelFileIdentity(stat),
  };
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (process.platform === 'win32') fs.rmSync(target, { force: true });
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
