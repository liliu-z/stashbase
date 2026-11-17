import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session, Stream, Token } from 'transcribe-cpp';
import { createBufferedRecognition } from './stream.ts';
import { SPEECH_SEGMENT_MAX_SAMPLES } from './model-manifest.ts';

function nativeFixture(limitMs: number, failFinalize = false, tokens: Token[] = []) {
  const segments: number[][] = [];
  const disposed: number[] = [];
  const finalized: number[] = [];
  const createSession = () => {
    const id = segments.length;
    const received: number[] = [];
    segments.push(received);
    let finished = false;
    const stream = {
      async feed(pcm: Float32Array) { received.push(...pcm); },
      async finalize() {
        if (failFinalize) throw new Error('native finalization failed');
        finished = true;
        finalized.push(id);
        return { isFinal: true };
      },
      get state() { return finished ? 'finished' : 'active'; },
      get snapshot() { return { tokens }; },
      get text() {
        assert.ok(finished, 'right-context text must only be read after finalization');
        return { full: `Segment ${id + 1}.` };
      },
      reset() { assert.ok(finished || failFinalize); },
    } as unknown as Stream;
    return {
      limits: { effectiveMaxAudioMs: limitMs },
      async stream() { return stream; },
      dispose() { disposed.push(id); },
    } as unknown as Session;
  };
  return { createSession, segments, disposed, finalized };
}

test('native limits split a capture frame without dropping or replaying samples and flush the final tail once', async () => {
  const native = nativeFixture(0.125); // A native cap smaller than one input frame: two samples.
  const recognition = createBufferedRecognition(native.createSession);
  await recognition.feed(new Float32Array([1, 2, 3, 4, 5]));
  assert.equal(await recognition.finish(), 'Segment 1. Segment 2. Segment 3.');
  assert.deepEqual(native.segments, [[1, 2], [3, 4], [5]]);
  assert.deepEqual(native.finalized, [0, 1, 2]);
  assert.deepEqual(native.disposed, [0, 1, 2]);
  assert.equal(await recognition.finish(), 'Segment 1. Segment 2. Segment 3.');
  assert.deepEqual(native.finalized, [0, 1, 2], 'a repeated finish cannot flush the same tail twice');
});

test('an unlimited native stream still rolls over at the application memory bound', async () => {
  const native = nativeFixture(0);
  const recognition = createBufferedRecognition(native.createSession);
  // Multiple small frames avoid fixture argument-vector limits.
  for (let offset = 0; offset < SPEECH_SEGMENT_MAX_SAMPLES + 3; offset += 16000) {
    await recognition.feed(new Float32Array(Math.min(16000, SPEECH_SEGMENT_MAX_SAMPLES + 3 - offset)));
  }
  await recognition.finish();
  assert.deepEqual(native.segments.map((segment) => segment.length), [SPEECH_SEGMENT_MAX_SAMPLES, 3]);
});

test('failed finalization cannot return an incomplete transcription as completed text', async () => {
  const native = nativeFixture(1000, true);
  const recognition = createBufferedRecognition(native.createSession);
  await recognition.feed(new Float32Array([1, 2, 3]));
  await assert.rejects(recognition.finish(), /native finalization failed/);
  assert.deepEqual(native.finalized, []);
  recognition.dispose();
  assert.deepEqual(native.disposed, [0]);
});


test('timestamp ownership retains complete BPE words and intentional repetitions across overlap', async () => {
  const token = (text: string, t0Ms: number) => ({ text, t0Ms, t1Ms: t0Ms + 80 }) as Token;
  const tokens = [token(' go', 1000), token('ing', 1040), token(' go', 2000), token(' go', 3000)];
  const before = createBufferedRecognition(nativeFixture(5000, false, tokens).createSession);
  const after = createBufferedRecognition(nativeFixture(5000, false, tokens).createSession);
  await before.feed(new Float32Array(64000));
  await after.feed(new Float32Array(64000));
  assert.equal(await before.finish({ endSample: 40000 }), 'going go');
  assert.equal(await after.finish({ startSample: 40000 }), 'go');
});
