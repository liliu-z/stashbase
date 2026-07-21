/**
 * AudioTranscription is the deep module for source audio -> transcript.
 *
 * Its public result is provider-neutral structured JSON plus Markdown. The
 * implementation hides ffprobe, FFmpeg normalization, chunk overlap,
 * provider JSON, checkpoints, merging, and atomic final writes. Providers
 * implement the registry contract without changing callers or derived-data
 * consumers.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  derivedAudioPreviewFor,
  derivedAudioPreviewMetadataFor,
  derivedAudioWorkFor,
  derivedDir,
  derivedNoteFor,
  derivedTranscriptFor,
  registerDerivedSource,
} from './derived-store.ts';
import { getTranscriptionPreferences } from './app-config.ts';
import { isAudioFile } from './format.ts';
import {
  discoverNewSources,
  getScheduledConversion,
  indexFreshDerived,
  maybeConvert,
  cancelConversionAndWait,
  cancelConversionForModelRemoval,
  interruptConversionForInteractivePreview,
  runAuxiliaryConversion,
  TransientConversionError,
  type ConversionSpec,
  type DerivedFreshnessSpec,
} from './conversion.ts';
import type { ConversionProgress } from './conversion-status.ts';
import { isPendingOrFailed, markCancelled } from './conversion-status.ts';
import { filesystemPath } from './filesystem-path.ts';
import { isCloudPlaceholderName, isIndexExcludedDirName } from './indexable.ts';
import { blake3File } from './file-hash.ts';
import {
  getTranscriptionProvider,
  type TranscriptionModelRef,
  type TranscriptionProvider,
} from './transcription-provider.ts';
import {
  FfmpegAudioMediaTools,
  type AudioMediaTools,
} from './audio-media-tools.ts';
import type {
  AudioPreviewStatus,
  AudioTranscript,
  AudioTranscriptSegment,
  ConfiguredTranscriptionBlock,
} from '../shared/transcription.ts';
export type {
  AudioPreviewStatus,
  AudioTranscript,
  AudioTranscriptSegment,
  ConfiguredTranscriptionBlock,
} from '../shared/transcription.ts';
export type { AudioMediaTools, AudioSourceProbe } from './audio-media-tools.ts';

const AUDIO_COMPLETE_MARKER = '<!-- stashbase-audio-transcription: complete -->';
const TRANSCRIPT_SCHEMA_VERSION = 1;
const CHUNK_DURATION_MS = 10 * 60 * 1000;
const CHUNK_OVERLAP_MS = 1500;
const AUDIO_PREVIEW_TEMP_MAX_AGE_MS = 24 * 60 * 60_000;
const AUDIO_PREVIEW_TEMP_RE = /\.preview\.webm\.(\d+)\.(\d+)\.tmp\.webm$/;

export type { TranscriptionAdapterSegment, TranscriptionModelRef, TranscriptionProvider } from './transcription-provider.ts';
/** Backward-compatible name for tests and integrations that implement only
 * inference. Production registration uses the deeper provider contract. */
export type TranscriptionAdapter = Pick<TranscriptionProvider, 'id' | 'version' | 'transcribe'>;

interface AudioWorkManifest {
  schemaVersion: 1;
  source: AudioSourceSignature;
  durationMs: number;
  provider: string;
  providerVersion: string;
  modelId: string;
  requestedLanguage: string;
  effectiveLanguage?: string;
  chunkDurationMs: number;
  overlapMs: number;
}

interface AudioChunkCheckpoint {
  schemaVersion: 1;
  index: number;
  unitStartMs: number;
  unitEndMs: number;
  detectedLanguage: string;
  segments: Omit<AudioTranscriptSegment, 'id'>[];
}

interface AudioTranscriptionPaths {
  note: string;
  transcript: string;
  work: string;
  preview: string;
  previewMetadata: string;
}

interface AudioPreviewManifest {
  schemaVersion: 1;
  source: AudioSourceSignature;
}

interface AudioSourceIdentity {
  size: number;
  mtimeMs: number;
  /** dev/inode/ctime detects replacements before a reconcile hash diff runs. */
  statIdentity: string;
}

interface AudioSourceSignature extends AudioSourceIdentity {
  contentHash: string;
}

export interface AudioTranscriptionOptions {
  model: TranscriptionModelRef;
  language: string;
  onProgress?: (progress: ConversionProgress) => void;
  signal?: AbortSignal;
  yieldLane?: () => Promise<void>;
}

/** Orchestrates one provider-neutral transcription. */
export class AudioTranscription {
  constructor(
    private readonly adapter: TranscriptionAdapter,
    private readonly mediaTools: AudioMediaTools,
  ) {}

