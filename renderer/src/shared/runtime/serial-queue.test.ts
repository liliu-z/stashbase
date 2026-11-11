import { describe, expect, it } from 'vite-plus/test';

import { createSerialQueue } from './serial-queue';

describe('createSerialQueue', () => {
  it('starts each operation after the previous one settles, even when it rejected', async () => {
    const enqueue = createSerialQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = enqueue(
      () =>
        new Promise<void>((resolve) => {
          order.push('first started');
          releaseFirst = resolve;
        }),
    );
    const failed = enqueue(async () => {
      order.push('second started');
      throw new Error('second failed');
    });
    const third = enqueue(async () => {
      order.push('third started');
      return 3;
    });

    await Promise.resolve();
    expect(order).toEqual(['first started']);
    releaseFirst();
    await first;
    await expect(failed).rejects.toThrow('second failed');
    await expect(third).resolves.toBe(3);
    expect(order).toEqual(['first started', 'second started', 'third started']);
  });
});
