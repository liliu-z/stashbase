// One real model/worker/service job across production rollover boundaries.
// Audio is accelerated with bounded backpressure; this is not a physical mic soak.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { createSpeechService } from '../../server/speech/service.ts';
import { SPEECH_MODEL } from '../../server/speech/model-manifest.ts';
import { speechFixturePcm, speechModelFile } from './speech-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const value = (key, fallback) => { const at = args.indexOf(key); return at < 0 ? fallback : args[at + 1]; };
const minutes = Number(value('--minutes', '2'));
const cpu = args.includes('--cpu') || !(process.platform === 'darwin' && process.arch === 'arm64');
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120) throw new Error('Pass --model <pinned GGUF> and --minutes 0..120.');
const model = await speechModelFile(root, args);

async function continuous() {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(model)) hash.update(chunk);
  assert.equal(hash.digest('hex'), SPEECH_MODEL.sha256);
  const pcm = speechFixturePcm(await fs.readFile(path.join(root, 'scripts/fixtures/speech/jfk.wav')));
  const repetitions = Math.ceil(minutes * 60 * 32000 / pcm.length);
  const bytes = repetitions * pcm.length;
  const spool = await fs.mkdtemp(path.join(os.tmpdir(), 'stashbase-native-speech-'));
  const service = createSpeechService({ root: spool, modelPath: () => model, cpu });
  let peakWorkerRssMiB = 0;
  let peakSpoolFrames = 0;
  let lastReport = 0;
  const memorySamples = [];
  const started = performance.now();
  try {
    const job = await service.start('native-verification', '/fixture', 'continuous');
    const directory = path.join(spool, job.id);
    const sample = async () => {
      const frames = (await fs.readdir(directory)).length;
      peakSpoolFrames = Math.max(peakSpoolFrames, frames);
      if (process.platform !== 'win32') {
        const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
        let workerRssMiB = 0;
        for (const row of rows.trim().split('\n')) {
          const [pid, parent, rss] = row.trim().split(/\s+/u).map(Number);
          if (parent === process.pid && pid !== process.pid) workerRssMiB = Math.max(workerRssMiB, rss / 1024);
        }
        peakWorkerRssMiB = Math.max(peakWorkerRssMiB, workerRssMiB);
        if (workerRssMiB > 256) memorySamples.push(workerRssMiB);
      }
      const status = service.status('native-verification', job.id);
      if (status.phase === 'failed') throw new Error(status.error);
      assert.equal(status.text, '', 'intermediate native text remains hidden');
      return frames;
    };
    let sequence = 0;
    for (let offset = 0; offset < bytes; offset += 32000) {
      if (sequence % 20 === 0) {
        // Engage backpressure before the 77-second CI fixture is fully queued,
        // so Stop measures the final tail rather than an entire CPU backlog.
        while (await sample() >= 60) await delay(100);
      }
      const frame = Buffer.alloc(Math.min(32000, bytes - offset));
      for (let i = 0; i < frame.length;) {
        const source = (offset + i) % pcm.length;
        const count = Math.min(frame.length - i, pcm.length - source);
        pcm.copy(frame, i, source, source + count);
        i += count;
      }
      await service.push('native-verification', job.id, sequence++, frame.toString('base64'));
      if (performance.now() - lastReport >= 30_000) {
        lastReport = performance.now();
        console.log(JSON.stringify({ scenario: 'speech-continuous-progress', audioSeconds: (offset + frame.length) / 32000, peakWorkerRssMiB, peakSpoolFrames }));
      }
    }
    await service.finish('native-verification', job.id, sequence);
    const stopped = performance.now();
    const deadline = stopped + 5 * 60_000;
    let result = service.status('native-verification', job.id);
    while (result.phase !== 'ready') {
      if (result.phase === 'failed') throw new Error(result.error);
      if (performance.now() > deadline) throw new Error('Continuous native transcription did not finish.');
      await delay(100);
      result = service.status('native-verification', job.id);
    }
    const normalized = result.text.toLowerCase().replace(/[^a-z\s]/gu, '').replace(/\s+/gu, ' ');
    const reference = 'and so my fellow americans ask not what your country can do for you ask what you can do for your country';
    assert.equal(normalized.trim(), Array(repetitions).fill(reference).join(' '), 'every fixture word must survive stream boundaries in order');
    const occurrences = normalized.split('country can do for you').length - 1;
    const secondOccurrences = normalized.split('what you can do for your country').length - 1;
    assert.equal(secondOccurrences, repetitions, 'the second clause must survive every rollover');
    assert.equal(occurrences, repetitions, 'a phrase crossing native boundaries must not be lost or repeated');
    assert.ok(normalized.trim().endsWith('your country'), 'Stop must flush the last spoken words');
    assert.ok(peakSpoolFrames <= 80, 'native processing must make progress within the bounded upload window');
    assert.deepEqual(await fs.readdir(directory), [], 'processed native audio must be removed');
    console.log(JSON.stringify({ scenario: 'speech-continuous', backendPreference: cpu ? 'cpu' : 'metal-with-cpu-fallback', audioSeconds: bytes / 32000, wallSeconds: (performance.now() - started) / 1000, stopToDraftMs: performance.now() - stopped, repetitions, occurrences, secondOccurrences, peakWorkerRssMiB, firstWorkerRssMiB: memorySamples[0], lastWorkerRssMiB: memorySamples.at(-1), peakSpoolFrames, sampleFrames: sequence, tailPreserved: true }));
    await service.cancel('native-verification', job.id);
    assert.deepEqual(await fs.readdir(spool), []);
  } finally { await service.close(); await fs.rm(spool, { recursive: true, force: true }); }
}

if (args.includes('--child')) await continuous();
else {
  const child = spawn(electron, ['--import', 'tsx', fileURLToPath(import.meta.url), ...args, '--child'], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true });
  child.once('error', (error) => { console.error(error); process.exitCode = 1; });
  child.once('exit', (code) => { if (code) process.exitCode = code; });
}
