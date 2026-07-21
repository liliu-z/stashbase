/** Explicit composition point for transcription providers and model lifecycle. */
import {
  cancelAudioTranscriptionsUsingModel,
  cleanupStaleAudioPreviewTemporaries,
} from './audio-transcription.ts';
import {
  cleanupStaleTranscriptionModelDownloads,
  configureTranscriptionModelLifecycle,
} from './transcription-models.ts';
import { registerTranscriptionProvider } from './transcription-provider.ts';
import {
  LOCAL_TRANSCRIPTION_PROVIDER_ID,
  WhisperCppAdapter,
} from './whisper-cpp-provider.ts';
import { reconcileLibraryFolders } from './state.ts';

let initialized = false;
let recoveredAfterBind = false;
const localProvider = new WhisperCppAdapter();

export function initializeTranscriptionRuntime(): void {
  if (initialized) return;
  initialized = true;
  registerTranscriptionProvider(localProvider);
  configureTranscriptionModelLifecycle({
    onAvailable: (id) => reconcileLibraryFolders(`transcription model ${id} available`),
    release: async (id) => {
      await cancelAudioTranscriptionsUsingModel(LOCAL_TRANSCRIPTION_PROVIDER_ID, id);
    },
  });
}

/** Reclaim crash residue only after this process wins the server-port
 * arbiter. Import-time cleanup would let a losing startup contender unlink
 * the active server's fixed-name model download before exiting EADDRINUSE. */
export function recoverTranscriptionRuntimeAfterServerBind(): {
  modelDownloads: string[];
  audioPreviews: string[];
} {
  initializeTranscriptionRuntime();
  if (recoveredAfterBind) return { modelDownloads: [], audioPreviews: [] };
  const recovered = {
    modelDownloads: cleanupStaleTranscriptionModelDownloads(),
    audioPreviews: cleanupStaleAudioPreviewTemporaries(),
  };
  recoveredAfterBind = true;
  return recovered;
}
