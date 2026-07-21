import {
  resolveAudioMediaToolchain,
  runTranscriptionTool,
  type AudioMediaToolchain,
} from './transcription-tools.ts';

const AUDIO_PROBE_TIMEOUT_MS = 60_000;
const AUDIO_DECODE_TIMEOUT_MS = 5 * 60_000;
const AUDIO_PREVIEW_TIMEOUT_MS = 30 * 60_000;

export interface AudioSourceProbe {
  durationMs: number;
}

export interface AudioMediaTools {
  probe(sourceAbs: string, signal?: AbortSignal): Promise<AudioSourceProbe>;
  decodeChunk(input: {
    sourceAbs: string;
    wavPath: string;
    startMs: number;
    durationMs: number;
    signal?: AbortSignal;
  }): Promise<void>;
  createPreview(
    sourceAbs: string,
    previewAbs: string,
    signal?: AbortSignal,
    onProgress?: (completedMs: number) => void,
  ): Promise<void>;
}

/** Local FFmpeg adapter for the provider-neutral transcription and preview pipelines. */
export class FfmpegAudioMediaTools implements AudioMediaTools {
  constructor(private readonly toolchain: () => AudioMediaToolchain = resolveAudioMediaToolchain) {}

  async probe(sourceAbs: string, signal?: AbortSignal): Promise<AudioSourceProbe> {
    const { stdout } = await runTranscriptionTool(this.toolchain().ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      sourceAbs,
    ], { signal, timeoutMs: AUDIO_PROBE_TIMEOUT_MS });
    const parsed = JSON.parse(stdout) as { format?: { duration?: string | number } };
    return { durationMs: Math.round(Number(parsed.format?.duration) * 1000) };
  }

  async decodeChunk(input: {
    sourceAbs: string;
    wavPath: string;
    startMs: number;
    durationMs: number;
    signal?: AbortSignal;
  }): Promise<void> {
    await runTranscriptionTool(this.toolchain().ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', secondsArg(input.startMs),
      '-i', input.sourceAbs,
      '-t', secondsArg(input.durationMs),
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      '-y', input.wavPath,
    ], { signal: input.signal, timeoutMs: AUDIO_DECODE_TIMEOUT_MS });
  }

  async createPreview(
    sourceAbs: string,
    previewAbs: string,
    signal?: AbortSignal,
    onProgress?: (completedMs: number) => void,
  ): Promise<void> {
    await runTranscriptionTool(this.toolchain().ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', sourceAbs, '-vn', '-c:a', 'libopus', '-b:a', '96k',
      '-progress', 'pipe:1', '-nostats',
      '-y', previewAbs,
    ], {
      signal,
      timeoutMs: AUDIO_PREVIEW_TIMEOUT_MS,
      onStdoutLine: (line) => {
        const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
        if (match) onProgress?.(Number(match[1]) / 1000);
      },
    });
  }
}

function secondsArg(ms: number): string {
  return (ms / 1000).toFixed(3);
}
