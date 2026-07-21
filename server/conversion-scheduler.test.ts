import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConversionScheduler,
  type ConversionJob,
  type ConversionLane,
  type ConversionRunContext,
  type ConversionUrgency,
} from './conversion-scheduler.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function job(
  key: string,
  lane: ConversionLane,
  urgency: ConversionUrgency,
  run: (signal: AbortSignal) => Promise<void>,
  cost = 10,
): ConversionJob {
  return { key, lane, urgency, cost, run: ({ signal }) => run(signal) };
}

function controlledJob(
  key: string,
  lane: ConversionLane,
  urgency: ConversionUrgency,
  run: (context: ConversionRunContext) => Promise<void>,
  cost = 10,
): ConversionJob {
  return { key, lane, urgency, cost, run };
}

test('light DOCX work starts while the heavy OCR lane is occupied', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { light: 2, heavy: 1 } });
  const heavyGate = deferred();
  const started: string[] = [];
  scheduler.schedule(job('/ocr.png', 'heavy', 'background', async () => {
    started.push('ocr');
    await heavyGate.promise;
  }));
  await tick();

  const docxDone = scheduler.schedule(job('/report.docx', 'light', 'interactive', async () => {
    started.push('docx');
  })).completion;
  await docxDone;

  assert.deepEqual(started, ['ocr', 'docx']);
  heavyGate.resolve();
  await tick();
});

test('interactive heavy work does not preempt a running job but runs next', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { heavy: 1 } });
  const firstGate = deferred();
  const order: string[] = [];
  scheduler.schedule(job('/first.png', 'heavy', 'background', async () => {
    order.push('first');
    await firstGate.promise;
  }));
  await tick();
  scheduler.schedule(job('/background.png', 'heavy', 'background', async () => {
    order.push('background');
  }));
  const interactive = scheduler.schedule(job('/opened.pdf', 'heavy', 'interactive', async () => {
    order.push('interactive');
  })).completion;
  assert.deepEqual(order, ['first']);
  firstGate.resolve();
  await interactive;
  assert.deepEqual(order, ['first', 'interactive']);
});

test('a cooperative yield lets higher-priority heavy work run before the task resumes', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { heavy: 1 } });
  const mayYield = deferred();
  const order: string[] = [];
  const audio = scheduler.schedule(controlledJob('/recording.wav', 'heavy', 'background', async ({ yieldLane }) => {
    order.push('audio-1');
    await mayYield.promise;
    await yieldLane();
    order.push('audio-2');
  }));
  await tick();

  const pdf = scheduler.schedule(job('/opened.pdf', 'heavy', 'interactive', async () => {
    order.push('pdf');
  }));
  mayYield.resolve();
  await Promise.all([audio.completion, pdf.completion]);

  assert.deepEqual(order, ['audio-1', 'pdf', 'audio-2']);
});

test('snapshot exposes yielded work without treating it as a running conversion', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { heavy: 1 } });
  const mayYield = deferred();
  const blocker = deferred();
  const audio = scheduler.schedule(controlledJob('/recording.wav', 'heavy', 'background', async ({ yieldLane }) => {
    await mayYield.promise;
    await yieldLane();
  }));
  await tick();
  const pdf = scheduler.schedule(job('/opened.pdf', 'heavy', 'interactive', () => blocker.promise));

  mayYield.resolve();
  await tick();
  const yielded = scheduler.get('/recording.wav');
  assert.equal(yielded?.state, 'yielded');
  assert.equal(yielded?.tasksAhead, 1);
  assert.equal(scheduler.hasRunningUnder('/recording.wav'), false);
  assert.equal(scheduler.hasRunningUnder('/opened.pdf'), true);

  blocker.resolve();
  await Promise.all([audio.completion, pdf.completion]);
});

test('cancelling yielded work wakes and retires the suspended run', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { heavy: 1 } });
  const mayYield = deferred();
  const blocker = deferred();
  let abortReason: unknown;
  const audio = scheduler.schedule(controlledJob('/folder/recording.wav', 'heavy', 'background', async ({ signal, yieldLane }) => {
    await mayYield.promise;
    try {
      await yieldLane();
    } finally {
      abortReason = signal.reason;
    }
  }));
  await tick();
  const pdf = scheduler.schedule(job('/opened.pdf', 'heavy', 'interactive', () => blocker.promise));
  mayYield.resolve();
  await tick();
  assert.equal(scheduler.get('/folder/recording.wav')?.state, 'yielded');

  const cancelled = scheduler.cancel('/folder/recording.wav', 'folder-removed');
  assert.ok(cancelled);
  await cancelled;
  assert.equal(abortReason, 'folder-removed');
  assert.equal(scheduler.has('/folder/recording.wav'), false);
  assert.equal(scheduler.has('/opened.pdf'), true);

  blocker.resolve();
  await pdf.completion;
  await assert.rejects(audio.completion);
});

