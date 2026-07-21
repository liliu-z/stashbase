import type {
  AudioPreviewStatus,
  AudioTranscriptSegment,
  AudioTranscriptState,
} from './apiTypes.ts';
import { preparationWaitCopy } from './preparation-copy.ts';

export function audioPreviewProgressCopy(state: AudioPreviewStatus | null): string {
  if (state?.status === 'queued') {
    return preparationWaitCopy('audio-preview', state.tasksAhead);
  }
  if (state?.status === 'converting') {
    return state.totalMs > 0
      ? `Preparing a browser-compatible local preview · ${state.percent}%`
      : 'Preparing a browser-compatible local preview…';
  }
  return 'Preparing a browser-compatible local preview…';
}

export function audioTranscriptStatusCopy(state: AudioTranscriptState | null): string | null {
  if (!state) return 'Checking transcript…';
  if (state.status === 'ready') return null;
  if (state.status === 'blocked') {
    if (state.reason === 'runtime-unavailable') {
      return `Local transcription runtime unavailable: ${state.error}`;
    }
    if (state.reason === 'model-not-installed') {
      return `Download the ${state.modelId} local model to transcribe this file.`;
    }
    if (state.reason === 'model-verifying') {
      return `Verifying the ${state.modelId} model before transcription…`;
    }
    if (state.reason === 'model-unavailable') {
      return state.error
        ? `The ${state.modelId} model is unavailable: ${state.error}`
        : `The ${state.modelId} model is unavailable from ${state.providerId}.`;
    }
    return `The ${state.providerId} transcription provider is unavailable.`;
  }
  if (state.status === 'cancelled') return 'Transcription was cancelled. Reprocess when you are ready.';
  if (state.status === 'failed') return `Transcription failed: ${state.error}`;
  const progress = state.progress;
  if (progress?.phase === 'queued') {
    return preparationWaitCopy('transcript', progress.tasksAhead);
  }
  if (progress?.phase === 'yielded') {
    return preparationWaitCopy('transcript', progress.tasksAhead);
  }
  if (progress?.phase === 'indexing') return 'Indexing transcript…';
  if (progress?.phase === 'extracting' && progress.totalUnits) {
    return `Transcription progress · ${progress.completedUnits ?? 0} of ${progress.totalUnits} chunks complete`;
  }
  return 'Transcribing locally…';
}

/** Resolve a semantic-search chunk back to a timestamped transcript segment.
 * Derived Markdown timestamps are authoritative; normalized text matching is
 * the fallback for chunks that begin/end in the middle of a transcript line. */
export function findAudioSeekSegment(
  chunkText: string,
  segments: AudioTranscriptSegment[],
  explicitTimestampMs?: number,
): AudioTranscriptSegment | null {
  const timestampMs = typeof explicitTimestampMs === 'number' && Number.isFinite(explicitTimestampMs)
    ? Math.max(0, explicitTimestampMs)
    : firstTranscriptTimestamp(chunkText);
  if (timestampMs != null) {
    const exactStart = segments.find((segment) => timestampMs === segment.startMs);
    if (exactStart) return exactStart;
    const containing = segments.find((segment, index) => (
      timestampMs >= segment.startMs
      && (index === segments.length - 1
        ? timestampMs <= Math.max(segment.startMs, segment.endMs)
        : timestampMs < Math.max(segment.startMs, segment.endMs))
    ));
    if (containing) return containing;
    const nearest = [...segments].sort((left, right) => (
      Math.abs(left.startMs - timestampMs) - Math.abs(right.startMs - timestampMs)
    ))[0];
    if (nearest && Math.abs(nearest.startMs - timestampMs) <= 2_000) return nearest;
  }

  const normalizedChunk = normalizeSearchText(chunkText);
  if (!normalizedChunk) return null;
  const exact = [...segments]
    .sort((left, right) => right.text.length - left.text.length)
    .find((segment) => {
      const text = normalizeSearchText(segment.text);
      return text.length >= 3 && (normalizedChunk.includes(text) || text.includes(normalizedChunk));
    });
  if (exact) return exact;

  const chunkTokens = tokenSet(normalizedChunk);
  let best: { segment: AudioTranscriptSegment; score: number } | null = null;
  for (const segment of segments) {
    const segmentTokens = tokenSet(normalizeSearchText(segment.text));
    if (segmentTokens.size < 2) continue;
    let shared = 0;
    for (const token of segmentTokens) if (chunkTokens.has(token)) shared += 1;
    const score = shared / segmentTokens.size;
    if (score >= 0.6 && (!best || score > best.score)) best = { segment, score };
  }
  return best?.segment ?? null;
}

function firstTranscriptTimestamp(value: string): number | null {
  const match = value.match(/\[(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;
  const millis = Number((match[4] ?? '').padEnd(3, '0')) || 0;
  return ((hours * 60 * 60) + (minutes * 60) + seconds) * 1000 + millis;
}

function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[`*_#>[\](){}-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter((token) => token.length >= 2));
}
