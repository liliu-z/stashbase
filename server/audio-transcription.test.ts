import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AudioBlockedSourceCache,
  AudioTranscription,
  AudioPreviewPipeline,
  cancelAudioPreparation,
  incompleteAudioSourcesForFolder,
  isAudioTranscriptTextUnavailable,
  type AudioMediaTools,
  type TranscriptionAdapter,
} from './audio-transcription.ts';
import {
  getScheduledConversion,
  maybeConvert,
  runAuxiliaryConversion,
} from './conversion.ts';
import { readAll as readConversionStatus } from './conversion-status.ts';
import { closeStateDb } from './state-db.ts';
import {
  derivedAudioPreviewFor,
  derivedAudioPreviewMetadataFor,
  derivedAudioWorkFor,
  derivedNoteFor,
  derivedTranscriptFor,
} from './derived-store.ts';

test('audio transcription checkpoints chunks, merges timestamps, and resumes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-audio-test-'));
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(temp, 'app-data');
  try {
    const source = path.join(temp, 'meeting.mp3');
    const model = path.join(temp, 'ggml-small.bin');
    fs.writeFileSync(source, 'source bytes');
    fs.writeFileSync(model, 'model bytes');

    const media = new FakeMediaTools(12 * 60 * 1000);
    const adapter = new FakeAdapter();
    const transcription = new AudioTranscription(adapter, media);
    let yields = 0;
    const progress: unknown[] = [];
    const result = await transcription.prepare(source, {
      model: { id: 'small', localPath: model },
      language: 'auto',
      yieldLane: async () => { yields += 1; },
      onProgress: (next) => progress.push(next),
    });

    assert.equal(adapter.calls.length, 2);
    assert.deepEqual(adapter.languages, ['auto', 'auto']);
    assert.equal(media.decodes.length, 2);
    assert.equal(isAudioTranscriptTextUnavailable(source), false);
    assert.equal(yields, 1);
    assert.deepEqual(progress, [
      { phase: 'extracting', completedUnits: 0, totalUnits: 2 },
      { phase: 'extracting', completedUnits: 1, totalUnits: 2 },
      { phase: 'extracting', completedUnits: 2, totalUnits: 2 },
    ]);
    assert.equal(result.language, 'en');
    assert.deepEqual(
      result.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
      [
        { startMs: 1_000, endMs: 2_000, text: 'first chunk' },
        { startMs: 600_000, endMs: 601_000, text: 'second chunk' },
      ],
    );
    assert.match(fs.readFileSync(derivedNoteFor(source), 'utf8'), /stashbase-audio-transcription: complete/);
    assert.equal(JSON.parse(fs.readFileSync(derivedTranscriptFor(source), 'utf8')).provider.model, 'small');
    assert.equal(fs.readdirSync(derivedAudioWorkFor(source)).filter((name) => name.startsWith('chunk-')).length, 2);

    // Simulate a metadata-only touch followed by a crash after final-output
    // invalidation. Content-addressed checkpoints rebuild both final files
    // without running inference again.
    const touched = new Date(Date.now() + 1_000);
    fs.utimesSync(source, touched, touched);
    fs.rmSync(derivedNoteFor(source), { force: true });
    fs.rmSync(derivedTranscriptFor(source), { force: true });
    await transcription.prepare(source, {
      model: { id: 'small', localPath: model },
      language: 'auto',
    });
    assert.equal(adapter.calls.length, 2);
    assert.equal(media.decodes.length, 2);

    fs.appendFileSync(source, ' changed');
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(source, future, future);
    assert.equal(isAudioTranscriptTextUnavailable(source), true);
  } finally {
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('audio completion rejects partial Markdown and malformed transcript JSON', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-audio-complete-test-'));
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(temp, 'app-data');
  try {
    const source = path.join(temp, 'voice.wav');
    fs.writeFileSync(source, 'source');
    const transcription = new AudioTranscription(new FakeAdapter(), new FakeMediaTools(60_000));
    await transcription.prepare(source, { model: { id: 'tiny' }, language: 'auto' });
    assert.equal(isAudioTranscriptTextUnavailable(source), false);

    fs.writeFileSync(derivedNoteFor(source), '# incomplete transcript\n', 'utf8');
    assert.equal(isAudioTranscriptTextUnavailable(source), true);

    await transcription.prepare(source, { model: { id: 'tiny' }, language: 'auto' });
    const transcript = JSON.parse(fs.readFileSync(derivedTranscriptFor(source), 'utf8'));
    transcript.segments[0].id = 99;
    fs.writeFileSync(derivedTranscriptFor(source), JSON.stringify(transcript), 'utf8');
    assert.equal(isAudioTranscriptTextUnavailable(source), true);
  } finally {
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('transcript Markdown keeps each provider segment on one timestamped physical line', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-audio-markdown-line-test-'));
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(temp, 'app-data');
  try {
    const source = path.join(temp, 'voice.wav');
    fs.writeFileSync(source, 'source');
    const adapter: TranscriptionAdapter = {
      id: 'multiline-provider',
      version: '1',
      transcribe: async () => ({
        language: 'en',
        segments: [{ startMs: 1_000, endMs: 2_000, text: ' repeated\nphrase ' }],
      }),
    };
    await new AudioTranscription(adapter, new FakeMediaTools(60_000)).prepare(source, {
      model: { id: 'tiny' },
      language: 'auto',
    });
    const markdown = fs.readFileSync(derivedNoteFor(source), 'utf8');
    assert.match(markdown, /- \[00:00:01\.000\] repeated phrase/);
    assert.doesNotMatch(markdown, /repeated\nphrase/);
  } finally {
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('invalid chunk checkpoints are discarded and recomputed', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-audio-checkpoint-test-'));
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(temp, 'app-data');
  try {
    const source = path.join(temp, 'meeting.mp3');
    fs.writeFileSync(source, 'source bytes');
    const media = new FakeMediaTools(60_000);
    await new AudioTranscription(new FakeAdapter(), media).prepare(source, {
      model: { id: 'tiny' },
      language: 'auto',
    });

    const checkpointPath = path.join(derivedAudioWorkFor(source), 'chunk-00000.json');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    checkpoint.segments[0].endMs = 90_000;
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint), 'utf8');
    fs.rmSync(derivedNoteFor(source), { force: true });
    fs.rmSync(derivedTranscriptFor(source), { force: true });

    const replacement = new FakeAdapter();
    await new AudioTranscription(replacement, media).prepare(source, {
      model: { id: 'tiny' },
      language: 'auto',
    });
    assert.equal(replacement.calls.length, 1);
  } finally {
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('audio preview cache uses an exact source signature and rejects mid-conversion changes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-audio-preview-test-'));
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(temp, 'app-data');
  try {
    const source = path.join(temp, 'voice.aiff');
    fs.writeFileSync(source, 'source');
    const media = new FakeMediaTools(60_000);
    const previewPipeline = new AudioPreviewPipeline(media);
    const crashedTemporary = `${derivedAudioPreviewFor(source)}.2147483647.1.tmp.webm`;
    fs.mkdirSync(path.dirname(crashedTemporary), { recursive: true });
    fs.writeFileSync(crashedTemporary, 'partial preview');
    const progress: Array<{ completedMs: number; totalMs: number }> = [];
    await previewPipeline.prepare(source, undefined, (next) => progress.push(next));
    assert.equal(fs.existsSync(crashedTemporary), false);
    await previewPipeline.prepare(source);
    assert.equal(media.previews, 1);
    assert.deepEqual(progress, [
      { completedMs: 0, totalMs: 60_000 },
      { completedMs: 30_000, totalMs: 60_000 },
      { completedMs: 60_000, totalMs: 60_000 },
    ]);
    assert.equal(fs.existsSync(derivedAudioPreviewMetadataFor(source)), true);

    const touched = new Date(Date.now() + 1_000);
    fs.utimesSync(source, touched, touched);
    await previewPipeline.prepare(source);
    assert.equal(media.previews, 1, 'metadata-only changes reuse a content-identical preview');

    const originalMtime = fs.statSync(source).mtime;
    fs.writeFileSync(source, 'replac');
    fs.utimesSync(source, originalMtime, originalMtime);
    await previewPipeline.prepare(source);
    assert.equal(media.previews, 2, 'same-size replacements invalidate preview even when mtime is preserved');

    fs.rmSync(derivedAudioPreviewFor(source), { force: true });
    fs.rmSync(derivedAudioPreviewMetadataFor(source), { force: true });
    media.changeSourceDuringPreview = source;
    await assert.rejects(
      previewPipeline.prepare(source),
      /source changed during preview conversion/,
    );
    assert.equal(fs.existsSync(derivedAudioPreviewFor(source)), false);
    assert.equal(fs.existsSync(derivedAudioPreviewMetadataFor(source)), false);
  } finally {
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('same-size same-mtime audio replacement invalidates a completed transcript', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-audio-identity-test-'));
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(temp, 'app-data');
  try {
    const source = path.join(temp, 'voice.wav');
    fs.writeFileSync(source, 'source');
    const originalMtime = fs.statSync(source).mtime;
    const transcription = new AudioTranscription(new FakeAdapter(), new FakeMediaTools(60_000));
    await transcription.prepare(source, { model: { id: 'tiny' }, language: 'auto' });
    assert.equal(isAudioTranscriptTextUnavailable(source), false);

    fs.writeFileSync(source, 'change');
    fs.utimesSync(source, originalMtime, originalMtime);
    assert.equal(isAudioTranscriptTextUnavailable(source), true);
  } finally {
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('blocked readiness lists only incomplete audio sources', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-audio-blocked-test-'));
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(temp, 'app-data');
  try {
    const source = path.join(temp, 'nested', 'voice.wav');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'source');
    assert.deepEqual(await incompleteAudioSourcesForFolder(temp), ['nested/voice.wav']);

    await new AudioTranscription(new FakeAdapter(), new FakeMediaTools(60_000)).prepare(source, {
      model: { id: 'tiny' },
      language: 'auto',
    });
    assert.deepEqual(await incompleteAudioSourcesForFolder(temp), []);
  } finally {
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('blocked readiness scan is reused until tree or provider state changes', async () => {
  const cache = new AudioBlockedSourceCache();
  let scans = 0;
  const scan = async () => {
    scans += 1;
    return ['meeting.wav'];
  };
  assert.deepEqual(await cache.read('/tmp/library', 1, 'missing:small', scan), ['meeting.wav']);
  assert.deepEqual(await cache.read('/tmp/library', 1, 'missing:small', scan), ['meeting.wav']);
  assert.equal(scans, 1);
  await cache.read('/tmp/library', 2, 'missing:small', scan);
  await cache.read('/tmp/library', 2, 'verifying:small', scan);
  assert.equal(scans, 3);
});

test('explicit audio cancel gates a preview-finally resume before awaiting task retirement', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-audio-cancel-gate-'));
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = path.join(temp, 'app-data');
  const source = path.join(temp, 'meeting.wav');
  const preview = path.join(temp, 'meeting.webm');
  const derived = path.join(temp, 'meeting.md');
  fs.writeFileSync(source, 'source');
  let resumeAttempt: Promise<void> | null = null;
  try {
    const auxiliary = runAuxiliaryConversion({
      taskKey: preview,
      sourcePath: source,
      lane: 'heavy',
      urgency: 'interactive',
      cost: 1,
      run: (signal) => new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    });
    resumeAttempt = auxiliary.finally(() => {
      const resumed = maybeConvert(source, {
        kind: 'cancelled_preview_resume_test',
        lane: 'heavy',
        cost: 20,
        matches: () => true,
        derivedNote: () => derived,
        convert: async () => { fs.writeFileSync(derived, 'must not run'); },
      });
      assert.equal(resumed, null);
    });

    assert.equal(await cancelAudioPreparation(source), true);
    await resumeAttempt;
    assert.equal(getScheduledConversion(source), null);
    assert.equal(fs.existsSync(derived), false);
    assert.equal(readConversionStatus()[source]?.status, 'cancelled');
  } finally {
    await resumeAttempt?.catch(() => undefined);
    closeStateDb();
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

class FakeMediaTools implements AudioMediaTools {
  readonly decodes: Array<{ startMs: number; durationMs: number }> = [];
  previews = 0;
  changeSourceDuringPreview: string | null = null;

  constructor(private readonly durationMs: number) {}

  async probe(): Promise<{ durationMs: number }> {
    return { durationMs: this.durationMs };
  }

  async decodeChunk(input: { wavPath: string; startMs: number; durationMs: number }): Promise<void> {
    this.decodes.push({ startMs: input.startMs, durationMs: input.durationMs });
    fs.writeFileSync(input.wavPath, 'wav');
  }

  async createPreview(
    _sourceAbs: string,
    previewAbs: string,
    _signal?: AbortSignal,
    onProgress?: (completedMs: number) => void,
  ): Promise<void> {
    this.previews += 1;
    onProgress?.(this.durationMs / 2);
    fs.writeFileSync(previewAbs, 'preview');
    if (this.changeSourceDuringPreview) fs.appendFileSync(this.changeSourceDuringPreview, ' changed-during-preview');
  }
}

class FakeAdapter implements TranscriptionAdapter {
  readonly id = 'fake-local';
  readonly version = '1';
  readonly calls: string[] = [];
  readonly languages: string[] = [];

  async transcribe(input: { audioPath: string; language: string }): Promise<{
    language: string;
    segments: Array<{ startMs: number; endMs: number; text: string }>;
  }> {
    this.calls.push(input.audioPath);
    this.languages.push(input.language);
    const index = this.calls.length - 1;
    return index === 0
      ? {
          language: 'en',
          segments: [
            { startMs: 1_000, endMs: 2_000, text: ' first chunk ' },
            // Falls in the overlap owned by the next work unit.
            { startMs: 600_000, endMs: 601_000, text: 'discarded overlap' },
          ],
        }
      : {
          language: 'en',
          // Chunk two begins at source offset 598_500ms.
          segments: [{ startMs: 1_500, endMs: 2_500, text: ' second chunk ' }],
        };
  }
}
