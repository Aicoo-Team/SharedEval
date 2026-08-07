/**
 * Runs `worker` over `items` with at most `limit` concurrent executions and
 * returns the results in input order.
 *
 * The Harbor backend prepares one Docker image tag and one materialized task
 * directory per selected task. Once the six-task allowlist is removed a run may
 * span the full PACT-Pair dataset (600 tasks), so an unbounded
 * `Promise.all(tasks.map(...))` would spawn hundreds of concurrent
 * subprocesses / filesystem operations at once. This keeps that fan-out
 * bounded without changing the per-task work or its ordering. If one worker
 * fails, no new items are claimed; already-running work is drained before the
 * first error is rethrown so caller cleanup cannot race background workers.
 */
export async function mapWithConcurrencyV1<Item, Result>(
  items: readonly Item[],
  limit: number,
  worker: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('mapWithConcurrencyV1 limit must be a positive integer');
  }
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  const runWorker = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index] as Item, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  if (failed) throw firstError;
  return results;
}
