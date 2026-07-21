/** Native executable resolution and cancellable process ownership for audio. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lowerExtractorPriority, spawnOptionsForExtractor, terminateExtractorTree } from './extractor-process.ts';
import { TransientConversionError } from './conversion.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.STASHBASE_APP_ROOT
  ? path.resolve(process.env.STASHBASE_APP_ROOT)
  : path.resolve(__dirname, '..');
const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : APP_ROOT;
const DEFAULT_TOOL_TIMEOUT_MS = 30 * 60_000;

export type TranscriptionTool = 'whisper' | 'ffmpeg' | 'ffprobe';

export interface TranscriptionToolchain {
  whisper: string;
  ffmpeg: string;
  ffprobe: string;
}

export type AudioMediaToolchain = Pick<TranscriptionToolchain, 'ffmpeg' | 'ffprobe'>;
export type WhisperToolchain = Pick<TranscriptionToolchain, 'whisper'>;

const ENV_KEYS: Record<TranscriptionTool, string> = {
  whisper: 'STASHBASE_WHISPER_BIN',
  ffmpeg: 'STASHBASE_FFMPEG_BIN',
  ffprobe: 'STASHBASE_FFPROBE_BIN',
};

export function resolveTranscriptionToolchain(): TranscriptionToolchain {
  return {
    ...resolveWhisperToolchain(),
    ...resolveAudioMediaToolchain(),
  };
}

export function resolveAudioMediaToolchain(): AudioMediaToolchain {
  return {
    ffmpeg: resolveTranscriptionTool('ffmpeg'),
    ffprobe: resolveTranscriptionTool('ffprobe'),
  };
}

export function resolveWhisperToolchain(): WhisperToolchain {
  return { whisper: resolveTranscriptionTool('whisper') };
}

export function transcriptionToolchainError(): string | null {
  try {
    resolveTranscriptionToolchain();
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

function resolveTranscriptionTool(tool: TranscriptionTool): string {
  const override = process.env[ENV_KEYS[tool]]?.trim();
  if (override) {
    if (!isFile(override)) throw new Error(`${ENV_KEYS[tool]} does not point to a file`);
    return path.resolve(override);
  }

  const executable = process.platform === 'win32'
    ? `${tool === 'whisper' ? 'whisper-cli' : tool}.exe`
    : tool === 'whisper' ? 'whisper-cli' : tool;
  const target = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(RESOURCES_ROOT, 'transcription', target, executable),
    path.join(RESOURCES_ROOT, 'transcription', executable),
    path.join(APP_ROOT, 'native', 'transcription', 'sidecar.nosync', target, executable),
  ];
  const bundled = candidates.find(isFile);
  if (bundled) return bundled;

  // Developer builds may use tools already on PATH. Packaged builds must be
  // self-contained and never silently depend on Homebrew/system installs.
  if (RESOURCES_ROOT === APP_ROOT) {
    const fromPath = executableOnPath(executable);
    if (fromPath) return fromPath;
    throw new Error(`${executable} is missing; run pnpm build:transcription-sidecar`);
  }
  throw new Error(`bundled ${executable} is missing for ${target}`);
}

export function runTranscriptionTool(
  command: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    stderrLimit?: number;
    timeoutMs?: number;
    onStdoutLine?: (line: string) => void;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new TransientConversionError('audio transcription cancelled'));
      return;
    }
    const proc = spawn(command, args, {
      ...spawnOptionsForExtractor(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    lowerExtractorPriority(proc);
    const limit = options.stderrLimit ?? 64 * 1024;
    let stdout = '';
    let stdoutLineBuffer = '';
    let stderr = '';
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    const timeoutMs = positiveTimeout(options.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateExtractorTree(proc);
    }, timeoutMs);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cancelled = true;
      terminateExtractorTree(proc);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const emitStdoutLines = (chunk: string, flush = false) => {
      if (!options.onStdoutLine) return;
      stdoutLineBuffer += chunk;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      const tail = lines.pop() ?? '';
      stdoutLineBuffer = flush ? '' : tail;
      for (const line of lines) options.onStdoutLine(line);
      if (flush && tail) options.onStdoutLine(tail);
    };
    proc.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout = (stdout + text).slice(-limit);
      emitStdoutLines(text);
    });
    proc.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-limit); });
    proc.once('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      emitStdoutLines('', true);
      reject(new Error(`could not start ${path.basename(command)}: ${err.message}`));
    });
    // `exit` may precede closure of inherited stdout/stderr handles. Resolve
    // only after `close`, otherwise ffprobe JSON or progress tails can be
    // truncated even though the process returned zero.
    proc.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      emitStdoutLines('', true);
      if (cancelled) {
        reject(new TransientConversionError('audio transcription cancelled'));
      } else if (timedOut) {
        reject(new Error(`${path.basename(command)} timed out after ${Math.ceil(timeoutMs / 1000)}s`));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const tail = stderr.trim().split(/\r?\n/).slice(-4).join('\n');
        reject(new Error(`${path.basename(command)} exited ${code}: ${tail || '(no stderr)'}`));
      }
    });
  });
}

export function transcriptionThreadCount(): number {
  return Math.max(1, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1));
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function isFile(candidate: string): boolean {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

function executableOnPath(executable: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, process.platform === 'win32' && !path.extname(executable)
        ? `${executable}${extension.toLowerCase()}`
        : executable);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}
