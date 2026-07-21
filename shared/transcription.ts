import type { ConversionProgress } from './conversion.ts';

export const TRANSCRIPTION_LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'es', label: 'Spanish' },
] as const;

const TRANSCRIPTION_LANGUAGE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;

/** Normalize a provider language code. Empty input is intentionally not
 * treated as `auto`, because HTTP callers use null to distinguish an omitted
 * per-attempt override from an explicit automatic-detection request. */
export function normalizeTranscriptionLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || TRANSCRIPTION_LANGUAGE_RE.test(normalized)) return normalized;
  return null;
}

export type LocalTranscriptionModelId = 'tiny' | 'base' | 'small';

export type TranscriptionModelOperation =
  | { status: 'idle' }
  | { status: 'verifying' }
  | { status: 'downloading'; receivedBytes: number; totalBytes: number }
  | { status: 'failed'; error: string };

export interface TranscriptionModelState {
  id: string;
  label: string;
  sizeBytes?: number;
  speed?: string;
  accuracy?: string;
  resourceUse?: string;
  available: boolean;
  management: 'local-download' | 'provider';
  operation?: TranscriptionModelOperation;
}

export interface TranscriptionProviderSettingsState {
  id: string;
  label: string;
  kind: 'local' | 'remote';
  description: string;
  models: TranscriptionModelState[];
  runtimeError?: string;
}

export interface TranscriptionSettings {
  providerId: string;
  modelId: string;
  language: string;
  providers: TranscriptionProviderSettingsState[];
}

export interface AudioTranscriptSegment {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface AudioTranscript {
  schemaVersion: 1;
  source: {
    durationMs: number;
    size: number;
    mtimeMs: number;
    statIdentity: string;
    contentHash: string;
  };
  provider: { id: string; version: string; model: string };
  language: string;
  createdAt: string;
  segments: AudioTranscriptSegment[];
}

export type ConfiguredTranscriptionBlock =
  | { reason: 'provider-unavailable'; providerId: string }
  | { reason: 'runtime-unavailable'; providerId: string; error: string }
  | { reason: 'model-verifying'; providerId: string; modelId: string }
  | { reason: 'model-not-installed'; providerId: string; modelId: string }
  | { reason: 'model-unavailable'; providerId: string; modelId: string; error?: string };

export type AudioTranscriptState =
  | { status: 'ready'; transcript: AudioTranscript }
  | { status: 'pending'; progress?: ConversionProgress }
  | ({ status: 'blocked' } & ConfiguredTranscriptionBlock)
  | { status: 'cancelled' }
  | { status: 'failed'; error: string };

export type AudioPreviewStatus =
  | { status: 'idle' }
  | { status: 'ready' }
  | { status: 'queued'; tasksAhead: number }
  | { status: 'converting'; completedMs: number; totalMs: number; percent: number };
