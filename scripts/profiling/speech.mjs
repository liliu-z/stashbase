// Explicit real-model verification in Electron's embedded Node, without
// accounts, installed agent CLIs, cloud inference, or production app data.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { speechFixturePcm, speechModelFile } from './speech-fixture.mjs';
import { SPEECH_MODEL, SPEECH_TRANSCRIBE_OPTIONS, SPEECH_STREAM_OPTIONS } from '../../server/speech/model-manifest.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const value = (key, fallback) => { const at = args.indexOf(key); return at < 0 ? fallback : args[at + 1]; };
const runs = Number(value('--runs', '2'));
const soakMinutes = Number(value('--soak-minutes', '0'));
const offline = args.includes('--offline');
if (!Number.isInteger(runs) || runs < 1 || runs > 10 || !Number.isFinite(soakMinutes) || soakMinutes < 0 || soakMinutes > 1440) throw new Error('Invalid speech profiling duration or run count.');

async function child(modelPath) {
  const { TranscribeModel, setLogHandler } = await import('transcribe-cpp');
  setLogHandler(() => {});
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(modelPath)) digest.update(chunk);
  if (digest.digest('hex') !== SPEECH_MODEL.sha256) throw new Error('The speech fixture model checksum does not match the app manifest.');
  const bytes = speechFixturePcm(await fs.readFile(path.join(root, 'scripts', 'fixtures', 'speech', 'jfk.wav')));
  const pcm = new Float32Array(bytes.length / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2) / 32768;
  const start = performance.now();
  const model = await TranscribeModel.load(modelPath, { backend: process.platform === 'darwin' && process.arch === 'arm64' ? 'metal' : 'cpu' });
  const loadMs = performance.now() - start;
  const memory = [];
  try {
    const totalRuns = soakMinutes ? Math.ceil(soakMinutes * 60 / (pcm.length / 16000)) : runs;
    for (let run = 0; run < totalRuns; run++) {
      const session = model.createSession({ nThreads: Math.min(4, Math.max(1, os.availableParallelism() - 1)) });
      const stream = offline ? null : await session.stream(SPEECH_STREAM_OPTIONS);
      const inferenceStart = performance.now();
      try {
        let text;
        let stopped = inferenceStart;
        if (stream) {
          for (let offset = 0; offset < pcm.length; offset += 16000) await stream.feed(pcm.subarray(offset, offset + 16000));
          stopped = performance.now();
          await stream.finalize();
          if (stream.state !== 'finished') throw new Error('Streaming recognition did not finish.');
          text = stream.text.full;
        } else {
          const result = await session.run(pcm, SPEECH_TRANSCRIBE_OPTIONS);
          if (result.aborted || result.truncated) throw new Error('Offline recognition did not finish.');
          text = result.text;
        }
        const finalized = performance.now();
        const referenceMatched = /country can do for you/iu.test(text);
        if (!referenceMatched) throw new Error('The native speech fixture did not complete the expected English transcription.');
        const result = {
          scenario: 'speech', platform: process.platform, arch: process.arch,
          electron: process.versions.electron, backend: model.backend, run: run + 1,
          mode: offline ? 'offline' : 'streaming', maxAudioMs: session.limits.effectiveMaxAudioMs,
          loadMs: run === 0 ? loadMs : 0, audioSeconds: pcm.length / 16000,
          inferenceMs: finalized - inferenceStart, finalizeMs: finalized - stopped,
          rssMiB: process.memoryUsage().rss / 1048576,
          peakRssMiB: process.resourceUsage().maxRSS / 1024,
          referenceMatched,
        };
        memory.push(result.rssMiB);
        if (!soakMinutes || run % 5 === 0 || run + 1 === totalRuns) console.log(JSON.stringify(result));
      } finally { session.dispose(); }
    }
    if (soakMinutes) console.log(JSON.stringify({ scenario: 'speech-soak', audioMinutes: soakMinutes, runs: totalRuns, firstRssMiB: memory[0], lastRssMiB: memory.at(-1), maxRssMiB: Math.max(...memory) }));
  } finally { model.dispose(); }
}

const model = await speechModelFile(root, args);
if (args.includes('--child')) await child(model);
else {
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of Object.keys(environment)) if (/^(TRANSCRIBE|GGML|KOFFI)_/u.test(key)) delete environment[key];
  const launches = [
    ['--import', 'tsx', fileURLToPath(import.meta.url), '--child', '--model', model, '--runs', String(runs), '--soak-minutes', String(soakMinutes), ...(offline ? ['--offline'] : [])],
    // The repeated fixture lasts 77 seconds: it crosses both production rollovers
    // (40 and 72 seconds) and verifies the final tail. Keep the longer default
    // profiling scenario separate so Intel CPU CI fits its whole-job budget.
    ...(args.includes('--verify-continuous') ? [['--import', 'tsx', fileURLToPath(new URL('./speech-continuous.mjs', import.meta.url)), '--child', '--model', model, '--minutes', '1.25']] : []),
  ];
  for (const arguments_ of launches) {
    const processChild = spawn(electron, arguments_, { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
    const code = await new Promise((resolve) => {
      processChild.once('error', (error) => { console.error(error.message); resolve(1); });
      processChild.once('exit', resolve);
    });
    if (code !== 0) { process.exitCode = 1; break; }
  }
}
