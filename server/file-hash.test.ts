import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { blake3File } from './file-hash.ts';

test('blake3File matches the byte hash without a whole-file read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-file-hash-'));
  try {
    const file = path.join(dir, 'recording.bin');
    const content = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
    fs.writeFileSync(file, content);
    assert.equal(await blake3File(file), bytesToHex(blake3(content)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