  async prepare(sourceAbs: string, options: AudioTranscriptionOptions): Promise<AudioTranscript> {
    throwIfAborted(options.signal);
    const paths = audioPaths(sourceAbs);
    const sourceSignature = await audioSourceSignature(sourceAbs, options.signal);
    fs.mkdirSync(derivedDir(), { recursive: true });

    const probe = await this.mediaTools.probe(sourceAbs, options.signal);
    if (!Number.isFinite(probe.durationMs) || probe.durationMs <= 0) {
      throw new Error('audio duration could not be determined');
    }
    const expected: AudioWorkManifest = {
      schemaVersion: 1,
      source: sourceSignature,
      durationMs: probe.durationMs,
      provider: this.adapter.id,
      providerVersion: this.adapter.version,
      modelId: options.model.id,
      requestedLanguage: options.language,
      chunkDurationMs: CHUNK_DURATION_MS,
      overlapMs: CHUNK_OVERLAP_MS,
    };
    let manifest = readCompatibleManifest(paths.work, expected);
    if (!manifest) {
      fs.rmSync(paths.work, { recursive: true, force: true });
      fs.mkdirSync(paths.work, { recursive: true });
      manifest = expected;
      writeJsonAtomic(path.join(paths.work, 'manifest.json'), manifest);
    }

    const unitCount = Math.ceil(probe.durationMs / CHUNK_DURATION_MS);
    const chunks: AudioChunkCheckpoint[] = [];
    let effectiveLanguage = manifest.effectiveLanguage;
    options.onProgress?.({ phase: 'extracting', completedUnits: 0, totalUnits: unitCount });
    for (let index = 0; index < unitCount; index++) {
      throwIfAborted(options.signal);
      const unitStartMs = index * CHUNK_DURATION_MS;
      const unitEndMs = Math.min(probe.durationMs, unitStartMs + CHUNK_DURATION_MS);
      const checkpointPath = path.join(paths.work, `chunk-${String(index).padStart(5, '0')}.json`);
      let checkpoint = readChunkCheckpoint(
        checkpointPath,
        index,
        unitStartMs,
        unitEndMs,
        probe.durationMs,
        index === unitCount - 1,
      );
      if (!checkpoint) {
        const sourceStartMs = Math.max(0, unitStartMs - CHUNK_OVERLAP_MS);
        const sourceEndMs = Math.min(probe.durationMs, unitEndMs + CHUNK_OVERLAP_MS);
        const wavPath = path.join(paths.work, `chunk-${String(index).padStart(5, '0')}.wav`);
        try {
          await this.mediaTools.decodeChunk({
            sourceAbs,
            wavPath,
            startMs: sourceStartMs,
            durationMs: sourceEndMs - sourceStartMs,
            signal: options.signal,
          });
          const result = await this.adapter.transcribe({
            audioPath: wavPath,
            model: options.model,
            // Auto-detect independently per durable chunk. Reusing the first
            // detected language here silently mistranscribes later speakers or
            // sections that switch languages.
            language: options.language,
            signal: options.signal,
          });
          effectiveLanguage ??= normalizeLanguage(result.language, options.language);
          checkpoint = {
            schemaVersion: 1,
            index,
            unitStartMs,
            unitEndMs,
            detectedLanguage: normalizeLanguage(result.language, effectiveLanguage ?? options.language),
            segments: result.segments
              .map((segment) => ({
                startMs: clampMs(sourceStartMs + segment.startMs, probe.durationMs),
                endMs: clampMs(sourceStartMs + segment.endMs, probe.durationMs),
                text: segment.text.trim(),
              }))
              .filter((segment) => {
                if (!segment.text) return false;
                const midpoint = segment.startMs + Math.max(0, segment.endMs - segment.startMs) / 2;
                return midpoint >= unitStartMs && (index === unitCount - 1 ? midpoint <= unitEndMs : midpoint < unitEndMs);
              }),
          };
          writeJsonAtomic(checkpointPath, checkpoint);
          if (manifest.effectiveLanguage !== effectiveLanguage) {
            manifest = { ...manifest, effectiveLanguage };
            writeJsonAtomic(path.join(paths.work, 'manifest.json'), manifest);
          }
        } finally {
          fs.rmSync(wavPath, { force: true });
        }
      } else {
        effectiveLanguage ??= normalizeLanguage(checkpoint.detectedLanguage, options.language);
      }
      chunks.push(checkpoint);
      options.onProgress?.({ phase: 'extracting', completedUnits: index + 1, totalUnits: unitCount });
      if (index + 1 < unitCount) await options.yieldLane?.();
    }

    throwIfAborted(options.signal);
    const beforePublish = await audioSourceSignature(sourceAbs, options.signal);
    if (!sameAudioSourceSignature(sourceSignature, beforePublish)) {
      throw new TransientConversionError('audio source changed during transcription');
    }
    const transcript: AudioTranscript = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      source: { ...sourceSignature, durationMs: probe.durationMs },
      provider: { id: this.adapter.id, version: this.adapter.version, model: options.model.id },
      language: effectiveLanguage ?? options.language,
      createdAt: new Date().toISOString(),
      segments: chunks
        .flatMap((chunk) => chunk.segments)
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
        .map((segment, index) => ({ ...segment, id: index + 1 })),
    };
    parseAudioTranscript(transcript);
    writeJsonAtomic(paths.transcript, transcript);
    writeTextAtomic(paths.note, renderTranscriptMarkdown(sourceAbs, transcript));
    if (!sameAudioSourceIdentity(sourceSignature, audioSourceIdentity(sourceAbs))) {
      cleanupFinalAudio(sourceAbs);
      throw new TransientConversionError('audio source changed while publishing transcript');
    }
    return transcript;
  }
}