test('duplicate scheduling coalesces and promotes the existing task', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { heavy: 1 } });
  const gate = deferred();
  scheduler.schedule(job('/blocker.png', 'heavy', 'background', () => gate.promise));
  const first = scheduler.schedule(job('/same.pdf', 'heavy', 'background', async () => undefined));
  const duplicate = scheduler.schedule(job('/same.pdf', 'heavy', 'interactive', async () => {
    throw new Error('duplicate run callback must not replace the original');
  }));

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(first.completion, duplicate.completion);
  assert.equal(
    scheduler.snapshot().tasks.find((task) => task.key === '/same.pdf')?.urgency,
    'interactive',
  );

  gate.resolve();
  await first.completion;
});

test('duplicate scheduling does not rewrite a running task priority', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { heavy: 1 } });
  const gate = deferred();
  const first = scheduler.schedule(job('/running.pdf', 'heavy', 'background', () => gate.promise, 10));
  await tick();

  const duplicate = scheduler.schedule(job('/running.pdf', 'heavy', 'interactive', async () => undefined, 0));
  const running = scheduler.snapshot().tasks.find((task) => task.key === '/running.pdf');
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.completion, first.completion);
  assert.equal(running?.state, 'running');
  assert.equal(running?.urgency, 'background');
  assert.equal(running?.cost, 10);

  gate.resolve();
  await first.completion;
});

test('settled callback can replace a retired task without an identity gap', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { light: 1 } });
  const order: string[] = [];
  let replacement: Promise<void> | undefined;
  const first = scheduler.schedule({
    ...job('/reopen.docx', 'light', 'background', async () => { order.push('first'); }),
    onSettled: () => {
      assert.equal(scheduler.has('/reopen.docx'), false);
      replacement = scheduler.schedule(job(
        '/reopen.docx',
        'light',
        'background',
        async () => { order.push('replacement'); },
      )).completion;
    },
  });

  await first.completion;
  assert.ok(replacement);
  await replacement;
  assert.deepEqual(order, ['first', 'replacement']);
});

test('active folders, bounded ageing, and cost order queued work', async () => {
  let now = 0;
  const active = new Set<string>();
  const scheduler = new ConversionScheduler({
    laneCapacity: { heavy: 1 },
    ageingMs: 60_000,
    now: () => now,
    isActive: (key) => active.has(key),
  });
  const gate = deferred();
  const order: string[] = [];
  scheduler.schedule(job('/blocker', 'heavy', 'background', () => gate.promise));
  scheduler.schedule(job('/old-expensive', 'heavy', 'background', async () => { order.push('old'); }, 10));
  now = 61_000;
  scheduler.schedule(job('/new-cheap', 'heavy', 'background', async () => { order.push('new'); }, 0));
  scheduler.schedule(job('/active-expensive', 'heavy', 'background', async () => { order.push('active'); }, 10));
  active.add('/active-expensive');
  scheduler.prioritiesChanged();
  await tick();

  gate.resolve();
  await tick();
  await tick();

  assert.deepEqual(order, ['old', 'active', 'new']);
});

test('crossing the ageing boundary bumps observable queue versions', async () => {
  let now = 0;
  const scheduler = new ConversionScheduler({
    laneCapacity: { heavy: 1 },
    ageingMs: 60_000,
    now: () => now,
  });
  const gate = deferred();
  scheduler.schedule(job('/blocker', 'heavy', 'interactive', () => gate.promise));
  scheduler.schedule(job('/ageing.pdf', 'heavy', 'background', async () => undefined));
  await tick();

  const before = scheduler.snapshot();
  const versionBefore = before.versions['/ageing.pdf'] ?? 0;
  now = 60_001;
  const after = scheduler.snapshot();

  assert.equal(after.tasks.find((task) => task.key === '/ageing.pdf')?.urgency, 'active-folder');
  assert.ok(after.revision > before.revision);
  assert.ok((after.versions['/ageing.pdf'] ?? 0) > versionBefore);
  gate.resolve();
  await tick();
});

