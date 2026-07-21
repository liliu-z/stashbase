import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupStaleTranscriptionModelDownloads,
  configureTranscriptionModelLifecycle,
  isTranscriptionModelInstalled,
  localTranscriptionModelAvailability,
  listTranscriptionModels,
  removeTranscriptionModel,
  startTranscriptionModelDownload,
  transcriptionModelPath,
} from './transcription-models.ts';

test('model download rejects a mismatched declared size before writing', async () => {
  await withModelData(async () => {
    startTranscriptionModelDownload('tiny', {
      fetchImpl: async () => new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-length': '1' },
      }),
    });
    const failure = await waitForFailure('tiny');
    assert.match(failure, /content length mismatch/);
    assert.equal(fs.existsSync(`${transcriptionModelPath('tiny')}.part`), false);
  });
});

test('model download fails after a bounded connection wait', async () => {
  await withModelData(async () => {
    startTranscriptionModelDownload('tiny', {
      connectTimeoutMs: 10,
      fetchImpl: (() => new Promise<Response>(() => undefined)) as typeof fetch,
    });
    const failure = await waitForFailure('tiny');
    assert.match(failure, /connection timed out/);
    assert.equal(fs.existsSync(`${transcriptionModelPath('tiny')}.part`), false);
  });
});

test('model download fails and removes its partial file after read inactivity', async () => {
  await withModelData(async () => {
    startTranscriptionModelDownload('tiny', {
      readTimeoutMs: 10,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      }), { status: 200 }),
    });
    const failure = await waitForFailure('tiny');
    assert.match(failure, /stalled while receiving data/);
    assert.equal(fs.existsSync(`${transcriptionModelPath('tiny')}.part`), false);
  });
});

test('removing a downloading model aborts the request and returns to idle', async () => {
  await withModelData(async () => {
    startTranscriptionModelDownload('tiny', {
      connectTimeoutMs: 1_000,
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason);
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch,
    });
    await removeTranscriptionModel('tiny');
    const model = listTranscriptionModels().find((candidate) => candidate.id === 'tiny');
    assert.deepEqual(model?.download, { status: 'idle' });
    assert.equal(fs.existsSync(`${transcriptionModelPath('tiny')}.part`), false);
  });
});

test('a detached checksum marker cannot bless corrupted same-size model bytes', async () => {
  await withModelData(async () => {
    const modelPath = transcriptionModelPath('tiny');
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.closeSync(fs.openSync(modelPath, 'w'));
    fs.truncateSync(modelPath, 77_691_713);
    const marker = `${modelPath}.sha256`;
    fs.writeFileSync(marker, 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21\n');

    assert.equal(isTranscriptionModelInstalled('tiny'), false);
    assert.deepEqual(localTranscriptionModelAvailability('tiny'), { status: 'verifying' });
    assert.equal(listTranscriptionModels().find((model) => model.id === 'tiny')?.download.status, 'verifying');
    let downloadStarted = false;
    assert.deepEqual(startTranscriptionModelDownload('tiny', {
      fetchImpl: async () => {
        downloadStarted = true;
        return new Response();
      },
    }), { status: 'verifying' });
    assert.equal(downloadStarted, false);
    const verificationFailure = await waitForFailure('tiny');
    assert.match(verificationFailure, /checksum mismatch/);
    assert.deepEqual(localTranscriptionModelAvailability('tiny'), {
      status: 'unavailable',
      error: verificationFailure,
    });
    assert.equal(fs.existsSync(marker), false);
  });
});

test('startup cleanup removes model download residue from a hard crash', async () => {
  await withModelData(async () => {
    const part = `${transcriptionModelPath('small')}.part`;
    fs.mkdirSync(path.dirname(part), { recursive: true });
    fs.writeFileSync(part, 'partial model bytes');
    assert.deepEqual(cleanupStaleTranscriptionModelDownloads(), ['small']);
    assert.equal(fs.existsSync(part), false);
  });
});

test('model removal makes weights unavailable before waiting for active jobs', async () => {
  await withModelData(async () => {
    const modelPath = transcriptionModelPath('tiny');
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, 'model being removed');

    let release!: () => void;
    const activeJobsStopped = new Promise<void>((resolve) => { release = resolve; });
    configureTranscriptionModelLifecycle({ release: () => activeJobsStopped });
    const removal = removeTranscriptionModel('tiny');

    assert.equal(isTranscriptionModelInstalled('tiny'), false);
    assert.throws(() => startTranscriptionModelDownload('tiny'), /being removed/);
    release();
    await removal;
    assert.equal(fs.existsSync(modelPath), false);
  });
});

async function waitForFailure(id: 'tiny' | 'base' | 'small'): Promise<string> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const download = listTranscriptionModels().find((model) => model.id === id)?.download;
    if (download?.status === 'failed') return download.error;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`model ${id} did not fail before the test deadline`);
}

async function withModelData(run: () => Promise<void>): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-model-test-'));
  const previousRoot = process.env.STASHBASE_LOCAL_DATA_ROOT;
  process.env.STASHBASE_LOCAL_DATA_ROOT = temp;
  try {
    await run();
  } finally {
    await Promise.all(['tiny', 'base', 'small'].map((id) => removeTranscriptionModel(id as 'tiny' | 'base' | 'small')));
    configureTranscriptionModelLifecycle({});
    if (previousRoot === undefined) delete process.env.STASHBASE_LOCAL_DATA_ROOT;
    else process.env.STASHBASE_LOCAL_DATA_ROOT = previousRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