/** Model-independent source audio -> browser-compatible preview pipeline. */
export class AudioPreviewPipeline {
  constructor(private readonly mediaTools: AudioMediaTools) {}

  async prepare(
    sourceAbs: string,
    signal?: AbortSignal,
    onProgress?: (progress: { completedMs: number; totalMs: number }) => void,
  ): Promise<string> {
    const preview = derivedAudioPreviewFor(sourceAbs);
    const metadata = derivedAudioPreviewMetadataFor(sourceAbs);
    cleanupAudioPreviewTemporaries(preview);
    const currentIdentity = audioSourceIdentity(sourceAbs);
    if (currentIdentity && audioPreviewIsCurrent(preview, metadata, currentIdentity)) return preview;
    const startedWith = await audioSourceSignature(sourceAbs, signal);
    // A metadata-only touch or byte-identical replacement changes the cheap
    // stat identity but not the preview. Refresh the manifest instead of
    // spending another heavy-lane FFmpeg pass.
    if (audioPreviewMatchesContent(preview, metadata, startedWith)) {
      writeJsonAtomic(metadata, { schemaVersion: 1, source: startedWith } satisfies AudioPreviewManifest);
      if (!sameAudioSourceIdentity(startedWith, audioSourceIdentity(sourceAbs))) {
        fs.rmSync(metadata, { force: true });
        throw new TransientConversionError('audio source changed while refreshing preview metadata');
      }
      return preview;
    }
    fs.mkdirSync(derivedDir(), { recursive: true });
    const tmp = `${preview}.${process.pid}.${Date.now()}.tmp.webm`;
    try {
      const probe = await this.mediaTools.probe(sourceAbs, signal);
      onProgress?.({ completedMs: 0, totalMs: probe.durationMs });
      await this.mediaTools.createPreview(sourceAbs, tmp, signal, (completedMs) => {
        onProgress?.({
          completedMs: Math.min(probe.durationMs, Math.max(0, completedMs)),
          totalMs: probe.durationMs,
        });
      });
      onProgress?.({ completedMs: probe.durationMs, totalMs: probe.durationMs });
      if (!sameAudioSourceSignature(startedWith, await audioSourceSignature(sourceAbs, signal))) {
        throw new TransientConversionError('audio source changed during preview conversion');
      }
      publishCompletedFile(tmp, preview);
      writeJsonAtomic(metadata, { schemaVersion: 1, source: startedWith } satisfies AudioPreviewManifest);
      if (!sameAudioSourceIdentity(startedWith, audioSourceIdentity(sourceAbs))) {
        fs.rmSync(preview, { force: true });
        fs.rmSync(metadata, { force: true });
        throw new TransientConversionError('audio source changed while publishing preview');
      }
      return preview;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

const productionMediaTools = new FfmpegAudioMediaTools();
const previewPipeline = new AudioPreviewPipeline(productionMediaTools);
const transcriptionJobs = new Map<string, Map<string, Map<string, { sourceAbs: string; completion: Promise<void> }>>>();
const audioPreviewProgress = new Map<string, { completedMs: number; totalMs: number }>();

function configuredTranscription(): {
  provider: TranscriptionProvider;
  model: TranscriptionModelRef;
  language: string;
} | null {
  const resolved = resolveConfiguredTranscription();
  return resolved.status === 'ready' ? resolved.selection : null;
}

function resolveConfiguredTranscription():
  | { status: 'ready'; selection: { provider: TranscriptionProvider; model: TranscriptionModelRef; language: string } }
  | { status: 'blocked'; block: ConfiguredTranscriptionBlock } {
  const preferences = getTranscriptionPreferences();
  const provider = getTranscriptionProvider(preferences.providerId);
  if (!provider) {
    return {
      status: 'blocked',
      block: { reason: 'provider-unavailable', providerId: preferences.providerId },
    };
  }
  const resolved = provider.resolveSelection(preferences.modelId);
  if (resolved.status === 'ready') {
    return {
      status: 'ready',
      selection: { provider, model: resolved.model, language: preferences.language },
    };
  }
  if (resolved.status === 'blocked' && resolved.reason === 'runtime-unavailable') {
    return {
      status: 'blocked',
      block: { reason: 'runtime-unavailable', providerId: provider.id, error: resolved.error },
    };
  }
  return {
    status: 'blocked',
    block: {
      reason: resolved.status === 'blocked' ? resolved.reason : 'model-unavailable',
      providerId: provider.id,
      modelId: preferences.modelId,
      ...(resolved.status === 'blocked' && resolved.error ? { error: resolved.error } : {}),
    },
  };
}

export function configuredTranscriptionBlock(): ConfiguredTranscriptionBlock | null {
  const resolved = resolveConfiguredTranscription();
  return resolved.status === 'blocked' ? resolved.block : null;
}

export function derivedTranscriptPathForAudio(sourceAbs: string): string {
  return derivedTranscriptFor(sourceAbs);
}

export function readAudioTranscript(sourceAbs: string): AudioTranscript | null {
  return readCurrentAudioTranscript(sourceAbs, derivedNoteFor(sourceAbs));
}

/** Search and Agent-read guard for a stale/missing final transcript. Unlike
 *  scheduler/failure state this also covers an audio source that changed while
 *  the selected model was not installed, so an old index row can never make
 *  stale transcript text visible during the dynamic blocked state. */
export function isAudioTranscriptTextUnavailable(sourceAbs: string): boolean {
  return isAudioFile(sourceAbs) && readCurrentAudioTranscript(sourceAbs, derivedNoteFor(sourceAbs)) === null;
}

export function maybeConvertAudio(
  sourceAbs: string,
  options: { urgency?: 'interactive'; language?: string } = {},
): Promise<void> | null {
  const configured = configuredTranscription();
  if (!configured) return null;
  const language = options.language?.trim().toLowerCase() || configured.language;
  const completion = maybeConvert(sourceAbs, audioSpec(configured.provider, configured.model, language), {
    urgency: options.urgency ?? 'background',
    cost: 20,
  });
  if (completion) trackTranscriptionJob(configured.provider.id, configured.model.id, sourceAbs, completion);
  return completion;
}

/** Persist explicit user intent before waiting for the current source-owned
 * task snapshot. This gate prevents preview settlement from enqueueing a
 * checkpoint resume in the cancellation await gap. */
export async function cancelAudioPreparation(sourceAbs: string): Promise<boolean> {
  const sourcePath = filesystemPath.absolute(sourceAbs);
  const stopIncomplete = readAudioTranscript(sourcePath) === null;
  if (stopIncomplete) markCancelled(sourcePath);
  const cancelled = await cancelConversionAndWait(sourcePath, 'user-request');
  const shouldRemainStopped = cancelled || stopIncomplete;
  if (shouldRemainStopped) markCancelled(sourcePath);
  return shouldRemainStopped;
}

export function discoverNewAudio(folderAbs: string): void {
  const configured = configuredTranscription();
  if (!configured) return;
  const spec = audioSpec(configured.provider, configured.model, configured.language);
  discoverNewSources(folderAbs, spec, (abs) => { maybeConvertAudio(abs); });
}

/** Incomplete audio that cannot enter the scheduler because the selected
 * provider/runtime/model is unavailable. Index status exposes these paths so
 * Search never counts setup-blocked transcript text as ready. */
export async function blockedAudioSourcesForFolder(folderAbs: string, treeRevision: number): Promise<string[]> {
  const block = configuredTranscriptionBlock();
  if (!block) return [];
  return blockedAudioSourceCache.read(
    folderAbs,
    treeRevision,
    JSON.stringify(block),
    () => incompleteAudioSourcesForFolder(folderAbs),
  );
}

/** Revision-keyed cache keeps the frequent status endpoint independent from
 * recursive library size. Its injected scan seam makes the liveness contract
 * deterministic to test without filesystem timing assertions. */
export class AudioBlockedSourceCache {
  private readonly entries = new Map<string, {
    revision: number;
    blockKey: string;
    result: Promise<string[]>;
  }>();

  read(
    folderAbs: string,
    revision: number,
    blockKey: string,
    scan: () => Promise<string[]>,
  ): Promise<string[]> {
    const root = filesystemPath.absolute(folderAbs);
    const cached = this.entries.get(root);
    if (cached?.revision === revision && cached.blockKey === blockKey) return cached.result;
    const result = scan().catch((err) => {
      if (this.entries.get(root)?.result === result) this.entries.delete(root);
      throw err;
    });
    this.entries.set(root, { revision, blockKey, result });
    return result;
  }
}

const blockedAudioSourceCache = new AudioBlockedSourceCache();

/** Startup recovery for preview files whose owning native process died. The
 * server-port winner is the only production caller, so a startup loser cannot
 * interfere with the active daemon's work. PID liveness additionally keeps
 * alternate-port developer servers isolated. */
export function cleanupStaleAudioPreviewTemporaries(
  root = derivedDir(),
  now = Date.now(),
  maxAgeMs = AUDIO_PREVIEW_TEMP_MAX_AGE_MS,
): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = AUDIO_PREVIEW_TEMP_RE.exec(entry.name);
    if (!match) continue;
    const file = path.join(root, entry.name);
    try {
      const pid = Number(match[1]);
      const staleByAge = now - fs.statSync(file).mtimeMs > maxAgeMs;
      if (!staleByAge && processIsAlive(pid)) continue;
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch {
      // Rebuildable residue must never make server startup fail.
    }
  }
  return removed;
}

export async function incompleteAudioSourcesForFolder(folderAbs: string): Promise<string[]> {
  const root = filesystemPath.absolute(folderAbs);
  const out: string[] = [];
  await walkAudioSourcesAsync(root, async (sourceAbs) => {
    if (isPendingOrFailed(sourceAbs)) return;
    if (await readCurrentAudioTranscriptAsync(sourceAbs, derivedNoteFor(sourceAbs))) return;
    const rel = filesystemPath.relative(root, sourceAbs);
    if (rel != null) out.push(rel);
  });
  return out.sort();
}

export function indexFreshAudio(sourceAbs: string): Promise<boolean> {
  return indexFreshDerived(sourceAbs, audioFreshnessSpec());
}

export async function prepareAudioPreview(sourceAbs: string, signal?: AbortSignal): Promise<string> {
  registerDerivedSource(sourceAbs);
  const preview = derivedAudioPreviewFor(sourceAbs);
  const currentIdentity = audioSourceIdentity(sourceAbs);
  if (
    currentIdentity
    && audioPreviewIsCurrent(preview, derivedAudioPreviewMetadataFor(sourceAbs), currentIdentity)
  ) return preview;
  const interruptedTranscription = await interruptConversionForInteractivePreview(sourceAbs);
  try {
    await runAuxiliaryConversion({
      taskKey: preview,
      sourcePath: sourceAbs,
      lane: 'heavy',
      urgency: 'interactive',
      cost: 2,
      signal,
      run: async (schedulerSignal) => {
        const progressKey = filesystemPath.identity(sourceAbs);
        try {
          await previewPipeline.prepare(sourceAbs, schedulerSignal, (progress) => {
            audioPreviewProgress.set(progressKey, progress);
          });
        } finally {
          audioPreviewProgress.delete(progressKey);
        }
      },
    });
    return preview;
  } finally {
    // `maybeConvertAudio` respects durable failed/cancelled state, so a user
    // who cancelled transcription while preview work was active is not
    // silently overridden by this resume attempt.
    if (interruptedTranscription && fs.existsSync(sourceAbs)) maybeConvertAudio(sourceAbs);
  }
}

export function readAudioPreviewStatus(sourceAbs: string): AudioPreviewStatus {
  const source = audioSourceIdentity(sourceAbs);
  const preview = derivedAudioPreviewFor(sourceAbs);
  if (source && audioPreviewIsCurrent(preview, derivedAudioPreviewMetadataFor(sourceAbs), source)) {
    return { status: 'ready' };
  }
  const scheduled = getScheduledConversion(preview);
  if (!scheduled) return { status: 'idle' };
  if (scheduled.state === 'queued' || scheduled.state === 'yielded') {
    return { status: 'queued', tasksAhead: scheduled.tasksAhead ?? 0 };
  }
  const progress = audioPreviewProgress.get(filesystemPath.identity(sourceAbs));
  const completedMs = progress?.completedMs ?? 0;
  const totalMs = progress?.totalMs ?? 0;
  return {
    status: 'converting',
    completedMs,
    totalMs,
    percent: totalMs > 0 ? Math.max(0, Math.min(100, Math.round((completedMs / totalMs) * 100))) : 0,
  };
}

/** Stop queued/running local inference before deleting a model. In particular,
 * Windows cannot remove a model while whisper.cpp still has it open/mapped. */
export async function cancelAudioTranscriptionsUsingModel(providerId: string, modelId: string): Promise<string[]> {
  const providerJobs = transcriptionJobs.get(providerId);
  const jobs = [...(providerJobs?.get(modelId)?.values() ?? [])];
  for (const job of jobs) cancelConversionForModelRemoval(job.sourceAbs);
  await Promise.allSettled(jobs.map((job) => job.completion));
  return jobs.map((job) => job.sourceAbs);
}

function trackTranscriptionJob(
  providerId: string,
  modelId: string,
  sourceAbs: string,
  completion: Promise<void>,
): void {
  const key = filesystemPath.identity(sourceAbs);
  let providerJobs = transcriptionJobs.get(providerId);
  if (!providerJobs) {
    providerJobs = new Map();
    transcriptionJobs.set(providerId, providerJobs);
  }
  let jobs = providerJobs.get(modelId);
  if (!jobs) {
    jobs = new Map();
    providerJobs.set(modelId, jobs);
  }
  jobs.set(key, { sourceAbs, completion });
  void completion.finally(() => {
    const currentProvider = transcriptionJobs.get(providerId);
    const current = currentProvider?.get(modelId);
    if (current?.get(key)?.completion !== completion) return;
    current.delete(key);
    if (current.size === 0) currentProvider?.delete(modelId);
    if (currentProvider?.size === 0) transcriptionJobs.delete(providerId);
  }).catch(() => undefined);
}

function audioSpec(
  provider: TranscriptionProvider,
  model: TranscriptionModelRef,
  language: string,
): ConversionSpec {
  const transcription = new AudioTranscription(provider, productionMediaTools);
  return {
    kind: 'audio_transcription',
    lane: 'heavy',
    cost: 20,
    matches: isAudioFile,
    ...AUDIO_FRESHNESS_POLICY,
    convert: (abs, onProgress, signal, yieldLane) => transcription.prepare(abs, {
      model,
      language,
      onProgress,
      signal,
      yieldLane,
    }),
    cleanupBeforeConvert: cleanupFinalAudio,
    cleanupAfterFailure: cleanupFinalAudio,
    cleanupDerived: cleanupAllAudio,
  };
}

/** Freshness/indexing is provider-independent: an already-complete transcript
 * remains readable even if its provider is temporarily unavailable. */
function audioFreshnessSpec(): DerivedFreshnessSpec {
  return AUDIO_FRESHNESS_POLICY;
}

const AUDIO_FRESHNESS_POLICY = {
  derivedNote: derivedNoteFor,
  derivedReady: (sourceAbs: string, notePath: string) => readCurrentAudioTranscript(sourceAbs, notePath) !== null,
  indexSourceHash: (sourceAbs: string) => readAudioTranscript(sourceAbs)?.source.contentHash ?? null,
} satisfies DerivedFreshnessSpec;

/** Manual retry invalidates inference outputs and checkpoints but keeps an
 *  already-generated browser playback fallback, which is model-independent. */
export function resetAudioTranscription(sourceAbs: string): void {
  cleanupFinalAudio(sourceAbs);
  fs.rmSync(derivedAudioWorkFor(sourceAbs), { recursive: true, force: true });
}

function audioPaths(sourceAbs: string): AudioTranscriptionPaths {
  return {
    note: derivedNoteFor(sourceAbs),
    transcript: derivedTranscriptFor(sourceAbs),
    work: derivedAudioWorkFor(sourceAbs),
    preview: derivedAudioPreviewFor(sourceAbs),
    previewMetadata: derivedAudioPreviewMetadataFor(sourceAbs),
  };
}

function cleanupFinalAudio(sourceAbs: string): void {
  const paths = audioPaths(sourceAbs);
  fs.rmSync(paths.note, { force: true });
  fs.rmSync(paths.transcript, { force: true });
}

function cleanupAllAudio(sourceAbs: string): void {
  const paths = audioPaths(sourceAbs);
  cleanupFinalAudio(sourceAbs);
  fs.rmSync(paths.work, { recursive: true, force: true });
  fs.rmSync(paths.preview, { force: true });
  fs.rmSync(paths.previewMetadata, { force: true });
  cleanupAudioPreviewTemporaries(paths.preview);
}

function cleanupAudioPreviewTemporaries(preview: string): void {
  const dir = path.dirname(preview);
  const prefix = `${path.basename(preview)}.`;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !AUDIO_PREVIEW_TEMP_RE.test(entry.name)) continue;
    const match = AUDIO_PREVIEW_TEMP_RE.exec(entry.name);
    if (!match || processIsAlive(Number(match[1]))) continue;
    try { fs.rmSync(path.join(dir, entry.name), { force: true }); } catch { /* best-effort rebuildable cleanup */ }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function readCurrentAudioTranscript(sourceAbs: string, notePath: string): AudioTranscript | null {
  try {
    const source = audioSourceIdentity(sourceAbs);
    if (!source) return null;
    const note = fs.statSync(notePath);
    if (note.mtimeMs < source.mtimeMs) return null;
    const noteText = fs.readFileSync(notePath, 'utf8');
    if (!noteText.trimEnd().endsWith(AUDIO_COMPLETE_MARKER)) return null;
    const transcript = parseAudioTranscript(JSON.parse(fs.readFileSync(derivedTranscriptFor(sourceAbs), 'utf8')));
    return sameAudioSourceIdentity(transcript.source, source) && nonEmptyString(transcript.source.contentHash)
      ? transcript
      : null;
  } catch {
    return null;
  }
}

async function readCurrentAudioTranscriptAsync(sourceAbs: string, notePath: string): Promise<AudioTranscript | null> {
  try {
    const sourceStat = await fs.promises.stat(sourceAbs);
    if (!sourceStat.isFile()) return null;
    const source: AudioSourceIdentity = {
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      statIdentity: `${sourceStat.dev}:${sourceStat.ino}:${sourceStat.ctimeMs}`,
    };
    const note = await fs.promises.stat(notePath);
    if (note.mtimeMs < source.mtimeMs || !(await fileTailContains(notePath, AUDIO_COMPLETE_MARKER))) return null;
    const raw = await fs.promises.readFile(derivedTranscriptFor(sourceAbs), 'utf8');
    // Parsing can still be CPU work for very long transcripts; yield between
    // files so one first-time scan cannot monopolise the server turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const transcript = parseAudioTranscript(JSON.parse(raw));
    return sameAudioSourceIdentity(transcript.source, source) && nonEmptyString(transcript.source.contentHash)
      ? transcript
      : null;
  } catch {
    return null;
  }
}

async function fileTailContains(file: string, marker: string): Promise<boolean> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, Buffer.byteLength(marker) + 256);
    const buffer = Buffer.alloc(length);
    const start = Math.max(0, stat.size - length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8').trimEnd().endsWith(marker);
  } finally {
    await handle.close();
  }
}

