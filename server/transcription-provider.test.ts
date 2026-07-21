import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listTranscriptionProviderSettings,
  registerTranscriptionProvider,
  type TranscriptionProvider,
} from './transcription-provider.ts';
import { requireModelForProvider } from './routes/transcription.ts';

test('registered remote providers expose provider-neutral Settings metadata', () => {
  const provider: TranscriptionProvider = {
    id: 'test-remote-provider',
    version: '1',
    settings: () => ({
      id: 'test-remote-provider',
      label: 'Test remote',
      kind: 'remote',
      description: 'Test-only remote transcription provider.',
      models: [{
        id: 'remote-fast',
        label: 'Remote Fast',
        available: true,
        management: 'provider',
      }],
    }),
    resolveSelection: (modelId) => modelId === 'remote-fast'
      ? { status: 'ready', model: { id: modelId } }
      : { status: 'invalid-model' },
    transcribe: async () => ({ language: 'en', segments: [] }),
  };
  registerTranscriptionProvider(provider);
  assert.deepEqual(
    listTranscriptionProviderSettings().find((candidate) => candidate.id === provider.id),
    provider.settings(),
  );
  assert.equal(requireModelForProvider('remote-fast', provider.id), 'remote-fast');
  assert.throws(
    () => requireModelForProvider('local-only-model', provider.id),
    /unsupported transcription model/,
  );
});
