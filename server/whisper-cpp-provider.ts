import fs from 'node:fs';
import transcriptionToolchain from '../native/transcription/toolchain.json' with { type: 'json' };
import { TransientConversionError } from './conversion.ts';
import {
  listTranscriptionModels,
  localTranscriptionModelAvailability,
} from './transcription-models.ts';
import {
  resolveWhisperToolchain,
  runTranscriptionTool,
  transcriptionThreadCount,
  transcriptionToolchainError,
  type WhisperToolchain,
} from './transcription-tools.ts';
import type {
  TranscriptionAdapterSegment,
  TranscriptionModelRef,
  TranscriptionProvider,
  TranscriptionProviderSelection,
} from './transcription-provider.ts';

const WHISPER_CHUNK_TIMEOUT_MS = 30 * 60_000;

export const LOCAL_TRANSCRIPTION_PROVIDER_ID = transcriptionToolchain.providerId;

/** The only adapter that knows local model paths and whisper.cpp JSON. */
export class WhisperCppAdapter implements TranscriptionProvider {
  readonly id = LOCAL_TRANSCRIPTION_PROVIDER_ID;
  readonly version = transcriptionToolchain.whisperCppVersion;

  constructor(private readonly toolchain: () => WhisperToolchain = resolveWhisperToolchain) {}

  settings() {
    return {
      id: this.id,
      label: 'Local whisper.cpp',
      kind: 'local' as const,
      description: 'Runs entirely on this device with downloaded Whisper weights.',
      models: listTranscriptionModels().map((model) => ({
        id: model.id,
        label: model.label,
        sizeBytes: model.sizeBytes,
        speed: model.speed,
        accuracy: model.accuracy,
        resourceUse: model.resourceUse,
        available: model.installed,
        management: 'local-download' as const,
        operation: model.download,
      })),
      runtimeError: transcriptionToolchainError() ?? undefined,
    };
  }

  resolveSelection(modelId: string): TranscriptionProviderSelection {
    if (modelId !== 'tiny' && modelId !== 'base' && modelId !== 'small') return { status: 'invalid-model' };
    const runtimeError = transcriptionToolchainError();
    if (runtimeError) return { status: 'blocked', reason: 'runtime-unavailable', error: runtimeError };
    const availability = localTranscriptionModelAvailability(modelId);
    if (availability.status === 'ready') {
      return { status: 'ready', model: { id: modelId, localPath: availability.path } };
    }
    if (availability.status === 'verifying') return { status: 'blocked', reason: 'model-verifying' };
    if (availability.status === 'unavailable') {
      return { status: 'blocked', reason: 'model-unavailable', error: availability.error };
    }
    return { status: 'blocked', reason: 'model-not-installed' };
  }

  async transcribe(input: {
    audioPath: string;
    model: TranscriptionModelRef;
    language: string;
    signal?: AbortSignal;
  }): Promise<{ language: string; segments: TranscriptionAdapterSegment[] }> {
    if (!input.model.localPath || !fs.existsSync(input.model.localPath)) {
      throw new TransientConversionError('selected transcription model is not installed');
    }
    const outputBase = `${input.audioPath}.whisper-output`;
    try {
      await runTranscriptionTool(this.toolchain().whisper, [
        '--model', input.model.localPath,
        '--file', input.audioPath,
        '--language', input.language,
        '--threads', String(transcriptionThreadCount()),
        '--output-json',
        '--output-file', outputBase,
        '--no-prints',
      ], { signal: input.signal, timeoutMs: WHISPER_CHUNK_TIMEOUT_MS });
      return parseWhisperJson(`${outputBase}.json`);
    } finally {
      fs.rmSync(`${outputBase}.json`, { force: true });
    }
  }
}

function parseWhisperJson(jsonPath: string): { language: string; segments: TranscriptionAdapterSegment[] } {
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
    result?: { language?: unknown };
    transcription?: Array<{
      offsets?: { from?: unknown; to?: unknown };
      text?: unknown;
    }>;
  };
  if (!Array.isArray(raw.transcription)) throw new Error('whisper.cpp returned invalid JSON');
  const segments = raw.transcription.map((segment) => {
    const startMs = segment.offsets?.from;
    const endMs = segment.offsets?.to;
    if (
      typeof startMs !== 'number' || !Number.isFinite(startMs) || startMs < 0
      || typeof endMs !== 'number' || !Number.isFinite(endMs) || endMs < startMs
      || typeof segment.text !== 'string'
    ) throw new Error('whisper.cpp returned invalid segment JSON');
    return { startMs, endMs, text: segment.text };
  });
  return {
    language: typeof raw.result?.language === 'string' ? raw.result.language : 'unknown',
    segments,
  };
}
