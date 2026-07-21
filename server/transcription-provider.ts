import type { TranscriptionProviderSettingsState } from '../shared/transcription.ts';

export interface TranscriptionAdapterSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptionModelRef {
  id: string;
  /** Present only for providers whose weights are installed locally. */
  localPath?: string;
}

export type TranscriptionProviderSelection =
  | { status: 'ready'; model: TranscriptionModelRef }
  | { status: 'invalid-model' }
  | { status: 'blocked'; reason: 'runtime-unavailable'; error: string }
  | { status: 'blocked'; reason: 'model-verifying' | 'model-not-installed' | 'model-unavailable'; error?: string };

/** Provider-neutral inference contract. Model availability belongs to the
 * provider, so orchestration does not assume that every model is a local file. */
export interface TranscriptionProvider {
  readonly id: string;
  readonly version: string;
  settings(): TranscriptionProviderSettingsState;
  resolveSelection(modelId: string): TranscriptionProviderSelection;
  transcribe(input: {
    audioPath: string;
    model: TranscriptionModelRef;
    language: string;
    signal?: AbortSignal;
  }): Promise<{ language: string; segments: TranscriptionAdapterSegment[] }>;
}

const providers = new Map<string, TranscriptionProvider>();

export function registerTranscriptionProvider(provider: TranscriptionProvider): void {
  const id = provider.id.trim();
  if (!id) throw new Error('transcription provider id is required');
  const current = providers.get(id);
  if (current && current !== provider) throw new Error(`transcription provider already registered: ${id}`);
  providers.set(id, provider);
}

export function getTranscriptionProvider(id: string): TranscriptionProvider | null {
  return providers.get(id) ?? null;
}

export function isTranscriptionProviderRegistered(id: string): boolean {
  return providers.has(id);
}

export function listTranscriptionProviderSettings(): TranscriptionProviderSettingsState[] {
  return [...providers.values()].map((provider) => provider.settings());
}
