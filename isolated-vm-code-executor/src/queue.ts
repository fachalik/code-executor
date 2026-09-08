import { config } from "./config";

/**
 * Admission control for the sandbox.
 *
 * Each isolate evaluates on its own thread, so a slow script does not stall the
 * event loop the way the WASM sandbox does. What it does consume is a thread and
 * up to `maxMemoryBytes` of heap for its whole deadline, so unbounded admission
 * would let a burst of requests walk the container into the OOM killer. Runs are
 * bounded and the overflow queues.
 *
 * Two ways to be turned away, both 429:
 *  - the queue is already `maxQueueDepth` deep, or
 *  - the wait for a slot passed `queueTimeoutMs`.
 * The second matters more than it looks: with `maxConcurrent` slots each held
 * for up to `maxTimeoutMs`, a request at the back of a deep queue would
 * otherwise sit for minutes and answer long after the caller gave up.
 */

export class QueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueFullError";
  }
}

interface Waiter {
  grant: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let active = 0;
const waiting: Waiter[] = [];

/**
 * Hands the slot straight to the next waiter instead of decrementing first.
 * Releasing the count would let a request arriving in the gap jump the queue
 * and push concurrency past the ceiling.
 */
const release = (): void => {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.grant();
    return;
  }
  active -= 1;
};

const waitForSlot = (): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      grant: resolve,
      reject,
      timer: setTimeout(() => {
        const index = waiting.indexOf(waiter);
        if (index !== -1) waiting.splice(index, 1);
        reject(
          new QueueFullError(
            `Timed out after ${config.queueTimeoutMs} ms waiting for an execution slot`
          )
        );
      }, config.queueTimeoutMs),
    };
    waiting.push(waiter);
  });

export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= config.maxConcurrent) {
    if (waiting.length >= config.maxQueueDepth) {
      throw new QueueFullError("Executor is saturated; retry shortly");
    }
    // Resolving means the slot was handed over directly — `active` already
    // accounts for it, so it must not be incremented again here.
    await waitForSlot();
  } else {
    active += 1;
  }

  try {
    return await fn();
  } finally {
    release();
  }
}

export const queueStats = () => ({ active, queued: waiting.length });
