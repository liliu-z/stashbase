import { AgentSessionError } from '@/features/agent/application/ports';
import type { SpeechPort } from '@/features/agent/application/speech-port';
import { request } from '@/platform/http/classify';
import type { HttpClient } from '@/platform/http/client';
import {
  speechFailureSchema,
  speechJobSchema,
  speechModelStatusSchema,
  speechCancelledSchema,
} from '@/protocols/http/speech';

export function createSpeechAdapter(http: HttpClient): SpeechPort {
  const call = (path: string, signal: AbortSignal, body?: unknown) =>
    request(http, {
      error: AgentSessionError,
      failureSchema: speechFailureSchema,
      path: `/api/speech${path}`,
      signal,
      schema: speechJobSchema,
      ...(body === undefined ? {} : { method: 'POST' as const, body }),
    });
  return {
    model: (signal) =>
      request(http, {
        error: AgentSessionError,
        failureSchema: speechFailureSchema,
        path: '/api/speech/model',
        signal,
        schema: speechModelStatusSchema,
      }),
    start: (id, conversation, folder, signal) =>
      call(`/jobs?${new URLSearchParams({ folder })}`, signal, { id, conversation }),
    audio(id, sequence, pcm, signal) {
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return call(`/jobs/${id}/audio`, signal, { sequence, pcm: btoa(binary) });
    },
    finish: (id, sequence, signal) => call(`/jobs/${id}/finish`, signal, { sequence }),
    status: (id, signal) => call(`/jobs/${id}`, signal),
    retry: (id, signal) => call(`/jobs/${id}/retry`, signal, {}),
    async cancel(id, signal) {
      await request(http, {
        error: AgentSessionError,
        failureSchema: speechFailureSchema,
        path: `/api/speech/jobs/${id}`,
        signal,
        method: 'DELETE',
        schema: speechCancelledSchema,
      });
    },
  };
}