function parseAudioTranscript(value: unknown): AudioTranscript {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('invalid audio transcript');
  const source = value.source;
  const provider = value.provider;
  const segments = value.segments;
  if (
    !isRecord(source)
    || !positiveFinite(source.durationMs)
    || !nonNegativeFinite(source.size)
    || !nonNegativeFinite(source.mtimeMs)
    || !nonEmptyString(source.statIdentity)
    || typeof source.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/i.test(source.contentHash)
    || !isRecord(provider)
    || !nonEmptyString(provider.id)
    || !nonEmptyString(provider.version)
    || !nonEmptyString(provider.model)
    || !nonEmptyString(value.language)
    || !nonEmptyString(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(segments)
  ) throw new Error('invalid audio transcript');

  let previousStartMs = -1;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (
      !isRecord(segment)
      || segment.id !== index + 1
      || !Number.isInteger(segment.id)
      || !nonNegativeFinite(segment.startMs)
      || !nonNegativeFinite(segment.endMs)
      || segment.endMs < segment.startMs
      || segment.endMs > source.durationMs
      || segment.startMs < previousStartMs
      || !nonEmptyString(segment.text)
    ) throw new Error('invalid audio transcript');
    previousStartMs = segment.startMs;
  }
  return value as unknown as AudioTranscript;
}

