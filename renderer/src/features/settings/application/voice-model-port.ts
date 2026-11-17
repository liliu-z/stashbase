import type { VoiceModelState } from '@/shared/domain/voice-typing';
export interface VoiceModelPort {
  load(signal: AbortSignal): Promise<VoiceModelState>;
  command(action: 'stop' | 'resume' | 'retry', signal: AbortSignal): Promise<VoiceModelState>;
}