test('bounded cost classifiers reorder queued work without consuming a lane slot', async () => {
  const scheduler = new ConversionScheduler({
    laneCapacity: { heavy: 1 },
    classifierCapacity: 2,
  });
  const blocker = deferred();
  const order: string[] = [];
  scheduler.schedule(job('/blocker', 'heavy', 'interactive', () => blocker.promise));
  await tick();

  const expensive = scheduler.schedule({
    ...job('/scanned.pdf', 'heavy', 'background', async () => { order.push('scanned'); }),
    classifyCost: async () => 10,
  });
  const cheap = scheduler.schedule({
    ...job('/text.pdf', 'heavy', 'background', async () => { order.push('text'); }),
    classifyCost: async () => 0,
  });
  await tick();
  blocker.resolve();
  await Promise.all([expensive.completion, cheap.completion]);

  assert.deepEqual(order, ['text', 'scanned']);
});

test('classifier capacity is bounded and folder cancellation waits for owned classifiers', async () => {
  const scheduler = new ConversionScheduler({
    laneCapacity: { heavy: 1 },
    classifierCapacity: 1,
  });
  const blocker = deferred();
  scheduler.schedule(job('/blocker', 'heavy', 'interactive', () => blocker.promise));
  await tick();

  const gates = [deferred(), deferred()];
  let active = 0;
  let maxActive = 0;
  const started: string[] = [];
  const aborted: string[] = [];
  const classifiedJob = (key: string, index: number): ConversionJob => ({
    ...job(key, 'heavy', 'background', async () => undefined),
    classifyCost: async (signal) => {
      started.push(key);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.race([
        gates[index].promise,
        new Promise<void>((resolve) => signal.addEventListener('abort', () => {
          aborted.push(key);
          resolve();
        }, { once: true })),
      ]);
      active -= 1;
      return 0;
    },
  });
  scheduler.schedule(classifiedJob('/folder/a.pdf', 0));
  scheduler.schedule(classifiedJob('/folder/b.pdf', 1));
  await tick();
  assert.deepEqual(started, ['/folder/a.pdf']);

  gates[0].resolve();
  await tick();
  await tick();
  assert.deepEqual(started, ['/folder/a.pdf', '/folder/b.pdf']);
  assert.equal(maxActive, 1);

  const cancelled = scheduler.cancelUnder('/folder', 'folder-removed');
  await Promise.all(cancelled.map((item) => item.completion));
  assert.deepEqual(aborted, ['/folder/b.pdf']);
  assert.equal(active, 0);
  blocker.resolve();
  await tick();
});

test('snapshot reports same-lane queue position and per-file versions', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { light: 1 } });
  const gate = deferred();
  scheduler.schedule(job('/running.docx', 'light', 'background', () => gate.promise));
  scheduler.schedule(job('/next.docx', 'light', 'background', async () => undefined));
  await tick();

  const before = scheduler.snapshot();
  const queued = before.tasks.find((task) => task.key === '/next.docx');
  assert.equal(queued?.state, 'queued');
  assert.equal(queued?.tasksAhead, 1);
  assert.ok(before.revision > 0);
  assert.ok((before.versions['/next.docx'] ?? 0) > 0);

  const version = before.versions['/next.docx'];
  gate.resolve();
  await tick();
  assert.ok((scheduler.snapshot().versions['/next.docx'] ?? 0) > version);
});

test('cancelUnder removes queued work and aborts running work', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { heavy: 1 } });
  let aborted = false;
  let abortReason: unknown;
  scheduler.schedule(job('/folder/running.png', 'heavy', 'background', (signal) => new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      abortReason = signal.reason;
      resolve();
    }, { once: true });
  })));
  scheduler.schedule(job('/folder/queued.png', 'heavy', 'background', async () => undefined));
  scheduler.schedule(job('/other/kept.png', 'heavy', 'background', async () => undefined));
  await tick();

  assert.equal(scheduler.hasRunningUnder('/folder'), true);
  assert.equal(scheduler.hasRunningUnder('/other'), false);

  const cancelled = scheduler.cancelUnder('/folder', 'folder-removed');
  await Promise.all(cancelled.map((item) => item.completion));
  assert.equal(aborted, true);
  assert.equal(abortReason, 'folder-removed');
  assert.equal(scheduler.has('/folder/running.png'), false);
  assert.equal(scheduler.has('/folder/queued.png'), false);
  assert.equal(scheduler.has('/other/kept.png'), true);
});

