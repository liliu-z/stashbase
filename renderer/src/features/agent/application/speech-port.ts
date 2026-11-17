import type { SpeechCapturePort, VoiceModelState } from '@/shared/domain/voice-typing';

export interface SpeechRecording {
  id: string;
  phase: 'recording' | 'processing' | 'ready' | 'failed' | 'cancelled';
  nextSequence: number;
  text: string;
  error: string | null;
}
export interface SpeechPort {
  model(signal: AbortSignal): Promise<VoiceModelState>;
  start(
    id: string,
    conversation: string,
    folder: string,
    signal: AbortSignal,
  ): Promise<SpeechRecording>;
  audio(
    id: string,
    sequence: number,
    pcm: Int16Array,
    signal: AbortSignal,
  ): Promise<SpeechRecording>;
  finish(id: string, sequence: number, signal: AbortSignal): Promise<SpeechRecording>;
  status(id: string, signal: AbortSignal): Promise<SpeechRecording>;
  retry(id: string, signal: AbortSignal): Promise<SpeechRecording>;
  cancel(id: string, signal: AbortSignal): Promise<void>;
}
export interface VoiceTypingPorts {
  speech: SpeechPort;
  capture: SpeechCapturePort;
}
