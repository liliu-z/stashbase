import fs from 'node:fs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Hash a potentially large source without buffering it into the Node heap.
 * The async iterator yields between chunks so API and renderer requests keep
 * making progress while long audio files are indexed. */
export async function blake3File(absPath: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const hash = blake3.create();
  for await (const chunk of fs.createReadStream(absPath, { highWaterMark: 1024 * 1024 })) {
    throwIfAborted(signal);
    hash.update(chunk as Buffer);
  }
  throwIfAborted(signal);
  return bytesToHex(hash.digest());
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('file hash cancelled');
}