test('filesystem root cancellation includes every absolute task', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { light: 1 } });
  const gate = deferred();
  scheduler.schedule(job('/running.docx', 'light', 'background', (signal) => new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  })));
  scheduler.schedule(job('/nested/queued.docx', 'light', 'background', () => gate.promise));
  await tick();

  assert.equal(scheduler.hasUnder('/'), true);
  const cancelled = scheduler.cancelUnder('/', 'folder-removed');
  await Promise.all(cancelled.map((item) => item.completion));
  assert.equal(cancelled.length, 2);
  assert.equal(scheduler.hasUnder('/'), false);
  gate.resolve();
});

test('Windows drive and UNC roots match descendants without matching sibling names', async () => {
  const scheduler = new ConversionScheduler({
    laneCapacity: { light: 4 },
    pathPlatform: 'win32',
  });
  const waitForAbort = (signal: AbortSignal) => new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  scheduler.schedule(job('C:/Folder/a.docx', 'light', 'background', waitForAbort));
  scheduler.schedule(job('C:/folderish/b.docx', 'light', 'background', waitForAbort));
  scheduler.schedule(job('//Server/Share/c.docx', 'light', 'background', waitForAbort));
  scheduler.schedule(job('//Server/Shared/d.docx', 'light', 'background', waitForAbort));
  const duplicate = scheduler.schedule(job('c:/folder/A.docx', 'light', 'interactive', async () => {
    throw new Error('case-variant duplicate must not run twice');
  }));
  await tick();

  assert.equal(duplicate.created, false);
  assert.equal(scheduler.hasUnder('c:/folder/'), true);
  assert.equal(scheduler.get('c:/FOLDER/a.docx')?.key, 'C:/Folder/a.docx');
  const driveFolder = scheduler.cancelUnder('c:/folder/', 'folder-removed');
  await Promise.all(driveFolder.map((item) => item.completion));
  assert.deepEqual(driveFolder.map((item) => item.key), ['C:/Folder/a.docx']);
  assert.equal(Object.hasOwn(scheduler.snapshot().versions, 'c:/folder/a.docx'), false);
  assert.equal(scheduler.has('C:/folderish/b.docx'), true);

  const driveRoot = scheduler.cancelUnder('C:/', 'folder-removed');
  await Promise.all(driveRoot.map((item) => item.completion));
  assert.deepEqual(driveRoot.map((item) => item.key), ['C:/folderish/b.docx']);

  const uncShare = scheduler.cancelUnder('//server/share/', 'folder-removed');
  await Promise.all(uncShare.map((item) => item.completion));
  assert.deepEqual(uncShare.map((item) => item.key), ['//Server/Share/c.docx']);
  assert.equal(scheduler.has('//server/shared/d.docx'), true);

  const remaining = scheduler.cancelAll('shutdown');
  await Promise.all(remaining.map((item) => item.completion));
  assert.deepEqual(remaining.map((item) => item.key), ['//Server/Shared/d.docx']);
});

test('hidden auxiliary work shares lane capacity and cancels by source scope', async () => {
  const scheduler = new ConversionScheduler({ laneCapacity: { heavy: 1 } });
  const auxiliary = scheduler.schedule({
    key: '/derived/voice.preview.webm',
    scope: '/folder/voice.aiff',
    visible: false,
    lane: 'heavy',
    urgency: 'interactive',
    cost: 1,
    run: ({ signal }) => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
  });
  const visible = scheduler.schedule(job('/folder/meeting.wav', 'heavy', 'interactive', async () => undefined));
  await tick();

  assert.equal(scheduler.get('/derived/voice.preview.webm')?.state, 'running');
  assert.deepEqual(scheduler.snapshot().tasks.map((task) => ({ key: task.key, tasksAhead: task.tasksAhead })), [
    { key: '/folder/meeting.wav', tasksAhead: 1 },
  ]);
  assert.equal(scheduler.hasRunningUnder('/folder'), true);
  const cancelled = scheduler.cancelScope('/folder/voice.aiff', 'source-change');
  await Promise.all(cancelled.map((item) => item.completion));
  await Promise.all([auxiliary.completion, visible.completion]);
  assert.deepEqual(cancelled.map((item) => item.key), ['/derived/voice.preview.webm']);
});
