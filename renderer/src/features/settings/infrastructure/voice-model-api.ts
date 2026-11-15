import type { VoiceModelPort } from '@/features/settings/application/voice-model-port';
import { settingsRequest } from '@/features/settings/infrastructure/settings-request';
import { request } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import { speechFailureSchema, speechModelStatusSchema } from '@/protocols/http/speech';

export function createVoiceModelAdapter(http: HttpClient): VoiceModelPort {
  const read = (signal: AbortSignal, action?: 'stop' | 'resume' | 'retry') =>
    request(http, {
      ...settingsRequest({ path: '/api/speech/model', signal, failureSchema: speechFailureSchema }),
      schema: speechModelStatusSchema,
      ...(action ? { method: 'POST' as const, body: { action } } : {}),
    });
  return { load: (signal) => read(signal), command: (action, signal) => read(signal, action) };
}
