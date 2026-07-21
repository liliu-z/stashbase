import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { transcriptionModelPath } from './transcription-models.ts';
import {
  initializeTranscriptionRuntime,
  recoverTranscriptionRuntimeAfterServerBind,
} from './transcription-runtime.ts';
import { derivedAudioPreviewFor } from './derived-store.ts';

test('a startup contender cannot reclaim model downloads before it owns the server port', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-transcription-runtime-test-'));
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = temp;
  try {
    const part = `${transcriptionModelPath('small')}.part`;
    fs.mkdirSync(path.dirname(part), { recursive: true });
    fs.writeFileSync(part, 'active download owned by the server-port winner');
    const previewTemporary = `${derivedAudioPreviewFor(path.join(temp, 'meeting.wav'))}.2147483647.1.tmp.webm`;
    fs.mkdirSync(path.dirname(previewTemporary), { recursive: true });
    fs.writeFileSync(previewTemporary, 'preview bytes left by a crashed server');

    initializeTranscriptionRuntime();
    assert.equal(fs.existsSync(part), true);
    assert.equal(fs.existsSync(previewTemporary), true);

    const recovered = recoverTranscriptionRuntimeAfterServerBind();
    assert.equal(fs.existsSync(part), false);
    assert.equal(fs.existsSync(previewTemporary), false);
    assert.deepEqual(recovered, {
      modelDownloads: ['small'],
      audioPreviews: [previewTemporary],
    });
  } finally {
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
