/** A native buffered stream is finalized before reset, including its right
 * context. Native Parakeet retains its input, so every stream has a finite cap. */
import type { Session, Stream, Token } from 'transcribe-cpp';
import { SPEECH_STREAM_OPTIONS, SPEECH_SEGMENT_MAX_SAMPLES } from './model-manifest.ts';

export function createBufferedRecognition(createSession: () => Session) {
  let session: Session | undefined;
  let stream: Stream | undefined;
  let samples = 0;
  let limit = SPEECH_SEGMENT_MAX_SAMPLES;
  const completed: Array<{ offset: number; text: string; tokens: Token[] }> = [];
  let offset = 0;
  const dispose = () => {
    stream?.reset();
    stream = undefined;
    session?.dispose();
    session = undefined;
    samples = 0;
  };
  async function begin() {
    session = createSession();
    const milliseconds = session.limits.effectiveMaxAudioMs;
    limit = Number.isFinite(milliseconds) && milliseconds > 0
      ? Math.min(SPEECH_SEGMENT_MAX_SAMPLES, Math.floor(milliseconds * 16))
      : SPEECH_SEGMENT_MAX_SAMPLES;
    if (limit < 1) throw new Error('The speech runtime returned an invalid audio limit');
    stream = await session.stream(SPEECH_STREAM_OPTIONS);
  }
  async function finalize() {
    if (!stream) return;
    const result = await stream.finalize();
    if (!result.isFinal || stream.state !== 'finished') throw new Error('Recognition stopped before completion');
    const text = stream.text.full.trim();
    completed.push({ offset, text, tokens: stream.snapshot.tokens });
    offset += samples;
    dispose();
  }
  return {
    async feed(pcm: Float32Array) {
      for (let offset = 0; offset < pcm.length;) {
        if (!stream) await begin();
        const count = Math.min(limit - samples, pcm.length - offset);
        await stream!.feed(pcm.subarray(offset, offset + count));
        samples += count;
        offset += count;
        if (samples === limit) await finalize();
      }
    },
    async finish(range: { startSample?: number; endSample?: number } = {}) {
      await finalize();
      if (!range.startSample && range.endSample === undefined) return completed.map((part) => part.text).filter(Boolean).join(' ');
      return completed.map((part) => ownedWords(part.tokens, (range.startSample ?? 0) / 16 - part.offset / 16, (range.endSample ?? Infinity) / 16 - part.offset / 16, part.text)).filter(Boolean).join(' ');
    },
    dispose,
  };
}

/** Own whole words by their acoustic start time, never by matching strings:
 * repeated words are valid speech, and BPE pieces must not be split at a cut. */
function ownedWords(tokens: Token[], fromMs: number, untilMs: number, text: string): string {
  if (!tokens.length && text) throw new Error('Recognition returned no token timestamps');
  const words: Array<{ text: string; start: number }> = [];
  for (const token of tokens) {
    if (!Number.isFinite(token.t0Ms) || token.t0Ms < 0) throw new Error('Recognition returned invalid token timestamps');
    if (!words.length || /^\s/u.test(token.text)) words.push({ text: token.text, start: token.t0Ms });
    else words[words.length - 1]!.text += token.text;
  }
  return words.filter((word) => word.start >= fromMs && word.start < untilMs).map((word) => word.text).join('').trim();
}
