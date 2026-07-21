import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  resolveAudioMediaToolchain,
  resolveWhisperToolchain,
  runTranscriptionTool,
} from './transcription-tools.ts';

test('audio media tool resolution does not require a local whisper runtime', () => {
  const keys = [
    'STASHBASE_FFMPEG_BIN',
    'STASHBASE_FFPROBE_BIN',
    'STASHBASE_WHISPER_BIN',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.STASHBASE_FFMPEG_BIN = process.execPath;
    process.env.STASHBASE_FFPROBE_BIN = process.execPath;
    process.env.STASHBASE_WHISPER_BIN = path.join(process.cwd(), 'missing-whisper-cli');

    assert.deepEqual(resolveAudioMediaToolchain(), {
      ffmpeg: process.execPath,
      ffprobe: process.execPath,
    });
    assert.throws(resolveWhisperToolchain, /STASHBASE_WHISPER_BIN does not point to a file/);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('native transcription tools are terminated after their deadline', async () => {
  await assert.rejects(
    runTranscriptionTool(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { timeoutMs: 50 }),
    /timed out after 1s/,
  );
});

test('native transcription tools expose complete stdout progress lines across chunks', async () => {
  const lines: string[] = [];
  await runTranscriptionTool(process.execPath, [
    '-e',
    "process.stdout.write('out_time_us=12'); process.stdout.write('3456\\nprogress=continue\\n')",
  ], { onStdoutLine: (line) => lines.push(line) });
  assert.deepEqual(lines, ['out_time_us=123456', 'progress=continue']);
});

test('native transcription tools wait for inherited stdout to close', async () => {
  const child = [
    "const { spawn } = require('node:child_process')",
    "spawn(process.execPath, ['-e', \"setTimeout(() => process.stdout.write('late-output\\\\n'), 40)\"], { detached: true, stdio: ['ignore', process.stdout, 'ignore'] }).unref()",
  ].join(';');
  const { stdout } = await runTranscriptionTool(process.execPath, ['-e', child]);
  assert.match(stdout, /late-output/);
});