async function walkAudioSourcesAsync(
  dir: string,
  visit: (sourceAbs: string) => Promise<void>,
): Promise<void> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (isCloudPlaceholderName(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('_files') || isIndexExcludedDirName(entry.name)) continue;
      await walkAudioSourcesAsync(full, visit);
    } else if (entry.isFile() && isAudioFile(entry.name)) {
      await visit(full);
    }
  }
}

function audioSourceIdentity(sourceAbs: string): AudioSourceIdentity | null {
  try {
    const stat = fs.statSync(sourceAbs);
    return stat.isFile()
      ? {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          statIdentity: `${stat.dev}:${stat.ino}:${stat.ctimeMs}`,
        }
      : null;
  } catch {
    return null;
  }
}

async function audioSourceSignature(sourceAbs: string, signal?: AbortSignal): Promise<AudioSourceSignature> {
  const before = audioSourceIdentity(sourceAbs);
  if (!before) throw new Error('audio source is not a file');
  const contentHash = await blake3File(sourceAbs, signal);
  const after = audioSourceIdentity(sourceAbs);
  if (!sameAudioSourceIdentity(before, after)) {
    throw new TransientConversionError('audio source changed while hashing');
  }
  return { ...before, contentHash };
}

function sameAudioSourceIdentity(
  left: AudioSourceIdentity | null,
  right: AudioSourceIdentity | null,
): boolean {
  return left != null
    && right != null
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.statIdentity === right.statIdentity;
}

