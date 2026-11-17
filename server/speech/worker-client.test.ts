import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeechEngine } from './worker-client.ts';

test('cancellation cannot launch a late worker and failed native loading never reports successful text', async () => {
  const engine = createSpeechEngine();
  const pending = engine.load('/no-such-voice-model.gguf', true);
  const refused = assert.rejects(pending, /cancelled/u);
  await engine.close();
  await refused;
  try {
    await assert.rejects(engine.load('/no-such-voice-model.gguf', true), /failed|stopped/u);
  } finally { await engine.close(); }
});
