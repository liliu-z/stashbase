/** Immutable model data, independent of the desktop version. Never resolve main
 * or accept a renderer-supplied download URL/checksum at runtime. */
export const SPEECH_MODEL = {
  name: 'Parakeet Unified EN 0.6B Q8_0',
  revision: '843b1b175ace04f5a89d379c79e2518c0d065b25',
  sizeBytes: 731357568,
  sha256: '4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795',
  url: 'https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/843b1b175ace04f5a89d379c79e2518c0d065b25/parakeet-unified-en-0.6b-Q8_0.gguf',
} as const;

export const SPEECH_TRANSCRIBE_OPTIONS = { language: 'en', timestamps: 'none' } as const;
export const SPEECH_STREAM_OPTIONS = {
  ...SPEECH_TRANSCRIBE_OPTIONS, timestamps: 'token', commitPolicy: 'stable_prefix',
  family: { kind: 'parakeet_buffered', leftMs: 5600, chunkMs: 1040, rightMs: 1040 },
} as const;
export const SPEECH_SEGMENT_MAX_SAMPLES = 40 * 16000;
export const SPEECH_LEFT_CONTEXT_SAMPLES = 6 * 16000;
export const SPEECH_RIGHT_CONTEXT_SAMPLES = 2 * 16000;

export function speechPlatformSupported(platform = process.platform, arch = process.arch): boolean {
  return (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
    || ((platform === 'linux' || platform === 'win32') && arch === 'x64');
}
