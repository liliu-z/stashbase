/** Runs operations one at a time, in the order they were enqueued. Each starts
 *  only after the previous one settles, whether it resolved or rejected, and
 *  its own result or rejection reaches only its caller. */
export function createSerialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return function enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
