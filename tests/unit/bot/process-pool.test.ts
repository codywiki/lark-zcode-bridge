import { describe, expect, it } from 'vitest';
import {
  ProcessPool,
  ProcessPoolAcquireAborted,
} from '../../../src/bot/process-pool.js';

describe('ProcessPool cancellation', () => {
  it('removes an aborted waiter without leaking capacity', async () => {
    const pool = new ProcessPool(() => 1);
    const releaseFirst = await pool.acquire();
    const controller = new AbortController();
    const waiting = pool.acquire(controller.signal);

    expect(pool.snapshot()).toEqual({ active: 1, waiting: 1, cap: 1 });
    controller.abort();

    await expect(waiting).rejects.toBeInstanceOf(ProcessPoolAcquireAborted);
    expect(pool.snapshot()).toEqual({ active: 1, waiting: 0, cap: 1 });

    releaseFirst();
    releaseFirst();
    expect(pool.snapshot()).toEqual({ active: 0, waiting: 0, cap: 1 });
  });

  it('skips a cancelled waiter and preserves FIFO for the next one', async () => {
    const pool = new ProcessPool(() => 1);
    const releaseFirst = await pool.acquire();
    const cancelled = new AbortController();
    const second = pool.acquire(cancelled.signal);
    const third = pool.acquire();

    cancelled.abort();
    await expect(second).rejects.toBeInstanceOf(ProcessPoolAcquireAborted);
    releaseFirst();

    const releaseThird = await third;
    expect(pool.snapshot()).toEqual({ active: 1, waiting: 0, cap: 1 });
    releaseThird();
    expect(pool.snapshot()).toEqual({ active: 0, waiting: 0, cap: 1 });
  });

  it('rejects an already-aborted signal without entering the queue', async () => {
    const pool = new ProcessPool(() => 1);
    const controller = new AbortController();
    controller.abort();

    await expect(pool.acquire(controller.signal)).rejects.toBeInstanceOf(
      ProcessPoolAcquireAborted,
    );
    expect(pool.snapshot()).toEqual({ active: 0, waiting: 0, cap: 1 });
  });
});