function sameAudioSourceSignature(
  left: AudioSourceSignature | null,
  right: AudioSourceSignature | null,
): boolean {
  return sameAudioSourceIdentity(left, right) && left!.contentHash === right!.contentHash;
}

function audioPreviewIsCurrent(
  preview: string,
  metadata: string,
  source: AudioSourceIdentity,
): boolean {
  try {
    if (!fs.statSync(preview).isFile()) return false;
    const manifest = JSON.parse(fs.readFileSync(metadata, 'utf8')) as Partial<AudioPreviewManifest>;
    return manifest.schemaVersion === 1
      && nonEmptyString(manifest.source?.contentHash)
      && sameAudioSourceIdentity(manifest.source ?? null, source);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readCompatibleManifest(workDir: string, expected: AudioWorkManifest): AudioWorkManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workDir, 'manifest.json'), 'utf8')) as AudioWorkManifest;
    const compatible = raw.schemaVersion === expected.schemaVersion
      && (raw.effectiveLanguage === undefined || nonEmptyString(raw.effectiveLanguage))
      && raw.source.size === expected.source.size
      && raw.source.contentHash === expected.source.contentHash
      && raw.durationMs === expected.durationMs
      && raw.provider === expected.provider
      && raw.providerVersion === expected.providerVersion
      && raw.modelId === expected.modelId
      && raw.requestedLanguage === expected.requestedLanguage
      && raw.chunkDurationMs === expected.chunkDurationMs
      && raw.overlapMs === expected.overlapMs;
    return compatible ? raw : null;
  } catch {
    return null;
  }
}

