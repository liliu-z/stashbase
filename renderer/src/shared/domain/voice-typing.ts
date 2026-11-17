/** Shared presentation facts; the host wire is mapped by each feature adapter. */
export interface VoiceModelState {
  phase: 'missing' | 'downloading' | 'paused' | 'verifying' | 'ready' | 'failed' | 'unsupported';
  downloadedBytes: number;
  totalBytes: number;
  error: string | null;
}
export const voiceModelQueryKey = ['voice-typing', 'model'] as const;

export interface SpeechCapture {
  stop(): Promise<void>;
}
export interface SpeechCapturePort {
  open(options: {
    signal: AbortSignal;
    onAudio(pcm: Int16Array): void;
    onLevel(level: number): void;
    onEnded(message: string): void;
  }): Promise<SpeechCapture>;
}