function audioPreviewMatchesContent(
  preview: string,
  metadata: string,
  source: AudioSourceSignature,
): boolean {
  try {
    if (!fs.statSync(preview).isFile()) return false;
    const manifest = JSON.parse(fs.readFileSync(metadata, 'utf8')) as Partial<AudioPreviewManifest>;
    return manifest.schemaVersion === 1
      && manifest.source?.size === source.size
      && manifest.source?.contentHash === source.contentHash;
  } catch {
    return false;
  }
}

function readChunkCheckpoint(
  checkpointPath: string,
  index: number,
  unitStartMs: number,
  unitEndMs: number,
  durationMs: number,
  isLastUnit: boolean,
): AudioChunkCheckpoint | null {
  try {
    const raw = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as AudioChunkCheckpoint;
    if (
      raw.schemaVersion !== 1 || raw.index !== index ||
      raw.unitStartMs !== unitStartMs || raw.unitEndMs !== unitEndMs ||
      !nonEmptyString(raw.detectedLanguage) || !Array.isArray(raw.segments)
    ) return null;
    for (const segment of raw.segments) {
      if (
        !isRecord(segment)
        || !nonNegativeFinite(segment.startMs)
        || !nonNegativeFinite(segment.endMs)
        || segment.endMs < segment.startMs
        || segment.endMs > durationMs
        || !nonEmptyString(segment.text)
      ) return null;
      const midpoint = segment.startMs + (segment.endMs - segment.startMs) / 2;
      if (midpoint < unitStartMs || (isLastUnit ? midpoint > unitEndMs : midpoint >= unitEndMs)) return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function renderTranscriptMarkdown(sourceAbs: string, transcript: AudioTranscript): string {
  const lines = [
    `# Transcript: ${path.basename(sourceAbs)}`,
    '',
    `- Language: ${transcript.language}`,
    `- Model: ${transcript.provider.id} ${transcript.provider.version} / ${transcript.provider.model}`,
    `- Duration: ${formatTimestamp(transcript.source.durationMs)}`,
    '',
  ];
  for (const segment of transcript.segments) {
    lines.push(`- [${formatTimestamp(segment.startMs)}] ${segment.text.replace(/\s+/g, ' ').trim()}`);
  }
  lines.push('', AUDIO_COMPLETE_MARKER, '');
  return lines.join('\n');
}

function writeJsonAtomic(target: string, value: unknown): void {
  writeTextAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    publishCompletedFile(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Publish a fully-written file. POSIX rename replaces atomically; Windows
 *  cannot reliably replace an existing target, so stale rebuildable output is
 *  removed immediately before publication. Final transcript outputs have
 *  already been invalidated by the conversion owner before this point. */
function publishCompletedFile(tmp: string, target: string): void {
  if (process.platform === 'win32') fs.rmSync(target, { force: true });
  fs.renameSync(tmp, target);
}

function formatTimestamp(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function normalizeLanguage(candidate: string, fallback: string): string {
  const normalized = candidate.trim().toLowerCase();
  return normalized && normalized !== 'unknown' ? normalized : fallback;
}

function clampMs(value: number, durationMs: number): number {
  return Math.max(0, Math.min(durationMs, Math.round(value)));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransientConversionError('audio transcription cancelled');
}
